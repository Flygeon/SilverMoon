# AGENTS.md

## Project

**银月（SilverMoon）** — **Tauri 2 + Vue 3 + TypeScript** desktop media library app, with the backend written in Rust (SQLite, lofty, image processing) running **in the same process as the desktop shell**. Frontend uses Pinia, vue-router and Material Design 3.

The project lineage: Tauri 2 (originally `LumiLuna`) → Electron 44 → **back to Tauri 2**. See `README_zh.md` → 架构, and `doc/TAURI-MIGRATION.md` for what changed and what deliberately did not.

## Process model

```
┌────────────────────── Tauri 2 主程序（Rust，单进程）──────────────────────┐
│  窗口 / 托盘 / 全局热键 / 系统媒体控件（SMTC）                            │
│  154 条 `#[tauri::command]` 业务命令                                    │
│  app-cover:// 自定义协议（在线封面代理：绕 CORS + 防盗链 + 磁盘缓存）      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ @tauri-apps/api 的 invoke / listen
                      渲染进程（Vue 3，src/ipc/ 原生能力层）
```

- 渲染进程 → 宿主：`@tauri-apps/api/core` 的 `invoke`（命令）与 `@tauri-apps/api/event` 的 `listen`（事件）。
- 文件 / 对话框 / 网络 / 系统默认程序：Tauri 官方插件（`plugin-fs` / `plugin-dialog` / `plugin-http` / `plugin-opener` / `plugin-store` / `plugin-global-shortcut` / `plugin-updater`）。
- `src-tauri/src/commands/host.rs` 只保留插件覆盖不到、或必须与 Rust 侧目录口径一致的那几项（路径解析、版本号、退出、封面缓存、内存诊断、更新器门面）。

## Commands

```bash
# Frontend only (browser preview; all native capabilities fall back to mocks)
npm install && npm run dev:renderer   # Vite dev server on :1420

# Rust backend (needs MSVC on Windows / WebKitGTK deps on Linux — CI builds it otherwise)
npm run build:backend                 # cargo build --manifest-path src-tauri/Cargo.toml
npm run build:backend:release         # release build

# Full desktop app
npm run dev                           # tauri dev（自动拉起 Vite dev server）
npm run build                         # typecheck + renderer + tauri build
npm run dist                          # tauri build（打包安装包）

# Checks (all runnable locally)
npm run lint                          # eslint .
npm run format:check                  # prettier
npm run typecheck                     # vue-tsc --noEmit
npm test                              # vitest
npm run verify:rust-pure              # 真实执行 Rust 纯逻辑（wasm，绕开 MSVC 链接器）
npm run verify:mock-coverage          # mock 与后端路由表漂移
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets -- -D warnings   # 需要 MSVC / WebKitGTK 前置依赖
```

## Architecture

- `src-tauri/tauri.conf.json` — 应用配置（窗口、打包目标、`asset:` 协议范围、CSP）。**改了要用 `node_modules/@tauri-apps/cli/config.schema.json` 校验**（官方 schema）。
- `src-tauri/capabilities/*.json` — **按窗口**的权限清单（Tauri 2 的细粒度权限模型）。`default.json` 是主窗口，另有 `desktop-lyrics` / `extension` / `pixiv-login` / `wenku8-login` / `anime-webview` 五份。**新增窗口必须补一份**，否则该窗口的 IPC 全被拒；新增插件命令要在用到它的每个窗口里放行。
- `src-tauri/src/` — Rust 业务后端（命令、SQLite 库、扫描、元数据、在线源）。
  - `src-tauri/src/commands/host.rs` — 宿主能力（路径 / 版本 / 退出 / 封面缓存 / 诊断 / 更新器）。
  - `src-tauri/src/commands/music_tags.rs` — `musicTags` 通道（lofty 读写音频标签 + 在线标签磁盘缓存）。
  - `src-tauri/src/cover.rs` — `app-cover://` 协议（在线封面代理）。
  - `src-tauri/src/app_meta.rs` — 应用元信息 + 首个启动的旧数据迁移。
  - `src-tauri/silvermoon.config.json` — **single source of truth** for the app version (shared with `tauri.conf.json` and `scripts/check-version.mjs`).
- `src/ipc/` — **the single bridge between the renderer and the native layer** (`invoke` / `events` / `window` / `dragdrop` / `paths` / `app` / `store` / `dialog` / `fs` / `opener` / `http`). Business code imports from here directly; it must never import `@tauri-apps/*` itself (browser preview would break).
- `src/capabilities/index.ts` — higher-level facade over `src/ipc/`: wraps every backend command and provides a **browser mock** so `npm run dev:renderer` works without Tauri.
- `src/stores/` — Pinia stores: `library` (file cache + scan), `player` (audio playback + queue), `settings` (persisted via `JsonStore`).
- `src/tokens/theme.css` — M3 design tokens (CSS variables). Edit colors here, not in components.
- `archive/electron-host/` — **只读参考**：Electron 宿主层的完整快照（含 `electron/*`、splash 启动器、electron-builder 配置与相关脚本）。迁回 Tauri 后不再参与构建，但排查行为差异时可直接对照旧实现。

## Key Conventions

- **No emojis in UI** — Use Material Symbols Rounded icons only (class: `material-symbols-outlined`)
- **Path aliases**: `@` → `src/`, `@shared` → `shared/`
- **Icons font**: Google Fonts CDN (Chinese mirror `fonts.googleapis.cn`). CSS class `.material-symbols-outlined` maps to `Material Symbols Rounded` font family.
- **Music player**: FluidBackground uses 4-quadrant rotating canvas + `screen` blend + `blur(30px) saturate(2.5) brightness(0.5) scale(1.5)`. Magic numbers from Apple Music reference — do not change.
- **Lyric parser**: `parseLrc()` in `player.ts` supports dual-language (same-timestamp lines or `[tr:]` tags) + trailing-paren translations. `buildLyricSequence` (`src/utils/lyricTimeline.ts`) attaches a rough word-timeline (`units`) and — when `settings.detectInstrumental` is on — replaces leading credits (作词/作曲/编曲) with a 3-dot intro and inserts 3-dot interludes for long pauses. Plan: `逐字歌词策划书.md`.
- **Audio playback**: use `toAssetUrl()` from `src/ipc/invoke.ts` to convert a file path into an `asset:` URL (`convertFileSrc`). Audio element must be bound via `bindAudio()` then `initAudio()` called after mount.
- **Windows SMTC**: `commands/smtc.rs` registers the app as a system media session (Windows-only deps `smtc-tokio` + `tiny_http`, target-gated). Frontend pushes metadata via `capabilities.smtcSetMedia()` (local: `filePath`; online: `coverUrl`) and throttled state via `syncSmtc()` in the player store; OS media keys arrive as `smtc:command` events. Covers are served over `http://127.0.0.1` by a tiny_http thread — Windows' `RandomAccessStreamReference` does NOT accept `file://` URIs. Commands no-op on non-Windows.
- **Thumbnails**: Cached in `library.thumbCache`. Loaded via `loadThumbnails()` with 6-concurrent worker pool.
- **Settings persistence**: `settings.ts` uses `JsonStore` from `@/ipc/store` (backed by `tauri-plugin-store`). Auto-saves on any `watch()` change. Load on app start in `App.vue` `onMounted`.

## Gotchas

- **事件与命令的命名不要改**：Rust 侧 `app.emit("scan:progress", …)` 与前端 `listen("scan:progress", …)` 靠字符串对齐，改名不会报错、只会静默静默。
- **二进制过桥**：Tauri 2 的 invoke 原生支持 `Uint8Array`；`src/ipc/bridge.ts` 的 `toCloneablePayload()` 会**原样透传**它。不要把它转成 JSON 数组——写大文件时会膨胀数倍。
- **Map / Set 必须显式降级**：JSON 里没有原生表示，`toCloneablePayload()` 会把 Map 展开成普通对象、Set 展开成数组。musicTags store 的 `overrides` 就是 Map。
- **权限清单是按窗口的**：capabilities 用 `windows: [...]` 限定生效窗口。新增窗口（如新的子窗口）必须补一份 capability，否则该窗口里所有 IPC 都会被拒 —— 表现为「窗口能开，但界面全是 mock 行为/静默失败」。新增插件命令要加到**每个用到它的窗口**的清单里。
- **旧数据迁移**：数据目录仍是 `<appData>/<identifier>`。首次启动若新目录不存在而旧项目 `cn.cool.lumiluna` 存在，会自动整目录复制一次（只读旧目录）。逻辑在 `src-tauri/src/app_meta.rs`，且必须**早于**打开数据库。
- **封面代理是必需的**：酷狗 / 网易云 / QQ 图床都不返回 CORS 头且做防盗链，`<img>` 直连会失败。统一走 `toCoverProxyUrl()` → `app-cover://`（Rust 侧 `cover.rs`，带 256MB LRU 磁盘缓存 + 并发去重 + 负缓存）。
- **HTTP 响应要剥传输头**：Rust 侧 reqwest 已把 body 解压成明文，插件却把上游的 `content-length`（压缩后长度）原样透传；`src/ipc/http.ts` 会剥掉 `content-encoding` / `content-length` / `transfer-encoding`，否则调用方按错误长度截取。
- **命令错误以原始字符串 reject**：`[WENKU8_LOGIN_CANCELLED] …` 这类前缀判定依赖它，`invokeRaw()` 保证不把它包成 `Error`。
- `src/ipc/opener.ts` exports `openPath` (not `open`)
- Router uses `createWebHashHistory` — components are destroyed/recreated on route change. `keep-alive` is used in `App.vue` to preserve state (excludes PlayerView).
- `library.refresh(type)` caches by type. Call with `force=true` to bypass cache after scan.
- **Never pass Vue reactive state through the IPC bridge without `toCloneablePayload()`**: Tauri serialises to JSON, and a reactive Proxy plus `Map`/`Set` needs normalising first. `src/ipc/bridge.ts` runs every outbound payload through it, so new channels are covered — but a **shallow** spread is not enough. Regression tests: `src/ipc/__tests__/bridgeClone.test.ts`, `src/composables/__tests__/localTagIpcClone.test.ts`.
- **`titleBarStyle` / 无边框窗口**：主窗口 `decorations: false` 由 `tauri.conf.json` 声明，前端自绘标题栏靠 CSS `app-region: drag`；不要再引入 JS 拖拽窗口的实现（历史上因此出过 bug）。

## 在**没有 MSVC 链接器**的机器上验证 Rust

`cargo check / build / test` 需要宿主链接器（连 build script 都要），因此没装 VS Build Tools
的机器上跑不了。但有一条可用的旁路，**务必用它**：

```bash
rustup target add wasm32-unknown-unknown   # 一次性
npm run verify:rust-pure
```

`wasm32-unknown-unknown` 用 rustup 自带的 `rust-lld` 链接，不需要 MSVC。该脚本把
`src-tauri/src` 里**不带外部依赖的纯函数按原文抽出来**编成 wasm，在 Node 里真的跑断言
（函数改名会直接报错，不会静默失效）。

- **能覆盖**：封面 Referer 伪装、封面扩展名推断、路径规范化等纯逻辑。
- **不能覆盖**：任何带 build script 的 crate（`serde` 等传递依赖会拖进来），
  因此网络 / 数据库 / Tauri API 路径仍需 CI。
- 新增纯逻辑时，把它加进 `scripts/verify-rust-pure.mjs` 的 `TARGETS`。

另外 `cargo generate-lockfile` / `cargo fetch` **不需要链接器**，可用于验证依赖声明是否自洽。

## Build CI

GitHub Actions builds Windows (NSIS), Linux (AppImage) and macOS (dmg) in parallel with a `lint` job. Push to `main` triggers the build; pushing a `v*` tag creates a Release with the artifacts.

The `build` job deliberately does **not** declare `needs: lint`, so the slow Windows job starts immediately instead of waiting for lint.
