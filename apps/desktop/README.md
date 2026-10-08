# SilverMoon · Media Library

<div align="center">

**An all-media manager** — browse, organize and play **images, videos, music and e-books (EPUB/PDF)** in a single desktop app, with Pixiv, online novels and online anime built in.

[简体中文](README_zh.md) ｜ [English](README.md)

Current version **v0.1.0**

</div>

SilverMoon is built on **Tauri 2 + Vue 3 + TypeScript + Material Design 3**, with the backend written in **Rust** (in the same process as the desktop shell): one web front end plus a Rust backend, all data kept local — no cloud sync, no mandatory account.

> **SilverMoon — Chinese name 「银月」.** [LumiLuna](https://github.com/Flygeon/LumiLuna-Next) (Tauri 2) was ported to Electron, and then **ported back to Tauri 2**. Both times the strategy was "swap the shell, keep the engine": the Vue front end and the Rust backend keep their business logic nearly untouched — only the host layer was replaced. See [Architecture](#-architecture) and [doc/TAURI-MIGRATION.md](doc/TAURI-MIGRATION.md).

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
- **Extension framework (Extension Host)**: extensions run as separate child processes so the main project stays slim; the first reference extension **MiaoHui** provides image/video indexing + OCR + ASR + vector search
- Audio preset marketplace: pull community presets online and import them in one click
- 🌍 Chinese / English i18n

## 🏗️ Architecture

The app is now a **single Tauri 2 process**: desktop shell and Rust backend ship as one executable.

```
┌──────────────────── Tauri 2 program (Rust, single process) ────────────────────┐
│ Windows / tray / global shortcuts / system media controls (SMTC)               │
│ tauri:// serves the built front end   asset: protocol (local files, Range)     │
│ app-cover: protocol (online cover proxy: CORS bypass + hotlink referer + cache)│
│ 154 #[tauri::command] business commands                                        │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ @tauri-apps/api (invoke / listen)
┌───────────────────────────────▼───────────────────────────────────────────────┐
│ Renderer (Vue 3)   src/ipc/ - native capability layer   src/ - business code  │
└───────────────────────────────────────────────────────────────────────────────┘
```

> **Porting history**: Tauri 2 (originally LumiLuna) → Electron 44 → **back to Tauri 2**.
> The full write-up (what changed, what behaves deliberately differently, how to roll back)
> lives in [doc/TAURI-MIGRATION.md](doc/TAURI-MIGRATION.md).

**How "swap the shell, keep the engine" was achieved**: business code keeps its **calling style**; only the **host layer** was replaced. The `silvermoon-ipc` shim left behind by the Electron port kept every host difference in one place, so migrating back was a **mechanical rewrite on the Rust side**, plus a re-implementation of `src/ipc/` on the front end.

| Layer | Approach | Business-code changes |
|---|---|---|
| Front end | Every `src/ipc/` module keeps its **exported names and signatures**, swapping the internals for `@tauri-apps/*` | `src/capabilities/` and all views/stores: **untouched** |
| Rust | Drop the `crates/silvermoon-ipc` shim; `silvermoon_ipc::X` → `tauri::Y` (473 sites, one-to-one) | Logic untouched |
| New modules | `src/cover.rs` (cover protocol), `src/commands/music_tags.rs` (lofty tag writing), `src/commands/host.rs` (host commands) | Restores what the Node main process used to do |
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

1. **Window navigation interception**: Tauri's `on_navigation` can reject a navigation **synchronously** by returning `false`, which is more direct than the Electron version's "allow first, roll back if the backend says no". The only call site (Pixiv login callback) behaves identically.
2. **`panic = "abort"` in release**: with a single process the backend shares its fate with the UI, so the aggressive old-Tauri optimisations are back (fat LTO + single codegen unit + abort).
3. **Memory diagnostics changed scope**: Tauri is "one process plus the system WebView", so the per-Chromium-process snapshot Electron could produce is unavailable. `metrics` reports this process's RSS only and states that explicitly in a `note` field; `bench` degrades to an empty report.
4. **Capability manifest**: Tauri 2 uses a fine-grained permission model — the main window's plugin abilities are each allowed in `src-tauri/capabilities/default.json`. New plugin commands must be added there or they will be rejected at runtime.

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
- On Windows, building the Rust part needs MSVC Build Tools (`link.exe`); on Linux you need the Tauri WebKitGTK dependencies (see `Install system dependencies` in `.github/workflows/build.yml`)

### Development

```bash
npm install

# One command starts the Vite dev server + Tauri (compiles Rust and opens the window)
npm run dev
```

### Front-end preview only (browser + mock data)

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

In a plain browser there is no Tauri runtime, so `src/capabilities` falls back to its built-in mocks and the UI remains browsable.

### Packaging

```bash
npm run build                    # Typecheck + front-end bundle + tauri build
npm run dist                     # tauri build (packages only, no extra typecheck)
```

> **CI/CD (recommended)**: pushing to `main` builds Windows NSIS + Linux AppImage + macOS dmg
> automatically (artifacts under Actions Artifacts); pushing a `v*` tag creates a GitHub Release.
> No local MSVC setup required.

## 🧱 Tech stack

| Area | Technology |
|---|---|
| Desktop shell | **Tauri 2** (uses the system WebView: WebView2 / WKWebView / WebKitGTK) |
| Backend | **Rust** (same process as the desktop shell, `#[tauri::command]` over IPC) |
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
src-tauri/         # Tauri 2 program (Rust; shell + business backend in one process)
  tauri.conf.json  #   App config (windows / bundle targets / asset: protocol / CSP)
  capabilities/    #   Per-window permission manifest (new plugin commands go here)
  silvermoon.config.json # App metadata (single source of truth for the version)
  src/
    lib.rs         #   Boot: register protocols → migrate legacy data → open DB → tray/extensions/online
    main.rs        #   Entry point (panic logging hook)
    cover.rs       #   app-cover: protocol (cover proxy: CORS bypass + hotlink referer + LRU cache)
    app_meta.rs    #   App metadata + first-launch legacy data migration
    tray.rs        #   System tray (menu built in Rust)
    commands/
      host.rs      #   Host abilities: paths / version / exit / cover cache / memory metrics / updater
      music_tags.rs#   musicTags channel (lofty tag read-write + online tag disk cache)
      scan.rs metadata.rs thumbnail.rs song.rs book.rs skin.rs stats.rs
      smtc.rs      #   Windows system media controls (SMTC)
      desktop.rs   #   Wallpaper / wakelock / notifications / accent colour (UDA)
      extension.rs #   Extension framework
      ffmpeg.rs app.rs
    anime.rs netease.rs kugou.rs pixiv.rs novel.rs novel_auth.rs novel_bqg.rs
    osu.rs webdav.rs bilibili.rs media.rs error.rs
  crates/
    silvermoon-bili/ # Bilibili protocol layer (WBI signing / danmaku parsing / normalisation)
src/ipc/           # Native capability layer of the renderer (the only place importing @tauri-apps/*)
  bridge.ts        #   Low-level wrapper (invoke / batch / payload normalisation)
  invoke.ts        #   Backend command calls + local file URLs (toAssetUrl)
  events.ts        #   listen / once / emit / emitTo
  window.ts        #   Window handles, creation, lookup
  dragdrop.ts      #   File drag & drop (Tauri supplies real paths)
  dpi.ts           #   Logical coordinates vs physical pixels (re-exports Tauri's geometry classes)
  paths.ts         #   App directories and path joining (same source as the Rust side)
  app.ts           #   Version and other app metadata
  store.ts         #   JSON key-value store (JsonStore → plugin-store)
  dialog.ts        #   File dialogs and message boxes (plugin-dialog)
  fs.ts            #   File reads and writes (plugin-fs)
  opener.ts        #   Hand off to the OS / reveal in file manager (plugin-opener)
  http.ts          #   fetch with CORS exemption (plugin-http, Rust network stack)
src/               # Web front end (business logic untouched by the port)
  capabilities/    # Unified native capability layer (invoke wrappers + browser mocks)
  stores/          # Pinia stores (library / player / settings / pixiv / anime / skins / audioEffects …)
  components/      # FluidBackground / LyricsView / BookReader / NovelReader / AnimePlayer / PixivCard …
  views/           # Tab views / full-screen player / desktop lyrics / extension host
  workers/         # Word-by-word analysis Web Worker
  utils/           # Lyric timelines / anime rules and streaming / NetEase / skins / WebDAV / audio effects …
  tokens/          # M3 design tokens (theme.css, fonts.css)
shared/            # Types shared by both ends / i18n
example/           # Example skins
miaohui-extension/ # Reference extension: image/video indexing + OCR + ASR + vector search (MIT)
doc/               # Design and planning documents (incl. TAURI-MIGRATION.md)
scripts/           # Build and verification scripts
archive/electron-host/ # Read-only reference: the Electron host snapshot (not part of the build)
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
- [md3Music](https://github.com/zzyoxml/md3Music) — Kugou Music API (login / parsing / check-in); its embedded Rust server is vendored verbatim under `src-tauri/kugou_server/` (© zzyoxml, AGPL-3.0)

> Each reference project's license applies to its own code; this project's own code remains GPL-3.0-only.
> `src-tauri/kugou_server/` is AGPL-3.0 code from md3Music, vendored verbatim with its
> [LICENSE](src-tauri/kugou_server/LICENSE) preserved. Under GPLv3 §13, AGPLv3 code may be combined with this project,
> and AGPL §13's network-interaction terms apply to that combination; if you redistribute it, comply with AGPL-3.0 as well.
