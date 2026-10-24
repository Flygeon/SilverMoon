# SilverMoon · Media Library

<div align="center">

**An all-media manager** — browse, organize and play **images, videos, music and e-books (EPUB/PDF)** in a single desktop app, with Pixiv, online novels and online anime built in.

[简体中文](README_zh.md) ｜ [English](README.md)

Current version **v0.1.1**

</div>

SilverMoon is built on **Electron 44 + Vue 3 + TypeScript + Material Design 3**, with the backend written in **Rust** and running as a **standalone sidecar process** (HTTP + SSE): one web front end plus a Rust backend, all data kept local — no cloud sync, no mandatory account.

> **SilverMoon — Chinese name 「银月」.** [LumiLuna](https://github.com/Flygeon/LumiLuna-Next) (Tauri 2) was ported to Electron, then back to Tauri 2, and **in 2026-10 ported back to Electron again**. Every time the strategy was "swap the shell, keep the engine": the Vue front end and the Rust backend keep their business logic nearly untouched — only the host layer was replaced. For the current architecture see [`doc/AGENTS.md`](doc/AGENTS.md); the previous move back to Tauri is documented in [doc/TAURI-MIGRATION.md](doc/TAURI-MIGRATION.md) (historical).

The music player follows an **Apple Music–style** design — fluid animated background, cover-driven color extraction, word-by-word karaoke lyrics — and the whole app adheres to **Material Design 3**.

## ✨ Features

### 🗂️ Local media library

- Unified management of images / videos / music / e-books (EPUB, PDF), recursive directory scanning with a SQLite (WAL) index
- Audio tags (lofty), EXIF orientation, image and video thumbnail caching
- Folder browsing, favorites, play history, recycle bin (restorable)
- Custom frameless title bar on Windows, system tray, global hotkeys

### 🎵 Music player

- **Apple Music–style player**: fluid animated background, cover-driven color extraction, word-by-word karaoke lyrics
- **Word-by-word lyrics**: official timelines from QQ Music QRC / Kugou KRC, plus a Web Worker + FFT (spectral flux) local analysis fallback
- **Audio effects engine**: 10-band EQ + bass boost + reverb + stereo width; presets can be saved, imported/exported and shared as compact codes (LLFX3 format)
- **Desktop lyrics**: a separate transparent always-on-top window with mouse pass-through, 4 transition animations, position memory and lock
- **SMTC (Windows system media controls)**: taskbar media flyout, media keys (play/pause/next/prev/seek) and cover art
- **Online music**: NetEase Cloud Music (QR / phone login with the full weapi/xeapi protocol), cloud drive and playlists; Kugou (QR / phone login, daily recommendations, charts, daily check-in); plus an experimental Meting aggregator
- Listen Now feed (personal FM / daily recommendations), comment panel, listening-time statistics

### 📖 Readers

- Built-in **EPUB / PDF** reader: chapter sidebar, single-page / two-page / scrolling modes
- Reading progress **auto-saved and restored** (precise CFI positioning, saved on exit or book close)
- Adjustable background theme (dark / light / sepia / green), font family, size, line height and paragraph spacing
- Online novels reuse the same reading settings and pagination

### 🌐 Online sources

- **Online images (Pixiv)** — login, recommendations / ranking / search, artwork detail with multi-page images, comments, bookmarks, follows and follow feed, ugoira animations; images are fetched through a Rust proxy with the proper `Referer`. Disabled by default; enable it in settings
- **Online novels** — Wenku8 login and online bookshelf, BQG source, online reading with statistics
- **Online anime** — rule-based aggregated search and source switching, seasonal home page, Bangumi details and collection sync; playback via ArtPlayer + DanDanPlay danmaku + HLS

### 🎨 Appearance and extensions

- **Material Design 3**: Monet dynamic color, light / dark / follow-system
- **Extension framework (Extension Host)**: users can author and install their own extensions. Each ships its own engine (child process + localhost HTTP) and frontend (served over a dedicated `ext:` protocol), so the main project stays slim; declarative contributions cover windows / hotkeys / tray / settings / **skins**, with lazy activation, a permission model and API version gating
  - Skins are now **packaged as extensions**: installing a skin means installing an extension that declares `contributes.themes`; the settings page no longer hosts a skin library
  - Author SDK: `packages/extension-api`; guide: `doc/扩展开发指南.md`; examples: `example/extensions/`
  - First reference extension **MiaoHui** provides image/video indexing + OCR + ASR + vector search
- Audio preset marketplace: pull community presets online and import them in one click
- 🌍 Chinese / English i18n

## 🏗️ Architecture

The app is now **three processes**: the Electron main process, the renderer, and the Rust backend running as a **standalone sidecar**. Host and backend talk over a **plain-text, curl-friendly** HTTP boundary.

```
┌──────────────── Electron main process (Node, bundled) ────────────────┐
│ Windows / tray / global hotkeys / file dialogs / default apps        │
│ app:// serves the built front end   asset:// local files (Range)     │
│ app-cover:// online cover proxy (Referer spoof + disk cache)         │
│ host-server: POST /_host ←── reverse calls from the backend          │
└────────┬─────────────────────────────────────┬───────────────────────┘
         │ IPC (preload contextBridge)          │ POST /cmd, /batch
         │                                      │ SSE GET /events
┌────────▼──────────────┐            ┌──────────▼─────────────┐
│ Renderer (Vue 3)      │            │ Backend sidecar (Rust) │
│ src/ipc/ capability   │            │ backend/ business code │
└───────────────────────┘            └────────────────────────┘
```

> **Porting history**: Tauri 2 (originally LumiLuna) → Electron 44 → back to Tauri 2 → **back to Electron in 2026-10**.
> The authoritative description of the current architecture is [`doc/AGENTS.md`](doc/AGENTS.md);
> the previous move back to Tauri is written up in [doc/TAURI-MIGRATION.md](doc/TAURI-MIGRATION.md) (**historical**).

**How "swap the shell, keep the engine" was achieved**: business code keeps its **calling style**; only the **host layer** was replaced. The `silvermoon-ipc` contract layer keeps every host difference in one place — it mirrors Tauri's `Builder` / `Host` (≈AppHandle) / `State` / `Window` / `rt` plus a few macros, so the 190 business commands needed **zero** changes.

| Layer | Approach | Business-code changes |
|---|---|---|
| Front end | Every `src/ipc/` module keeps its **exported names and signatures**, swapping the internals for `window.__SILVERMOON__` | `src/capabilities/` and all views/stores: **untouched** |
| Rust | Keep the `crates/silvermoon-ipc` contract layer; the `#[silvermoon_ipc::command]` macro emits route records | Logic untouched |
| New modules | `electron/` (host layer), `fqapi/` (Tomato Novel sidecar) | Host abilities now live in the Node main process |
| Data | Directory stays `<appData>/<identifier>`; the first launch copies the whole legacy `cn.cool.lumiluna` directory once (read-only) | — |

### IPC layer coverage (measured)

| Item | Count |
|---|---|
| `#[silvermoon_ipc::command]` registrations | **190** |
| Sidecar HTTP routes | `/health` `/cmd` `/batch` `/events` `/_host` |
| Renderer IPC channels | `sm:invoke` / `sm:invokeBatch` / `sm:call` / `sm:emit` |
| Custom protocols | `app://` / `asset://` / `app-cover://` (`ext://` pending — see below) |

### Design decisions and behavioural notes

1. **Authentication**: both HTTP servers bind `127.0.0.1` only and share a fresh random `X-SilverMoon-Token` per launch. A missing token is **rejected**, not allowed (set `SILVERMOON_ALLOW_NO_TOKEN=1` to debug).
2. **Remote-page command whitelist**: the preloads for the Pixiv / Wenku8 / anime-stream windows run in the **page world** with `contextIsolation: false`, so the commands they may call are narrowed to `REMOTE_WINDOW_ALLOWED_COMMANDS` in `electron/ipc.ts`. **New injected calls must be added to that table.**
3. **`panic = "abort"` in release**: the sidecar is a separate process, so a backend crash no longer takes the UI with it; release builds still use fat LTO + a single codegen unit to shrink the binary.
4. **Memory diagnostics**: `bench` uses Electron's `app.getAppMetrics()`, which yields per-process snapshots (something the Tauri era could not produce).
5. **⚠️ The `ext:` protocol is not registered yet**: extension UIs build `ext://localhost/...` via `toAssetUrl(dir, "ext")`, but `electron/protocols.ts` only registers `app` / `asset` / `app-cover`. Symptom: extension iframes fail to load. See the Gotchas section of [`doc/AGENTS.md`](doc/AGENTS.md).

## 🔗 Reference projects

Parts of this project are inspired by or ported from the following open-source projects. Thanks to their authors:

| Project | Use | License |
|---|---|---|
| [pixez-flutter](https://github.com/Notsfsssf/pixez-flutter) | Pixiv login, image viewing | GPL-3.0 |
| [hikari_novel_flutter](https://github.com/15dd/hikari_novel_flutter) | Novel parsing | MIT |
| [Kazumi](https://github.com/Predidit/Kazumi) | Anime parsing | GPL-3.0 |
| [LDDC](https://github.com/chenmozhijin/LDDC) | QQ Music QRC word-by-word lyrics | GPL-3.0-only |
| [md3Music](https://github.com/zzyoxml/md3Music) | Kugou Music API (login / parsing / check-in) | AGPL-3.0 |

## 🚀 Getting started

### Requirements

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/) 1.82+
- On Windows, building the Rust backend needs MSVC Build Tools (`link.exe`); on Linux you need the base build toolchain (see `Install system dependencies` in `.github/workflows/build.yml`)

### Development

```bash
npm install

# Build the Rust backend once (output: backend/target/debug/silvermoon[.exe])
npm run build:backend

# One command starts the Vite dev server + Electron main watch + Electron
npm run dev
```

> The window opens even without a built backend; data operations then report "backend not started" — handy for front-end-only work.

### Front-end preview only (browser + mock data)

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

In a plain browser there is no Electron runtime, so `src/capabilities` falls back to its built-in mocks and the UI remains browsable.

### Checks

```bash
npm run lint                 # check-version + eslint
npm run format:check         # prettier
npm run typecheck            # vue-tsc + tsc (electron main)
npm test                     # vitest
npm run verify:rust-pure     # really executes pure Rust logic (wasm, no MSVC needed)
npm run verify:mock-coverage # mock vs backend route-table drift
npm run verify:m3-tokens     # colour tokens vs shared/m3-theme.ts
npm run verify:settings-index # settings index freshness
npm run check:icon-font      # icon font subset vs source
```

> ⚠️ CI's `lint` job runs its steps **sequentially** — any earlier failure skips the Rust checks.
> **A red lint job does not mean Rust was verified**; look at which step failed first.

### Packaging

```bash
npm run build:backend:release    # release Rust backend (required before packaging)
npm run build                    # Typecheck + renderer bundle + Electron main bundle
npm run dist                     # electron-builder (Windows NSIS / Linux AppImage / macOS dmg)
```

> **CI/CD (recommended)**: pushing to `main` builds Windows NSIS + Linux AppImage + macOS dmg
> automatically (artifacts under Actions Artifacts); pushing a `v*` tag creates a GitHub Release.
> No local MSVC setup required.

## 🧱 Tech stack

| Area | Technology |
|---|---|
| Desktop shell | **Electron 44** (main process in Node, bundled by esbuild into a single `dist-electron/main.cjs`) |
| Backend | **Rust** (standalone sidecar process, HTTP `POST /cmd` + SSE `GET /events`) |
| Front end | **Vue 3 + Vite + TypeScript** |
| State management | **Pinia** |
| UI | **Material Design 3** (`@m3e/web` M3 Expressive + `@material/web` + custom components) |
| Database | **rusqlite** (SQLite, WAL) |
| Audio metadata / thumbnails | **lofty**, **image**, **kamadak-exif** |
| Windows media controls | **smtc-tokio** + **tiny_http** (SMTC) |
| Anime playback | **ArtPlayer** + **hls.js** + DanDanPlay danmaku |
| EPUB / PDF | **epub.js**, **pdf.js** |
| Web scraping | **scraper**, **regex**, **roxmltree** |
| NetEase protocol | Pure-Rust weapi / eapi / xeapi signing (AES-CBC/ECB, RSA, X25519 + AES-GCM) |
| Word-by-word analysis | Web Worker + FFT (spectral flux) + IndexedDB |
| Online music aggregation | meting API |
| Tomato Novel source | Dedicated sidecar (`fqapi/`, line-delimited JSON over stdio, reqwest 0.13 + rustls) |
| i18n | Lightweight in-house i18n (`shared/i18n.ts`) |

## 📁 Project layout

```
electron/          # Electron host layer (main process, 24 files)
  main.ts          #   Entry point; boot order is documented at the top — don't reorder it
  ipc.ts           #   Command dispatch (sm:invoke) + remote-page whitelist + host ops
  sidecar.ts       #   Spawns the Rust backend, parses the SILVERMOON_READY handshake
  host-server.ts   #   POST /_host ← reverse calls from the backend (windows / tray / hotkeys)
  windows.ts       #   Main window and child windows (desktop-lyrics / extension / …)
  protocols.ts     #   The app: / asset: / app-cover: custom protocols
  preload.ts       #   Exposes window.__SILVERMOON__ via contextBridge (the only outward channel)
  webview-preload.ts # Remote-page preload (runs in the page world; narrowed by the whitelist)
  tray.ts updater.ts store.ts fqapi.ts csp.ts perf.ts bench.ts log.ts
backend/           # Rust business backend (standalone process)
  silvermoon.config.json # App metadata (single source of truth for the version, read by vite and Rust)
  src/
    lib.rs         #   Boot orchestration + command registry (generate_handler!)
    main.rs        #   Entry point (panic logging hook)
    app_meta.rs    #   App metadata + first-launch legacy data migration
    tray.rs        #   System tray
    commands/
      scan.rs metadata.rs thumbnail.rs song.rs book.rs skin.rs stats.rs
      music_tags.rs#   musicTags channel (lofty tag read-write + online tag disk cache)
      smtc.rs      #   Windows system media controls (SMTC)
      desktop.rs   #   Wallpaper / wakelock / notifications / accent colour (UDA)
      extension.rs #   Extension framework (ext_* commands, routed to the engine's localhost HTTP)
      ffmpeg.rs app.rs
    anime.rs netease.rs kugou.rs pixiv.rs novel.rs novel_auth.rs novel_bqg.rs
    osu.rs webdav.rs bilibili.rs media.rs error.rs
  crates/
    silvermoon-ipc/        # Contract layer (Host / State / Window / tray / rt / server)
    silvermoon-ipc-macros/ # #[silvermoon_ipc::command] / generate_handler! / generate_context!
    silvermoon-bili/       # Bilibili protocol layer (WBI signing / danmaku parsing / normalisation)
  kugou_server/    # Vendored: md3Music's Kugou Rust server (AGPL-3.0)
fqapi/             # Tomato Novel content sidecar (standalone process, stdio line JSON)
splash/            # Native launcher (Rust + Win32, MD3-drawn splash)
  # It is the **parent process**: shows the splash first, then spawns SilverMoon.exe
  # with --splash-pipe=<name>.
src/ipc/           # Native capability layer of the renderer (the only place touching __SILVERMOON__)
  bridge.ts        #   Low-level wrapper (invoke / batch / payload normalisation)
  invoke.ts        #   Backend command calls + local file URLs (toAssetUrl)
  events.ts        #   listen / once / emit (incl. dynamic names ext://<id>/<event>)
  window.ts        #   Window handles, creation, lookup
  dragdrop.ts      #   File drag & drop
  dpi.ts           #   Logical coordinates vs physical pixels
  paths.ts         #   App directories and path joining (same source as the Rust side)
  app.ts           #   Version and other app metadata
  store.ts         #   JSON key-value store (JsonStore → main-process electron/store.ts)
  dialog.ts        #   File dialogs and message boxes
  fs.ts            #   File reads and writes
  opener.ts        #   Hand off to the OS / reveal in file manager
  http.ts          #   fetch with CORS exemption (main-process network stack)
src/               # Web front end (business logic survives host swaps)
  capabilities/    # Unified native capability layer (invoke wrappers + browser mocks)
  features/        # Drawing / writing workbenches
  stores/          # Pinia stores (library / player / settings / pixiv / anime / skins / audioEffects …)
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / BilibiliCard …
  views/           # Tab views / full-screen player / desktop lyrics / extension host / settings
  composables/     # Reusable composition (useLazyCover / useDesktopChrome / useAmbilight …)
  workers/         # Word-by-word analysis Web Worker
  utils/           # Lyric timelines / anime rules and streaming / NetEase / skins / WebDAV / hero transitions …
  tokens/          # M3 design tokens (theme.css, fonts.css; colour section is generated)
shared/            # Types shared by both ends / i18n / the M3 colour kernel
example/           # Example extensions and skins
miaohui-extension/ # Reference extension: image/video indexing + OCR + ASR + vector search (MIT)
packages/extension-api/ # Author SDK for extensions
doc/               # Docs: AGENTS.md (architecture source of truth) / SPEC.md / LOG.md / proposals
scripts/           # Build and verification scripts
src-tauri/         # ⚠️ Tauri-era leftovers — not part of the build; do not infer architecture from it
archive/electron-host/ # Read-only reference: archive from the previous host move
.github/workflows/ # GitHub Actions automated builds (Windows / Linux / macOS)
```

## 🤝 Contributing

Issues and pull requests are welcome! For significant changes, please open an issue first to discuss.

## 📄 License

This project is licensed under **GPL-3.0-only**; see [LICENSE](LICENSE) for the full text.

Third-party projects referenced or ported:

- [pixez-flutter](https://github.com/Notsfsssf/pixez-flutter) — Pixiv login, image viewing (© Notsfsssf, GPL-3.0)
- [hikari_novel_flutter](https://github.com/15dd/hikari_novel_flutter) — novel parsing (© 15dd, MIT)
- [Kazumi](https://github.com/Predidit/Kazumi) — anime parsing (© Predidit, GPL-3.0)
- [LDDC](https://github.com/chenmozhijin/LDDC) — QQ Music QRC word-by-word lyrics ported from it (© 沉默の金, GPL-3.0-only)
- [md3Music](https://github.com/zzyoxml/md3Music) — Kugou Music API (login / parsing / check-in); its embedded Rust server is vendored verbatim under `kugou_server/` (© zzyoxml, AGPL-3.0)

> Each reference project's license applies to its own code; this project's own code remains GPL-3.0-only.
> `backend/kugou_server/` is AGPL-3.0 code from md3Music, vendored verbatim with its
> [LICENSE](backend/kugou_server/LICENSE) preserved. Under GPLv3 §13, AGPLv3 code may be combined with this project,
> and AGPL §13's network-interaction terms apply to that combination; if you redistribute it, comply with AGPL-3.0 as well.
