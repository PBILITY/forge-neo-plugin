/**
 * dsh-forge-neo — Client half.
 *
 * The right-sidebar side card (DSH-better-sidebar) embeds the WHOLE Forge Neo
 * Web UI in an iframe, so every Forge feature works exactly as in its own
 * browser tab — including extensions such as sd-webui-prompt-all-in-one, whose
 * tag picker only renders inside Forge's own Gradio page.
 *
 * A small bar above the frame carries what the plugin itself owns: the server
 * status pill, start / restart / stop, "open in browser", and reload.
 *
 * Bundle format constraints: CJS in a lazy factory, `require('react')` only,
 * no ESM import/export, no side effects at factory time.
 */
window.__ModuleLoader__.load({
  id: 'dsh-forge-neo',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const TAB_ID = 'dsh-forge-neo'
    const TAB_KIND = 'forge'
    const NS = 'dsh-forge-neo'

    // ------------------------------------------------------------------ i18n --

    const zh = {
      title: 'Forge Neo',
      guideDesc: '整页嵌入本机 Forge Neo，含提示词插件等全部扩展',
      'status.ready': '已连接',
      'status.offline': '未连接',
      'status.noApi': '未开 API',
      'status.checking': '检测中',
      'action.reload': '刷新',
      'action.open': '新窗口',
      'action.log': '日志',
      'action.start': '启动',
      'action.restart': '重启',
      'action.stop': '停止',
      'log.title': '服务实时日志',
      'log.follow': '跟随',
      'log.pause': '暂停',
      'log.clear': '清空',
      'log.empty': '还没有日志。用「启动」按钮拉起 Forge 后，这里的输出会实时出现。',
      'log.hint': '日志来自插件启动的 Forge 进程（stdout/stderr），并落盘到 forge-neo.log。如果你用绘世启动器启动，插件看不到它的控制台。',
      'log.running': '运行中',
      'log.stopped': '未运行',
      'log.lines': '行',
      'label.offline': 'Forge 未运行。点「启动」会用整合包自带的 Python 拉起（已带 --api 与依赖补丁），也可以直接用绘世启动器。',
      'label.noApi': '服务在跑但没开 SD API：「生成」工具用不了，页面本身可用。点「重启」会带上 --api。',
      'label.starting': '正在启动 Forge，首次加载模型可能需要一会儿…',
      'label.frameHint': '下面的页面就是 Forge 本体，所有扩展（含提示词插件）都在里面。',
    }

    const en = {
      title: 'Forge Neo',
      guideDesc: 'The whole local Forge Neo UI, extensions included',
      'status.ready': 'Connected',
      'status.offline': 'Offline',
      'status.noApi': 'API off',
      'status.checking': 'Checking',
      'action.reload': 'Reload',
      'action.open': 'New window',
      'action.log': 'Logs',
      'action.start': 'Start',
      'action.restart': 'Restart',
      'action.stop': 'Stop',
      'log.title': 'Live server log',
      'log.follow': 'Follow',
      'log.pause': 'Pause',
      'log.clear': 'Clear',
      'log.empty': 'No log yet. Start Forge with the Start button and its output shows up here live.',
      'log.hint': 'Lines come from the Forge process this plugin started (stdout/stderr) and are also written to forge-neo.log. A server you started with the launcher is not visible here.',
      'log.running': 'running',
      'log.stopped': 'stopped',
      'log.lines': 'lines',
      'label.offline': 'Forge is not running. Start it here (bundled Python, with --api and the import patch), or use the launcher.',
      'label.noApi': 'The server runs without its SD API: the Generate tool will not work, the page itself does. Restart adds --api.',
      'label.starting': 'Starting Forge — the first model load can take a moment…',
      'label.frameHint': 'The page below IS Forge, so every extension (the prompt helper included) is there.',
    }

    let language = 'zh'
    let translate = null
    const languageListeners = new Set()

    const dict = () => (language === 'en' ? en : zh)

    const t = (key) => {
      if (translate !== null) {
        try {
          const value = translate(key)
          if (typeof value === 'string' && value !== key) return value
        } catch {
          /* fall through to the local dictionary */
        }
      }
      return dict()[key] ?? key
    }

    const applyLocaleId = (id) => {
      const text = String(id ?? '').toLowerCase()
      const next = text.startsWith('en') ? 'en' : 'zh'
      if (next === language) return
      language = next
      for (const listener of [...languageListeners]) {
        try {
          listener()
        } catch {
          /* one bad subscriber must not break the rest */
        }
      }
    }

    const subscribeLanguage = (listener) => {
      languageListeners.add(listener)
      return () => languageListeners.delete(listener)
    }

    const useLanguage = () => useSyncExternalStore(subscribeLanguage, () => language, () => 'zh')

    const localeIdOf = (locale) => {
      try {
        const value = typeof locale?.getLocale === 'function' ? locale.getLocale() : locale?.getSnapshot?.()
        if (typeof value === 'string') return value
        const active = value?.active ?? value?.locale ?? value?.id
        if (typeof active === 'string') return active
        if (active && typeof active === 'object') return String(active.id ?? active.locale ?? '')
        return String(value?.id ?? '')
      } catch {
        return ''
      }
    }

    // ------------------------------------------------------------------- api --

    /** Document-relative so a reverse-proxy prefix is preserved. */
    const apiUrl = (path) => new URL(`forge-neo/api/${path}`.replace(/^\/+/, ''), document.baseURI)

    async function call(path, body) {
      const response = await fetch(apiUrl(path), {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * Where the iframe points.
     *
     * The Forge origin is deliberately NOT the plugin's own HTTP origin: DSH's
     * own routes answer page requests behind an auth cookie, while Forge is a
     * separate local server on its own port. `baseUrl` comes from the Host
     * status, so a non-default port needs no client rebuild.
     */
    const forgeUrl = (baseUrl) => {
      const base = typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : 'http://127.0.0.1:7860'
      return `${base.replace(/\/+$/, '')}/`
    }

    // ---------------------------------------------------------------- styles --

    const S = {
      root: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        fontSize: 12,
        fontFamily: 'var(--dsw-font-family, inherit)',
      },
      bar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      title: { margin: 0, fontSize: 12.5, fontWeight: 700 },
      spacer: { flex: 1 },
      ghost: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      note: {
        flex: 'none',
        padding: '5px 8px',
        fontSize: 11,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      frameWrap: { flex: 1, minHeight: 0, position: 'relative', background: 'var(--dsw-alias-bg-base)' },
      frame: { width: '100%', height: '100%', border: 'none', display: 'block', background: '#fff' },
      overlay: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 16,
        textAlign: 'center',
        background: 'var(--dsw-alias-bg-base)',
      },
      logPane: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base)',
      },
      logToolbar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      logBody: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        margin: 0,
        padding: '6px 8px 10px',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: 10.5,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      logLine: { display: 'block' },
      activeBtn: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    }

    function StatusPill({ state }) {
      const color = {
        ready: 'var(--dsw-alias-state-success-primary)',
        noApi: 'var(--dsw-alias-state-warn-primary)',
        offline: 'var(--dsw-alias-state-error-primary)',
        starting: 'var(--dsw-alias-state-warn-primary)',
        checking: 'var(--dsw-alias-state-idle-primary)',
      }[state] ?? 'var(--dsw-alias-state-idle-primary)'
      const label = state === 'starting' ? t('action.start') : t(`status.${state}`)
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10.5,
          color: 'var(--dsw-alias-label-secondary)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 999,
          padding: '1px 7px',
          whiteSpace: 'nowrap',
        },
      }, h('span', { style: { width: 5, height: 5, borderRadius: '50%', background: color, display: 'block' } }), label)
    }

    // ------------------------------------------------------------------ log ---

    /**
     * Strip ANSI SGR/OSC sequences.
     *
     * Forge's tqdm bars and Gradio's coloured warnings carry escape codes; a
     * plain text console shows them as `[93m` noise, so they are removed per line
     * at render time (the stored line stays byte-faithful for the file).
     */
    const stripAnsi = (line) =>
      String(line)
        // CSI: ESC [ params intermediate final
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        // OSC terminated by BEL (the terminator Forge's tqdm/progress emits)
        .replace(/\u001b\][^\u0007]*\u0007/g, '')
        // Any remaining ESC + one byte: covers the ST-terminated OSC tail and
        // stray single escapes such as the cursor-up that tqdm writes.
        .replace(/\u001b[@-~]/g, '')
        .replace(/\u001b/g, '')

    /**
     * The live console of the Forge process.
     *
     * It polls `/forge-neo/api/log?since=<cursor>` and appends only new lines, so
     * a chatty Gradio server costs one small JSON per tick instead of re-sending
     * its whole tail. `follow` keeps the view pinned to the bottom until the
     * reader scrolls up, which is what makes a log pane usable while a model
     * loads.
     */
    function LogPane({ onClose }) {
      useLanguage()
      const [lines, setLines] = useState([])
      const [seq, setSeq] = useState(0)
      const [follow, setFollow] = useState(true)
      const [running, setRunning] = useState(false)
      const [hint, setHint] = useState('')
      const bodyRef = useRef(null)
      const alive = useRef(true)
      const cursor = useRef(0)
      const followRef = useRef(true)

      useEffect(() => () => { alive.current = false }, [])
      useEffect(() => { followRef.current = follow }, [follow])

      const pull = useCallback(async () => {
        try {
          const next = await call(`log?since=${cursor.current}`)
          if (!alive.current) return
          setRunning(next.running === true)
          if (Array.isArray(next.lines) && next.lines.length > 0) {
            const incoming = next.lines
            cursor.current = Number.isInteger(next.seq) ? next.seq : cursor.current + incoming.length
            setLines((current) => {
              const merged = [...current, ...incoming]
              // A very long session must not grow the DOM without bound.
              return merged.length > 4000 ? merged.slice(-4000) : merged
            })
            setSeq(cursor.current)
          }
        } catch (cause) {
          if (alive.current) setHint(cause.message)
        }
      }, [])

      useEffect(() => {
        pull()
        const timer = setInterval(pull, running ? 1000 : 2500)
        return () => clearInterval(timer)
      }, [pull, running])

      useEffect(() => {
        const node = bodyRef.current
        if (node === null || !follow) return
        node.scrollTop = node.scrollHeight
      }, [lines, follow])

      const clear = async () => {
        try {
          await call('log/clear', {})
          if (!alive.current) return
          cursor.current = 0
          setLines([])
          setSeq(0)
          setHint('')
        } catch (cause) {
          if (alive.current) setHint(cause.message)
        }
      }

      return h('div', { style: S.logPane },
        h('div', { style: S.logToolbar },
          h('span', { style: { fontSize: 11, fontWeight: 600 } }, t('log.title')),
          h('span', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
            h('span', {
              style: {
                width: 5,
                height: 5,
                borderRadius: '50%',
                display: 'block',
                background: running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
              },
            }),
            running ? t('log.running') : t('log.stopped'),
            h('span', null, `· ${seq} ${t('log.lines')}`),
          ),
          h('span', { style: S.spacer }),
          h('button', {
            type: 'button',
            style: follow ? S.activeBtn : S.ghost,
            onClick: () => setFollow((v) => !v),
            title: follow ? t('log.pause') : t('log.follow'),
          }, follow ? t('log.pause') : t('log.follow')),
          h('button', { type: 'button', style: S.ghost, onClick: clear }, t('log.clear')),
          h('button', { type: 'button', style: S.ghost, onClick: onClose }, '×'),
        ),
        lines.length === 0
          ? h('div', { style: { ...S.note, borderBottom: 'none' } }, t('log.empty'))
          : h('pre', { ref: bodyRef, style: S.logBody },
              lines.map((line, index) => h('span', { key: index, style: S.logLine }, stripAnsi(line))),
            ),
        hint ? h('div', { style: { ...S.note, borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: 'none', color: 'var(--dsw-alias-state-error-primary)' } }, hint) : null,
        h('div', { style: { ...S.note, borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: 'none', fontSize: 10 } }, t('log.hint')),
      )
    }

    // ----------------------------------------------------------------- panel ---

    function ForgePanel() {
      useLanguage()
      const [status, setStatus] = useState(null)
      const [state, setState] = useState('checking')
      const [error, setError] = useState('')
      /** Whether the live log replaces the embedded page. */
      const [showLog, setShowLog] = useState(false)
      /** Bumped to force the iframe to reload the document. */
      const [frameRev, setFrameRev] = useState(0)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const refresh = useCallback(async () => {
        try {
          const next = await call('status')
          if (!alive.current) return
          setStatus(next)
          setState((current) => {
            if (current === 'starting') return current
            return next.reachable ? (next.api ? 'ready' : 'noApi') : 'offline'
          })
        } catch (cause) {
          if (!alive.current) return
          setStatus({ reachable: false, api: false, detail: cause.message })
          setState((current) => (current === 'starting' ? current : 'offline'))
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      // Once Forge answers, drop the "starting" state and let the frame load.
      useEffect(() => {
        if (state !== 'starting') return
        if (status?.reachable) {
          setState(status.api ? 'ready' : 'noApi')
          setFrameRev((n) => n + 1)
        }
      }, [state, status])

      const server = async (action) => {
        setError('')
        if (action === 'start' || action === 'restart') setState('starting')
        else setState('checking')
        try {
          const result = await call('server', { action })
          if (result && result.ok === false) {
            setError(result.detail ?? 'unknown error')
            setState('offline')
            return
          }
          await refresh()
          setFrameRev((n) => n + 1)
        } catch (cause) {
          if (!alive.current) return
          setError(cause.message)
          setState('offline')
        }
      }

      const url = forgeUrl(status?.baseUrl)
      const reachable = status?.reachable === true

      return h('div', { 'data-dsh-plugin': TAB_ID, style: S.root },
        h('div', { style: S.bar },
          h('h2', { style: S.title }, t('title')),
          h(StatusPill, { state }),
          status?.pid ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, `pid ${status.pid}`) : null,
          h('span', { style: S.spacer }),
          h('button', {
            type: 'button',
            style: showLog ? S.activeBtn : S.ghost,
            onClick: () => setShowLog((value) => !value),
          }, t('action.log')),
          h('button', { type: 'button', style: S.ghost, onClick: () => setFrameRev((n) => n + 1), disabled: !reachable }, t('action.reload')),
          h('button', {
            type: 'button',
            style: S.ghost,
            onClick: () => { try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* popup blocked */ } },
            disabled: !reachable,
          }, t('action.open')),
          state === 'offline'
            ? h('button', { type: 'button', style: S.ghost, onClick: () => server('start') }, t('action.start'))
            : null,
          state === 'noApi'
            ? h('button', { type: 'button', style: S.ghost, onClick: () => server('restart') }, t('action.restart'))
            : null,
          state === 'ready' && status?.owned
            ? h('button', { type: 'button', style: S.ghost, onClick: () => server('restart') }, t('action.restart'))
            : null,
          state === 'ready' && status?.owned
            ? h('button', { type: 'button', style: S.ghost, onClick: () => server('stop') }, t('action.stop'))
            : null,
        ),

        error ? h('div', { style: { ...S.note, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        state === 'offline' ? h('div', { style: S.note }, t('label.offline')) : null,
        state === 'noApi' ? h('div', { style: { ...S.note, color: 'var(--dsw-alias-state-warn-primary)' } }, t('label.noApi')) : null,

        h('div', { style: S.frameWrap },
          // The log replaces the page rather than stacking above it: a live
          // console is read while the model loads, and an overlay would keep
          // Forge's Gradio event loop running behind an opaque layer.
          showLog
            ? h(LogPane, { onClose: () => setShowLog(false) })
            // The frame is only mounted once Forge answers: pointing it at a dead
            // port renders the browser's own error page, which looks like a bug.
            : reachable || state === 'starting'
              ? h('iframe', {
                  key: `${url}#${frameRev}`,
                  src: url,
                  title: 'Forge Neo',
                  style: S.frame,
                  allow: 'clipboard-read; clipboard-write; fullscreen',
                })
              : h('div', { style: S.overlay },
                  h('div', { style: { fontSize: 12.5, maxWidth: 420, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
                    state === 'starting' ? t('label.starting') : t('label.offline'),
                  ),
                  state === 'starting'
                    ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('label.frameHint'))
                    : h('button', { type: 'button', style: S.ghost, onClick: () => server('start') }, t('action.start')),
                ),
        ),
      )
    }

    /** Guide-card glyph for the tab picker. */
    function ForgeGuideIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 2, y: 2.4, width: 12, height: 11.2, rx: 2.2 }),
        h('circle', { cx: 8, cy: 7.4, r: 2.1 }),
        h('path', { d: 'M3.6 12.7l3.1-3.2 1.9 1.8 1.5-1.4 2.4 2.6' }),
      )
    }

    // ----------------------------------------------------------------- apply ---

    module.exports.inject = ['slots', 'locale', 'sidebarRightTabs']

    /** `ctx.get`/`ctx.service`, either shape, never throwing. */
    const serviceOf = (ctx, name) => {
      try {
        const value = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
        if (value !== undefined && value !== null) return value
      } catch {
        /* a missing inject declaration makes ctx.get throw */
      }
      try {
        const value = ctx?.[name]
        if (value !== undefined && value !== null) return value
      } catch {
        /* ignore */
      }
      return undefined
    }

    function apply(ctx) {
      try {
        const effect = typeof ctx.effect === 'function' ? (callback, label) => ctx.effect(callback, label) : (callback) => callback()

        const locale = serviceOf(ctx, 'locale')
        if (locale !== undefined) {
          try {
            effect(() => locale.register(NS, { zh, en }), 'forge-neo: dictionaries')
          } catch {
            /* an older locale service still renders the local dictionary */
          }
          try {
            translate = locale.bind(NS)
          } catch {
            translate = null
          }
          try {
            applyLocaleId(localeIdOf(locale))
            effect(() => locale.subscribe(() => applyLocaleId(localeIdOf(locale))), 'forge-neo: language')
          } catch {
            /* ignore */
          }
        }

        const tabs = serviceOf(ctx, 'sidebarRightTabs')
        const slots = serviceOf(ctx, 'slots')
        if (tabs === undefined || slots === undefined) return
        if (typeof tabs.register !== 'function' || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return

        effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('title'),
          guide: [{
            order: 36,
            title: () => t('title'),
            description: () => t('guideDesc'),
            icon: ForgeGuideIcon,
          }],
        }), 'forge-neo: tab type')

        effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: () => ({}),
        }, ForgePanel)), 'forge-neo: tab body')
      } catch (error) {
        try {
          console.error('[forge-neo] apply failed:', error)
        } catch {
          /* even a missing console must not fail the boot */
        }
      }
    }

    module.exports.apply = apply
    return module.exports
  },
})
