# AGENTS.md

> **最后核对：2026-10-17，v0.1.1。** 本文件每轮会作为「Additional instructions」自动注入，
> **写错会直接误导接手的 AI**。改动前先按下面「如何核对」一节验证，不要凭印象改。
>
> **如何核对**：架构看 `apps/desktop/package.json` 的 `main` 与 `.github/workflows/build.yml`
> 的 `--manifest-path`；命令数看 `backend/src/lib.rs` 的 `generate_handler![...]`；
> 目录行为看实际 `ls`。**怀疑本文件与代码冲突时，以代码与 CI 为准，并回来修本文件。**
>
> **文档三层**：本文件（项目现在是什么）→ [`SPEC.md`](SPEC.md)（应该成为什么、验收标准）
> → [`LOG.md`](LOG.md)（怎么一步步变成现在这样、决策原因）。对外变化看
> [`../CHANGELOG.md`](../CHANGELOG.md)。

## Project

**银月（SilverMoon）** — 本地优先的**全媒体库**桌面应用：图片 / 视频 / 音乐 / 小说 / 绘画 /
书籍 / 番剧，数据全部留在本地，无云同步、不强制账号。

技术栈：**Electron 44 + Vue 3 + TypeScript + Material Design 3**，业务后端是**独立的 Rust
sidecar 进程**（SQLite / lofty / 图像处理 / 在线源协议）。

宿主沿革：Tauri 2（原名 LumiLuna）→ Electron 44 → 迁回 Tauri 2 → **2026-10 再迁回 Electron**。
两次迁移都是「换壳不换芯」：业务代码几乎没动，只换宿主层。`silvermoon-ipc` 契约层就是
为此存在（`silvermoon_ipc::command` 宏让 185 条业务命令一行都不用改）。

## Process model

**三进程**，宿主与后端之间是一条明文、可 curl 的 HTTP 边界：

```
┌──────────────── Electron 主进程（Node）───────────────┐
│ 窗口 / 托盘 / 全局热键 / 对话框 / 默认程序             │
│ app:// 前端产物   asset:// 本地文件（支持 Range）      │
│ app-cover:// 在线封面代理（Referer 伪装 + 磁盘缓存）   │
│ host-server: POST /_host ←── 后端反向调用（建窗口/托盘）│
└──────┬──────────────────────────────────┬─────────────┘
       │ IPC（preload contextBridge）      │ POST /cmd、/batch
       │                                  │ SSE GET /events
┌──────▼──────────────┐        ┌──────────▼──────────────┐
│ 渲染进程（Vue 3）   │        │ 后端 sidecar（Rust）     │
│ src/ipc/ 原生能力层 │        │ backend/ 业务代码         │
└─────────────────────┘        └─────────────────────────┘
```

- **渲染进程 → 主进程**：`electron/preload.ts` 经 `contextBridge` 暴露 `window.__SILVERMOON__`，
  通道只有 `sm:invoke` / `sm:invokeBatch` / `sm:call` / `sm:emit`（白名单式）。
- **主进程 → 后端**：`electron/sidecar.ts` spawn 可执行文件，从 stdout 解析
  `SILVERMOON_READY {"port":N}` 握手，之后转发命令与事件。
- **后端 → 主进程**：`electron/host-server.ts` 的 `POST /_host`，用于建窗口、托盘、热键、开文件。
- 两个 HTTP 服务都只绑 `127.0.0.1`，共用 `X-SilverMoon-Token` 请求头（每次启动随机生成）。
- **splash 启动器**（`splash/`，Rust + Win32）是**父进程**：先出画面，再拉起 `SilverMoon.exe`
  并传 `--splash-pipe=<name>`。因此 NSIS 快捷方式指向 `silvermoon-splash.exe`（见
  `build/installer.nsh`）。`npm run dev` **不启** splash。
- **第二个 sidecar**：`fqapi/`（番茄小说内容源）独立进程，stdio 行分隔 JSON、零端口，
  握手行 `FQAPI_READY {...}`。宿主侧管理在 `electron/fqapi.ts`（懒启动）。

## Commands

```bash
# 开发（Vite :1420 + esbuild watch + Electron，三件事由 30 行原生代码串起来）
npm run dev

# 仅前端预览（浏览器 + mock，无原生能力）
npm run dev:renderer

# Rust 后端（需要 MSVC；本机没有就走 CI）
npm run build:backend              # cargo build --manifest-path backend/Cargo.toml
npm run build:backend:release

# 打包
npm run build                      # typecheck + build:renderer + build:main
npm run dist                       # build + electron-builder（NSIS / AppImage / dmg）

# 本地能跑的校验（全部接入 CI）
npm run lint                       # check-version.mjs && eslint .
npm run format:check               # prettier（src / shared / scripts / electron）
npm run typecheck                  # vue-tsc --noEmit && tsc -p tsconfig.electron.json
npm test                           # vitest run
npm run verify:rust-pure           # wasm 旁路真实执行 Rust 纯逻辑（扩展启动策略 / 握手行 / 封面扩展名，见下）
npm run verify:mock-coverage       # mock 与后端路由表漂移
npm run verify:m3-tokens           # 颜色令牌与 shared/m3-theme.ts 是否一致
npm run verify:settings-index      # 设置项索引是否过期
npm run check:icon-font            # 图标字体子集是否与源码一致
```

## Architecture

- `electron/` — **Electron 宿主层**（24 个文件）。启动顺序写死在 `main.ts` 顶部注释：
  `registerSchemes()`（必须在 ready 前）→ 解析路径 + 迁移旧数据（决定 userData）→ ready →
  `handle*Protocol()` → `startHostServer()` → `registerIpc()` → `startSidecar()` 与
  `createMainWindow()` **并行**（界面不等后端就绪）。关键文件：
  `main.ts` / `ipc.ts`（命令分发 + 远程窗口白名单）/ `sidecar.ts` / `windows.ts` /
  `protocols.ts` / `host-server.ts` / `preload.ts` / `webview-preload.ts` / `tray.ts` /
  `updater.ts` / `store.ts` / `fqapi.ts` / `csp.ts`。
- `backend/` — **Rust 业务后端**（独立进程）。`src/lib.rs` 是启动编排与命令注册表
  （`generate_handler![...]`），`src/commands/` 是命令实现，其余按业务分文件
  （`anime` / `bilibili` / `kugou` / `netease` / `novel*` / `pixiv` / `osu` / `webdav` / …）。
  - `backend/crates/silvermoon-ipc` — **契约层**（Host / State / 窗口 / 托盘 / 菜单 / rt / server）。
  - `backend/crates/silvermoon-ipc-macros` — `#[silvermoon_ipc::command]`、
    `generate_handler!`、`generate_context!`。**这两个 crate 是 path 依赖、不属于 workspace 成员**，
    `cargo fmt --manifest-path backend/Cargo.toml` 不会检查它们，CI 里单独各查一次。
  - `backend/silvermoon.config.json` — **版本号单一真源**（vite 与 Rust 两侧都读它）。
- `fqapi/` — 番茄内容源 sidecar（GPL-3.0，裁剪自 fqapp）。`sign` / `device` / `upstream` /
  `endpoints` 四个模块。**它的 reqwest 0.13 + rustls 与 backend 的 0.12 + native-tls 刻意隔离**
  （同一 crate 会出现两份 reqwest、TLS provider 只能选一个）。
- `src/ipc/` — **渲染进程与原生层之间的唯一通道**（`bridge` / `invoke` / `events` / `window` /
  `dragdrop` / `dpi` / `paths` / `app` / `store` / `dialog` / `fs` / `opener` / `http`）。
  业务代码只 import 这里，**不得直接碰 `window.__SILVERMOON__`**（浏览器预览会废）。
- `src/capabilities/index.ts` — `src/ipc/` 之上的门面：包好每条后端命令，并提供**浏览器 mock**。
- `src/stores/` — Pinia：`library` / `player` / `settings` / `pixiv` / `anime` / `skins` /
  `musicTags` / `bilibili` / `drawing` / `writing` / …。
- `src/m3e.ts` — `@m3e/web` 原生组件按需副作用注册（导入即 `customElements.define`）。
  **UI 一律用官方 `m3e-*` 组件**，不要手写「长得像 MD3」的原生元素。
- `src/tokens/theme.css` — M3 令牌。**颜色令牌段是生成的，禁止手改** —— 改
  `shared/m3-theme.ts` 后跑 `npm run gen:m3-tokens`。见 `doc/M3配色系统.md`。
- `src/views/settingsIndex.generated.ts` — **生成的**设置项索引，供设置搜索跳转，
  别手改；跑 `npm run gen:settings-index`。
- `shared/` — 双端共享（`m3-theme.ts` 配色内核、`types.ts`、`i18n.ts`）。
- `doc/` — 设计文档。**`doc/AGENTS.md` 就是本文件**；同目录还有 [`SPEC.md`](SPEC.md)
  （设计边界与验收标准）与 [`LOG.md`](LOG.md)（逐轮施工记录 + 决策原因）。
  `REWRITE_PROMPT_TAURI2.md` 是历史归档，**不要照着它建 Tauri 项目**；
  `TAURI-MIGRATION.md` 记录的是**上一轮**迁回 Tauri 的过程，也不是当前架构。
- ✅ `apps/desktop/src-tauri/`（Tauri 时代遗留树，192 文件 / 7.6MB）**已于 2026-10-22 整树删除**，
  连同 `check-version.mjs` 的「遗留副本」校验、`verify-capability-scopes.mjs`、`.gitignore`
  与 `eslint.config.js` 的对应规则一并清掉。要取回历史：`git show c9cee4b:apps/desktop/src-tauri/<path>`。
  **现在仓库里只有一棵 Rust 业务树（`backend/`）**；仍看到 `src-tauri` 字样时那是历史注释，
  不是可编译的代码。

## Key Conventions

- **UI 不用 emoji**，一律 Material Symbols Rounded（class `material-symbols-outlined`）。
  字体是**本地子集**（`src/assets/fonts/material-symbols-rounded.woff2`，约 86KB）；
  新增图标名后必须跑 `npm run fetch:icon-font` 重新生成子集，否则界面缺图标。
- 路径别名：`@` → `src/`，`@shared` → `shared/`。
- **本地文件 URL 一律走 `toAssetUrl()`**（`src/ipc/invoke.ts`），生成 `asset://localhost/<path>`。
  **在线封面一律走 `toCoverProxyUrl()` → `app-cover://`**（宿主补 Referer + 磁盘缓存 + 并发去重）。
- **FluidBackground 的魔法数字不要改**：4 象限旋转 canvas + `screen` 混合 +
  `blur(30px) saturate(2.5) brightness(0.5) scale(1.5)`（取自 Apple Music 参考）。
- **歌词**：`parseLrc()` / `buildLyricSequence()` 都在 `src/utils/lyricTimeline.ts`
  （不在 store 里）。支持同时间戳双语行、`[tr:]`、行尾括号译文；`detectInstrumental`
  开启时会把开头的作词/作曲/编曲替换成三点前奏、并为长停顿插入三点间奏。
- **音频**：`bindAudio()` 后调 `initAudio()`（在 mount 之后）。
- **设置持久化**：`settings.ts` 用 `JsonStore`（`src/ipc/store.ts` → `electron/store.ts`），
  整文件 JSON 落在应用数据目录。写盘是**显式** `save()`，主进程退出前有兜底落盘。
- **SMTC（Windows）**：`backend/src/commands/smtc.rs` 用 `smtc-tokio` 注册系统媒体会话，
  封面必须走 `http://127.0.0.1:<随机端口>`（`tiny_http` 线程提供）——
  `RandomAccessStreamReference::CreateFromUri` **不接受 `file://`**。非 Windows 下命令空转。
- **设置项文案/索引**：`SettingsView.vue` 的结构决定索引，加设置项后跑
  `npm run gen:settings-index`，否则设置搜索搜不到。

## Gotchas

- **事件名不能改**：Rust 侧 `emit("scan:progress", …)` 与前端 `listen(...)` 靠字符串对齐，
  改名不报错、只静默失效。扩展事件是 `ext://<id>/<event>`。
- **`capabilities/*.json` 已经失效** —— 那是 Tauri 2 按窗口的权限模型。迁回 Electron 后
  权限在 `electron/ipc.ts` 的通道白名单与 `isTrustedRenderer()` 里。**新增窗口不需要
  capabilities**，但要在 `windows.ts` 里创建、并确认它属于可信来源。
- **远程页窗口只允许白名单命令**：Pixiv / 文库8 / 番剧取流窗口的预加载跑在**页面世界**且
  `contextIsolation: false`，`electron/ipc.ts` 的 `REMOTE_WINDOW_ALLOWED_COMMANDS` 是唯一的收敛点。
  **新增注入脚本调用必须同步加进这张表**（历史上漏掉 `wenku8_login_submit` 会让登录静默失效）。
- **`ext:` 协议（2026-10-22 已补齐）**：`ExtensionEmbed.vue` / `ExtensionHost.vue`
  用 `toAssetUrl(dir, "ext")` 生成 `ext://localhost/...`，对应 `electron/protocols.ts` 的
  `registerSchemes()` 第四个 scheme 与 `handleExtProtocol()`，根目录锁在
  `<app_data_dir>/extensions`（与 Rust 侧 `app_data_dir().join("extensions")` 同处）。
  - 路径判定是**安全边界**，抽在 `electron/extPathGuard.ts` 的 `extIsServable()`，
    由 `electron/__tests__/extProtocol.test.ts` 的 14 条用例守着（`..` 逃逸、
    `extensions-evil` 前缀混淆、大小写、反斜杠形态）。
  - ⚠️ **不要给 `ext:` 开 `corsEnabled` / `bypassCSP`**：它存在的意义就是用独立 origin
    隔离扩展 UI 与 `asset://`（否则扩展页与任意本地文件同源，能直接 fetch 本机任意文件），
    开了就白做。
  - ⚠️ `src/ipc/invoke.ts` 的 `toAssetUrl()` 幂等白名单必须含 `ext:`，否则已带协议的串
    会被二次包装成 `ext://localhost/ext%3A%2F%2F...`，iframe 白屏。
- **二进制过桥**：`invoke` 原生支持 `Uint8Array`，`toCloneablePayload()` 会原样透传 ——
  **不要转成 JSON 数组**（写大文件会膨胀数倍）。
- **Map / Set 必须显式降级**：JSON 没有原生表示，`toCloneablePayload()` 会把 Map 展开成对象、
  Set 展开成数组（`musicTags` 的 `overrides` 就是 Map）。
- **响应式 Proxy 不能直接过桥**：Electron 的 `ipcRenderer.invoke` 走结构化克隆，直接传 Vue
  Proxy 会抛 `DataCloneError`。新通道都在 `src/ipc/bridge.ts` 里统一降级，但**浅拷贝不够**。
  回归测试：`src/ipc/__tests__/bridgeClone.test.ts`。
- **封面代理是必需的**：酷狗 / 网易云 / QQ 图床都不返回 CORS 头且做防盗链，`<img>` 直连必失败。
- **HTTP 响应要剥传输头**：主进程的 `net.fetch` 已把 body 解压成明文，但上游的
  `content-length`（压缩后长度）会原样透传；`src/ipc/http.ts` 剥掉
  `content-encoding` / `content-length` / `transfer-encoding`，否则调用方按错误长度截取。
- **命令错误以原始字符串 reject**：`[WENKU8_LOGIN_CANCELLED] …` 这类前缀判定依赖它，
  `invokeRaw()` 保证不包成 `Error`。
- `src/ipc/opener.ts` 导出的是 `openPath`（不是 `open`）。
- **路由是 hash 模式**（`createWebHashHistory`），切页会销毁重建组件；`App.vue` 用
  `keep-alive` 保状态（排除 `PlayerView`）。
- `library.refresh(type)` 按类型缓存，扫描后要 `force=true` 才绕过。
- **无边框窗口**：主窗口的 `decorations: false` 来自 `backend/silvermoon.config.json` 的
  `window.decorations`，由 `electron/windows.ts` 读成 BrowserWindow 的 `frame`；前端自绘
  标题栏靠 CSS `app-region: drag`。**不要再引入 JS 拖拽窗口的实现**（历史上因此出过 bug）。
- **`electron-builder.yml` 的 `extraResources` 只在平台级写**，顶层一律不写：顶层与平台级
  同时出现同一个 `from → to` 会让 electron-builder 并发 copyfile，Windows 上必踩
  `EBUSY: resource busy or locked`，NSIS 整步失败。
- **只保留两个语言包**（`electronLanguages: zh-CN / en-US`）：Electron 自带 55 个
  `locales/*.pak`，实测 48.3MB，而界面只有中英。
- **taglib-wasm 必须在 asar 之外**（`asarUnpack`）：WASI 后端要用真实文件系统打开 `.wasm`。
- **旧数据迁移**：数据目录是 `<appData>/<identifier>`（`cn.cool.silvermoon`）；首次启动若旧
  项目目录 `cn.cool.lumiluna` 存在，会整目录复制一次（只读旧目录）。逻辑在
  `backend/src/app_meta.rs`，**必须早于打开数据库**。

## 在**没有 MSVC 链接器**的机器上验证 Rust

本机装不了 `cargo check / build / test`（连 build script 都要链接器）。可用的旁路：

```bash
rustup target add wasm32-unknown-unknown   # 一次性
npm run verify:rust-pure
```

`wasm32-unknown-unknown` 用 rustup 自带的 `rust-lld` 链接。脚本把 `backend/src` 里
**不带外部依赖的纯函数按原文抽出来**编成 wasm，在 Node 里真跑断言（改名会直接报错，
不会静默失效）。新增纯逻辑时把它加进 `scripts/verify-rust-pure.mjs` 的 `TARGETS`。

- **能覆盖**：`TARGETS` 里当前这 3 项 —— 扩展启动策略（`wants_startup`）、引擎握手行解析
  （`parse_ready_line`）、封面扩展名推断（`cover_ext`）。**不是「Rust 纯逻辑都能覆盖」**：
  只收 `backend/src` 里**确实存在**且不带外部依赖的函数，加一项就得实际跑通一次。
- **不能覆盖**：任何带 build script 的 crate（`serde` 等会拖进来），网络 / 数据库 /
  宿主 API 路径仍必须走 CI。
- **只认 `backend/src`**：Tauri 时代的 `src-tauri/src/`（`cover.rs` / `ext_protocol.rs` /
  `commands/host.rs`）迁回 Electron 后从未搬回来，**不能当目标** —— `extractFn()` 直读源文件，
  路径不存在会让脚本一上来就 ENOENT，一条断言都跑不到。
- `cargo generate-lockfile` / `cargo fetch` **不需要链接器**，可用于验证依赖声明是否自洽。

## Build CI

`.github/workflows/build.yml` 有四个 job：`lint`、`fqapi sidecar`（三平台 + 握手冒烟）、
`build`（Windows NSIS / Linux AppImage / macOS dmg 矩阵）、`release`（**仅 `v*` tag**）。

- `lint` 是**顺序步骤**：前端（ESLint / Prettier / typecheck / vitest / mock 漂移 /
  图标字体 / M3 token）全过才轮到 Rust（fmt × 4 处 → Clippy → 单测）。
  **前面任一失败会 skip 后面的** —— lint 红 ≠ Rust 已验证。
- `build` **刻意不写 `needs: lint`**，让最慢的 Windows 构建立即开跑。
- macOS 产物目录**不固定**（`mac` / `mac-arm64` / `mac-universal`），
  踩过：别人以为叫 `mac`，实际 runner 是 arm64。脚本里用 `find` 找 `SilverMoon.app`。
- 本机无链接器，Rust 编译只能由 CI 完成（约 20 分钟一轮）。**用户说「push 构建」= 推并
  关注 CI 结果**，不是只推上去。

## 版本号与提交

- **版本号分散在多处，单一真源是 `backend/silvermoon.config.json`**（vite 与 Rust 两侧都读它）。
  `node scripts/check-version.mjs`（挂在 `npm run lint` 里）实测校验 **6 处**：单一真源、
  `package.json`、`backend/Cargo.toml`、`backend/Cargo.lock`（可选）、
  `apps/desktop/README.md`、`apps/desktop/README_zh.md`。
  仓库根 `README.md` / `README_en.md` 也在清单里但**是可选的**（写了才校验），当前不含版本号。
  （`src-tauri/silvermoon.config.json` 那条「遗留副本」校验已随整树删除一并移除，
  所以处数从 7 降到 6。）
  **⚠️ 脚本不覆盖 `fqapi/`** —— `fqapi/Cargo.toml` 与 `fqapi/Cargo.lock` 要**手动**
  一起改，否则「关于」页版本与 fqapi 自报版本（它用 `env!("CARGO_PKG_VERSION")`）对不上。
- **禁止 `git add -A`**：仓库根常驻大量未跟踪的参考项目与 `.local/state` 里的敏感文件。
  一律显式列路径，提交前 `git diff --cached --name-only` 核对。
- 提交信息只写定位所需的要点；**决策原因写 LOG / CHANGELOG**，不堆在 commit body 里。
