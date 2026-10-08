# SilverMoon · 光影媒体库

<div align="center">

**全媒体管理应用** —— 在一个桌面应用里浏览、整理与播放 **图片、视频、音乐、电子书（EPUB/PDF）**，并内置 Pixiv、在线小说、在线番剧三大在线源。

[简体中文](README_zh.md) ｜ [English](README.md)

当前版本 **v0.1.0**

</div>

SilverMoon（中文名**银月**）基于 **Tauri 2 + Vue 3 + TypeScript + Material Design 3**，后端是 **Rust** 原生进程（与桌面壳同进程）：一套 Web 前端 + Rust 后端，数据全部留在本地，无云同步、不强制账号。

> 中文名「银月」只用于项目与文档的描述；**软件界面内一律显示英文名 SilverMoon**（窗口标题、启动屏、安装快捷方式等）。

> **本项目由 [LumiLuna](https://github.com/Flygeon/LumiLuna-Next)（Tauri 2）迁到 Electron，再迁回 Tauri 2。** 两次迁移都是「换壳不换芯」：Vue 前端与 Rust 后端的业务代码基本原样保留，只替换宿主层。详见 [架构](#-架构) 与 [TAURI-MIGRATION.md](doc/TAURI-MIGRATION.md)。

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
- **扩展框架（Extension Host）**：扩展以独立子进程运行，主项目零体积增加；首个参考扩展 **MiaoHui（妙绘）** 提供图片 / 视频索引 + OCR + ASR + 向量检索
- 音效预设市场：在线拉取社区预设，一键导入
- 🌍 中 / 英双语 i18n

## 🏗️ 架构

现在是 **Tauri 2 单进程**：宿主与 Rust 后端合并成一个可执行文件。

```
┌────────────────────── Tauri 2 主程序（Rust，单进程）──────────────────────┐
│ 窗口管理 / 托盘 / 全局热键 / 系统媒体控件（SMTC）                          │
│ tauri:// 承载前端产物    asset: 协议（本地文件代理，原生支持 Range）        │
│ app-cover: 协议（在线封面代理：绕 CORS + 防盗链伪装 + 磁盘缓存）            │
│ 154 条 #[tauri::command] 业务命令                                        │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ @tauri-apps/api（invoke / listen）
┌───────────────────────────────▼─────────────────────────────────────────┐
│ 渲染进程（Vue 3）    src/ipc/ 原生能力层    src/ 业务代码                │
└─────────────────────────────────────────────────────────────────────────┘
```

> **迁移沿革**：Tauri 2（原名 LumiLuna） → Electron 44 → **迁回 Tauri 2**。
> 这次迁回的完整说明（改了什么、哪些行为有意不同、如何回滚）见
> [`doc/TAURI-MIGRATION.md`](doc/TAURI-MIGRATION.md)。

**「换壳不换芯」是怎么做到的**：不改业务代码的**调用方式**，只替换**宿主层**。
迁到 Electron 时留下的 `silvermoon-ipc` 兼容层把宿主差异全部关在一处，
因此这次迁回在 Rust 侧是一次**机械映射**，前端则只需重实现 `src/ipc/`。

| 层 | 做法 | 业务代码改动量 |
|---|---|---|
| 前端 | `src/ipc/` 各模块**导出名与签名不变**，内部换成 `@tauri-apps/*` | `src/capabilities/` 与所有页面 / store **零改动** |
| 后端 | 删除 `crates/silvermoon-ipc` 兼容层，业务代码里 `silvermoon_ipc::X` → `tauri::Y`（473 处，一对一） | 业务逻辑零改动 |
| 新增 | `src/cover.rs`（封面协议）、`src/commands/music_tags.rs`（lofty 写标签）、`src/commands/host.rs`（宿主命令） | 补回原先由 Node 主进程承担的能力 |
| 数据 | 目录仍是 `<appData>/<identifier>`，首次启动自动从旧项目 `cn.cool.lumiluna` 整目录复制一次（只读旧目录） | —— |

### IPC 层覆盖面（实测调用量）

| 项 | 数量 |
|---|---|
| `#[command]` 命令 | 154 |
| `Host`（应用句柄）引用 | 190+ |
| `State<'_, T>` 注入 | 29 |
| `rt::spawn_blocking` | 42 |
| `WindowBuilder` / `Window` | 4 |
| `emit` / `emit_to` | 8 |
| tray / menu 构造点 | 1 |

### 设计取舍与行为约定

1. **窗口导航拦截**：Tauri 的 `on_navigation` 可**同步**返回 `false` 直接拒绝导航，比 Electron 版「先放行、判定为否再回退」更直接。现存唯一调用点（Pixiv 登录回调）行为一致。
2. **打包后 `panic = "abort"`**：单进程模型下后端与 UI 同命运，因此恢复旧 Tauri 版的激进优化（fat LTO + 单 codegen unit + abort）。
3. **内存诊断口径变化**：Tauri 是「单进程 + 系统 WebView」，拿不到 Electron 那种按 Chromium 进程的内存快照。`metrics` 只回报本进程 RSS，并在返回值里带 `note` 显式标注口径；`bench` 相应退化为空报告。
4. **权限清单**：Tauri 2 用细粒度权限模型，主窗口的插件能力在 `src-tauri/capabilities/default.json` 里逐项放行。新增插件命令必须同步补权限，否则运行期被拒。

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
- Windows 需要 MSVC Build Tools（`link.exe`）；Linux 需要 WebKitGTK 等 Tauri 前置依赖
  （清单见 `.github/workflows/build.yml` 的 `Install system dependencies`）

### 本地开发

```bash
npm install

# 一条命令拉起 Vite dev server + Tauri（自动编译 Rust 并开窗口）
npm run dev
```

### 仅前端预览（浏览器 + mock 数据）

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

浏览器里没有 Tauri 运行时，`src/capabilities` 会走内置 mock，界面可正常浏览。

### 验证

```bash
npm run typecheck            # vue-tsc
npm test                     # vitest
npm run verify:rust-pure     # 真实执行 Rust 纯逻辑（wasm，无需 MSVC）
npm run verify:mock-coverage # mock 与后端路由表漂移检查
```

> 没有装 MSVC（`link.exe`）也能验证一部分 Rust：`verify:rust-pure` 用 rustup 自带的
> `rust-lld` 把不带依赖的纯函数编成 wasm 并在 Node 里真跑断言。完整编译仍需 CI。

### 打包构建

```bash
npm run build                    # 类型检查 + 前端产物 + tauri build
npm run dist                     # tauri build（只打包，不重复 typecheck）
```

> **CI/CD（推荐）**：推送代码到 `main` 自动构建 Windows NSIS + Linux AppImage + macOS dmg
> （产物在 Actions Artifacts）；推送 `v*` Tag 自动创建 GitHub Release。无需本地配置 MSVC。

## 🧱 技术栈

| 领域 | 技术 |
|---|---|
| 桌面壳 | **Tauri 2**（复用系统 WebView：WebView2 / WKWebView / WebKitGTK） |
| 后端 | **Rust**（与桌面壳同进程，`#[tauri::command]` 直接过桥） |
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
src-tauri/         # Tauri 2 主程序（Rust，宿主 + 业务后端同进程）
  tauri.conf.json  #   应用配置（窗口 / 打包目标 / asset: 协议 / CSP）
  capabilities/    #   主窗口的细粒度权限清单（新增插件命令必须在此放行）
  silvermoon.config.json # 应用元信息（版本号单一真源）
  src/
    lib.rs         #   启动编排：注册协议 → 迁移旧数据 → 打开数据库 → 托盘 / 扩展 / 在线源
    main.rs        #   入口（含 panic 落盘钩子）
    cover.rs       #   app-cover: 协议（在线封面代理：绕 CORS + 防盗链 + LRU 磁盘缓存）
    app_meta.rs    #   应用元信息 + 首个启动的旧数据迁移
    tray.rs        #   系统托盘（菜单结构由 Rust 构造）
    commands/
      host.rs      #   宿主能力：路径 / 版本 / 退出 / 封面缓存 / 内存诊断 / 更新器
      music_tags.rs#   musicTags 通道（lofty 读写音频标签 + 在线标签磁盘缓存）
      scan.rs metadata.rs thumbnail.rs song.rs book.rs skin.rs stats.rs
      smtc.rs      #   Windows 系统媒体控件（SMTC）
      desktop.rs   #   壁纸 / 常亮锁 / 通知 / 强调色（UDA 跨桌面环境）
      extension.rs #   扩展框架
      ffmpeg.rs app.rs
    anime.rs netease.rs kugou.rs pixiv.rs novel.rs novel_auth.rs novel_bqg.rs
    osu.rs webdav.rs bilibili.rs media.rs error.rs
  crates/
    silvermoon-bili/ # B 站协议层（WBI 签名 / 弹幕解析 / 归一化，纯逻辑无 IO）
src/ipc/           # 渲染进程的原生能力层（唯一允许接触 @tauri-apps/* 的地方）
  bridge.ts        #   底层封装（invoke / 批量 / 过桥载荷降级）
  invoke.ts        #   后端命令调用 + 本地文件 URL（toAssetUrl）
  events.ts        #   listen / once / emit / emitTo
  window.ts        #   窗口句柄、创建、查询（AppWindow / getCurrentWindow / createWindow）
  dragdrop.ts      #   文件拖放（Tauri 原生提供磁盘路径）
  dpi.ts           #   逻辑坐标与物理像素（再导出 Tauri 的几何类）
  paths.ts         #   应用目录与路径拼接（与 Rust 侧同源）
  app.ts           #   版本等应用元信息
  store.ts         #   JSON 键值存储（JsonStore → plugin-store）
  dialog.ts        #   文件对话框与消息框（plugin-dialog）
  fs.ts            #   文件读写（plugin-fs）
  opener.ts        #   交给系统打开 / 定位（plugin-opener）
  http.ts          #   带 CORS 豁免的 fetch（plugin-http，Rust 网络栈）
src/               # Web 前端（业务逻辑原样保留）
  capabilities/    # 统一原生能力接口（invoke 封装 + 浏览器 mock）
  stores/          # Pinia 状态（library / player / settings / pixiv / anime / skins / audioEffects …）
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / PixivCard …
  views/           # 各 Tab 页 / 全屏播放器 / 桌面歌词 / 扩展宿主
  workers/         # 逐字分析 Web Worker
  utils/           # 歌词时间轴 / 动漫规则与取流 / 网易云 / 皮肤 / WebDAV / 音效 …
  tokens/          # M3 设计令牌（theme.css、fonts.css）
shared/            # 双端共享类型 / i18n
example/           # 示例皮肤
miaohui-extension/ # 参考扩展：图片视频索引 + OCR + ASR + 向量检索（MIT）
doc/               # 设计与方案文档（含 TAURI-MIGRATION.md）
scripts/           # 构建与校验脚本
archive/electron-host/ # 只读参考：Electron 宿主层快照（不再参与构建）
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
- [md3Music](https://github.com/zzyoxml/md3Music) —— 酷狗音乐 API（登录 / 音乐解析 / 每日签到），其内嵌的 Rust 服务端已原样引入 `src-tauri/kugou_server/`（© zzyoxml，AGPL-3.0）

> 各参考项目的许可条款适用于其对应代码；本项目的自有代码仍以 GPL-3.0-only 发布。
> 其中 `src-tauri/kugou_server/` 为 md3Music 的 AGPL-3.0 代码，原样 vendored 并保留其
> [LICENSE](src-tauri/kugou_server/LICENSE)。依 GPLv3 §13，AGPLv3 代码可与本项目组合，
> AGPL §13 的网络交互条款适用于该组合；如需在本项目中分发，请一并遵守 AGPL-3.0。
