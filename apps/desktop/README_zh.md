# SilverMoon · 光影媒体库

<div align="center">

**全媒体管理应用** —— 在一个桌面应用里浏览、整理与播放 **图片、视频、音乐、电子书（EPUB/PDF）**，并内置 Pixiv、在线小说、在线番剧三大在线源。

[简体中文](README_zh.md) ｜ [English](README.md)

当前版本 **v0.1.1**

</div>

SilverMoon（中文名**银月**）基于 **Electron 44 + Vue 3 + TypeScript + Material Design 3**，后端是**独立的 Rust sidecar 进程**（通过 HTTP + SSE 与宿主通信）：一套 Web 前端 + Rust 后端，数据全部留在本地，无云同步、不强制账号。

> 中文名「银月」只用于项目与文档的描述；**软件界面内一律显示英文名 SilverMoon**（窗口标题、启动屏、安装快捷方式等）。

> **本项目由 [LumiLuna](https://github.com/Flygeon/LumiLuna-Next)（Tauri 2）迁到 Electron，再迁回 Tauri 2，最后于 2026-10 再次迁回 Electron。** 每次迁移都是「换壳不换芯」：Vue 前端与 Rust 后端的业务代码基本原样保留，只替换宿主层。当前架构的权威描述见 [`doc/AGENTS.md`](doc/AGENTS.md)；上一轮迁回 Tauri 的过程记录在 [`doc/TAURI-MIGRATION.md`](doc/TAURI-MIGRATION.md)（历史文档）。

音乐播放器采用 **类 Apple Music 样式** —— 流体动态背景、封面驱动取色、逐字卡拉 OK 歌词；整个应用严格遵循 **Material Design 3** 设计系统。

## ✨ 功能特性

### 🗂️ 本地媒体库

- 图片 / 视频 / 音乐 / 电子书（EPUB、PDF）四类媒体统一管理，递归扫描目录 + SQLite（WAL）索引
- 音频标签（lofty）、EXIF 取向、图片与视频缩略图缓存
- 文件夹浏览、收藏、历史记录、回收站（可恢复）
- Windows 自定义无边框标题栏 + 托盘 + 全局热键

### 🎵 音乐播放器

- **类 Apple Music 播放器**：流体动态背景、封面驱动取色、逐字卡拉 OK 歌词
- **逐字歌词**：QQ 音乐 QRC / 酷狗 KRC 官方时间轴，外加 Web Worker + FFT（谱通量）本地分析兜底
- **音效引擎**：10 段 EQ + 低音增强 + 混响 + 立体声宽度，预设可保存 / 导入导出 / 生成分享码（LLFX3 紧凑格式）
- **桌面歌词**：独立透明置顶窗口、鼠标穿透、4 种切换动画、位置记忆与锁定
- **SMTC（Windows 系统媒体控件）**：任务栏媒体浮层、媒体键（播放/暂停/切歌/拖动进度）、封面图
- **在线音乐**：网易云扫码 / 手机号登录（weapi / xeapi 全协议）、云盘与歌单；酷狗扫码 / 手机号登录、每日推荐与排行榜、每日签到（畅听 VIP + 概念版双签到）；另有实验性 Meting 聚合源
- 现在就听信息流（私人 FM / 每日推荐）、评论面板、听歌时长统计

### 📖 阅读器

- 内置 **EPUB / PDF** 阅读器：章节目录侧边栏、单页 / 双页 / 滚动模式
- 阅读进度 **自动保存与恢复**（CFI 精确定位，退出应用或关闭书籍时保存）
- 背景主题（dark / light / sepia / green）、正文字体、字号、行距、段距可调
- 在线小说同样复用完整阅读设置与分页排版

### 🌐 在线内容源

- **在线图片（Pixiv）** —— 登录、推荐 / 排行榜 / 搜索、作品详情与多页大图、评论、收藏、关注与关注流、ugoira 动图；图片经 Rust 代理取回并自动携带 `Referer`。默认关闭，需在设置中开启
- **在线小说** —— 文库（Wenku8）登录与在线书架、笔趣阁（BQG）源、在线阅读与阅读统计
- **在线番剧** —— 规则采集式聚合搜索与换源、热门番组主页、Bangumi 详情与追番同步；ArtPlayer 播放 + DanDanPlay 弹幕 + HLS

### 🎨 外观与扩展

- **Material Design 3** 设计系统：Monet 动态取色、浅色 / 深色 / 跟随系统
- **扩展框架（Extension Host）**：用户可自行开发与安装扩展。扩展自带引擎（子进程 + localhost HTTP）与前端（独立 `ext:` 协议加载），主项目零体积增加；声明式贡献点覆盖窗口 / 热键 / 托盘 / 设置 / **皮肤**，支持懒加载、权限模型与版本区间校验
  - 皮肤已**改由扩展承载**：装皮肤 = 装一个声明 `contributes.themes` 的扩展
  - 作者 SDK `packages/extension-api`；开发指南 `doc/扩展开发指南.md`；示例 `example/extensions/`
  - 首个参考扩展 **MiaoHui（妙绘）** 提供图片 / 视频索引 + OCR + ASR + 向量检索
- 音效预设市场：在线拉取社区预设，一键导入
- 🌍 中 / 英双语 i18n

## 🏗️ 架构

现在是**三个进程**：Electron 主进程、渲染进程、Rust 后端 sidecar。宿主与后端之间是一条**明文、可 curl** 的 HTTP 边界。

```
┌──────────────── Electron 主进程（Node，esbuild 打包）────────────────┐
│ 窗口 / 托盘 / 全局热键 / 文件对话框 / 系统默认程序                    │
│ app:// 前端产物   asset:// 本地文件（支持 Range）                     │
│ app-cover:// 在线封面代理（Referer 伪装 + 磁盘缓存 + 并发去重）       │
│ host-server: POST /_host ←── 后端反向调用（建窗口 / 托盘 / 热键）     │
└────────┬─────────────────────────────────────┬──────────────────────┘
         │ IPC（preload contextBridge）         │ POST /cmd、/batch
         │                                     │ SSE GET /events
┌────────▼──────────────┐            ┌─────────▼──────────────┐
│ 渲染进程（Vue 3）     │            │ 后端 sidecar（Rust）   │
│ src/ipc/ 原生能力层   │            │ backend/ 业务代码       │
└───────────────────────┘            └────────────────────────┘
```

> **迁移沿革**：Tauri 2（原名 LumiLuna） → Electron 44 → 迁回 Tauri 2 → **2026-10 再迁回 Electron**。
> 当前架构与约定的权威描述是 [`doc/AGENTS.md`](doc/AGENTS.md)；
> 上一轮迁回 Tauri 的过程记录在 [`doc/TAURI-MIGRATION.md`](doc/TAURI-MIGRATION.md)（**历史文档，不是当前架构**）。

**「换壳不换芯」是怎么做到的**：不改业务代码的**调用方式**，只替换**宿主层**。
`silvermoon-ipc` 契约层把宿主差异全部关在一处 —— 它复刻了 Tauri 的 `Builder` / `Host`（≈AppHandle）/
`State` / `Window` / `rt` 与几个宏，因此业务命令**一行都不用改**。

| 层 | 做法 | 业务代码改动量 |
|---|---|---|
| 前端 | `src/ipc/` 各模块**导出名与签名不变**，内部换成 `window.__SILVERMOON__` | `src/capabilities/` 与所有页面 / store **零改动** |
| 后端 | 保留 `crates/silvermoon-ipc` 契约层，`#[silvermoon_ipc::command]` 宏生成路由记录 | 业务逻辑零改动 |
| 新增 | `electron/`（宿主层）、`fqapi/`（番茄内容源 sidecar） | 宿主能力由 Node 主进程承担 |
| 数据 | 目录仍是 `<appData>/<identifier>`，首次启动自动从旧项目 `cn.cool.lumiluna` 整目录复制一次（只读旧目录） | —— |

### IPC 层覆盖面（实测）

| 项 | 数量 |
|---|---|
| `#[silvermoon_ipc::command]` 注册命令 | **181** |
| sidecar HTTP 路由 | `/health` `/cmd` `/batch` `/events` `/_host` |
| 前端 IPC 通道 | `sm:invoke` / `sm:invokeBatch` / `sm:call` / `sm:emit` |
| 自定义协议 | `app://` / `asset://` / `app-cover://`（`ext://` 待补，见下） |

### 设计取舍与行为约定

1. **鉴权**：两个 HTTP 服务都只绑 `127.0.0.1`，共用每次启动随机生成的 `X-SilverMoon-Token`。
   空令牌**拒绝**而非放行（调试需显式设 `SILVERMOON_ALLOW_NO_TOKEN=1`）。
2. **远程页命令白名单**：Pixiv / 文库8 / 番剧取流窗口的预加载跑在页面世界且 `contextIsolation: false`，
   它们能调用的命令被收敛到 `electron/ipc.ts` 的 `REMOTE_WINDOW_ALLOWED_COMMANDS`。
   **新增注入脚本调用必须同步加进这张表。**
3. **打包后 `panic = "abort"`**：sidecar 与 UI 分离，后端崩溃不会连带界面；
   但 release 仍启用 fat LTO + 单 codegen unit 压缩体积。
4. **内存诊断**：`bench` 走 Electron 的 `app.getAppMetrics()`，能拿到按进程的内存快照（Tauri 时代拿不到）。
5. **⚠️ `ext:` 协议尚未注册**：扩展 UI 用 `toAssetUrl(dir, "ext")` 生成 `ext://localhost/...`，
   但 `electron/protocols.ts` 只注册了 `app` / `asset` / `app-cover` 三个。
   当前症状：扩展 iframe 加载不出来。修法见 [`doc/AGENTS.md`](doc/AGENTS.md) 的 Gotchas。

## 🔗 参考项目

本项目的部分功能参考或移植自以下开源项目，感谢原作者的工作：

| 项目 | 用途 | 许可证 |
|---|---|---|
| [pixez-flutter](https://github.com/Notsfsssf/pixez-flutter) | Pixiv 登录、图片查看 | GPL-3.0 |
| [hikari_novel_flutter](https://github.com/15dd/hikari_novel_flutter) | 小说解析 | MIT |
| [Kazumi](https://github.com/Predidit/Kazumi) | 动漫解析 | GPL-3.0 |
| [LDDC](https://github.com/chenmozhijin/LDDC) | QQ 音乐 QRC 逐字歌词 | GPL-3.0-only |
| [md3Music](https://github.com/zzyoxml/md3Music) | 酷狗音乐 API（登录 / 音乐解析 / 每日签到） | AGPL-3.0 |

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/) 1.82+
- Windows 编译 Rust 后端需要 MSVC Build Tools（`link.exe`）；Linux 需要基础构建工具
  （清单见 `.github/workflows/build.yml` 的 `Install system dependencies`）

### 本地开发

```bash
npm install

# 先编一次 Rust 后端（产物：backend/target/debug/silvermoon[.exe]）
npm run build:backend

# 一条命令拉起 Vite dev server + Electron 主进程 watch + Electron
npm run dev
```

> 后端没编也能打开界面，只是数据相关操作会提示「后端未启动」—— 只调前端时很方便。

### 仅前端预览（浏览器 + mock 数据）

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

浏览器里没有 Electron 运行时，`src/capabilities` 会走内置 mock，界面可正常浏览。

### 验证

```bash
npm run lint                 # check-version + eslint
npm run format:check         # prettier
npm run typecheck            # vue-tsc + tsc（electron 主进程）
npm test                     # vitest
npm run verify:rust-pure     # 真实执行 Rust 纯逻辑（wasm，无需 MSVC）
npm run verify:mock-coverage # mock 与后端路由表漂移检查
npm run verify:m3-tokens     # 颜色令牌与 shared/m3-theme.ts 是否一致
npm run verify:settings-index # 设置项索引是否过期
npm run check:icon-font      # 图标字体子集是否与源码一致
```

> 没有装 MSVC（`link.exe`）也能验证一部分 Rust：`verify:rust-pure` 用 rustup 自带的
> `rust-lld` 把不带依赖的纯函数编成 wasm 并在 Node 里真跑断言。完整编译仍需 CI。
>
> ⚠️ CI 的 `lint` 是**顺序步骤**，前面任一失败会 skip 后面的 Rust 检查 ——
> **lint 红 ≠ Rust 已验证**，定位时先看停在哪一步。

### 打包构建

```bash
npm run build:backend:release    # release 版 Rust 后端（打包前必须先跑）
npm run build                    # 类型检查 + 前端产物 + Electron 主进程产物
npm run dist                     # electron-builder 打包
```

> **CI/CD（推荐）**：推送代码到 `main` 自动构建 Windows NSIS + Linux AppImage + macOS dmg
> （产物在 Actions Artifacts）；推送 `v*` Tag 自动创建 GitHub Release。无需本地配置 MSVC。

## 🧱 技术栈

| 领域 | 技术 |
|---|---|
| 桌面壳 | **Electron 44**（主进程 Node，esbuild 打包为单文件 `dist-electron/main.cjs`） |
| 后端 | **Rust**（独立 sidecar 进程，HTTP `POST /cmd` + SSE `GET /events`） |
| 前端 | **Vue 3 + Vite + TypeScript** |
| 状态管理 | **Pinia** |
| UI | **Material Design 3**（`@m3e/web` M3 Expressive + `@material/web` + 自定义组件） |
| 数据库 | **rusqlite**（SQLite，WAL） |
| 音频元数据 / 缩略图 | **lofty**、**image**、**kamadak-exif** |
| Windows 媒体控件 | **smtc-tokio** + **tiny_http**（SMTC） |
| 在线番剧播放 | **ArtPlayer** + **hls.js** + DanDanPlay 弹幕 |
| EPUB / PDF | **epub.js**、**pdf.js** |
| 网页解析 | **scraper**、**regex**、**roxmltree** |
| 网易云协议 | 纯 Rust weapi / eapi / xeapi 签名（AES-CBC/ECB、RSA、X25519 + AES-GCM） |
| 逐字时间轴分析 | Web Worker + FFT（谱通量）+ IndexedDB |
| 在线音乐聚合 | meting API |
| 番茄内容源 | 独立 sidecar（`fqapi/`，stdio 行分隔 JSON，reqwest 0.13 + rustls） |
| 国际化 | 自研轻量 i18n（`shared/i18n.ts`） |

## 📁 目录结构

```
electron/          # Electron 宿主层（主进程，24 个文件）
  main.ts          #   入口：启动顺序写死在文件顶部注释，不要随意调换
  ipc.ts           #   命令分发（sm:invoke）+ 远程页白名单 + 宿主 op
  sidecar.ts       #   拉起 Rust 后端，解析 SILVERMOON_READY 握手，转发命令 / 事件
  host-server.ts   #   POST /_host ← 后端反向调用（建窗口 / 托盘 / 热键 / 开文件）
  windows.ts       #   主窗口与子窗口创建（含 desktop-lyrics / extension 等）
  protocols.ts     #   app: / asset: / app-cover: 三个自定义协议
  preload.ts       #   contextBridge 暴露 window.__SILVERMOON__（唯一对外通道）
  webview-preload.ts # 远程页预加载（跑在页面世界，权限收紧在白名单里）
  tray.ts updater.ts store.ts fqapi.ts csp.ts perf.ts bench.ts log.ts
backend/           # Rust 业务后端（独立进程）
  silvermoon.config.json # 应用元信息（版本号单一真源，vite 与 Rust 双侧读取）
  src/
    lib.rs         #   启动编排 + 命令注册表（generate_handler!）
    main.rs        #   入口（含 panic 落盘钩子）
    app_meta.rs    #   应用元信息 + 首个启动的旧数据迁移
    tray.rs        #   系统托盘
    commands/
      scan.rs metadata.rs thumbnail.rs song.rs book.rs skin.rs stats.rs
      music_tags.rs#   musicTags 通道（lofty 读写音频标签 + 在线标签磁盘缓存）
      smtc.rs      #   Windows 系统媒体控件（SMTC）
      desktop.rs   #   壁纸 / 常亮锁 / 通知 / 强调色（UDA 跨桌面环境）
      extension.rs #   扩展框架（ext_* 命令，路由到扩展引擎的 localhost HTTP）
      ffmpeg.rs app.rs
    anime.rs netease.rs kugou.rs pixiv.rs novel.rs novel_auth.rs novel_bqg.rs
    osu.rs webdav.rs bilibili.rs media.rs error.rs
  crates/
    silvermoon-ipc/        # 契约层（Host / State / Window / tray / rt / server）
    silvermoon-ipc-macros/ # #[silvermoon_ipc::command] / generate_handler! / generate_context!
    silvermoon-bili/       # B 站协议层（WBI 签名 / 弹幕解析 / 归一化，纯逻辑无 IO）
  kugou_server/    # vendored：md3Music 的酷狗 Rust 服务端（AGPL-3.0）
fqapi/             # 番茄小说内容源 sidecar（独立进程，stdio 行 JSON）
splash/            # 原生启动器（Rust + Win32，MD3 自绘 splash）
  # 它是**父进程**：先出画面，再拉起 SilverMoon.exe 并传 --splash-pipe=<name>
src/ipc/           # 渲染进程的原生能力层（唯一允许接触 window.__SILVERMOON__ 的地方）
  bridge.ts        #   底层封装（invoke / 批量 / 过桥载荷降级）
  invoke.ts        #   后端命令调用 + 本地文件 URL（toAssetUrl）
  events.ts        #   listen / once / emit（含动态事件名 ext://<id>/<event>）
  window.ts        #   窗口句柄、创建、查询
  dragdrop.ts      #   文件拖放
  dpi.ts           #   逻辑坐标与物理像素
  paths.ts         #   应用目录与路径拼接（与 Rust 侧同源）
  app.ts           #   版本等应用元信息
  store.ts         #   JSON 键值存储（JsonStore → 主进程 electron/store.ts）
  dialog.ts        #   文件对话框与消息框
  fs.ts            #   文件读写
  opener.ts        #   交给系统打开 / 定位
  http.ts          #   带 CORS 豁免的 fetch（主进程网络栈）
src/               # Web 前端（业务逻辑跨宿主保留）
  capabilities/    # 统一原生能力接口（invoke 封装 + 浏览器 mock）
  features/        # 绘画（drawing）/ 创作（writing）工作台
  stores/          # Pinia 状态（library / player / settings / pixiv / anime / skins / audioEffects …）
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / BilibiliCard …
  views/           # 各 Tab 页 / 全屏播放器 / 桌面歌词 / 扩展宿主 / 设置
  composables/     # 组合式复用（useLazyCover / useDesktopChrome / useAmbilight …）
  workers/         # 逐字分析 Web Worker
  utils/           # 歌词时间轴 / 捉漫规则与取流 / 网易云 / 皮肤 / WebDAV / 音效 / hero 动画 …
  tokens/          # M3 设计令牌（theme.css、fonts.css；颜色段由脚本生成）
shared/            # 双端共享（m3-theme 配色内核 / types / i18n）
example/           # 示例扩展与皮肤
miaohui-extension/ # 参考扩展：图片视频索引 + OCR + ASR + 向量检索（MIT）
packages/extension-api/ # 扩展作者 SDK
doc/               # 文档：AGENTS.md（架构真源）/ SPEC.md / LOG.md / 各类方案书
scripts/           # 构建与校验脚本
src-tauri/         # ⚠️ Tauri 时代遗留树，CI 不参与构建，勿据此推断架构
archive/electron-host/ # 只读参考：上一轮迁移留下的归档
.github/workflows/ # GitHub Actions 自动构建（Windows / Linux / macOS）
```

## 🤝 贡献

欢迎提交 Issue 与 Pull Request！重大改动建议先通过 Issue 讨论。

## 📄 许可证

本项目采用 **GPL-3.0-only** 许可协议，完整文本见 [LICENSE](LICENSE)。

参考与移植的第三方项目：

- [pixez-flutter](https://github.com/Notsfsssf/pixez-flutter) —— Pixiv 登录、图片查看（© Notsfsssf，GPL-3.0）
- [hikari_novel_flutter](https://github.com/15dd/hikari_novel_flutter) —— 小说解析（© 15dd，MIT）
- [Kazumi](https://github.com/Predidit/Kazumi) —— 动漫解析（© Predidit，GPL-3.0）
- [LDDC](https://github.com/chenmozhijin/LDDC) —— QQ 音乐 QRC 逐字歌词模块移植自该项目（© 沉默の金，GPL-3.0-only）
- [md3Music](https://github.com/zzyoxml/md3Music) —— 酷狗音乐 API（登录 / 音乐解析 / 每日签到），其内嵌的 Rust 服务端已原样引入 `backend/kugou_server/`（© zzyoxml，AGPL-3.0）

> 各参考项目的许可条款适用于其对应代码；本项目的自有代码仍以 GPL-3.0-only 发布。
> 其中 `backend/kugou_server/` 为 md3Music 的 AGPL-3.0 代码，原样 vendored 并保留其
> [LICENSE](backend/kugou_server/LICENSE)。依 GPLv3 §13，AGPLv3 代码可与本项目组合，
> AGPL §13 的网络交互条款适用于该组合；如需在本项目中分发，请一并遵守 AGPL-3.0。
