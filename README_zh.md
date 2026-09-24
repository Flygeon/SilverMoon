# SilverMoon · 光影媒体库

<div align="center">

**全媒体管理应用** —— 在一个桌面应用里浏览、整理与播放 **图片、视频、音乐、电子书（EPUB/PDF）**，并内置 Pixiv、在线小说、在线番剧三大在线源。

[简体中文](README_zh.md) ｜ [English](README.md)

当前版本 **v1.2.1**

</div>

SilverMoon 基于 **Electron + Vue 3 + TypeScript + Material Design 3**，后端仍是原来的 **Rust** 原生进程：一套 Web 前端 + Rust 后端，数据全部留在本地，无云同步、不强制账号。

> **本项目是 [LumiLuna](https://github.com/Flygeon/LumiLuna-Next) 从 Tauri 2 迁移到 Electron 的重构版。** 迁移策略是「换壳不换芯」：Vue 前端与 Rust 后端的业务代码基本原样保留，只替换了宿主层。详见 [架构](#-架构)。

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
- **皮肤系统**：外部皮肤包（ZIP 资产 + 背景图 + 图标包 + CSS 注入）导入与固化，内置多款皮肤，示例见 `example/`
- **扩展框架（Extension Host）**：扩展以独立 sidecar 运行，主项目零体积增加；首个参考扩展 **MiaoHui（妙绘）** 提供图片 / 视频索引 + OCR + ASR + 向量检索
- 音效预设市场：在线拉取社区预设，一键导入
- 🌍 中 / 英双语 i18n

## 🏗️ 架构

迁到 Electron 后，进程拆成三块：

```
┌─────────────────────────── Electron 主进程（Node） ───────────────────────────┐
│ 窗口管理 / 托盘 / 全局热键 / 文件对话框 / 系统默认程序                          │
│ app:// 协议（承载前端产物）   asset:// 协议（本地文件代理，支持 Range）          │
│ 宿主 HTTP 服务（127.0.0.1:随机端口）←── Rust 侧车反向调用                       │
└───────┬───────────────────────────────────────────────────────────┬───────────┘
        │ IPC（preload contextBridge）                               │ HTTP /cmd + SSE /events
┌───────▼───────────────────────────────┐               ┌───────────▼───────────┐
│ 渲染进程（Vue 3 / 原前端）             │               │ Rust 侧车（原后端）    │
│ src/shims/ 顶替 @tauri-apps/*          │               │ src-tauri/ 业务码不动  │
└───────────────────────────────────────┘               └───────────────────────┘
```

**「最小化重构」是怎么做到的**：不在业务代码里改调用方式，而是在**依赖层**做替换。

| 层 | 做法 | 业务代码改动量 |
|---|---|---|
| 前端 | `vite.config.ts` 的 alias + `tsconfig.json` 的 `paths` 把 `@tauri-apps/*` 指向 `src/shims/` 下的等价实现 | **0 行** |
| Rust | `Cargo.toml` 里 `tauri` 依赖换成同名兼容 crate `src-tauri/crates/tauri-compat`，`#[tauri::command]`/`AppHandle`/`State`/`Emitter` 等 API 面逐个复刻 | 只有 `lib.rs` 去掉 6 行插件注册、`commands/extension.rs` 换 2 行 import |
| 数据 | 沿用 Tauri 的目录约定 `<appData>/<identifier>`，首次启动自动从旧项目 `cn.cool.lumiluna` 整目录复制一次（只读旧目录） | —— |

前端源码经逐文件比对，**136 个源文件中仅 14 个有差异，且全部是品牌串与构建配置**。

### 兼容层实现的 Tauri API 面（实测调用量）

| 项 | 数量 |
|---|---|
| `#[tauri::command]` 命令 | 154 |
| `tauri::AppHandle` 引用 | 190+ |
| `State<'_, T>` 注入 | 29 |
| `async_runtime::spawn_blocking` | 42 |
| `WebviewWindowBuilder` / `WebviewWindow` | 4 |
| `emit` / `emit_to` | 8 |
| tray / menu 构造点 | 1 |

### 与原 Tauri 的行为差异

1. **不再有插件机制**。`tauri-plugin-*` 的能力改由 Electron 主进程承担；其中 Rust 侧真正用到的 `opener` 与 `global-shortcut` 已在兼容层内重做，其余（dialog / fs / store / http）本就只在前端使用。
2. **`on_navigation` 的拦截时机**。Tauri 是同步拒绝；Electron 主进程无法同步跨进程询问 Rust，因此改为「先放行、Rust 判定不放行时执行 `stop()` 并回退到上一个已提交地址」。现有唯一调用点（Pixiv 登录回调拦截）行为一致。
3. **托盘可见性**。Electron 托盘没有「隐藏但保留」的 API，`set_visible` 退化为无操作（业务侧只调用过 `set_visible(true)`）。
4. **打包后 `panic` 不再 abort**。侧车是长期驻留进程，保留 unwind 语义可让单个命令的 panic 只影响当次调用。

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
- Windows 构建 Rust 侧车需要 MSVC Build Tools（`link.exe`）

### 本地开发

```bash
npm install

# 先构建 Rust 侧车（产物：src-tauri/target/debug/silvermoon[.exe]）
npm run build:backend

# 一条命令同时拉起 Vite dev server + Electron 主进程 watch + Electron
npm run dev
```

未构建侧车也能启动界面，但所有数据操作会返回「后端未启动」并弹出说明 —— 便于先调前端。

### 仅前端预览（浏览器 + mock 数据）

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

浏览器里 `window.__SILVERMOON__` 不存在，`src/capabilities` 会走内置 mock，界面可正常浏览。

### 打包构建

```bash
npm run build:backend:release    # 构建 release 版 Rust 侧车
npm run build                    # 类型检查 + 前端产物 + Electron 主进程产物
npm run dist                     # electron-builder 打包（Windows NSIS / Linux AppImage）
```

> **CI/CD（推荐）**：推送代码到 `main` 自动构建 Windows NSIS + Linux AppImage（产物在 Actions Artifacts）；推送 `v*` Tag 自动创建 GitHub Release。无需本地配置 MSVC。

## 🧱 技术栈

| 领域 | 技术 |
|---|---|
| 桌面壳 | **Electron 44**（主进程 Node） |
| 后端 | **Rust**（独立 sidecar 进程，HTTP + SSE 与前端通信） |
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
| 国际化 | 自研轻量 i18n（`shared/i18n.ts`） |

## 📁 目录结构

```
electron/          # Electron 主进程（迁移后新增）
  main.ts          #   启动编排：协议 → 宿主服务 → 侧车 → 主窗口
  sidecar.ts       #   拉起/守护 Rust 侧车，HTTP 命令 + SSE 事件
  host-server.ts   #   Rust → Electron 的反向调用入口（建窗 / eval / 托盘 / 热键 / 打开文件）
  windows.ts       #   窗口注册表、创建、关闭拦截、事件派发
  protocols.ts     #   app://（前端产物）与 asset://（本地文件代理，支持 Range）
  ipc.ts           #   渲染进程 → 主进程的能力分发（白名单通道）
  store.ts         #   plugin-store 的落盘实现
  tray.ts          #   系统托盘
  preload.ts       #   contextBridge 桥 + 拖放路径解析 + __TAURI_INTERNALS__ 注入
  webview-preload.ts # 远程页窗口专用（初始化脚本 + 最小 __TAURI__.core.invoke）
src/shims/         # @tauri-apps/* 的替身（迁移后新增）
  bridge.ts        #   与主进程通信的底层封装
  api/             #   core / event / window / webview / webviewWindow / dpi / path / app
  plugin-*.ts      #   store / dialog / fs / opener / http
src/               # Web 前端（迁移前原样保留）
  capabilities/    # 统一原生能力接口（invoke 封装 + 浏览器 mock）
  stores/          # Pinia 状态（library / player / settings / pixiv / anime / skins / audioEffects …）
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / PixivCard …
  views/           # 各 Tab 页 / 全屏播放器 / 桌面歌词 / 扩展宿主
  workers/         # 逐字分析 Web Worker
  utils/           # 歌词时间轴 / 动漫规则与取流 / 网易云 / 皮肤 / WebDAV / 音效 …
  tokens/          # M3 设计令牌（theme.css、fonts.css）
src-tauri/         # Rust 后端（原样保留）
  src/commands/    # 扫描 / 元数据 / 缩略图 / 书籍 / SMTC / 皮肤 / 扩展 / FFmpeg
  src/*.rs         # pixiv / novel / anime / netease / webdav / tray / media
  crates/          # 迁移后新增的兼容层
    tauri-compat/        # 同名 tauri 替身：API 面 + HTTP/SSE 服务 + 反向 RPC
    tauri-compat-macros/ # #[command] / generate_handler! / generate_context!
  silvermoon.config.json # 应用元信息（编译期与运行期共用的单一真源）
shared/            # 双端共享类型 / i18n
example/           # 示例皮肤
miaohui-extension/ # 参考扩展：图片视频索引 + OCR + ASR + 向量检索（MIT）
doc/               # 设计与方案文档
scripts/           # 构建脚本（dev 编排 / esbuild 打包 Electron）
.github/workflows/ # GitHub Actions 自动构建
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
- [md3Music](https://github.com/zzyoxml/md3Music) —— 酷狗音乐 API（登录 / 音乐解析 / 每日签到），其内嵌的 Rust 服务端已原样引入 `src-tauri/kugou_server/`（© zzyoxml，AGPL-3.0）

> 各参考项目的许可条款适用于其对应代码；本项目的自有代码仍以 GPL-3.0-only 发布。
> 其中 `src-tauri/kugou_server/` 为 md3Music 的 AGPL-3.0 代码，原样 vendored 并保留其
> [LICENSE](src-tauri/kugou_server/LICENSE)。依 GPLv3 §13，AGPLv3 代码可与本项目组合，
> AGPL §13 的网络交互条款适用于该组合；如需在本项目中分发，请一并遵守 AGPL-3.0。
