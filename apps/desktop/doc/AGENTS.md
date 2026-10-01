# AGENTS.md

## Project

**银月（SilverMoon）** — Electron 44 + Vue 3 + TypeScript desktop media library app, with the backend still written in Rust (SQLite, lofty, image processing) running as a **separate sidecar process**. Frontend uses Pinia, vue-router and Material Design 3.

The project was ported from Tauri 2 (originally `LumiLuna`). See `README_zh.md` → 架构 for the full picture.

## Process model

```
Electron main process ──HTTP POST /cmd + SSE /events──> Rust backend (127.0.0.1, random port)
        ^                                                        |
        └───────── reverse RPC: host server POST /_host ─────────┘
```

- Renderer → main: `window.__SILVERMOON__` (contextBridge, injected by `electron/preload.ts`).
- Main → backend: `electron/sidecar.ts` spawns the binary, parses `SILVERMOON_READY {"port":N}` from stdout, and relays commands/events.
- Backend → main: `electron/host-server.ts` exposes `POST /_host`, which the Rust side calls for window/tray/hotkey/dialog operations.
- Both HTTP servers bind `127.0.0.1` only and authenticate with the `X-SilverMoon-Token` header.

## Commands

```bash
# Frontend only (browser preview; all native capabilities fall back to mocks)
npm install && npm run dev          # Vite dev server on :1420

# Backend (needs MSVC on Windows / system deps on Linux — CI builds it otherwise)
npm run build:backend               # cargo build --manifest-path backend/Cargo.toml
npm run build:backend:release       # release build of the sidecar

# Full desktop app
npm run dev                         # vite + esbuild watch + electron (scripts/dev.mjs)
npm start                           # run the already-built app
npm run dist                        # typecheck + build + electron-builder

# Checks (all runnable locally, no linker required except cargo)
npm run lint                        # eslint .
npm run format:check                # prettier
npm run typecheck                   # vue-tsc --noEmit && tsc -p tsconfig.electron.json
npm test                            # vitest
cd backend && cargo fmt --check
cd backend && cargo clippy --all-targets -- -D warnings
```

## Architecture

- `electron/` — Electron main process: windows, tray, hotkeys, dialogs, `app://` + `asset://` protocols, sidecar supervision, host RPC server.
- `src/ipc/` — **the single bridge between the renderer and the native layer** (`invoke` / `events` / `window` / `dragdrop` / `paths` / `app` / `store` / `dialog` / `fs` / `opener` / `http`). Business code imports from here directly.
- `src/capabilities/index.ts` — higher-level facade over `src/ipc/`: wraps every backend command and provides a **browser mock** so `npm run dev` works without Electron.
- `backend/` — Rust backend (commands, SQLite library DB, scanning, metadata).
  - `backend/crates/silvermoon-ipc/` — command macro + route table + managed state + events + local HTTP/SSE server.
  - `backend/crates/silvermoon-ipc-macros/` — `#[command]` / `generate_handler!` / `generate_context!`.
  - `backend/silvermoon.config.json` — **single source of truth** for app metadata, read at compile time by `generate_context!` and at runtime by `electron/config.ts`.
- `src/stores/` — Pinia stores: `library` (file cache + scan), `player` (audio playback + queue), `settings` (persisted via `JsonStore`).
- `src/tokens/theme.css` — M3 design tokens (CSS variables). Edit colors here, not in components.

## Key Conventions

- **No emojis in UI** — Use Material Symbols Rounded icons only (class: `material-symbols-outlined`)
- **Path aliases**: `@` → `src/`, `@shared` → `shared/`
- **Icons font**: Google Fonts CDN (Chinese mirror `fonts.googleapis.cn`). CSS class `.material-symbols-outlined` maps to `Material Symbols Rounded` font family.
- **Music player**: FluidBackground uses 4-quadrant rotating canvas + `screen` blend + `blur(30px) saturate(2.5) brightness(0.5) scale(1.5)`. Magic numbers from Apple Music reference — do not change.
- **Lyric parser**: `parseLrc()` in `player.ts` supports dual-language (same-timestamp lines or `[tr:]` tags) + trailing-paren translations. `buildLyricSequence` (`src/utils/lyricTimeline.ts`) attaches a rough word-timeline (`units`) and — when `settings.detectInstrumental` is on — replaces leading credits (作词/作曲/编曲) with a 3-dot intro and inserts 3-dot interludes for long pauses. `LyricsView` renders Apple-Music-style word fill (gradient via `background-position`, rAF-driven by `audioEl.currentTime`) + sung words float up. Phase 2 precise word timing: `src/utils/wordAnalysis.ts` decodes audio → FFT onset detection in `src/workers/wordAnalysis.worker.ts` → cached in IndexedDB (`src/utils/wordCache.ts`), auto-upgrading on play. Plan: `逐字歌词策划书.md`.
- **Audio playback**: use `toAssetUrl()` from `src/ipc/invoke.ts` to convert a file path into an `asset://` URL. Audio element must be bound via `bindAudio()` then `initAudio()` called after mount.
- **Windows SMTC**: `commands/smtc.rs` registers the app as a system media session (Windows-only deps `smtc-tokio` + `tiny_http`, target-gated). Frontend pushes metadata via `capabilities.smtcSetMedia()` (local: `filePath`; online: `coverUrl`) and throttled state via `syncSmtc()` in the player store; OS media keys arrive as `smtc:command` events, dispatched in the player store. Covers are served over `http://127.0.0.1` by a tiny_http thread — Windows' `RandomAccessStreamReference` does NOT accept `file://` URIs. Commands no-op on non-Windows.
- **Online music (experimental)**: toggle in Settings; Music tab adds playlist/search tabs backed by the meting API (`src/utils/meting.ts`). `player.queue` is a unified `QueueItem` (`MediaEntry | OnlineSong`); `playOnline()`/`loadOnlineSong()` stream http(s) URLs. Local audio appears as a "本地音乐" playlist when online mode is on.
- **Thumbnails**: Cached in `library.thumbCache`. Loaded via `loadThumbnails()` with 6-concurrent worker pool.
- **Settings persistence**: `settings.ts` uses `JsonStore` from `@/ipc/store`. Auto-saves on any `watch()` change. Load on app start in `App.vue` `onMounted`.

## Build CI

GitHub Actions builds Windows (NSIS) and Linux (AppImage) in parallel with a `lint` job. Push to `main` triggers the build; pushing a `v*` tag creates a Release with the artifacts. No local MSVC needed — builds happen on cloud runners.

The `build` job deliberately does **not** declare `needs: lint`, so the slow Windows job starts immediately instead of waiting ~4 minutes for lint.

## Gotchas

- Windows builds need MSVC (`link.exe`) — cannot build locally without Visual Studio Build Tools
- Rust `lofty` crate: `ItemKey::UnsynchronizedLyrics` does not exist in v0.20, only `ItemKey::Lyrics`
- `src/ipc/opener.ts` exports `openPath` (not `open`)
- **Command errors reject with the raw string**, not an `Error`. Messages like `[WENKU8_LOGIN_CANCELLED] …` are matched by prefix, so never wrap the reject value.
- The renderer must be served over `app://`, not `file://` — Chromium disables IndexedDB in an opaque origin, and the app stores the word cache / online cache / WebDAV credentials in IndexedDB.
- Remote-page windows (Pixiv login, Wenku8 login, anime stream capture) run with `contextIsolation: false` and `electron/webview-preload.ts`; they get a minimal `window.__SILVERMOON_HOST__.invoke` and nothing else.
- The sidecar exits on stdin EOF — the host must keep `child.stdin` open and `end()` it before killing.
- Router uses `createWebHashHistory` — components are destroyed/recreated on route change. `keep-alive` is used in `App.vue` to preserve state (excludes PlayerView).
- `library.refresh(type)` caches by type. Call with `force=true` to bypass cache after scan.
