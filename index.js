/**
 * dsh-forge-neo — Host half.
 *
 * Bridges a local Forge Neo (sd-webui-forge-classic / NeoForge) install into the
 * DeepSeek Harness:
 *
 *  - model tools: forge_status, forge_models, forge_generate, forge_options,
 *    forge_server, forge_interrupt
 *  - the HTTP route family `/forge-neo/api/*` the Web GUI panel talks to
 *  - process control (start/stop) for the Forge server, including the Python
 *    bootstrap that makes this install's torch/xformers combination importable
 *
 * Tools are registered through `ctx.tools.register` with raw JSON Schema
 * parameters (the enforced subset: type / properties / required /
 * additionalProperties / items / enum / const).
 *
 * @module dsh-forge-neo
 */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, appendFile, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'

/** Loader plugin name. */
export const name = 'forge-neo'
/** `webServer`, `attachments` and `llm` are read with `ctx.get` so the plugin also loads without them. */
export const inject = ['tools']

const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:7860',
  pythonPath: 'E:\\sd-webui-forge-neo-aki-v1\\python\\python.exe',
  webuiDir: 'E:\\sd-webui-forge-neo-aki-v1\\sd-webui-forge-classic',
  autoStart: false,
  launchMode: 'webui',
  port: 7860,
  outputDir: '',
}

const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const NOBODY = { type: 'object', additionalProperties: false, properties: {} }

/** Complete the row config and resolve absolute paths. */
function resolveConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.baseUrl = String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '')
  cfg.webuiDir = String(cfg.webuiDir || '')
  cfg.pythonPath = String(cfg.pythonPath || '')
  cfg.port = Number.isFinite(Number(cfg.port)) ? Number(cfg.port) : 7860
  cfg.outputDir = String(cfg.outputDir || '') || (cfg.webuiDir ? join(cfg.webuiDir, 'output', 'forge-neo') : join(homedir(), '.dsh', 'forge-neo-output'))
  cfg.autoStart = cfg.autoStart === true
  cfg.launchMode = cfg.launchMode === 'api' ? 'api' : 'webui'
  return cfg
}

/** One HTTP call against the Forge REST API. */
async function forgeFetch(cfg, path, { method = 'GET', body, signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Forge request timed out after ${timeoutMs} ms`)), timeoutMs)
  const relay = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  try {
    const response = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let payload
    try {
      payload = raw === '' ? undefined : JSON.parse(raw)
    } catch {
      payload = raw
    }
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' ? payload.detail ?? payload.message ?? payload.error : payload
      const error = new Error(`Forge ${method} ${path} → HTTP ${response.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
      error.status = response.status
      throw error
    }
    return payload
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', relay)
  }
}

const text = (value) => ({ type: 'text', text: String(value) })

/**
 * Drop `undefined` members recursively. Tool values must be lossless JSON, and
 * a plausible-but-unset field (`pid` while nothing is running, `model` before
 * the server answers) is exactly the shape that violates it.
 * @param value - any JSON-like value produced by this plugin.
 * @returns the same shape with every `undefined` member omitted.
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact)
  if (value === null || typeof value !== 'object') return value
  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    next[key] = compact(entry)
  }
  return next
}

/** Serve one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/** Read a request body as JSON with a hard byte cap. */
async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Whether a request arrives from this machine's own page (loopback socket + loopback Host). */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || ''
  if (!(address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const hostname = host.replace(/:\d+$/, '')
  if (!(hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1')) return false
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Resolve a client-supplied file name inside the plugin's output directory. */
function fenceOutputPath(cfg, candidate) {
  const root = resolvePath(cfg.outputDir)
  const target = resolvePath(root, candidate)
  if (target !== root && !target.startsWith(root + sep)) throw new Error('path escapes the Forge output directory')
  return target
}

/** Whether the calling model route declares image input (so an attachment is worth attaching). */
async function routeAcceptsImages(ctx, exec) {
  const llm = ctx.get('llm')
  if (!llm) return false
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/** Persist one base64 image and describe it. */
async function saveImage(cfg, base64, index) {
  await mkdir(cfg.outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(cfg.outputDir, `forge-${stamp}-${randomUUID().slice(0, 8)}-${index}.png`)
  const bytes = Buffer.from(String(base64).replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64')
  await writeFile(file, bytes)
  return { path: file, name: basename(file), mediaType: MEDIA_TYPES[extname(file).slice(1).toLowerCase()] || 'image/png', bytes: bytes.length }
}

/** Reduce Forge's `info` JSON to the few fields worth showing in the transcript. */
function summariseInfo(info) {
  if (typeof info !== 'string' || info.trim() === '') return {}
  try {
    const parsed = JSON.parse(info)
    return {
      model: parsed.sd_model_name,
      seed: parsed.seed,
      sampler: parsed.sampler,
      scheduler: parsed.scheduler,
      steps: parsed.steps,
      cfg: parsed.cfg_scale,
      size: parsed.width && parsed.height ? `${parsed.width}x${parsed.height}` : undefined,
    }
  } catch {
    return { raw: info.slice(0, 400) }
  }
}

/**
 * Register the Forge Neo bridge.
 * @param ctx - Host context carrying `tools`.
 * @param rawConfig - the bundle row config from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  /** The Forge process this plugin owns, when it started one. */
  const owned = { child: undefined, since: 0, log: [] }
  /** Where the owned pid outlives this plugin instance (a reload keeps the server, not the handle). */
  const pidFile = join(cfg.outputDir, '.forge-neo.pid')
  /**
   * The log file a reload can still read: the ring buffer below belongs to THIS
   * plugin instance, so without a file the console of a server started by an
   * earlier instance would be gone.
   */
  const logFile = join(cfg.outputDir, 'forge-neo.log')
  /** Monotonic line counter, so a reader can ask for "everything after N". */
  let logSeq = 0
  let logLines = []
  /**
   * Absolute position of `logLines[0]`. The window is trimmed at the front, so
   * its first element is NOT position 0 once trimming happened; without this
   * offset a reader's cursor would silently skip or repeat lines.
   */
  let logBase = 0
  /** Serializes appends so interleaved stdout/stderr chunks keep their order. */
  let logQueue = Promise.resolve()

  /** Read the pid this plugin recorded earlier, if it is still alive. */
  async function readRecordedPid() {
    try {
      const pid = Number.parseInt(String(await readFile(pidFile, 'utf8')).trim(), 10)
      if (!Number.isInteger(pid) || pid <= 0) return undefined
      process.kill(pid, 0)
      return pid
    } catch {
      return undefined
    }
  }

  /** Persist the pid of a server this plugin started, or clear the record. */
  async function writeRecordedPid(pid) {
    try {
      if (pid === undefined) {
        await rm(pidFile, { force: true })
        return
      }
      await mkdir(cfg.outputDir, { recursive: true })
      await writeFile(pidFile, String(pid))
    } catch {
      /* recording is best effort; the live child handle still governs this instance */
    }
  }

  /**
   * Drop ANSI escape sequences from one recorded line.
   *
   * Tqdm progress bars and Gradio's coloured warnings emit SGR codes and
   * `ESC[A` cursor moves; the log file feeds both the console UI and line-based
   * reading, so it stores the readable text rather than raw control bytes.
   */
  const stripAnsi = (line) =>
    line
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b[@-~]/g, '')
      .replace(/\u001b/g, '')

  /**
   * Repair tqdm bars mangled by a legacy (non-UTF-8) stdout.
   *
   * A Forge process launched before `PYTHONIOENCODING=utf-8` wrote its bar
   * blocks through the console code page, so each `█` landed as a U+FFFD
   * replacement character — and tqdm pads the unfilled remainder with SPACES,
   * so the damaged cell is a mix of replacements and spaces, not a solid run.
   * The bar between `|` and `|` is therefore rebuilt from its width and the
   * sampled percentage instead of trying to count blocks.
   */
  const repairLegacyBar = (line) => {
    if (!line.includes('\uFFFD')) return line
    return line.replace(/(\d{1,3})%\|([\uFFFD ]*)\|/g, (match, percentText, cell) => {
      if (!cell.includes('\uFFFD')) return match
      const percent = Math.min(100, Math.max(0, Number.parseInt(percentText, 10)))
      // Each damaged block occupies one replacement char; spaces are real padding.
      const width = cell.length
      const filled = Math.round((percent / 100) * width)
      return `${percentText}%|${'\u2588'.repeat(filled)}${' '.repeat(Math.max(0, width - filled))}|`
    })
  }

  /**
   * Record one console chunk: into the in-memory tail (for the live reader) and
   * into the log file (so a later plugin instance still sees it).
   *
   * Tqdm rewrites its bar with `\r` and puts `ESC[A` (cursor up) AFTER that CR,
   * so a strip-then-split leaves the escape at the START of the next fragment —
   * where it no longer matches the CSI rule because the "line" begins with it.
   * Splitting first and stripping each fragment handles both orders, and a
   * fragment that was nothing but escapes trims to empty and is dropped.
   */
  const pushLog = (chunk) => {
    const fresh = []
    for (const raw of String(chunk).split(/[\r\n]+/)) {
      const line = stripAnsi(raw).trimEnd()
      if (line.trim() === '') continue
      fresh.push(line)
      owned.log.push(line)
      if (owned.log.length > 400) owned.log.splice(0, owned.log.length - 400)
    }
    if (fresh.length === 0) return
    logLines.push(...fresh)
    logSeq += fresh.length
    if (logLines.length > 4000) {
      const dropped = logLines.length - 4000
      logLines = logLines.slice(dropped)
      logBase += dropped
    }
    logQueue = logQueue
      .then(async () => {
        await mkdir(cfg.outputDir, { recursive: true })
        await appendFile(logFile, `${fresh.join('\n')}\n`, 'utf8')
      })
      .catch(() => {
        /* a log write failure must never break the server supervision */
      })
  }

  /**
   * Read every line the persisted log currently holds (bounded by file size).
   *
   * Lines written by an EARLIER plugin instance were recorded before the current
   * strip rules (and any instance that did not spawn the server records nothing
   * at all), so the file is cleaned on the way out as well: reading is the only
   * path that can see bytes this process never wrote.
   */
  async function readPersistedLog() {
    try {
      const text = await readFile(logFile, 'utf8')
      return text
        .split(/\r?\n/)
        .map((line) => repairLegacyBar(stripAnsi(line)).trimEnd())
        .filter((line) => line.trim() !== '')
    } catch {
      return undefined
    }
  }

  /**
   * The log surface shared by the tool, the panel route and the console UI.
   *
   * `seq` is the ABSOLUTE count of lines recorded since this plugin instance
   * started watching, so a reader keeps one cursor and asks for everything after
   * it. The in-memory buffer is the source of truth while this instance runs;
   * the file only supplies history from a PREVIOUS instance (a reload keeps the
   * server, not the buffer), which is why the two are never concatenated — that
   * would double-count the lines this instance already has in memory.
   */
  async function logSnapshot(since, limit = 500) {
    const from = Number.isInteger(since) && since >= 0 ? since : 0
    let lines
    let seq
    if (logSeq > 0) {
      // This instance is watching: serve its window, translated from absolute
      // positions through `logBase` (the absolute index of logLines[0]).
      const fromIndex = Math.max(from - logBase, 0)
      lines = logLines.slice(fromIndex).slice(-limit)
      seq = logSeq
    } else {
      // No recording in this instance: fall back to whatever the file kept.
      const persisted = (await readPersistedLog()) ?? []
      const skip = Math.min(from, persisted.length)
      lines = persisted.slice(skip).slice(-limit)
      seq = persisted.length
    }
    return {
      lines,
      seq,
      // The handle is lost across a plugin reload while the server keeps running,
      // so "running" means "a pid this plugin recorded is still alive".
      running: owned.child !== undefined || (await readRecordedPid()) !== undefined,
      pid: owned.child?.pid ?? (await readRecordedPid()),
      logFile,
    }
  }

  /** Probe the SD API; distinguishes "not running" from "running without --api". */
  async function probe(signal) {
    const started = Date.now()
    try {
      const progress = await forgeFetch(cfg, '/sdapi/v1/progress', { signal, timeoutMs: 5000 })
      return {
        reachable: true,
        api: true,
        latencyMs: Date.now() - started,
        progress: typeof progress?.progress === 'number' ? progress.progress : 0,
        state: progress?.state ?? {},
        eta: progress?.eta_relative ?? 0,
      }
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        return {
          reachable: true,
          api: false,
          latencyMs: Date.now() - started,
          detail: 'the server is running but its SD API is disabled — restart it with --api (forge_server action="restart" does that)',
        }
      }
      return { reachable: false, api: false, latencyMs: Date.now() - started, detail: error?.message ?? String(error) }
    }
  }

  /** The status snapshot shared by the tool and the panel. */
  async function status(signal) {
    const health = await probe(signal)
    const recorded = owned.child === undefined ? await readRecordedPid() : undefined
    const snapshot = {
      ...health,
      baseUrl: cfg.baseUrl,
      webuiDir: cfg.webuiDir,
      outputDir: cfg.outputDir,
      launchMode: cfg.launchMode,
      owned: owned.child !== undefined || (recorded !== undefined && health.reachable),
      pid: owned.child?.pid ?? recorded,
      log: owned.log.slice(-40),
      logFile,
    }
    if (!health.api) return compact(snapshot)
    try {
      const [options, memory, models] = await Promise.all([
        forgeFetch(cfg, '/sdapi/v1/options', { signal, timeoutMs: 20000 }),
        forgeFetch(cfg, '/sdapi/v1/memory', { signal, timeoutMs: 20000 }),
        forgeFetch(cfg, '/sdapi/v1/sd-models', { signal, timeoutMs: 20000 }),
      ])
      snapshot.model = options?.sd_model_checkpoint
      snapshot.modules = Array.isArray(options?.forge_additional_modules) ? options.forge_additional_modules : []
      snapshot.models = Array.isArray(models) ? models.map((entry) => entry.model_name ?? entry.title) : []
      snapshot.vram = memory?.cuda ?? undefined
      snapshot.ram = memory?.ram ?? undefined
    } catch (error) {
      snapshot.detail = error?.message ?? String(error)
    }
    return compact(snapshot)
  }

  /**
   * Launch the Forge server this plugin owns and wait for its API.
   *
   * The bundled Python is torch 2.9.1 with an xformers built against torch 2.10,
   * which imports `GroupName` from `torch.distributed.distributed_c10d` — a symbol
   * this torch does not export. diffusers imports `xformers.ops` unconditionally
   * once the package exists, so Forge dies at import time. Supplying the symbol
   * (xformers itself still reports no C++ library, so Forge falls back to its own
   * attention backends) is enough for the import chain to succeed.
   */
  async function launch(signal) {
    if (owned.child) return { ok: true, alreadyRunning: true, pid: owned.child.pid }
    const health = await probe(signal)
    if (health.reachable) {
      return {
        ok: true,
        alreadyRunning: true,
        api: health.api,
        detail: health.api ? 'Forge is already running' : 'Forge is running without --api; use restart to relaunch it with the API enabled',
      }
    }
    if (!cfg.webuiDir || !cfg.pythonPath) throw new Error('webuiDir and pythonPath must be configured before Forge can be started')
    const args = cfg.launchMode === 'api' ? ['--nowebui'] : []
    // `--server-name` marks the launch as non-local, which is what suppresses Forge's
    // `auto_launch_browser: Local` default; it also keeps the UI on the loopback address
    // this plugin talks to instead of every interface.
    args.push(
      '--api',
      '--port', String(cfg.port),
      '--server-name', '127.0.0.1',
      '--skip-prepare-environment',
      '--skip-install',
      '--skip-version-check',
      '--skip-python-version-check',
    )
    const bootstrap = [
      'import runpy, sys',
      'try:',
      '    import torch.distributed.distributed_c10d as _c10d',
      '    if not hasattr(_c10d, "GroupName"): _c10d.GroupName = str',
      'except Exception:',
      '    pass',
      'runpy.run_path("launch.py", run_name="__main__")',
    ].join('\n')
    const child = spawn(cfg.pythonPath, ['-c', bootstrap, ...args], {
      cwd: cfg.webuiDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        SD_WEBUI_RESTART: 'tmp/restart',
        // Without this, a piped stdout defaults to the console code page (gbk on
        // this machine), so tqdm's block characters are emitted as U+FFFD '?'
        // replacements and the progress bar is unreadable in the log view.
        PYTHONIOENCODING: 'utf-8',
        // PYTHONUTF8 also switches the interpreter's own default encoding, which
        // keeps the rest of the startup output (paths, model names) intact.
        PYTHONUTF8: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    owned.child = child
    owned.since = Date.now()
    owned.log = []
    child.stdout?.on('data', pushLog)
    child.stderr?.on('data', pushLog)
    child.once('exit', (code, signalName) => {
      pushLog(`[forge-neo] Forge exited (code=${code ?? 'null'}${signalName ? `, signal=${signalName}` : ''})`)
      if (owned.child === child) {
        owned.child = undefined
        // Only clear the record when THIS child was still the current one: a restart
        // spawns the replacement before the predecessor's exit arrives.
        void writeRecordedPid(undefined)
      }
    })
    child.once('error', (error) => pushLog(`[forge-neo] spawn failed: ${error.message}`))
    await writeRecordedPid(child.pid)

    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      if (owned.child === undefined && child.exitCode !== null) break
      const state = await probe(signal)
      if (state.reachable && state.api) return { ok: true, started: true, pid: child.pid, waitedMs: Date.now() - owned.since, log: owned.log.slice(-12) }
      await new Promise((done) => setTimeout(done, 2500))
    }
    return { ok: false, started: owned.child !== undefined, pid: child.pid, detail: 'Forge did not answer within 180 s', log: owned.log.slice(-30) }
  }

  /** Stop a server this plugin started; never touches one it does not own. */
  async function stop() {
    const pid = owned.child?.pid ?? (await readRecordedPid())
    if (pid === undefined) return { ok: false, detail: 'this plugin did not start the running Forge server; close it from the Web UI or the 绘世 launcher' }
    const child = owned.child
    owned.child = undefined
    if (child) {
      child.kill()
    } else {
      // A server started by an earlier instance of this plugin: only the recorded pid remains.
      try {
        process.kill(pid)
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      if (child && child.exitCode === null) child.kill('SIGKILL')
    }, 8000)
    timer.unref?.()
    await writeRecordedPid(undefined)
    return { ok: true, stopped: true, pid }
  }

  /** Patch the live Forge options. */
  async function setOptions(patch, signal) {
    const next = {}
    if (typeof patch.model === 'string' && patch.model !== '') {
      // `sd_model_checkpoint` expects the file name; a bare stem from forge_models is completed here.
      const candidate = patch.model.trim()
      next.sd_model_checkpoint = /\.[a-z0-9]+$/i.test(candidate) ? candidate : `${candidate}.safetensors`
    }
    if (Array.isArray(patch.modules)) next.forge_additional_modules = patch.modules.filter((entry) => typeof entry === 'string')
    if (typeof patch.vae === 'string' && patch.vae !== '') next.sd_vae = patch.vae
    if (typeof patch.clipSkip === 'number') next.CLIP_stop_at_last_layers = patch.clipSkip
    if (typeof patch.faceRestoration === 'string') next.face_restoration_model = patch.faceRestoration
    if (Object.keys(next).length === 0) throw new Error('nothing to change: pass model, modules, vae, clipSkip or faceRestoration')
    await forgeFetch(cfg, '/sdapi/v1/options', { method: 'POST', body: next, signal, timeoutMs: 600000 })
    return next
  }

  /**
   * One txt2img generation: persist every returned image, and attach the first
   * few when the calling route accepts image input.
   */
  async function generate(input, exec) {
    const request = {
      prompt: String(input.prompt ?? ''),
      negative_prompt: String(input.negative_prompt ?? ''),
      steps: Number.isFinite(input.steps) ? input.steps : 24,
      cfg_scale: Number.isFinite(input.cfg_scale) ? input.cfg_scale : 4,
      width: Number.isFinite(input.width) ? input.width : 832,
      height: Number.isFinite(input.height) ? input.height : 832,
      batch_size: Number.isFinite(input.batch_size) ? Math.min(Math.max(input.batch_size, 1), 8) : 1,
      seed: Number.isFinite(input.seed) ? input.seed : -1,
      send_images: true,
      save_images: false,
    }
    if (typeof input.sampler_name === 'string' && input.sampler_name !== '') request.sampler_name = input.sampler_name
    if (typeof input.scheduler === 'string' && input.scheduler !== '') request.scheduler = input.scheduler
    if (typeof input.model === 'string' && input.model.trim() !== '') {
      const current = await forgeFetch(cfg, '/sdapi/v1/options', { signal: exec?.signal, timeoutMs: 20000 })
      const loaded = String(current?.sd_model_checkpoint ?? '')
      const wanted = input.model.trim()
      // Forge reports the loaded checkpoint with its extension; callers legitimately
      // pass the bare name forge_models lists, so compare stem-wise before reloading.
      const same = loaded === wanted || loaded.replace(/\.[^.]+$/, '') === wanted.replace(/\.[^.]+$/, '')
      if (!same) await setOptions({ model: wanted }, exec?.signal)
    }
    const payload = await forgeFetch(cfg, '/sdapi/v1/txt2img', { method: 'POST', body: request, signal: exec?.signal, timeoutMs: 1800000 })
    const images = Array.isArray(payload?.images) ? payload.images : []
    const saved = []
    for (let index = 0; index < images.length; index += 1) {
      try {
        saved.push(await saveImage(cfg, images[index], index))
      } catch (error) {
        saved.push({ path: '', name: `image-${index}.png`, mediaType: 'image/png', bytes: 0, error: error?.message ?? String(error) })
      }
    }
    return { request, saved, info: summariseInfo(payload?.info), parameters: payload?.parameters ?? {} }
  }

  // ---------------------------------------------------------------- tools ----

  ctx.tools.register({
    name: 'forge_status',
    description:
      'Report the local Forge Neo (sd-webui-forge-classic / NeoForge) server: whether it is reachable, whether its SD API is enabled, the loaded checkpoint and additional modules, free VRAM, current queue progress, and the tail of its log when this plugin started the process. Call it before generating to confirm the server and model are ready.',
    parameters: NOBODY,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.reachable) return [text(`Forge is not reachable at ${value.baseUrl}. ${value.detail ?? ''}`)]
        if (!value.api) return [text(`Forge is running at ${value.baseUrl} but its SD API is disabled. ${value.detail ?? ''}`)]
        const vram = value.vram?.system ? `VRAM ${(value.vram.system.free / 1073741824).toFixed(1)} GB free of ${(value.vram.system.total / 1073741824).toFixed(1)} GB` : 'VRAM unknown'
        const busy = value.state?.job ? `running: ${value.state.job}` : 'idle'
        const loaded = value.model ? `model ${value.model}` : 'no model reported'
        return [text(`Forge is ready at ${value.baseUrl}. ${loaded}; ${vram}; ${busy}. ${value.models?.length ?? 0} checkpoint(s) available.`)]
      },
      presentationMeta: (_args, value) => compact({ reachable: value.reachable, api: value.api, model: value.model }),
    },
    isConcurrencySafe: () => true,
    execute: (_args, exec) => status(exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Check Forge Neo', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'forge_models',
    description:
      'List the checkpoints, VAEs, samplers, schedulers, upscalers or embeddings a local Forge Neo install has. Call it to pick a real checkpoint or sampler name before forge_generate rather than guessing one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: ['checkpoints', 'vaes', 'samplers', 'schedulers', 'upscalers', 'embeddings'] },
          description: 'Collections to return. Omit for checkpoints, samplers and schedulers.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const groups = Array.isArray(args.include) && args.include.length > 0 ? args.include : ['checkpoints', 'samplers', 'schedulers']
        const lines = []
        for (const group of groups) {
          const list = value[group]
          if (!Array.isArray(list)) continue
          const shown = list.slice(0, 80)
          lines.push(`${group} (${list.length}): ${shown.join(', ')}${list.length > shown.length ? ', …' : ''}`)
        }
        return [text(lines.length > 0 ? lines.join('\n') : 'Forge returned no collections for the requested groups.')]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const groups = Array.isArray(args.include) && args.include.length > 0 ? args.include : ['checkpoints', 'samplers', 'schedulers']
      /** Forge reports `{ name, title }` for most collections; a checkpoint's `title` carries the hash, so prefer the name. */
      const names = (items) => (Array.isArray(items) ? items.map((entry) => (typeof entry === 'string' ? entry : entry.model_name ?? entry.name ?? entry.title)).filter(Boolean) : [])
      const result = {}
      const want = new Set(groups)
      if (want.has('checkpoints')) result.checkpoints = names(await forgeFetch(cfg, '/sdapi/v1/sd-models', { signal: exec.signal }))
      if (want.has('samplers')) result.samplers = names(await forgeFetch(cfg, '/sdapi/v1/samplers', { signal: exec.signal }))
      if (want.has('schedulers')) result.schedulers = names(await forgeFetch(cfg, '/sdapi/v1/schedulers', { signal: exec.signal }))
      if (want.has('upscalers')) result.upscalers = names(await forgeFetch(cfg, '/sdapi/v1/upscalers', { signal: exec.signal }))
      if (want.has('vaes')) result.vaes = names(await forgeFetch(cfg, '/sdapi/v1/sd-modules', { signal: exec.signal }))
      if (want.has('embeddings')) {
        const embeddings = await forgeFetch(cfg, '/sdapi/v1/embeddings', { signal: exec.signal })
        result.embeddings = Object.keys(embeddings?.loaded ?? {})
      }
      return compact(result)
    },
    presentCall: () => ({ card: 'generic', title: 'List Forge Neo models', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'forge_generate',
    description:
      'Generate an image with the local Forge Neo (NeoForge) server through its txt2img API and save it under the configured output directory; when the calling model route accepts image input the image is attached so it can be inspected on the next step. Anime checkpoints take Danbooru-style tag prompts. A run takes seconds to a few minutes on a local GPU, so prefer modest steps while iterating.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'Positive prompt.' },
        negative_prompt: { type: 'string', description: 'Negative prompt.' },
        steps: { type: 'number', description: 'Sampling steps (default 24).' },
        cfg_scale: { type: 'number', description: 'CFG scale (default 4).' },
        width: { type: 'number', description: 'Image width in pixels (default 832).' },
        height: { type: 'number', description: 'Image height in pixels (default 832).' },
        batch_size: { type: 'number', description: 'Images to generate, 1–8 (default 1).' },
        seed: { type: 'number', description: 'Seed; -1 (default) is random.' },
        sampler_name: { type: 'string', description: 'Sampler name exactly as forge_models reports it, e.g. "ER SDE" or "DPM++ 2M".' },
        scheduler: { type: 'string', description: 'Scheduler name, e.g. "Beta" or "Karras".' },
        model: { type: 'string', description: 'Checkpoint file name to switch to first, e.g. "miaomiaoHarem_anima15.safetensors".' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['images'],
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['path', 'mediaType', 'bytes', 'name'],
              properties: {
                path: { type: 'string' },
                name: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                attachment: { type: 'object', additionalProperties: true },
              },
            },
          },
          info: { type: 'object', additionalProperties: true },
          parameters: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const info = value.info ?? {}
        const detail = [info.model, info.sampler, info.scheduler, info.steps ? `${info.steps} steps` : undefined, info.cfg ? `CFG ${info.cfg}` : undefined, info.seed !== undefined ? `seed ${info.seed}` : undefined, info.size].filter(Boolean)
        const lines = [`Generated ${value.images.length} image(s):`]
        for (const image of value.images) lines.push(`- ${image.path}`)
        if (detail.length > 0) lines.push('', detail.join(', '))
        const blocks = [text(lines.join('\n'))]
        for (const image of value.images) if (image.attachment) blocks.push({ type: 'image', attachment: image.attachment })
        return blocks
      },
      presentationMeta: (_args, value) => ({ paths: value.images.map((image) => image.path) }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1800000,
    async execute(args, exec) {
      if (String(args.prompt ?? '').trim() === '') throw new Error('prompt must be a non-empty string')
      const result = await generate(args, exec)
      if (result.saved.length === 0) throw new Error('Forge returned no images; check the server log with forge_status')
      const attach = ctx.get('attachments')
      const canAttach = attach !== undefined && (await routeAcceptsImages(ctx, exec))
      const images = []
      for (const image of result.saved.slice(0, 4)) {
        const entry = { path: image.path, name: image.name, mediaType: image.mediaType, bytes: image.bytes }
        if (canAttach && image.path !== '') {
          try {
            const data = await readFile(image.path)
            const ref = await attach.saveImage({ data, mediaType: image.mediaType, name: image.name })
            entry.attachment = {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name === undefined ? {} : { name: ref.name }),
            }
          } catch {
            /* the on-disk path remains the fallback */
          }
        }
        images.push(entry)
      }
      return compact({ images, info: result.info, parameters: result.parameters })
    },
    presentCall: (args) => ({ card: 'generic', title: `Forge Neo: ${String(args.prompt ?? '').slice(0, 80)}`, kind: 'other', rawInput: args }),
  })

  ctx.tools.register({
    name: 'forge_options',
    description:
      'Change the live Forge Neo server state: switch the loaded checkpoint, set the additional modules (VAE / text encoder file names), the VAE, CLIP skip, or the face-restoration model. Switching a checkpoint can take tens of seconds while the model loads.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', description: 'Checkpoint file name, e.g. "anima-base-v1.0.safetensors".' },
        modules: { type: 'array', items: { type: 'string' }, description: 'Forge additional modules (VAE / text encoder file names).' },
        vae: { type: 'string', description: 'VAE name.' },
        clipSkip: { type: 'number', description: 'CLIP skip (CLIP_stop_at_last_layers).' },
        faceRestoration: { type: 'string', description: 'Face restoration model name.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [text(`Updated Forge options: ${Object.entries(value).map(([key, val]) => `${key}=${Array.isArray(val) ? val.join('+') : val}`).join(', ')}`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 600000,
    execute: async (args, exec) => compact(await setOptions(args, exec.signal)),
    presentCall: () => ({ card: 'generic', title: 'Change Forge Neo options', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'forge_server',
    description:
      'Start, stop or restart the local Forge Neo server (sd-webui-forge-classic). Start launches the configured Python with the SD API enabled and waits until it answers (about 15–60 s); stop only terminates a server this plugin started. Use it when forge_status reports the server is down or running without its API.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Lifecycle action.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        if (args.action === 'stop') return [text(value.ok ? `Stopped Forge (pid ${value.pid}).` : `Did not stop Forge: ${value.detail}`)]
        if (value.ok) return [text(`Forge ${value.alreadyRunning ? 'was already running' : 'started'} at ${cfg.baseUrl}${value.pid ? ` (pid ${value.pid})` : ''}.`)]
        return [text(`Forge did not become ready: ${value.detail ?? 'unknown error'}`)]
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 300000,
    async execute(args, exec) {
      if (args.action === 'stop') return compact(await stop())
      if (args.action === 'restart') {
        const stopped = await stop()
        await new Promise((done) => setTimeout(done, 1500))
        return compact({ ...(await launch(exec.signal)), stopped: stopped.ok })
      }
      return compact(await launch(exec.signal))
    },
    presentCall: (args) => ({ card: 'generic', title: `Forge Neo: ${args.action} server`, kind: 'execute' }),
  })

  ctx.tools.register({
    name: 'forge_interrupt',
    description: 'Interrupt the generation currently running on the local Forge Neo server, or skip its remaining steps so the partial image is returned sooner.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { skip: { type: 'boolean', description: 'Skip the remaining steps instead of interrupting the whole run.' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [text(args.skip === true ? 'Asked Forge to skip to the end of the current generation.' : `Asked Forge to interrupt the current generation${typeof value.progress === 'number' ? ` at ${Math.round(value.progress * 100)}%` : ''}.`)],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await forgeFetch(cfg, args.skip === true ? '/sdapi/v1/skip' : '/sdapi/v1/interrupt', { method: 'POST', signal: exec.signal })
      try {
        const progress = await forgeFetch(cfg, '/sdapi/v1/progress', { signal: exec.signal })
        return compact({ ok: true, progress: typeof progress?.progress === 'number' ? progress.progress : undefined })
      } catch {
        return { ok: true }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Interrupt Forge Neo', kind: 'execute' }),
  })

  // --------------------------------------------------------------- routes ----

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/forge-neo/api',
      async handler(req, res) {
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
        const route = url.pathname.replace(/^\/forge-neo\/api/, '') || '/'
        try {
          if (route === '/status' && req.method === 'GET') {
            sendJson(res, 200, await status())
            return
          }
          /**
           * Live console feed. `?since=N` returns only lines after the reader's
           * cursor, so the UI polls incrementally instead of re-rendering the tail.
           */
          if (route === '/log' && req.method === 'GET') {
            const since = Number.parseInt(url.searchParams.get('since') ?? '', 10)
            const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
            const snapshot = await logSnapshot(
              Number.isInteger(since) ? since : 0,
              Number.isInteger(limit) && limit > 0 ? Math.min(limit, 4000) : 500,
            )
            sendJson(res, 200, snapshot)
            return
          }
          if (route === '/log/clear' && req.method === 'POST') {
            owned.log = []
            logLines = []
            logSeq = 0
            logBase = 0
            await rm(logFile, { force: true }).catch(() => {})
            sendJson(res, 200, { ok: true })
            return
          }
          if (route === '/models' && req.method === 'GET') {
            const [models, samplers, schedulers, options] = await Promise.all([
              forgeFetch(cfg, '/sdapi/v1/sd-models', { timeoutMs: 20000 }),
              forgeFetch(cfg, '/sdapi/v1/samplers', { timeoutMs: 20000 }),
              forgeFetch(cfg, '/sdapi/v1/schedulers', { timeoutMs: 20000 }),
              forgeFetch(cfg, '/sdapi/v1/options', { timeoutMs: 20000 }),
            ])
            sendJson(res, 200, {
              models: Array.isArray(models) ? models.map((entry) => entry.model_name ?? entry.title) : [],
              samplers: Array.isArray(samplers) ? samplers.map((entry) => entry.name) : [],
              schedulers: Array.isArray(schedulers) ? schedulers.map((entry) => entry.name) : [],
              current: options?.sd_model_checkpoint,
              modules: Array.isArray(options?.forge_additional_modules) ? options.forge_additional_modules : [],
            })
            return
          }
          if (route === '/generate' && req.method === 'POST') {
            const body = await readJsonBody(req)
            if (String(body.prompt ?? '').trim() === '') {
              sendJson(res, 400, { error: 'prompt must be a non-empty string' })
              return
            }
            const result = await generate(body, undefined)
            sendJson(res, 200, {
              images: result.saved.map((image) => ({ name: image.name, path: image.path, url: `image?path=${encodeURIComponent(image.name)}` })),
              info: result.info,
              request: result.request,
            })
            return
          }
          if (route === '/image' && req.method === 'GET') {
            const target = fenceOutputPath(cfg, url.searchParams.get('path') ?? '')
            const info = await stat(target)
            if (!info.isFile()) throw new Error('not a regular file')
            res.writeHead(200, {
              'content-type': MEDIA_TYPES[extname(target).slice(1).toLowerCase()] || 'application/octet-stream',
              'content-length': String(info.size),
              'cache-control': 'no-store',
            })
            createReadStream(target).pipe(res)
            return
          }
          if (route === '/gallery' && req.method === 'GET') {
            await mkdir(cfg.outputDir, { recursive: true })
            const entries = await readdir(cfg.outputDir, { withFileTypes: true })
            const files = entries
              .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
              .map((entry) => entry.name)
              .sort()
              .reverse()
              .slice(0, 60)
            sendJson(res, 200, { files, dir: cfg.outputDir })
            return
          }
          if (route === '/options' && req.method === 'POST') {
            sendJson(res, 200, await setOptions(await readJsonBody(req)))
            return
          }
          if (route === '/interrupt' && req.method === 'POST') {
            const body = await readJsonBody(req).catch(() => ({}))
            await forgeFetch(cfg, body?.skip === true ? '/sdapi/v1/skip' : '/sdapi/v1/interrupt', { method: 'POST' })
            sendJson(res, 200, { ok: true })
            return
          }
          if (route === '/server' && req.method === 'POST') {
            const body = await readJsonBody(req)
            if (body?.action === 'stop') sendJson(res, 200, await stop())
            else if (body?.action === 'restart') {
              await stop()
              await new Promise((done) => setTimeout(done, 1500))
              sendJson(res, 200, await launch())
            } else sendJson(res, 200, await launch())
            return
          }
          sendJson(res, 404, { error: `no route ${req.method} ${route}` })
        } catch (error) {
          sendJson(res, 500, { error: error?.message ?? String(error) })
        }
      },
    }), 'forge-neo: routes')
  })

  if (cfg.autoStart) {
    ctx.effect(() => {
      let cancelled = false
      const timer = setTimeout(async () => {
        if (cancelled) return
        try {
          const health = await probe()
          if (!health.reachable && !cancelled) await launch()
        } catch {
          /* auto-start failure must not fail the composition */
        }
      }, 2000)
      timer.unref?.()
      return () => {
        cancelled = true
        clearTimeout(timer)
        void stop()
      }
    }, 'forge-neo: auto-start')
  }
}
