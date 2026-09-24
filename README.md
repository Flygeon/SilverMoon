# SilverMoon · Media Library

<div align="center">

**An all-media manager** — browse, organize and play **images, videos, music and e-books (EPUB/PDF)** in a single desktop app, with Pixiv, online novels and online anime built in.

[简体中文](README_zh.md) ｜ [English](README.md)

Current version **v1.2.1**

</div>

SilverMoon is built on **Electron + Vue 3 + TypeScript + Material Design 3**, with the backend still written in **Rust**: one web front end plus a Rust backend, all data kept local — no cloud sync, no mandatory account.

> **SilverMoon — Chinese name 「银月」.** [LumiLuna](https://github.com/Flygeon/LumiLuna-Next) ported from Tauri 2 to Electron. The migration strategy is "swap the shell, keep the engine": the Vue front end and the Rust backend keep their business logic nearly untouched — only the host layer was replaced. See [Architecture](#-architecture).

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
- **Skin system**: import and pin external skin packages (ZIP assets + background images + icon packs + CSS injection); several built-in skins, examples under `example/`
- **Extension framework (Extension Host)**: extensions run as separate sidecars so the main project stays slim; the first reference extension **MiaoHui** provides image/video indexing + OCR + ASR + vector search
- Audio preset marketplace: pull community presets online and import them in one click
- 🌍 Chinese / English i18n

## 🏗️ Architecture

After the port, the app is split into three parts:

```
┌──────────────────────── Electron main process (Node) ─────────────────────────┐
│ Windows / tray / global shortcuts / file dialogs / opening files              │
│ app:// protocol (serves built front end)   asset:// protocol (local files, Range) │
│ Host HTTP server (127.0.0.1:random port) ←── reverse calls from the Rust backend │
└───────┬──────────────────────────────────────────────────────────┬────────────┘
        │ IPC (preload contextBridge)                              │ HTTP /cmd + SSE /events
┌───────▼─────────────────────────────┐               ┌──────────▼────────────┐
│ Renderer (Vue 3, original front end)│               │ Rust backend          │
│ src/ipc/ - native capability layer  │               │ backend/ business code│
└─────────────────────────────────────┘               └───────────────────────┘
```

**How "swap the shell, keep the engine" was achieved**: business code keeps its **calling style**; only the **host layer** was replaced.

| Layer | Approach | Business-code changes |
|---|---|---|
| Front end | New `src/ipc/` modules (invoke / events / window / dragdrop / paths / store / dialog / fs / opener / http); business files merely point their imports at it | ~30 files change imports and a few call sites; **logic untouched** |
| Rust | New `backend/crates/silvermoon-ipc`: command macro + route table + local HTTP server + reverse RPC into the host | 19 business modules change `use` prefixes and type names; **logic untouched** |
| Data | Directory stays `<appData>/<identifier>`; the first launch copies the whole legacy `cn.cool.lumiluna` directory once (read-only) | — |

### IPC layer coverage (measured usage)

| Item | Count |
|---|---|
| `#[command]` commands | 154 |
| `Host` (app handle) references | 190+ |
| `State<'_, T>` injections | 29 |
| `rt::spawn_blocking` | 42 |
| `WindowBuilder` / `Window` | 4 |
| `emit` / `emit_to` | 8 |
| tray / menu construction sites | 1 |

### Design decisions and behavioural notes

1. **Commands travel over HTTP, not a pipe** - easier for the host to handle concurrently, and debuggable with plain `curl`. The server binds `127.0.0.1` only and both sides share an `X-SilverMoon-Token`.
2. **`on_navigation` becomes "allow first, roll back if the backend says no"** - the Electron main process cannot ask the backend synchronously across processes. The only call site (Pixiv login callback) behaves identically.
3. **Tray visibility**: Electron has no "hidden but alive" tray API, so `set_visible` degrades to a no-op (the only call ever made is `set_visible(true)`).
4. **No `panic = "abort"` in release** - the backend is a long-lived process, so keeping unwinding lets a single command's panic affect only that call.
5. **State references are extended to `'static`** - `State<'_, T>` gets captured inside boxed `async` blocks. The safety argument lives in the doc comments of `crates/silvermoon-ipc/src/app.rs`.

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
- On Windows, building the Rust sidecar needs MSVC Build Tools (`link.exe`)

### Development

```bash
npm install

# Build the Rust sidecar first (output: backend/target/debug/silvermoon[.exe])
npm run build:backend

# One command starts the Vite dev server + Electron main watch + Electron
npm run dev
```

The UI can also start without a built sidecar, but every data operation will report "backend not started" and show an explanatory dialog — handy for front-end-only work.

### Front-end preview only (browser + mock data)

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

In a plain browser `window.__SILVERMOON__` does not exist, so `src/capabilities` falls back to its built-in mocks and the UI remains browsable.

### Packaging

```bash
npm run build:backend:release    # Build the release Rust sidecar
npm run build                    # Typecheck + front-end bundle + Electron main bundle
npm run dist                     # electron-builder package (Windows NSIS / Linux AppImage)
```

> **CI/CD (recommended)**: pushing to `main` builds Windows NSIS + Linux AppImage automatically (artifacts under Actions Artifacts); pushing a `v*` tag creates a GitHub Release. No local MSVC setup required.

## 🧱 Tech stack

| Area | Technology |
|---|---|
| Desktop shell | **Electron 44** (main process on Node) |
| Backend | **Rust** (standalone sidecar process, HTTP + SSE) |
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
| i18n | Lightweight in-house i18n (`shared/i18n.ts`) |

## 📁 Project layout

```
electron/          # Electron main process (added by the port)
  main.ts          #   Boot order: protocols → host server → sidecar → main window
  sidecar.ts       #   Spawns and supervises the Rust sidecar; HTTP commands + SSE events
  host-server.ts   #   Reverse entry point for Rust (create window / eval / tray / hotkeys / open file)
  windows.ts       #   Window registry, creation, close interception, event dispatch
  protocols.ts     #   app:// (front-end bundle) and asset:// (local files, Range support)
  ipc.ts           #   Renderer → main capability dispatch (whitelisted channels)
  store.ts         #   JSON key-value store backing JsonStore
  tray.ts          #   System tray
  preload.ts       #   contextBridge bridge + drag-drop path resolution
  webview-preload.ts # Remote-page windows (init script + a minimal __SILVERMOON_HOST__.invoke)
src/ipc/           # Native capability layer of the renderer (added by the port)
  bridge.ts        #   Low-level wrapper over the main-process bridge
  invoke.ts        #   Backend command calls + local file URLs (toAssetUrl)
  events.ts        #   listen / once / emit / emitTo
  window.ts        #   Window handles, creation, lookup
  dragdrop.ts      #   File drag & drop
  dpi.ts           #   Logical coordinates vs physical pixels
  paths.ts         #   App directories and path joining
  app.ts           #   Version and other app metadata
  store.ts         #   JSON key-value store (JsonStore)
  dialog.ts        #   File dialogs and message boxes
  fs.ts            #   File reads and writes
  opener.ts        #   Hand off to the OS / reveal in file manager
  http.ts          #   fetch with CORS exemption
src/               # Web front end (business logic untouched by the port)
  capabilities/    # Unified native capability layer (invoke wrappers + browser mocks)
  stores/          # Pinia stores (library / player / settings / pixiv / anime / skins / audioEffects …)
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / PixivCard …
  views/           # Tab views / full-screen player / desktop lyrics / extension host
  workers/         # Word-by-word analysis Web Worker
  utils/           # Lyric timelines / anime rules and streaming / NetEase / skins / WebDAV / audio effects …
  tokens/          # M3 design tokens (theme.css, fonts.css)
backend/         # Rust backend (business logic untouched by the port)
  src/commands/    # Scanning / metadata / thumbnails / books / SMTC / skins / extensions / FFmpeg
  src/*.rs         # pixiv / novel / anime / netease / webdav / tray / media
  crates/          # IPC layer added by the port
    silvermoon-ipc/        # Command registry + managed state + events + windows/tray + HTTP/SSE
    silvermoon-ipc-macros/ # #[command] / generate_handler! / generate_context!
  silvermoon.config.json # App metadata (single source of truth for compile time and runtime)
shared/            # Types shared by both ends / i18n
example/           # Example skins
miaohui-extension/ # Reference extension: image/video indexing + OCR + ASR + vector search (MIT)
doc/               # Design and planning documents
scripts/           # Build scripts (dev orchestration / esbuild bundling for Electron)
.github/workflows/ # GitHub Actions automated builds
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
- [md3Music](https://github.com/zzyoxml/md3Music) — Kugou Music API (login / parsing / check-in); its embedded Rust server is vendored verbatim under `backend/kugou_server/` (© zzyoxml, AGPL-3.0)

> Each reference project's license applies to its own code; this project's own code remains GPL-3.0-only.
> `backend/kugou_server/` is AGPL-3.0 code from md3Music, vendored verbatim with its
> [LICENSE](backend/kugou_server/LICENSE) preserved. Under GPLv3 §13, AGPLv3 code may be combined with this project,
> and AGPL §13's network-interaction terms apply to that combination; if you redistribute it, comply with AGPL-3.0 as well.
