# SilverMoon · Media Library

<div align="center">

**A local-first all-media library** — the desktop and mobile apps share one product idea: keep your **images, videos, music and e-books** on your own machine, and browse, organize and play them in one place.

[简体中文](README.md) ｜ [English](README_en.md)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Flygeon/SilverMoon)

</div>


SilverMoon (Chinese name **银月**) is a **monorepo**: the desktop app is built on **Electron + Vue 3 + TypeScript + Material Design 3** with its business backend still running as a standalone **Rust sidecar process**; the mobile app is a **Flutter** native implementation. All data stays local — no cloud sync, no mandatory account.

> The project started as [LumiLuna](https://github.com/Flygeon/LumiLuna-Next), was renamed SilverMoon after a Tauri 2 → Electron port, and the desktop business logic (Vue front end + Rust backend) was carried over nearly untouched.

## 🗂️ Repository layout

| Path | Contents | Stack |
|---|---|---|
| [`apps/desktop/`](apps/desktop/) | Desktop app (Windows / Linux / macOS) | Electron 44 + Vue 3 + TypeScript + Rust sidecar |
| [`apps/mobile/`](apps/mobile/) | Mobile app (Android / iOS), music player first | Flutter 3.x (Dart) |
| [`archive/electron-desktop/`](archive/electron-desktop/) | Source snapshot from before the desktop moved to a Flutter host (that refactor was later rolled back; mainline is still Electron) | Archived, read-only reference |
| [`docs/mobile-spec/`](docs/mobile-spec/) | Mobile technical specs (playback / lyrics / bridge inventory) | Docs |
| [`tools/`](tools/) | Cross-platform icon generator (desktop + mobile asset sets) | Python + Pillow |
| [`.github/workflows/`](.github/workflows/) | CI for desktop and mobile (build, static checks, release) | GitHub Actions |

The desktop app ships a much more detailed document of its own: [中文](apps/desktop/README_zh.md) ｜ [English](apps/desktop/README.md).

---

## 🖥️ Desktop · apps/desktop

**An all-media manager** — browse, organize and play **images, videos, music and e-books (EPUB/PDF)** in a single desktop app, with Pixiv, online novels, online anime and Bilibili video built in.

### ✨ Features

**🗂️ Local media library**

- Unified management of images / videos / music / e-books, recursive directory scanning with a SQLite (WAL) index
- Audio tags (lofty), EXIF orientation, image and video thumbnail caching (list endpoints return cache paths directly, so scrolling costs zero extra commands)
- Folder browsing, favorites, history, recycle bin (restorable)
- Custom frameless title bar on Windows, system tray, global hotkeys

**🎵 Music player**

- **Apple Music–style player**: fluid animated background, cover-driven color extraction, word-by-word karaoke lyrics
- **Word-by-word lyrics**: official timelines from QQ Music QRC / Kugou KRC, NetEase yrc / AMLL TTML, plus a Web Worker + FFT (spectral flux) local-analysis fallback
- **AMLL word-by-word lyrics source**: pulls from the AMLL TTML DB (a community-maintained Apple Music–style word-by-word library with translations, romanization and background vocals), placed first in the fallback chain — AMLL → QQ → Kugou → Meting → local — with a configurable mirror base URL
- **Audio effects engine**: 10-band EQ + bass boost + reverb + stereo width; presets can be saved, imported/exported and shared as compact codes (LLFX3)
- **Desktop lyrics**: a separate transparent always-on-top window with mouse pass-through, 4 transition animations, position memory and lock
- **SMTC (Windows system media controls)**: taskbar media flyout, media keys, cover art
- **Online music**: NetEase Cloud Music (QR / phone login with the full weapi / eapi / xeapi protocol, cloud drive and playlists), Kugou (QR / phone login, daily recommendations, charts, daily double check-in), plus an experimental Meting aggregator
- Listen Now feed, comment panel, listening-time statistics

**📖 Reading & writing**

- Built-in **EPUB / PDF** reader: chapter sidebar, single-page / two-page / scrolling modes, adjustable theme and typography
- Reading progress saved and restored automatically (precise CFI positioning)
- **Writing studio**: Markdown draft list with a source / preview split view, rendered by marked + DOMPurify
- **Drawing studio**: a canvas under the images tab, powered by leafer-editor (loaded on demand)

**🌐 Online sources** (all off by default; enable them in Settings)

- **Online images (Pixiv)** — login, recommendations / rankings / search, artwork details with multi-page originals, comments, bookmarks, following feed, ugoira animation
- **Online novels** — Wenku8 login and online bookshelf, BQG source, online reading and reading statistics
- **Online anime** — rule-based aggregated search with source switching, seasonal pages, Bangumi details and collection sync; ArtPlayer playback + DanDanPlay danmaku + HLS
- **Bilibili video** — recommendation feed / search / QR login, video details and comments, UP profile and uploads, history and favorites, like / coin / favorite; streams are fetched over **DASH + MSE** and muxed client-side, sharing the danmaku stack with anime
- **Bilibili anti-fraud & dynamics** — auto re-check comment / dynamic visibility after posting (visible, self-only or hidden), a dynamics feed with publishing, optional hiding of goods-promoting dynamics and comments, and one-click **AI video summary** with chapter outline on the video page

**🎨 Appearance & extensibility**

- **Material Design 3** design system: Monet dynamic color, light / dark / follow-system
- **Skin system**: import and pin external skin packs (ZIP assets + background images + icon packs + CSS injection), with a `--safe-mode` escape hatch; examples in [`apps/desktop/example/`](apps/desktop/example/)
- **Extension framework (Extension Host)**: extensions run as standalone sidecars so the main app grows by zero bytes; the reference extension **MiaoHui** adds image/video indexing + OCR + ASR + vector search
- Audio preset market: pull community presets from the network and import in one click
- More tools in the Treasure box: folders, WebDAV, osu! beatmap downloader, listening / reading statistics
- 🌍 Chinese / English i18n

### 🏗️ Architecture

Three processes, with a single plain-text, curl-friendly boundary between host and backend:

```
┌─────────────────────────── Electron main process (Node) ──────────────────────┐
│ Windows / tray / global hotkeys / file dialogs / default apps                 │
│ app:// protocol (front-end bundle)   asset:// protocol (local files, Range)   │
│ app-cover:// protocol (online cover proxy with Referer + disk cache)          │
│ Host HTTP server (127.0.0.1:random port) ←── reverse calls from the backend   │
└───────┬───────────────────────────────────────────────────────────┬───────────┘
        │ IPC (preload contextBridge)                               │ HTTP /cmd + SSE /events
┌───────▼───────────────────────────────┐               ┌───────────▼───────────┐
│ Renderer (Vue 3)                      │               │ Backend process (Rust)│
│ src/ipc/ native capability layer      │               │ backend/ business code│
└───────────────────────────────────────┘               └───────────────────────┘
```

- **Renderer → main**: `window.__SILVERMOON__` (contextBridge, whitelisted channels); business code always goes through `src/ipc/`
- **Main → backend**: `electron/sidecar.ts` spawns the executable, parses `SILVERMOON_READY {"port":N}` from stdout, and relays commands and events
- **Backend → main**: `electron/host-server.ts` exposes `POST /_host`, used by Rust to create windows, eval, register tray and hotkeys, and open files
- Both HTTP servers bind `127.0.0.1` only and share the `X-SilverMoon-Token` authentication header
- The backend registers **164 commands** in one routing table, exposed over `POST /cmd` and pushed back via SSE `GET /events`

### 🚀 Quick start

Requirements: [Node.js](https://nodejs.org/) 20+, [Rust](https://www.rust-lang.org/) 1.82+; building the backend on Windows needs MSVC Build Tools.

```bash
cd apps/desktop
npm install

# Build the backend sidecar first (output: backend/target/debug/silvermoon[.exe])
npm run build:backend

# One command brings up the Vite dev server + Electron main watch + Electron
npm run dev
```

The UI starts even without a built backend, but data operations report "backend not started" — handy when working on the front end only. Renderer-only preview (browser + mocks):

```bash
npm run dev:renderer     # Vite dev server (localhost:1420)
```

Packaging:

```bash
npm run build:backend:release   # release backend
npm run build                   # typecheck + renderer bundle + Electron main bundle
npm run dist                    # electron-builder (Windows NSIS / Linux AppImage / macOS DMG)
```

### 🧱 Tech stack

| Area | Technology |
|---|---|
| Desktop shell | Electron 44 (main process in Node, bundled with esbuild) |
| Front end | Vue 3 + Vite + TypeScript + Pinia + vue-router |
| UI | Material Design 3 (`@m3e/web` M3 Expressive + `@material/web`) |
| Backend | Rust (standalone sidecar over HTTP + SSE) |
| Database | rusqlite (SQLite, WAL) |
| Media processing | lofty, image, kamadak-exif, FFmpeg (optional external dependency) |
| Windows media controls | smtc-tokio + tiny_http |
| Online anime / Bilibili | ArtPlayer + hls.js + DASH (MSE) + DanDanPlay danmaku |
| EPUB / PDF | epub.js, pdf.js |
| Web scraping | scraper, regex, roxmltree |
| Online music protocols | Pure-Rust weapi / eapi / xeapi signing; Kugou API via the vendored `kugou_server` |
| Word-by-word timeline | Web Worker + FFT (spectral flux) + IndexedDB |

The full dependency and build reference lives in [`apps/desktop/README_zh.md`](apps/desktop/README_zh.md) (Chinese).

---

## 📱 Mobile · apps/mobile

The Flutter implementation of SilverMoon for Android / iOS. **The music player is the core**, with five tabs in total: images, videos, music, books and settings.

> The platform folders `android/` and `ios/` are **not committed**: the development machine has no Flutter SDK, so CI (or `tool/bootstrap.sh` locally) generates them from the templates shipped with the current Flutter version and then overlays the customized files from `tool/overlay/`. That keeps the Gradle / AGP / Xcode project formats permanently aligned with Flutter.

### ✨ Features

- **Local library**: scans the usual Android music directories (or custom ones), reads tags in an Isolate (ID3 / VorbisComment / MP4 atoms) and extracts embedded artwork
- **Playback core**: `just_audio` + `just_audio_background` (notification and lock-screen controls); queue semantics strictly mirror the desktop app (Fisher-Yates shuffle, repeat-one, play-next, playback-rate cycle)
- **Word-by-word lyrics**: LRC / QRC / KRC (decrypted) / yrc / TTML parsers ported 1:1 from the desktop app; timelines fetched through a QQ → Kugou → Meting → local fallback chain, with instrumental "three dots" detection
- **Audio effects**: hardware EQ (`AndroidEqualizer`, with the desktop 10-band parameters mapped to the nearest device bands) plus bass boost; reverb and stereo width are explicitly marked unavailable on mobile
- **Online music**: NetEase (search / song detail / lyrics / playlists / charts / comments / QR and phone login / cloud drive / liked songs / daily recommendations), Kugou (search / stream resolution / lyrics / QR and phone login / daily check-in / playlists and charts), Meting as aggregator fallback; credentials never leave the device
- **Appearance**: Material 3 + Monet dynamic color (Android 12+), cover-driven palette on the player page (histogram quantization), Apple Music–style mini player and full-screen now-playing page
- **Local media tabs**: images (grid + full-screen zoom viewer), videos (basic playback / seek / speed), books (plain-text .txt/.md reader that honestly reports non-UTF-8 files; EPUB / PDF are explicitly marked as unsupported)

### 🚀 Local development & build

```bash
cd apps/mobile
bash tool/bootstrap.sh      # generate android/ and ios/
flutter pub get
dart run flutter_launcher_icons
flutter run
```

On every push to `main`, CI ([mobile.yml](.github/workflows/mobile.yml), Flutter 3.47.5) builds:

- Android: `flutter build apk --release --split-per-abi` (arm64-v8a / armeabi-v7a / x86_64)
- iOS: `flutter build ios --release --no-codesign` → packaged as an unsigned `.ipa` (re-sign with Sideloadly / AltStore to install)
- Non-PR builds are published automatically as a prerelease (tag: `mobile-vN`)

See also [`apps/mobile/README.md`](apps/mobile/README.md); technical specs and implementation details are in [`docs/mobile-spec/`](docs/mobile-spec/) (documents 05 and 06 are historical, from the WebView era, and are marked as obsolete).

---

## 🗄️ Archive · archive/electron-desktop

[`archive/electron-desktop/`](archive/electron-desktop/) is the **complete source snapshot** of `apps/desktop` from before it switched to a Flutter host (also an Electron + Vue implementation). That refactor was rolled back and the mainline remains Electron, so the directory is a historical reference only — see [`ARCHIVE.md`](archive/electron-desktop/ARCHIVE.md).

## 🧰 Docs & tooling

- [`apps/desktop/doc/`](apps/desktop/doc/): design guide, skin system proposals, word-by-word lyrics plan, backend migration and performance reviews
- [`docs/mobile-spec/`](docs/mobile-spec/): mobile playback / lyrics specs and bridge call inventory
- [`tools/make-icons.py`](tools/make-icons.py): one source image produces every desktop (ICO / ICNS / PNG / tiles) and mobile (full-bleed iOS, Android adaptive) icon
  ```bash
  python tools/make-icons.py            # defaults to tools/app-icon-source.png
  ```
- [`apps/desktop/scripts/`](apps/desktop/scripts/): dev orchestration, esbuild bundling, icon and post-processing, font and spring-easing scripts

## 🔁 Continuous integration

| Workflow | Trigger | Contents |
|---|---|---|
| [`build.yml`](.github/workflows/build.yml) | push to `main` / PR / `v*` tag | Desktop: ESLint + Prettier + typecheck + unit tests + Rust fmt/clippy; Windows NSIS and Linux AppImage built in parallel; tagging creates a GitHub Release |
| [`mobile.yml`](.github/workflows/mobile.yml) | `apps/mobile/**` changes / manual | Mobile: per-ABI Android APKs and an unsigned iOS IPA, published as a prerelease |

## 🙏 Credits & license

This project is licensed under **GPL-3.0-only**; see [`apps/desktop/LICENSE`](apps/desktop/LICENSE) for the full text.

Parts of the project reference or are ported from the following open-source projects — thanks to their authors:

| Project | Used for | License |
|---|---|---|
| [pixez-flutter](https://github.com/Notsfsssf/pixez-flutter) | Pixiv login, image viewing | GPL-3.0 |
| [hikari_novel_flutter](https://github.com/15dd/hikari_novel_flutter) | Novel parsing and login | MIT |
| [Kazumi](https://github.com/Predidit/Kazumi) | Anime rule scraping and playback | GPL-3.0 |
| [LDDC](https://github.com/chenmozhijin/LDDC) | QQ Music QRC word-by-word lyrics, Kugou API client | GPL-3.0-only |
| [md3Music](https://github.com/zzyoxml/md3Music) | Kugou Music API (login / parsing / check-in); its embedded Rust server is vendored verbatim under `apps/desktop/backend/kugou_server/` | AGPL-3.0 |
| [PiliPlus](https://github.com/PiliPlus/PiliPlus) | Reference for the Bilibili API and WBI signing | GPL-3.0 |
| [api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) | NetEase weapi / eapi / xeapi signing and anti-risk-control measures | MIT |
| [MiaoHui](https://github.com/Kian0034/miaohui) | Reference extension: image/video indexing + OCR + ASR + vector search | MIT |

> Each reference project's license applies to its own code; this project's own code remains GPL-3.0-only.
> `apps/desktop/backend/kugou_server/` is AGPL-3.0 code from md3Music, vendored verbatim with its
> [LICENSE](apps/desktop/backend/kugou_server/LICENSE) preserved. Under GPLv3 §13, AGPLv3 code may be combined with this project,
> and AGPL §13's network-interaction terms apply to that combination; if you redistribute it, comply with AGPL-3.0 as well.

## 🤝 Contributing

Issues and pull requests are welcome! For significant changes, please open an issue first to discuss. See [`apps/desktop/CONTRIBUTORS.md`](apps/desktop/CONTRIBUTORS.md) for the contributor list.
