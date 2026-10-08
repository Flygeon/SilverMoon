# SilverMoon · 光影媒体库

<div align="center">

**本地优先的全媒体库** —— 桌面端与移动端共享同一套产品理念：把**图片、视频、音乐、电子书**留在本地，统一浏览、整理与播放。

[简体中文](README.md) ｜ [English](README_en.md)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Flygeon/SilverMoon)

</div>

SilverMoon（中文名**银月**）是一个 **monorepo**：桌面端是 **Tauri 2 + Vue 3 + TypeScript + Material Design 3**，业务后端是 **Rust**（与桌面壳同进程）；移动端是 **Flutter** 原生实现。数据全部留在本地，无云同步、不强制账号。

> 项目起源于 [LumiLuna](https://github.com/Flygeon/LumiLuna-Next)，经历 Tauri 2 → Electron → **迁回 Tauri 2**，并更名 SilverMoon；桌面端的业务逻辑（Vue 前端 + Rust 后端）在两次迁移中都基本原样保留。

## 🗂️ 仓库结构

| 路径 | 内容 | 技术栈 |
|---|---|---|
| [`apps/desktop/`](apps/desktop/) | 桌面端应用（Windows / Linux / macOS） | Tauri 2 + Vue 3 + TypeScript + Rust |
| [`apps/mobile/`](apps/mobile/) | 移动端应用（Android / iOS），音乐播放器为主 | Flutter 3.x（Dart） |
| [`apps/RNdesktop/`](apps/RNdesktop/) | 桌面端 **React Native 重构版**（Windows / macOS），**目前只有框架骨架** | React Native 0.83 + react-native-windows / react-native-macos |
| [`archive/electron-desktop/`](archive/electron-desktop/) | 桌面端更早一轮（切 Flutter 宿主未成）的源码快照 | 归档，只读参考 |
| [`archive/electron-host/`](archive/electron-host/) | 本轮迁回 Tauri 前的 Electron 宿主层快照 | 归档，只读参考 |
| [`docs/mobile-spec/`](docs/mobile-spec/) | 移动端技术规格（播放 / 歌词 / 桥调用清点） | 文档 |
| [`tools/`](tools/) | 跨端图标生成器（桌面 + 移动两套图标） | Python + Pillow |
| [`.github/workflows/`](.github/workflows/) | 桌面端与移动端的 CI（构建、静态检查、发版） | GitHub Actions |

桌面端自带一份更详细的说明：[中文](apps/desktop/README_zh.md) ｜ [English](apps/desktop/README.md)。

> `apps/RNdesktop/` 是桌面端的 **React Native 重构尝试**，当前**只搭了框架**
> （工程结构 / 主题 / 路由 / 宿主桥契约 / CI），所有页面都是显式标注「功能待填充」的占位屏，
> 也没有接入任何业务数据。说明见 [`apps/RNdesktop/README.md`](apps/RNdesktop/README.md)。

---

## 🖥️ 桌面端 · apps/desktop

**全媒体管理应用** —— 在一个桌面应用里浏览、整理与播放 **图片、视频、音乐、电子书（EPUB/PDF）**，并内置 Pixiv、在线小说、在线番剧、B 站视频等多个在线源。

### ✨ 功能特性

**🗂️ 本地媒体库**

- 图片 / 视频 / 音乐 / 电子书四类媒体统一管理，递归扫描目录 + SQLite（WAL）索引
- 音频标签（lofty）、EXIF 取向、图片与视频缩略图缓存（列表接口直出缓存路径，滚动时零额外命令）
- 文件夹浏览、收藏、历史记录、回收站（可恢复）
- Windows 自定义无边框标题栏 + 系统托盘 + 全局热键

**🎵 音乐播放器**

- **类 Apple Music 播放器**：流体动态背景、封面驱动取色、逐字卡拉 OK 歌词
- **逐字歌词**：QQ 音乐 QRC / 酷狗 KRC 官方时间轴，网易云 yrc / AMLL TTML，外加 Web Worker + FFT（谱通量）本地分析兜底
- **AMLL 逐字歌词源**：接入 AMLL TTML DB（社区维护的 Apple Music 风格逐字歌词库，自带翻译 / 音译 / 背景和声），默认排在回退链最前——AMLL → QQ 逐字 → 酷狗逐字 → Meting → 本地，基地址可换成社区镜像或自建
- **音效引擎**：10 段 EQ + 低音增强 + 混响 + 立体声宽度；预设可保存 / 导入导出 / 生成分享码（LLFX3）
- **桌面歌词**：独立透明置顶窗口、鼠标穿透、4 种切换动画、位置记忆与锁定
- **SMTC（Windows 系统媒体控件）**：任务栏媒体浮层、媒体键、封面图
- **在线音乐**：网易云（扫码 / 手机号登录，weapi / eapi / xeapi 全协议，云盘与歌单）、酷狗（扫码 / 手机号登录、每日推荐、排行榜、每日双签到）、实验性 Meting 聚合源
- 现在就听信息流、评论面板、听歌时长统计

**📖 阅读与写作**

- 内置 **EPUB / PDF** 阅读器：章节目录侧边栏、单页 / 双页 / 滚动模式、背景主题与排版可调
- 阅读进度自动保存与恢复（CFI 精确定位）
- **创作工作台**：Markdown 草稿列表 + 源码 / 预览双栏，marked + DOMPurify 渲染
- **绘画工作台**：图片页签下的画板，基于 leafer-editor（按需异步加载）

**🌐 在线内容源**（均默认关闭，在设置中开启）

- **在线图片（Pixiv）** —— 登录、推荐 / 排行榜 / 搜索、作品详情与多页大图、评论、收藏、关注流、ugoira 动图
- **在线小说** —— 文库（Wenku8）登录与在线书架、笔趣阁源、在线阅读与阅读统计
- **在线番剧** —— 规则采集式聚合搜索与换源、热门番组主页、Bangumi 详情与追番同步；ArtPlayer 播放 + DanDanPlay 弹幕 + HLS
- **B 站视频** —— 推荐流 / 搜索 / 扫码登录、视频详情与评论、UP 主页与投稿、历史与收藏、点赞投币收藏；取流走 **DASH + MSE** 自行合流，弹幕同番剧一套
- **B 站反诈与动态** —— 发评 / 发布动态后自动复查可见性（评论正常 / 仅自己可见 / 不可见分状态提示），动态流与发布，可选屏蔽带货动态与带货评论，视频详情页一键拉取 **AI 视频总结**与章节大纲

**🎨 外观与扩展**

- **Material Design 3** 设计系统：Monet 动态取色、浅色 / 深色 / 跟随系统
- **皮肤系统**：外部皮肤包（ZIP 资产 + 背景图 + 图标包 + CSS 注入）导入与固化，`--safe-mode` 逃生，示例见 [`apps/desktop/example/`](apps/desktop/example/)
- **扩展框架（Extension Host）**：扩展以独立子进程运行，主项目零体积增加；参考扩展 **MiaoHui（妙绘）** 提供图片 / 视频索引 + OCR + ASR + 向量检索
- 音效预设市场：在线拉取社区预设一键导入
- 百宝箱里的更多工具：文件夹、WebDAV、osu! 谱面下载、时长 / 阅读统计
- 🌍 中 / 英双语 i18n

### 🏗️ 架构

宿主与 Rust 后端同进程，前端只经一层 IPC：

```
┌────────────────────── Tauri 2 主程序（Rust，单进程）──────────────────────┐
│ 窗口管理 / 托盘 / 全局热键 / 系统媒体控件（SMTC）                          │
│ tauri:// 承载前端产物   asset: 协议（本地文件代理，原生支持 Range）         │
│ app-cover: 协议（在线封面代理：绕 CORS + 防盗链伪装 + 磁盘缓存）            │
│ 154 条 #[tauri::command] 商品命令                                        │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ @tauri-apps/api（invoke / listen）
┌───────────────────────────────▼─────────────────────────────────────────┐
│ 渲染进程（Vue 3）   src/ipc/ 原生能力层   src/ 业务代码                  │
└─────────────────────────────────────────────────────────────────────────┘
```

- **渲染进程 → 宿主**：`@tauri-apps/api` 的 `invoke`（命令）与 `listen`（事件），业务代码统一走 `src/ipc/`
- **文件 / 对话框 / 网络 / 系统默认程序**：Tauri 官方插件（`plugin-fs` / `plugin-dialog` / `plugin-http` / `plugin-opener` / `plugin-store`）
- **权限清单**：`src-tauri/capabilities/default.json` 逐项放行插件能力，缺一项就会在运行期被拒
- Rust 侧注册 **154 条 `#[tauri::command]`**；宿主与后端之间没有进程边界，也不再需要本地 HTTP / SSE 通道

> **迁移沿革**：Tauri 2（原名 LumiLuna） → Electron 44 → **迁回 Tauri 2**。详见
> [`apps/desktop/doc/TAURI-MIGRATION.md`](apps/desktop/doc/TAURI-MIGRATION.md)。

### 🚀 快速开始

环境要求：[Node.js](https://nodejs.org/) 20+、[Rust](https://www.rust-lang.org/) 1.82+；Windows 需要 MSVC Build Tools，Linux 需要 WebKitGTK 等 Tauri 前置依赖。

```bash
cd apps/desktop
npm install

# 一条命令拉起 Vite dev server + Tauri（自动编译 Rust 并开窗口）
npm run dev
```

仅前端预览（浏览器 + mock）：

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

打包：

```bash
npm run build                   # 类型检查 + 前端产物 + tauri build
npm run dist                    # tauri build 打包（Windows NSIS / Linux AppImage / macOS dmg）
```

### 🧱 技术栈

| 领域 | 技术 |
|---|---|
| 桌面壳 | Tauri 2（复用系统 WebView：WebView2 / WKWebView / WebKitGTK） |
| 前端 | Vue 3 + Vite + TypeScript + Pinia + vue-router |
| UI | Material Design 3（`@m3e/web` M3 Expressive + `@material/web`） |
| 后端 | Rust（与桌面壳同进程，`#[tauri::command]` 直接过桥） |
| 数据库 | rusqlite（SQLite，WAL） |
| 媒体处理 | lofty、image、kamadak-exif、FFmpeg（可选外部依赖） |
| Windows 媒体控件 | smtc-tokio + tiny_http |
| 在线番剧 / B 站 | ArtPlayer + hls.js + DASH(MSE) + DanDanPlay 弹幕 |
| EPUB / PDF | epub.js、pdf.js |
| 网页解析 | scraper、regex、roxmltree |
| 在线音乐协议 | 纯 Rust weapi / eapi / xeapi 签名；酷狗 API 经 vendored `kugou_server` |
| 逐字时间轴 | Web Worker + FFT（谱通量）+ IndexedDB |

依赖与构建的完整清单见 [`apps/desktop/README_zh.md`](apps/desktop/README_zh.md)。

---

## 📱 移动端 · apps/mobile

SilverMoon 的 Flutter 移动端实现（Android / iOS）。**以音乐播放器为核心**，另有图片 / 视频 / 书籍 / 设置共五个页签。

> 平台工程目录 `android/` 与 `ios/` **不入库**：开发机没有 Flutter SDK，改由 CI（或本地 `tool/bootstrap.sh`）用当前 Flutter 版本自带的模板现场生成，再覆盖 `tool/overlay/` 里的定制文件。这样 Gradle / AGP / Xcode 工程格式永远与 Flutter 版本对齐。

### ✨ 功能特性

- **本地曲库**：扫描 Android 常见音乐目录（可自定义），在 Isolate 里批量读标签（ID3 / VorbisComment / MP4 atom）并抽取内嵌封面
- **播放内核**：`just_audio` + `just_audio_background`（通知栏 / 锁屏控制）；队列语义与桌面端严格对齐（Fisher-Yates 随机、单曲循环、插播、倍速循环）
- **逐字歌词**：LRC / QRC / KRC（解密）/ yrc / TTML 解析 1:1 移植自桌面端；按 QQ → 酷狗 → Meting → 本地 的回退链取时间轴，内置间奏「三点」识别
- **音效**：设备硬件 EQ（`AndroidEqualizer`，10 段桌面参数就近映射到设备频段）+ 低音增强；混响与立体声宽度在移动端明确标注为不可用
- **在线音乐**：网易云（搜索 / 歌曲详情 / 歌词 / 歌单 / 排行榜 / 评论 / 扫码与手机号登录 / 云盘 / 我喜欢 / 每日推荐）、酷狗（搜索 / 取流 / 歌词 / 扫码与手机号登录 / 每日签到 / 歌单与排行榜）、Meting 聚合兜底；登录凭据只落在本机
- **外观**：Material 3 + Monet 动态取色（Android 12+），播放器页按封面取色（直方图量化），Apple Music 风格的迷你播放器与全屏播放页
- **本地媒体页签**：图片（网格 + 全屏缩放查看）、视频（基础播放 / 进度 / 倍速）、书籍（纯文本 .txt/.md 阅读器，非 UTF-8 会如实提示；EPUB / PDF 明确标注暂不支持）

### 🚀 本地开发与构建

```bash
cd apps/mobile
bash tool/bootstrap.sh      # 生成 android/ 与 ios/
flutter pub get
dart run flutter_launcher_icons
flutter run
```

CI（[`.github/workflows/mobile.yml`](.github/workflows/mobile.yml)，Flutter 3.47.5）在 push 到 `main` 时：

- Android：`flutter build apk --release --split-per-abi`（arm64-v8a / armeabi-v7a / x86_64）
- iOS：`flutter build ios --release --no-codesign` → 打成未签名 `.ipa`（可用 Sideloadly / AltStore 自签安装）
- 非 PR 构建自动发布为 prerelease（tag：`mobile-vN`）

移动端另有说明见 [`apps/mobile/README.md`](apps/mobile/README.md)；技术规格与实现细节见 [`docs/mobile-spec/`](docs/mobile-spec/)（其中 05 / 06 两份是 WebView 时代的历史文档，已标注废弃）。

---

## 🗄️ 归档 · archive/electron-desktop

[`archive/electron-desktop/`](archive/electron-desktop/) 与 [`archive/electron-host/`](archive/electron-host/) 是两轮宿主重构留下的**只读源码快照**：前者是更早一轮（切 Flutter 宿主，未成），后者是 **Electron 宿主层**（`electron/`、splash 启动器、electron-builder 配置与相关脚本）——本轮迁回 Tauri 2 后归档，仅作历史参考与行为对照。

## 🧰 文档与工具

- [`apps/desktop/doc/`](apps/desktop/doc/)：设计指南、皮肤系统方案、逐字歌词策划、后端迁移与性能评审等
- [`docs/mobile-spec/`](docs/mobile-spec/)：移动端播放 / 歌词技术规格与桥调用清点
- [`tools/make-icons.py`](tools/make-icons.py)：一张源图产出桌面（ICO / ICNS / PNG / 磁贴）与移动端（iOS 满幅、Android 自适应）全套图标
  ```bash
  python tools/make-icons.py            # 默认取 tools/app-icon-source.png
  ```
- [`apps/desktop/scripts/`](apps/desktop/scripts/)：dev 编排、esbuild 打包、图标与预处理、字体与弹簧曲线脚本

## 🔁 持续集成

| 工作流 | 触发 | 内容 |
|---|---|---|
| [`build.yml`](.github/workflows/build.yml) | push `main` / PR / `v*` tag | 桌面端：ESLint + Prettier + 类型检查 + 单测 + Rust fmt/clippy；Windows NSIS 与 Linux AppImage 并行构建；打 tag 时自动创建 Release |
| [`mobile.yml`](.github/workflows/mobile.yml) | `apps/mobile/**` 变更 / 手动 | 移动端：Android 分 ABI APK 与未签名 iOS IPA，并发布 prerelease |
| [`rndesktop.yml`](.github/workflows/rndesktop.yml) | `apps/RNdesktop/**` 变更 / 手动 | RN 桌面端：ESLint + Prettier + tsc + Jest；Windows MSIX 构建；macOS 为**手动触发**；`rndesktop-v*` tag 发 prerelease |

## 🙏 参考项目与许可

本项目采用 **GPL-3.0-only**，完整文本见 [`apps/desktop/LICENSE`](apps/desktop/LICENSE)。

部分功能参考或移植自以下开源项目，感谢原作者：

| 项目 | 用途 | 许可证 |
|---|---|---|
| [pixez-flutter](https://github.com/Notsfsssf/pixez-flutter) | Pixiv 登录、图片查看 | GPL-3.0 |
| [hikari_novel_flutter](https://github.com/15dd/hikari_novel_flutter) | 小说解析与登录 | MIT |
| [Kazumi](https://github.com/Predidit/Kazumi) | 番剧规则采集与播放 | GPL-3.0 |
| [LDDC](https://github.com/chenmozhijin/LDDC) | QQ 音乐 QRC 逐字歌词、酷狗 API 客户端 | GPL-3.0-only |
| [md3Music](https://github.com/zzyoxml/md3Music) | 酷狗音乐 API（登录 / 解析 / 签到），其内嵌 Rust 服务端原样引入 `apps/desktop/src-tauri/kugou_server/` | AGPL-3.0 |
| [PiliPlus](https://github.com/PiliPlus/PiliPlus) | B 站接口与 WBI 签名的移植参考 | GPL-3.0 |
| [api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) | 网易云 weapi / eapi / xeapi 签名与风控对策 | MIT |
| [MiaoHui](https://github.com/Kian0034/miaohui) | 参考扩展：图片视频索引 + OCR + ASR + 向量检索 | MIT |

> 各参考项目的许可条款适用于其对应代码；本项目的自有代码仍以 GPL-3.0-only 发布。
> 其中 `apps/desktop/src-tauri/kugou_server/` 为 md3Music 的 AGPL-3.0 代码，原样 vendored 并保留其
> [LICENSE](apps/desktop/src-tauri/kugou_server/LICENSE)。依 GPLv3 §13，AGPLv3 代码可与本项目组合，
> AGPL §13 的网络交互条款适用于该组合；如需分发，请一并遵守 AGPL-3.0。

## 🤝 贡献

欢迎提交 Issue 与 Pull Request！重大改动建议先通过 Issue 讨论。贡献者名单见 [`apps/desktop/CONTRIBUTORS.md`](apps/desktop/CONTRIBUTORS.md)。
