# Win7 兼容版（Electron 22）移植说明

本分支 `feat/win7-electron22` 在**同一份代码库**上增加了 Win7 兼容构建目标，
不 fork 代码。正式版（Electron 44 / Chromium 132 / Node 22）行为完全不变。

- 可行性分析（含全部实测依据）：[win7-electron22-feasibility.md](./win7-electron22-feasibility.md)
- 本文件：移植**怎么做**、怎么构建、怎么验收、还差什么。

---

## 1. 一句话概括

Win7 上能跑，靠的是三层：

| 层 | 正式版 | Win7 版 | 机制 |
|---|---|---|---|
| Electron | 44.4.5 | **22.3.27** | 最后一个支持 Win7 的大版本 |
| 主进程 Web API | Node 22 原生 fetch/Response | **undici@5 回填** | `electron/compat/` |
| 写音乐标签 | taglib-wasm (Node≥22.6) | **Rust lofty** | `backend/src/commands/tags.rs` |

以及一个构建期开关 `__SM_LEGACY_ELECTRON__`：现代产物里兼容分支的代码**根本不会被保留**。

---

## 2. 已完成的移植（本分支改动）

### 2.1 新增：Electron 22 兼容层

| 文件 | 作用 |
|---|---|
| `electron/compat/web-globals.ts` | 用 undici@5 补 `fetch`/`Response`/`Request`/`Headers`/`ReadableStream`；补 `Readable.toWeb` 降级 |
| `electron/compat/protocol.ts` | `protocol.handle`(25+) → `registerStreamProtocol`(22) 适配 |
| `electron/compat/file-path.ts` | `webUtils.getPathForFile`(29+) → `File.path`(22) 回退 |
| `electron/compat/env.d.ts` | `__SM_LEGACY_ELECTRON__` 构建期常量声明 |

**为什么选 undici@5**：engines `node >= 14`，实测在 Node 16.17.1 上
POST / SSE 流式 / Referer+UA+Range 自定义头 / redirect follow / AbortSignal **全部可用**，
且能被 esbuild 干净地内联（728 KB，gzip 后更小）。

### 2.2 改动：主进程接入兼容层

- `electron/main.ts` —— 顶部最先调用 `installWebGlobals()`（必须早于任何 fetch/Response）
- `electron/protocols.ts` —— 3 处 `protocol.handle` → `registerProtocolHandler`；
  `net.fetch` → `netFetch`（有 `net.fetch` 用之，否则退回全局 fetch）；
  2 处 `Readable.toWeb` → `toWebStream`
- `electron/preload.ts` —— `webUtils` → `getPathForFile` 回退
- `electron/sidecar.ts` / `electron/ipc.ts` —— **无需改动**，全局 fetch 由 2.1 补齐

### 2.3 新增：Rust 侧标签读写

`backend/src/commands/tags.rs` —— `tags_read_local` / `tags_write_local`

- 用仓库已有的 `lofty`（`osu.rs` 早有写盘先例，这里扩展到全部字段）
- 字段语义与 taglib 版**严格一致**：`None`=不改、`Some("")`=清空；
  `year`/`trackNo`/`discNo` 保留原始字符串（"2005-10-31" / "3/12"）
- 写盘前**整文件备份 + 失败回滚**（音频是用户原始资产）
- 按扩展名挑标签类型（flac/ogg→VorbisComments，m4a→Mp4Ilst，其余→ID3v2）

Electron 侧 `electron/tag-writer.ts` 增加 `USE_RUST_TAGS` 分支，
现代版仍走 taglib-wasm，只有 Win7 版走 sidecar RPC。

### 2.4 新增：SMTC 门控

SMTC 是 **Windows 10 才有的 WinRT API**，而 `cfg(windows)` 在 Win7 目标上**同样为真**，
只靠 target 判断分不出来，硬链接会在 Win7 上启动失败。

`backend/Cargo.toml` 新增 feature：

```toml
default = ["smtc"]
smtc = ["smtc-tokio"]   # now optional
win7 = []               # 标记 Win7 目标
```

`commands/smtc.rs` 的 4 处 `#[cfg(windows)]` 全部改为 `#[cfg(all(windows, feature = "smtc"))]`。
Win7 构建用 `--no-default-features --features win7`。**实测两种组合都能编译通过。**

### 2.5 新增：渲染层 Chromium 108 兼容

- `src/utils/legacyPolyfills.ts` —— 补 `Promise.withResolvers`（Chrome 119+），
  并标注 `color-mix()`（Chrome 111+）缺失
- `src/workers/pdfWorkerLegacy.ts` —— **worker 上下文需要独立的 polyfill**
  （主窗口的补丁不会传播到 Worker）。先补丁、再动态 import 官方 worker
- `src/utils/pdf.ts` —— 改用上面这个 worker 入口
- `vite.config.ts` —— `build.target: "chrome108"`、`worker.format: "es"`

**为什么 build target 钉 chrome108**：默认 `chrome87/es2020` 不允许 top-level await
（pdf.js worker 需要），且会把代码无谓地降级。钉 108 后现代版与 Win7 版**共用同一份 dist**。

### 2.6 新增：构建与验收

- `scripts/build-electron.mjs --win7` —— 产物到 `dist-electron-win7/`，target 降到 node16
- `electron-builder.win7.yml` —— 独立产物目录与 `productName: SilverMoon (Win7)`
- `scripts/verify-win7-build.mjs` —— 静态验收（见第 5 节）
- `package.json` 脚本：`build:main:win7` / `build:backend:win7` / `build:splash:win7` / `dist:win7`

---

## 3. 构建

```bash
# 1) 渲染层（两种目标共用）
npm run build:renderer

# 2) 主进程（Win7 版）
npm run build:main:win7

# 3) Rust 后端 + 启动器（Win7 目标，需要 nightly —— 见第 4 节的说明）
npm run build:backend:win7
npm run build:splash:win7

# 4) 打 NSIS 安装包
npm run dist:win7        # 或 npx electron-builder --config electron-builder.win7.yml --win nsis
```

---

## 4. Rust 后端的 Win7 目标（已跑通，两条路线）

### 问题

Rust 官方 **msvc** target 自 1.78 起要求 Windows 10+。**实测对比**（同一段触及
`std::sync::Mutex` 与线程的程序）：

| 工具链 | 目标 | 产物导入 |
|---|---|---|
| Rust 1.99 stable | `x86_64-pc-windows-gnu` | `api-ms-win-core-synch-l1-2-0.dll` → **WaitOnAddress**（Win8+，Win7 加载失败） |
| **Rust 1.77.2** | `x86_64-pc-windows-gnu` | 仅 `KERNEL32/msvcrt/ntdll` ✅ **Win7 可用** |

两种可行路线：

**路线 A（备选）：用 Rust 1.77.2 + `x86_64-pc-windows-gnu`**

已实测可行（产物无 Win8+ 符号）。但本仓库 `rust-version = 1.82`，需降级 toolchain；
依赖树里若有 crate 要求更新的 rustc，就得逐个 pin —— 这是主要风险。
另需 mingw-w64 工具链（`x86_64-w64-mingw32-gcc` / `windres`）。

**路线 B（本分支采用，已实测跑通）：nightly + `-Z build-std` + tier-3 `x86_64-win7-windows-gnu`**

Rust **官方为 Win7 保留了 tier-3 目标**（`x86_64-win7-windows-gnu` /
`x86_64-win7-windows-msvc`）；nightly 的 `--print target-list` 里有它们
（stable 没有）。tier-3 **无预编译 std**，必须 `-Z build-std=std,panic_abort`
从源码构建 —— 本分支已用这条路线**成功编出后端与启动器**，无需降级 rustc。

```bash
rustup toolchain install nightly --profile minimal
rustup component add rust-src --toolchain nightly
cargo +nightly build --release -Z build-std=std,panic_abort \
  --target x86_64-win7-windows-gnu --target-dir backend/target/win7
```

**`package.json` 里默认写的是路线 B 的命令**；若路线 B 在依赖上受阻，
改用路线 A（把 `--target` 换成 `x86_64-pc-windows-gnu` 并 pin toolchain 1.77.2）。
`scripts/verify-win7-build.mjs` 会同时探测两种 triple 的产物路径。

两条路都必须在**真实 Win7 或 Win7 虚拟机**上最终确认。

---

## 5. 验收

```bash
node scripts/verify-win7-build.mjs
```

静态断言四组：

1. **主进程产物** —— 不残留 `protocol.handle` 直调、已内联 undici、无 taglib-wasm 硬依赖
2. **语法** —— 可被 Node 16 解析
3. **Windows 二进制** —— `objdump` 检查**不得**导入 `WaitOnAddress` 等 Win8+ 符号
   （现成的 `splash/target/.../silvermoon-splash.exe` 就是反面样本，已复现）
4. **渲染层产物**存在

---

## 6. 本分支已验证 / 未验证

### ✅ 已实测通过

**运行时（真实 Electron 22.3.27 / Chromium 108 / Node 16.17.1）**

- 应用**完整启动**：宿主服务监听、IPC 注册、窗口创建
- 生产路径 `app://silvermoon/index.html` **正常加载**：
  `title=SilverMoon · 光影媒体库`、`.app-shell` 存在、Vue 挂载完成、
  首帧 FCP **182ms**、`window.__SILVERMOON__` 桥可用
- `asset://` Range 请求返回 **206** + 正确的 `Content-Range: bytes 0-9/3223`
- 上述路径是用**打包后 asar 里的真实产物**跑通的（不是源码态）

**二进制（路线 B：nightly + `-Z build-std` + `x86_64-win7-windows-gnu`）**

- Rust 后端 `silvermoon.exe`（12.9MB）**编译成功**，`objdump` 确认
  **无** `WaitOnAddress` / `api-ms-win-core-synch-l1-2`（Win8+ 符号）
- 启动器 `silvermoon-splash.exe`（483KB）**编译成功**，同样无 Win8+ 符号
  —— 对比：仓库里**原有**的启动器 exe 有这些符号（差点漏进发布版）
- 两处图标嵌入逻辑（`splash/build.rs`）在 win7 目标下仍正常

**工程门禁**

- `npx vitest run` —— **754 个测试全部通过**（60 个文件）
- `npx eslint .` —— **0 error**（81 个既有 warning）
- `npx prettier --check` —— 全部合规
- `vue-tsc --noEmit` 与 `tsc -p tsconfig.electron.json` —— **零错误**
- `node scripts/verify-packaging.mjs` —— 15 项断言全过
- `node scripts/verify-win7-build.mjs` —— 全过（含两个 exe 的 PE 检查）
- **现代构建回归**：`dist-electron/main.cjs` 53KB，undici **未被内联**
  （`__SM_LEGACY_ELECTRON__` 把整个兼容分支裁掉了），Node 22 下 parse 正常
- electron-builder + `electron-builder.win7.yml` 产出 `release-win7/win-unpacked/`，
  内部 **Electron 22.3.27**，`resources/bin/silvermoon-server.exe` 与
  `resources/silvermoon-splash.exe` 均就位

### ⚠️ 未验证（必须用真实 Win7 收尾）

- **在 Windows 7 上实际运行**。以上全部是 Linux + Electron 22 的等价验证，
  PE 符号检查也只是**静态**的；真机上仍可能出现未预见的加载/渲染差异。
- **完整 NSIS 安装包**：`--dir` 产物已验证，但容器里 Wine 无法跑自解压，
  安装步骤未走完。Windows CI（`windows-latest`）可直接产出。
- 启动器与主程序的**握手**在 Win7 上的表现（命名管道 + GDI 自绘分层窗口）。
- PDF 阅读器在 Chromium 108 下的实际渲染（polyfill 逻辑已就位，未跑真机）。
- `color-mix()` 缺失导致的 MD3 配色偏差程度（**不会崩，但会失真**）。

### 已知遗留

- **`color-mix()` 降级未做**。52 处 + `@m3e/web` 136 个文件依赖它，Chromium 108
  不支持。目前只做了能力探测（`data-legacy-color-mix` 属性），**没有提供视觉回退**。
  这是 Win7 版最大的体验缺口。建议做法：启动器/主进程侧预计算颜色令牌，
  或在 `@supports not (color: color-mix(...))` 下加载一份手写令牌覆盖表。
- Electron 22 已 **EOL**，Chromium 108 有长期未修的安全问题。**不要作为默认分发版本。**
- `scripts/verify-music-tags.mjs` 等既有验证脚本仍针对 taglib 路径，
  Win7 版需要为 Rust 侧补等价验证（尚未写）。
