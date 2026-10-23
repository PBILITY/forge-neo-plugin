# dsh-forge-neo

Forge Neo（`sd-webui-forge-classic` / NeoForge，即绘世整合包 2026 版）在 DeepSeek Harness 里的桥：

- **6 个模型工具**：`forge_status`、`forge_models`、`forge_generate`、`forge_options`、
  `forge_server`、`forge_interrupt`
- **右侧栏侧边卡片**（DSH-better-sidebar）：tab 类型 `forge`。卡片里**整页嵌入 Forge 本体**
  （`http://127.0.0.1:7860/` 的 iframe），所以提示词插件、ControlNet、后期处理等所有扩展
  都和在浏览器里打开 Forge 时一模一样；顶部窄条放插件自己负责的东西：状态灯、
  **日志**、刷新、新窗口、启动/重启/停止
- **实时日志窗口**：点顶部「日志」把页面切换成 Forge 进程的实时控制台（可暂停跟随、清空），
  日志同时落盘到 `outputDir/forge-neo.log`
- **HTTP 路由** `/forge-neo/api/*`（仅回环可访问）：侧边卡片与外部脚本共用

生成图存放在 `webuiDir/output/forge-neo/`，不写进 Forge 自己的 output 目录结构。

## 为什么需要 `GroupName` 补丁

整合包自带的 Python 是 **torch 2.9.1+cu130**，但其中的 **xformers 0.0.35 是按 torch 2.10 编译的**，
它从 `torch.distributed.distributed_c10d` 导入 `GroupName` —— 这个 torch 版本没有该符号。
diffusers 只要检测到 xformers 已安装就会 `import xformers.ops`，于是 Forge 在启动阶段直接崩：

```
ImportError: cannot import name 'GroupName' from 'torch.distributed.distributed_c10d'
```

`forge_server` 启动时用 `python -c` 注入一行补丁（`_c10d.GroupName = str`）再 `runpy` 执行
`launch.py`。xformers 本身仍然报告没有 C++ 库，Forge 会退回自己的 attention 后端，
所以补丁只影响导入链，不改变采样实现。

## 配置

在 profile 的 `cordis.patch.yml` 里改 `include:forge-neo` 行的 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:7860` | Forge 的地址 |
| `pythonPath` | `<整合包>\python\python.exe` | 用来启动 Forge 的解释器 |
| `webuiDir` | `<整合包>\sd-webui-forge-classic` | `launch.py` 所在目录 |
| `port` | `7860` | 启动时传的 `--port` |
| `launchMode` | `webui` | `webui`（带界面）或 `api`（`--nowebui`） |
| `outputDir` | `<webuiDir>/output/forge-neo` | 生成图目录 |
| `autoStart` | `false` | 插件加载时自动拉起 Forge |

启动参数固定带 `--server-name 127.0.0.1`：既让 Forge 认为自己是非本地部署（从而不自动弹浏览器），
也把界面限制在回环地址上。

## 工具速览

```text
forge_status                       # 可达性、模型、显存、队列进度
forge_models ["checkpoints", …]    # 真实存在的模型/采样器/调度器名字
forge_generate {prompt, …}         # txt2img，图存盘；当前模型支持图像输入时会附图
forge_options {model|modules|vae|clipSkip|faceRestoration}
forge_server {action: start|stop|restart}
forge_interrupt {skip?: true}
```

`forge_generate` 的 `model` 可以写 `forge_models` 返回的裸名（`miaomiaoHarem_anima15`），
插件会补全扩展名并按去扩展名比较，避免因为“看起来一样”而反复重载模型。

## 实现备注

- **工具 schema**：`ctx.tools.register` 收的是原始 JSON Schema（`required` 是对象级数组），
  不是 `defineTool` 的参数 DSL。
- **无损 JSON**：工具返回值里任何 `undefined` 都会让结果被判定为“非无损 JSON”而报错，
  所以所有返回值都经过 `compact()` 剔除 `undefined` 成员。
- **pid 持久化**：`stop` 要能停掉“上一次插件实例启动的”Forge，因此启动成功会把 pid 写到
  `outputDir/.forge-neo.pid`，退出时清除；重启时旧子进程的 `exit` 不会误删新记录。
- **`dsh.client.inject`**：只能列真正会出现在客户端模块图里的包。`@deepseek-ai/dsh-client-ui-slots`
  **不是**独立客户端模块（slots 是 `ui-layout`/`ui-renderer` 的内建服务），列它会令客户端半边
  永远等不到依赖、界面不出现。要进右侧栏侧边卡片，照 `dsh-comfy` / `dsh-sdwebui` 的做法：
  `dsh-client-locale` + `dsh-client-ui-sidebar-right` + `dsh-client-ui-session`。
- **侧边卡片两段式注册**：`sidebarRightTabs.register({ id, kind, title, guide })` 注册 tab 类型，
  再 `slots.inject('sidebar.right.pane.tab', () => slots.register({ name, key: id, locale, inject }, Panel))`
  注册正文；`key` 必须等于 tab 类型的 `id`。
- **整页嵌入而不是重画界面**：Forge 页面不带 `X-Frame-Options`、也不带 `frame-ancestors`，
  DSH 的 Electron CSP 是 `frame-src * data:`，所以 iframe 直接指向 `baseUrl` 就行。
  这也是提示词插件能显示的唯一方式 —— 它的标签面板是挂在 Forge Gradio 页面里的前端代码，
  自绘面板永远拿不到它。
- **iframe 只在 Forge 可达后才挂载**：指向死端口的 iframe 会渲染浏览器自带的错误页，
  看起来像插件坏了；启动期间显示提示，就绪后再挂载并可以点「刷新」重载文档。
- **日志只有插件自己 spawn 的进程才有**：Forge 没有日志接口，`stdout`/`stderr` 是唯一来源，
  而一个手写 `print` 到重定向文件的做法要改 Forge 源码。所以用绘世启动器起的实例，插件
  看不到它的控制台 —— 界面上也直说了。
- **日志游标是绝对值**：`/log?since=N` 里 `seq` 是「本实例开始记录以来的总行数」，
  前端存一个游标追加新行即可。环形窗口会从头部裁剪，所以窗口首行的绝对位置单独记在
  `logBase` 里，否则裁剪后会跳行或重行。
- **清空只清当前实例的窗口和文件**：服务器还在往 stdout 写，清空后新行照常进入。
- **ANSI 与 tqdm 的 `\r`**：tqdm 用 `\r` 原地重绘，并把 `ESC[A` 放在那个 CR **之后**，
  所以必须「先按 CR/LF 切分、再对每段剥 ANSI」，反过来的顺序会让 `ESC[A` 变成独立一行。
  读旧文件时也会再剥一次，因为旧实例写入的行可能来自更早的规则。
- **`PYTHONIOENCODING=utf-8` 是必需的**：Python 的 stdout 接管道时默认用控制台代码页
  （这台机器是 gbk），tqdm 的进度方块 `█` 会被写成 U+FFFD 替换字符，日志里全是 `����`。
  启动时同时设置 `PYTHONUTF8=1`，让解释器自身的默认编码也是 UTF-8。
  启动器自己拉的旧实例写坏的历史行，读取时会按进度条宽度和百分比重建（`repairLegacyBar`）。
- **manifest 缓存**：`clientModules` 每个包的 `package.json` 只读一次并缓存，且
  `reconcilePackage` 对同一个 loader source 直接短路返回，**重载插件不会重读 manifest**。
  改了 `dsh.client` / `dsh.bundle` 必须**重启应用**才会重新组合。
