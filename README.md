# SilverMoon · Media Library

<div align="center">

**An all-media manager** — browse, organize and play **images, videos, music and e-books (EPUB/PDF)** in a single desktop app, with Pixiv, online novels and online anime built in.

[简体中文](README_zh.md) ｜ [English](README.md)

Current version **v1.2.1**

</div>

SilverMoon is built on **Electron + Vue 3 + TypeScript + Material Design 3**, with the backend still written in **Rust**: one web front end plus a Rust backend, all data kept local — no cloud sync, no mandatory account.

> **This project is [LumiLuna](https://github.com/Flygeon/LumiLuna-Next) ported from Tauri 2 to Electron.** The migration strategy is "swap the shell, keep the engine": the Vue front end and the Rust backend keep their business logic nearly untouched — only the host layer was replaced. See [Architecture](#-architecture).

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
│ Host HTTP server (127.0.0.1:random port) ←── reverse calls from the Rust sidecar │
└───────┬──────────────────────────────────────────────────────────┬────────────┘
        │ IPC (preload contextBridge)                              │ HTTP /cmd + SSE /events
┌───────▼─────────────────────────────┐               ┌──────────▼────────────┐
│ Renderer (Vue 3, original front end)│               │ Rust sidecar          │
│ src/shims/ replaces @tauri-apps/*   │               │ src-tauri/ untouched  │
└─────────────────────────────────────┘               └───────────────────────┘
```

**How "minimal refactor" was achieved**: instead of changing how business code calls things, the **dependency layer** was swapped.

| Layer | Approach | Business-code changes |
|---|---|---|
| Front end | Vite `alias` + tsconfig `paths` map `@tauri-apps/*` to equivalent implementations under `src/shims/` | **0 lines** |
| Rust | The `tauri` dependency is replaced by a same-named compat crate at `src-tauri/crates/tauri-compat`, which reimplements `#[tauri::command]`, `AppHandle`, `State`, `Emitter`, … | Only 6 plugin-registration lines removed from `lib.rs`, 2 import lines changed in `commands/extension.rs` |
| Data | Keeps Tauri's directory convention `<appData>/<identifier>`; the first launch copies the whole legacy `cn.cool.lumiluna` directory once (read-only) | — |

A file-by-file diff of the front end shows **only 14 of 136 source files differ, and every difference is a brand string or build configuration**.

### Tauri API surface implemented by the compat layer (measured usage)

| Item | Count |
|---|---|
| `#[tauri::command]` commands | 154 |
| `tauri::AppHandle` references | 190+ |
| `State<'_, T>` injections | 29 |
| `async_runtime::spawn_blocking` | 42 |
| `WebviewWindowBuilder` / `WebviewWindow` | 4 |
| `emit` / `emit_to` | 8 |
| tray / menu construction sites | 1 |

### Known behavioural differences from Tauri

1. **No plugin mechanism.** `tauri-plugin-*` capabilities are now provided by the Electron main process; `opener` and `global-shortcut` (the only two used from Rust) are reimplemented inside the compat layer, while dialog / fs / store / http were only ever used by the front end.
2. **`on_navigation` timing.** Tauri rejects synchronously; the Electron main process cannot ask Rust synchronously across processes, so this becomes "allow first, and if Rust says no, `stop()` and go back to the last committed URL". The only call site (Pixiv login callback interception) behaves identically.
3. **Tray visibility.** Electron has no "hidden but alive" tray API, so `set_visible` degrades to a no-op (the only call ever made is `set_visible(true)`).
4. **`panic` no longer aborts in release.** The sidecar is a long-lived process, so keeping unwinding lets a single command's panic affect only that call.

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

# Build the Rust sidecar first (output: src-tauri/target/debug/silvermoon[.exe])
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
  store.ts         #   Disk-backed implementation of plugin-store
  tray.ts          #   System tray
  preload.ts       #   contextBridge bridge + drag-drop path resolution + __TAURI_INTERNALS__ injection
  webview-preload.ts # Remote-page windows (init script + a minimal __TAURI__.core.invoke)
src/shims/         # Replacements for @tauri-apps/* (added by the port)
  bridge.ts        #   Low-level wrapper over the main-process bridge
  api/             #   core / event / window / webview / webviewWindow / dpi / path / app
  plugin-*.ts      #   store / dialog / fs / opener / http
src/               # Web front end (kept as-is by the port)
  capabilities/    # Unified native capability layer (invoke wrappers + browser mocks)
  stores/          # Pinia stores (library / player / settings / pixiv / anime / skins / audioEffects …)
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / PixivCard …
  views/           # Tab views / full-screen player / desktop lyrics / extension host
  workers/         # Word-by-word analysis Web Worker
  utils/           # Lyric timelines / anime rules and streaming / NetEase / skins / WebDAV / audio effects …
  tokens/          # M3 design tokens (theme.css, fonts.css)
src-tauri/         # Rust backend (kept as-is by the port)
  src/commands/    # Scanning / metadata / thumbnails / books / SMTC / skins / extensions / FFmpeg
  src/*.rs         # pixiv / novel / anime / netease / webdav / tray / media
  crates/          # Compat layer added by the port
    tauri-compat/        # Same-named `tauri` shim: API surface + HTTP/SSE server + reverse RPC
    tauri-compat-macros/ # #[command] / generate_handler! / generate_context!
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
- [md3Music](https://github.com/zzyoxml/md3Music) — Kugou Music API (login / parsing / check-in); its embedded Rust server is vendored verbatim under `src-tauri/kugou_server/` (© zzyoxml, AGPL-3.0)

> Each reference project's license applies to its own code; this project's own code remains GPL-3.0-only.
> `src-tauri/kugou_server/` is AGPL-3.0 code from md3Music, vendored verbatim with its
> [LICENSE](src-tauri/kugou_server/LICENSE) preserved. Under GPLv3 §13, AGPLv3 code may be combined with this project,
> and AGPL §13's network-interaction terms apply to that combination; if you redistribute it, comply with AGPL-3.0 as well.
