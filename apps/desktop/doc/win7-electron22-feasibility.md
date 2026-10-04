# Win7 兼容版（Electron 22）实现难度分析

> 结论先行：**可行，但这不是「换个 Electron 版本重打一次包」，而是一次真正的 API 回填（backport）。**
> 工作量集中在 3 处硬阻塞：主进程 Web 标准 API 缺失、taglib-wasm 依赖 Node≥22、渲染层 color-mix/pdfjs。
> 预估 **10～18 人日**（1 名熟手），日历周期 **2～4 周**，其中约 1/3 花在 Win7 真机验证。

---

## 1. 目标版本基线（实测确认）

| 项 | 当前 | Win7 兼容版 |
|---|---|---|
| Electron | **44.4.5** | **22.3.27**（Electron 22 是最后一个支持 Win7/8/8.1 的大版本，23 起移除） |
| Chromium | 132 级别 | **108.0.5359.215** |
| Node（主进程） | 22 | **16.17.1** |
| V8 | — | 10.8 |

实测方式：`npm i electron@22.3.27` 后用 `ELECTRON_RUN_AS_NODE` 与 xvfb 真实启动校验，输出
`{electron:22.3.27, chrome:108.0.5359.215, node:16.17.1}`。

**打包链路本身已验证通**：electron-builder 26.15.3 + Electron 22.3.27 成功产出
`win-unpacked/` 与 `E22Test Setup 1.0.0.exe`（NSIS）。也就是**打包不是难点，代码才是。**

---

## 2. 阻塞点清单（按严重度）

### 🔴 A. 主进程 Web 标准 API 全缺（硬阻塞，但已证明可改）

Electron 22 / Node 16 里下列 API **全部 undefined**（已逐一实测）：

| API | Electron 22 实测 | 本项目用量 | 影响 |
|---|---|---|---|
| `protocol.handle` | ❌ undefined | **3 处** | `app://` `asset://` `app-cover://` 三个协议全挂 → **应用直接起不来** |
| `net.fetch` | ❌ undefined | 1 处 | 在线封面代理（防盗链 Referer 伪装）失效 |
| 全局 `fetch` | ❌ undefined | 3 处 | `ipc.ts` http 通道、`sidecar.ts` 的 `POST /cmd` 与 SSE `/events` 全挂 |
| `Response` / `Request` | ❌ undefined | **12 处** | 协议处理器返回值形态全部不合法 |
| `Readable.toWeb` | ❌ undefined | 2 处 | 音视频 Range 流式响应构造失败 |
| `response.body.getReader()` | ❌ undefined | 1 处 | SSE 消费循环不可用 |
| `webUtils.getPathForFile` | ❌ undefined | 4 处 | 文件拖放拿不到路径 |

**关键缓解**：Electron 22 仍有 `protocol.registerStreamProtocol` / `registerBufferProtocol`，
且 **`File.path` 还在**（实测 `'path' in new File(...)` 为 true，`electron.d.ts` 里
`interface File { path: string }` 仍在），拖放可退回 `file.path`。

> **我已做过可行性验证**：用 `registerStreamProtocol` 重写 `app://` 与 `asset://` 后，
> 真实的 `dist/` 在 Electron 22 里**完整渲染成功** ——
> `title=SilverMoon · 光影媒体库`、`.app-shell` 存在、主 JS 200 / 1,256,242 字节；
> `asset://` 的 Range 请求返回 **206** 且 `Content-Range: bytes 0-9/3223` 正确。
> → **协议层改造成本可控，且方案已跑通。**

涉及文件：`electron/protocols.ts`、`electron/ipc.ts`、`electron/sidecar.ts`、`electron/preload.ts`
外加 `scripts/build-electron.mjs` 的 `target: "node22"` → `node16`。

---

### 🔴 B. taglib-wasm 与 Node 16 根本不兼容（硬阻塞，需架构调整）

实测（`ELECTRON_RUN_AS_NODE` + Electron 22 的 Node 16.17.1）：

```
IMPORT OK
TAGLIB FAIL: EnvironmentError  Environment 'Node.js' Node.js v22.6.0 or higher is required.
             Current version: v16.17.1. Older versions lack WASI and Wasm exception handling.
             Required feature: WASI support.
```

- `taglib-wasm@2.3.0` engines: **`node >=24.0.0`**
- 即使退到 1.x，engines 仍是 **`node >=22.6.0`**（1.0.0～1.2.0 全都如此）
- Node 16 **没有 `wasi` 模块**（实测 `require('wasi')` → MODULE_NOT_FOUND），也**没有 `ReadableStream`**
- `forceWasmType: "wasi"` 是代码里写死的（`electron/tag-writer.ts:145`）

→ **「写音乐标签」功能在 Electron 22 上无解，除非换实现。**

**推荐解法（成本最低、架构最自然）**：把写标签下沉到 Rust 后端。
后端**已经在用 `lofty`**，且 `backend/src/osu.rs:895 write_tags()` 已有**经过验证的写盘实现**
（`Tag::save_to_path` + 内嵌封面）。只需：
1. 在 Rust 命令表新增 `write_tags` / `read_tags` 命令（复用 osu.rs 的写法，扩到全部字段）；
2. `electron/tags.ts` 的 `writeLocal` / `readLocal` 分支改走 sidecar RPC；
3. 保留 taglib-wasm 作为 Electron 44 版路径（构建期开关切换）。

代价：中断 `scripts/verify-music-tags.mjs` 那套「独立于 Electron 直测 tag-writer」的验证链，
需要为 Rust 侧补等价验证。预估 **2～4 人日**。

---

### 🟠 C. 渲染层：Chromium 108 缺 CSS/JS 特性

Chromium 108 实测支持情况：

| 特性 | 需要 | Chromium 108 实测 | 本项目用量 |
|---|---|---|---|
| `color-mix()` | Chrome 111 | ❌ **false** | **52 处 / 13 个文件** + `@m3e/web` 136 个文件 |
| `oklch()` | Chrome 111 | ❌ false | 仅 2 处（皮肤校验正则+提示文案，**非实际用色**） |
| `:has()` | Chrome 105 | ✅ true | 1 处 |
| 容器查询 | Chrome 105 | ✅ true | 0 |
| `structuredClone` | Chrome 98 | ✅ function | 2 处 |
| `Promise.withResolvers` | Chrome 119 | ❌ **undefined** | pdfjs 依赖，23 个文件 |
| `createImageBitmap` | 老旧 | ✅ function | 3 处 |
| fetch / Response | — | ✅ | 大量 |

两点后果：

1. **MD3 主题色会失真**。`@m3e/web`（Material Design 3 组件库）重度依赖 `color-mix()`，
   不支持的声明会被**静默丢弃** → 不会崩，但大量半透明/混色层级会变成错误颜色或透明。
   项目自身 13 个文件也有 52 处，其中 `BookReader.vue`（21 处）、`NovelReader.vue`（7 处）最集中。
   → 需要为 Win7 版预计算颜色变量或补 fallback。

2. **PDF 阅读器直接抛异常**。`pdfjs-dist@6.2.108`（engines `node>=22.13`）在
   `pdf.mjs` 与 `pdf.worker.mjs` 里调用 `Promise.withResolvers()`，
   渲染层里它是 undefined → **TypeError，PDF 功能不可用**。
   → 解法：降级 pdfjs 到老版本，或在 pdfjs 加载前打一个 `Promise.withResolvers` polyfill（**推荐，1 行**）。

> 附带：渲染层 JS **语法**没问题 —— 实测 Chromium 108 下 dist 正常加载执行，
> 现网 `dist/` 只用到 `??=` / `?.()` 等 Chrome 85+ 语法，Vite 6 的构建目标已足够低。

---

### 🟠 D. Rust 后端与启动器的 Win7 兼容

1. **Rust 官方 msvc target 自 1.78 起要求 Windows 10+**。
   本仓库 `rust-version = 1.82`，CI 用 `dtolnay/rust-toolchain@stable` +
   `x86_64-pc-windows-msvc` → **产物无法在 Win7 运行**。
   Win7 需改用 tier-3 的 `x86_64-win7-windows-msvc`（要 `-Z build-std`，nightly 或手动指定），
   CI 配置需单独一条。**这是后端侧最大的不确定项，务必先做 spike。**

2. **SMTC 是 Win10+ 的 WinRT API**。`backend/Cargo.toml` 里 `smtc-tokio` 已用
   `[target.'cfg(windows)'.dependencies]` 门控，但 `cfg(windows)` 在 Win7 目标上**仍然成立**，
   会照样链接。需要引入自定义 cfg（如 `win7` feature）把 `commands/smtc.rs` 的
   `imp::setup` / `set_media` / `set_playback` 整体短路为 no-op。

3. **现有启动器 exe 在 Win7 上根本加载不了** —— 实测其 PE 导入表含：
   ```
   DLL Name: api-ms-win-core-synch-l1-2-0.dll
     WaitOnAddress / WakeByAddressAll / WakeByAddressSingle   ← Windows 8+ 才有
   ```
   `WaitOnAddress` 是 Win8 引入的；Win7 上没有这个 API set 成员 → **启动器启动即失败**。
   必须用 win7 目标重编（Rust std 在该目标下会改用旧同步原语）。
   好消息：启动器其余部分（`SetLayeredWindowAttributes` / `CreateDIBSection` / GDI 自绘）
   都是 Win7 可用的，且**没有**用 DWM/Mica 之类 Win10+ 特性（已 grep 确认）。

---

## 3. 不需要担心的部分（降低预期风险）

- **打包工具链**：已验证 Electron 22 + electron-builder 26.15.3 能出 NSIS 安装包。
- **应用架构**：主进程 ↔ Rust sidecar 走 127.0.0.1 HTTP + SSE，与 Electron 版本无关。
- **Vue 3.5 / Pinia / vue-router**：都是纯浏览器兼容代码，实测正常渲染。
- **`Array.prototype.at` / `Object.hasOwn` / `crypto.randomUUID` / `AbortController`**：Node 16 与 Chromium 108 都有。
- **SQLite（rusqlite bundled）/ lofty / reqwest(native-tls)**：Win7 可用。
- **NSIS 安装器本身**：Win7 兼容。

---

## 4. 工作量拆分

| # | 工作项 | 人日 | 风险 |
|---|---|---|---|
| 1 | 双构建变体（单代码库 + 构建期开关，不 fork） | 0.5 | 低 |
| 2 | 主进程 API 回填（protocols / net / fetch / streams / webUtils） | 2～3 | 低（方案已验证） |
| 3 | taglib-wasm → Rust `lofty` 写标签下沉 | 2～4 | 中 |
| 4 | 渲染层 `color-mix` fallback + pdfjs polyfill | 2～4 | 中 |
| 5 | Rust win7 target + SMTC 门控 + 启动器重编 | 2～4 | **高** |
| 6 | Win7 真机/虚拟机验证 + 回归 | 2～3 | 中 |
| | **合计** | **10～18 人日** | |

---

## 5. 推荐实施策略

1. **单代码库双产物**，不做 fork：用环境变量（如 `SM_TARGET=win7`）在
   `electron-builder` 配置与 esbuild/vite 构建期切换，避免两份代码长期漂移。
   新增 `electron-builder.win7.yml`（`electronVersion: 22.3.27`、独立 output 与 artifactName）。
2. **先做 spike 再排期**：优先验证「Rust `x86_64-win7-windows-msvc` 能否编出可运行的
   `silvermoon-server.exe`」——这是唯一可能推翻整个方案的点。
3. **验证顺序**：协议层 → 后端 Win7 编译 → taglib 下沉 → 渲染层样式 → 真机回归。
4. **必须用真实 Win7 验证**。Wine 不可靠（本机 Wine 连 NSIS 的自解压都跑不起来），
   CI 也没有 Win7 runner，这一步只能人工/虚拟机完成。

---

## 6. 必须提前认知的代价

- **Electron 22 已 EOL**，Chromium 108 意味着长期不修的安全漏洞。
  该版本应明确定位为「兼容 Win7 的补充包」，**不建议作为默认分发版本**。
- 若接受改用 Flutter 宿主（仓库里 `apps/mobile` 与 `docs/mobile-spec` 已有相关基础，
  `archive/electron-desktop/ARCHIVE.md` 也提到过 Windows 侧 Flutter 重构方案），
  Win7 目标反而更省事；但那属于另一条路线，不在本次 Electron 22 诉求内。

---

## 附：本文结论的实测依据

- Electron 22.3.27 真实启动 + API 探针（`protocol.handle`/`net.fetch`/`webUtils`/`fetch`/`Response` 全 undefined）
- taglib-wasm 在 Node 16.17.1 下初始化报 `EnvironmentError ... WASI support`
- Electron 22 下用 `registerStreamProtocol` 重写 `app://` 后，真实 `dist/` 渲染成功；`asset://` Range 返回 206
- Chromium 108 渲染探针：`colorMix=false`、`withResolvers=undefined`、`structuredClone=function`、`has=true`
- electron-builder 26.15.3 + Electron 22.3.27 成功产出 NSIS 安装包
- 启动器 exe `objdump -p`：导入 `api-ms-win-core-synch-l1-2-0.dll` 的 `WaitOnAddress` 系列（Win8+）
