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

静态断言六组：

1. **主进程产物** —— 不残留 `protocol.handle` 直调、已内联 undici、无 taglib-wasm 硬依赖
2. **语法** —— 可被 Node 16 解析
3. **Windows 二进制** —— `objdump` 检查**不得**导入 Win8+ 符号（14 个符号 + 3 类 API set
   + 子系统版本 ≤ 6.1）。
   > ⚠️ **缺 `objdump` 时本检查直接失败**，不再降级成「跳过」。
   > 上一版是跳过 —— 那等于闸门根本不存在，而 CI 的 win7 作业本来就固定装了
   > binutils，跳过只会制造「检查过了」的错觉。
4. **[4.5] `parking_lot_core` Win7 补丁**（本轮新增）—— 防第 6 节那个
   「运行期 apiset 探测 → `0xC0000005`」的崩溃回归。四道断言：
   - 补丁文件在位，且 `create()` **函数体**内含版本闸门；
   - 闸门位于 apiset 探测**之前**（顺序错了等于没打）；
   - 用 `RtlGetVersion` 而非会谎报的 `GetVersionEx`；
   - `backend/Cargo.toml` 有 `[patch.crates-io]` 转发，且**产物**里含
     `RtlGetVersion` 导入（证明补丁真进了二进制，不只是"文件里有"）。
   > 写这组检查时的两个坑，都记在脚本注释里：
   > ① **不能扫二进制字符串**判断「有没有 apiset 探测」—— 打了补丁后
   > `api-ms-win-core-synch-l1-2-0.dll` 这个字面量**依然在二进制里**
   > （`&'static str` 编译器不会删），会假阳性；
   > ② **判定顺序前必须先剥注释** —— 补丁在函数体开头引用上游代码写的
   > 解释性注释里也含 `GetModuleHandleA(b"api-ms-win-core-synch...`，
   > 不剥注释就会命中注释、报出「闸门晚于探测」的假失败。
   >
   > 这组检查做过**负向测试**：手动把补丁的闸门删掉后，脚本确实报错。
5. **启动诊断设施在位** —— 两个 exe 内置启动轨迹（`silvermoon-boot-*` 指纹）、
   主进程产物含 `boot-diagnostics` 收集逻辑（见第 8 节）
6. **渲染层产物**存在

### 静态闸门的**能力边界**（重要，别误以为它全能）

`objdump -p` 只能看到 **PE 导入表**。以下三类 Win8+ 依赖它**查不出来**：

- **静态链接的 C 代码**（`rusqlite` 的 bundled SQLite、CRT 自身）在运行期通过
  `GetProcAddress` 动态解析的调用；
- 通过函数指针 / 延迟加载解析的调用；
- **运行期按名字探测 API set**（`GetModuleHandleA("api-ms-win-*-l1-2-0.dll")`）。
  —— 这正是第 6 节那个真实崩溃的形态：导入表**完全干净**，
  但 Win7 上执行到探测那一句就 AV。

第 3 类靠**第 4.5 组的定向检查**兜（只覆盖已知的那一处），
其余只能靠**运行时诊断**（第 8 节的启动轨迹）。三者互补，不能互相替代。

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

### ❌ 真实 Win7 实测结果（第一次上机）

以上全部是 Linux + Electron 22 的**等价**验证。真机跑第一轮就暴露出两个崩溃 ——
这正说明「静态检查全绿」与「能在 Win7 上跑」是两件事。

环境：`OS 版本 6.1.7601`（Win7 SP1，区域 2052）。

| 进程 | 现象 | 证据 |
| --- | --- | --- |
| 启动器 `silvermoon-splash.exe` | **APPCRASH**，双击快捷方式即崩 | `异常代码 c0000005`、`异常偏移 0x5da3`、`故障模块 = silvermoon-splash.exe` |
| 后端 `silvermoon-server.exe` | **静默退出** | Electron 侧 `侧车退出：code=3221225477`（= `0xC0000005`） |

两点关键判读：

1. **`0xC0000005` 是访问违例，不是加载失败**（后者是 `0xC0000135` 缺 DLL /
   `0xC000007B` 镜像无效）。也就是说：**符号能解析、进程能起来**，
   死在**执行期某一步**。这与「导入表里有 Win8+ 符号导致加载即失败」是
   **不同的**失败类别 —— 第 5 节的静态闸门拦不住这一种。
2. **两个崩溃都在 Rust 进程里**，且启动器是「Electron 起来之前」就崩 ——
   那段时间 Electron 侧完全没有观测机会。这就是第 8 节那套诊断设施存在的原因。

> 已知有效信息：**手动到安装目录双击本体（`SilverMoon.exe`）能打开**
> —— 即 Electron 主进程 + 渲染层本身没问题，问题集中在两个原生 Rust 进程。

### ✅ 根因已定位并修复（第二次上机，2026-10-05）

第一轮上机后做了「主动打点」的诊断构建（第 8 节），结果**两个日志文件都
根本不存在** —— 不是空文件，是**没有生成**。这个「空结果」本身就是最强线索：

> 打点是 `main()` 的**第一条语句**。文件不存在 ⇒ 进程**连 main 都没进** ⇒
> 崩在**加载期 / CRT 静态构造期**，早于一切 Rust 代码。

于是绕开运行期观察，改从**二进制静态分析**入手，结论如下。

#### 结论：`parking_lot_core` 在运行期探测 Win8+ 的 API set

`parking_lot_core` 0.9.12 的 Windows 线程停靠后端在选择实现时会做一次探测：

```rust
// src/thread_parker/windows/waitaddress.rs:22
pub fn create() -> Option<WaitAddress> {
    let synch_dll = GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll\0");
    if synch_dll == 0 { return None; }        // 看起来有 NULL 检查……
    let WaitOnAddress = GetProcAddress(synch_dll, b"WaitOnAddress\0")?;
    ...
}
```

`api-ms-win-core-synch-l1-2-0.dll` 是一个 **API Set 桩名**，而 API Set
重定向（apiset schema）是 **Windows 8 才引入**的机制：

| 系统 | `GetModuleHandleA("<apiset 名>")` 的行为 |
| --- | --- |
| Win8+ | 经 apex 表重定向到 `kernel32.dll`，正常返回句柄 |
| **Win7** | `kernelbase!GetModuleHandleA` → `BasepGetModuleHandleExW` 解析 apiset 时读到**未初始化的表** → **`0xC0000005` 访问违例** |

**不是返回 NULL，是直接崩。** 所以那句 `if synch_dll == 0 { return None; }`
**永远执行不到**，回退到 `KeyedEvent`（用 ntdll 的 `NtCreateKeyedEvent`，
XP+ 就有）的 `else if` 分支根本没机会运行。

#### 为什么这一条解释了**全部**观测现象

| 观测 | 解释 |
| --- | --- |
| `0xC0000005` 而非 `0xC0000135` | `GetModuleHandle` 不查磁盘，走的是 apiset 解析路径 |
| **轨迹日志一个都没生成** | 这条路在 CRT 静态构造期被触发，**早于 `main`** |
| 每次启动稳定复现、耗时一致 | 确定性的代码路径 |
| 第 5 节的 `objdump` 导入表检查**全绿** | `WaitOnAddress` 等由 `GetProcAddress` **动态**解析，**不在导入表**；名字只以字符串常量存在 |
| 两个 Rust 进程都崩 | 两者都链了 Rust std → `parking_lot_core` |

#### 为什么「只有 win7 target 会崩」

这是整件事最反直觉的一点。对比同一份代码的两种构建：

| 构建目标 | `api-ms-win-core-synch-l1-2-0` 的呈现方式 | Win7 上的结果 |
| --- | --- | --- |
| `x86_64-pc-windows-gnu`（稳定版） | **静态导入**（在 PE 导入表里，带 `WaitOnAddress` 等） | 加载器报 `0xC0000135` 缺模块 —— **干净失败**，不会 AV |
| `x86_64-win7-windows-gnu`（本项目用的 tier-3） | **运行期 `GetModuleHandleA` 探测**（导入表里 0 次） | 走进 apiset 解析 → **`0xC0000005`** |

**换句话说：为了 Win7 而选的 tier-3 target，反而把这个 bug 从「干净的加载
失败」变成了「加载期访问违例」。** 而 CI 跑在 Win10+ 的 runner 上，
`GetModuleHandleA` 走的是正常 apiset 重定向，**永远看不到这个问题**。

> 附带收获：这也**实证**了「`objdump` 只能看导入表」的能力边界
> （第 5 节）。这个 bug 用导入表检查**原理上**就查不出来。

#### 修法：`[patch.crates-io]` 打一个最小补丁

`parking_lot_core` 0.9.12 已是最新，上游这条路径对 Win7 就是坏的
（它的 CI 跑 Win10+，看不到）。所以用 `[patch.crates-io]` 把 crate 指向
仓库内的 `backend/patches/parking_lot_core/`，**只改一处**：

```rust
// waitaddress.rs —— 函数体开头，仅新增这一段
#[cfg(windows)]
{
    use super::bindings::os_version;
    let is_win7_or_lower = match os_version() {
        Some((major, minor)) => major < 6 || (major == 6 && minor <= 1),
        None => true,      // 读不到版本时保守按 Win7 处理
    };
    if is_win7_or_lower {
        return None;       // 强制回退 KeyedEvent（XP+ 可用）
    }
}
```

* 版本判断用 **`RtlGetVersion`**（读 PEB 真实版本），**不用** `GetVersionEx`
  —— 后者从 Win8.1 起会对没有 manifest 的进程**谎报** 6.2。
* 判据放在**运行时**而不是 `cfg`：`target_os = "windows"` 覆盖 Win7~Win11，
  编译期分不出来（这也是项目里 Win7 兼容要靠显式 `win7` feature 的同一个原因）。
* 其余逻辑与上游逐字一致。非 Win7 系统行为**完全不变**。

**维护提示**：升级 `parking_lot` / `parking_lot_core` 时，
**必须**检查 `waitaddress.rs` 是否变动，并把补丁重新应用；
`verify:win7` 里有一组检查专门防它被悄悄覆盖（见第 5 节 [4.5]）。

### ⚠️ 仍待真机确认

- **补丁后的构建在真实 Win7 上能否启动** —— 本轮修复尚未上机验证。
- **完整 NSIS 安装包**：`--dir` 产物已验证，但容器里 Wine 无法跑自解压，
  安装步骤未走完。Windows CI（`windows-latest`）可直接产出。
- 启动器与主程序的**握手**在 Win7 上的表现（命名管道 + GDI 自绘分层窗口）。
- PDF 阅读器在 Chromium 108 下的实际渲染（polyfill 逻辑已就位，未跑真机）。
- `color-mix()` 缺失导致的 MD3 配色偏差程度（**不会崩，但会失真**）。

### 已知遗留

- Electron 22 已 **EOL**，Chromium 108 有长期未修的安全问题。**不要作为默认分发版本。**
- `scripts/verify-music-tags.mjs` 等既有验证脚本仍针对 taglib 路径，
  Win7 版需要为 Rust 侧补等价验证（尚未写）。
- `color-mix()` 回退见第 7 节；`@m3e/web` 的禁用态/阴影类混色依赖运行期补丁，
  真实 Win7 上的观感仍待确认。
- 修复只覆盖了 `parking_lot_core` 这一处。全仓扫描过一遍依赖源码，
  **运行期 apiset 探测只有这一处**（其余 `api-ms-win-*` 引用都来自
  `windows-sys` / `windows` crate 的自动生成绑定，是静态声明，无运行期探测）。
  但**不排除**静态链接的第三方 C 代码里还有别的漏网之鱼 —— 这类只能靠上机实测。

---

## 7. `color-mix()` 视觉回退

### 问题

`color-mix()` 要 **Chrome 111+**，Chromium 108 直接**静默丢弃**该声明 ——
不报错、不警告，只在真机表现为「大量半透明层级变透明 / 发灰」。
而开发机是 Chromium 132，**本地永远复现不出来**。

本项目用量：自己源码 **45 处 / 13 个文件**，`@m3e/web`（MD3 组件库）
另有 **94 处**（全部形如 `color-mix(in srgb, C p%, transparent)`）。

### 方案：构建期 + 运行期两层

纯 CSS 无法表达「把某变量的透明度乘一下」（相对颜色语法要 Chrome 119+），
只能预先算成 `rgba()`；而 token 是动态的（种子色 / 皮肤 / 深浅色都会改），
所以分两层：

| 来源 | 处理 |
|---|---|
| 项目自己的 `.vue` / `.css` | **构建期**改写为 `var(--sm-mix-X-p, rgba(...))` |
| `@m3e/web` 的 CSS-in-JS | **运行期**补 `CSSStyleSheet.replaceSync`，注入前改写 |
| 动态 token 变化 | **运行期**从 `getComputedStyle` 重算并写 `:root` |

关键实现点（都踩过）：

1. **换算语义是预乘 alpha**。`color-mix(in srgb, C p%, transparent)` ≡
   「C 的 alpha × p/100」。源色自身可能半透明（`--md-sys-color-scrim` 是
   `rgba(0,0,0,0.7)`），所以是**乘积**不是直接取百分比：
   0.7 × 60% = **0.42**，不是 0.6。
2. **只给一侧权重时，另一侧补 `100% - 给定值`**（CSS Color 5 规则）。
   漏了这条会把 `C 12%, transparent` 算成 `12/(12+50) ≈ 0.194` 而不是 0.12。
3. **`MutationObserver` 的自触发死循环**。同步会写 `documentElement` 的
   `style`，而 observer 正监听该属性 —— 无条件写就是「写 → 观察 → 再写」，
   实测表现为**页面永远加载不完**。必须只在值真的变化时才写。
4. **`@m3e/web` 的 var 是三层嵌套的，必须递归解**。实测形态：

   ```css
   color-mix(in srgb, var(--m3e-text-button-disabled-container-color,
       var(--m3e-button-disabled-container-color,
           var(--md-sys-color-on-surface, #1D1B20))) 12%, transparent)
   ```

   只解**一层**时拿到的是另一个 `var(...)`（不是具体颜色），整条调用被判为
   「无法换算」而原样保留 → Chromium 108 上依然失效。
   实测：**50 个 shadow root 里 29 个残留** `color-mix`，而当时所有单测都是绿的
   （测试里的 var 只有一层，是「我以为」的形态）。

   修复：`resolveVarChain()` 递归解 var 链；权重也支持嵌套
   （`var(--a, var(--b, 20%))`，且会先读变量实时值 —— m3e 会设
   `--m3e-*-opacity: 8%`）。修完实测 **50 个 shadow root、0 残留**。

5. **worker / 组件级 token 要单独处理**：
   - `--reader-fg` / `--reader-bg` 由 `BookReader` 的 `:style` 写在组件根节点，
     `theme.css` 里查不到 → 构建期只能给 `transparent` 兜底，
     真实值由 `syncDerivedVarsForElement` 运行期写入；
   - `NovelReader` 的 7 处 `currentColor` 混色取决于元素自身颜色 →
     由 `syncCurrentColorVars` 按当前阅读主题写入。

### 开关与产物隔离

回退只在 `SM_COLORMIX_FALLBACK=1` 时启用（`npm run build:renderer:win7`）。
**现代构建的 CSS 逐字节不变**，零回归风险：

| 产物 | `color-mix` | `--sm-mix-*` |
|---|---|---|
| `npm run build:renderer`（正式版） | 45 | 0 |
| `npm run build:renderer:win7` | 0 | 45 |

### 验收

```bash
npm run build:renderer:win7 && npm run verify:colormix -- --mode=win7
npm run build:renderer       && npm run verify:colormix -- --mode=modern
```

`verify:colormix` 检查：Win7 产物不得有裸 `color-mix`、每处 `--sm-mix-*`
兜底必须是合法 `rgba` 或 `transparent`、alpha 落在 (0,1]、
且 scrim 的兜底必须是 `0.42`（钉住「乘积」语义）；现代产物则必须**保留**
原生 `color-mix` 且无 `--sm-mix-*` 泄漏。

单元测试另有四份：
- `src/utils/__tests__/colorMixMath.test.ts`（21 项）—— 解析与换算
- `src/utils/__tests__/colorMixRuntime.test.ts`（20 项）—— 运行期改写、可重入性、嵌套 var
- `src/utils/__tests__/colorMixParity.test.ts`（4 项）—— **构建期插件与运行期
  实现的一致性**（两边各有一份实现，算出的 rgba 必须逐字相同，否则主题切换
  瞬间颜色会跳变）
- `src/utils/__tests__/colorMixM3e.test.ts`（8 项）—— 从**真实** `@m3e/web`
  bundle 抽 94 条 color-mix（按 m3e 语义做 `${`` + `...}` 插值替换，得到运行期等价
  CSS），断言 **100% 可改写**。这是拦住「只解一层 var」那类缺陷的关键用例：
  它测的是**库的真实形态**，而不是自己的假设。

### 实测

在真实 Electron 22.3.27（Chromium 108）下确认：
`CSS.supports('color','color-mix(...)') === false`，
而 `:root` 上被写入 `--sm-mix-md-sys-color-primary-12 = rgba(59, 96, 143, 0.12)`
（base `#3b608f` × 12%）、`--sm-mix-md-sys-color-scrim-60 = rgba(0, 0, 0, 0.42)`
（0.7 × 60%），元素实际渲染出的 background 即为该 rgba。

---

## 8. 启动诊断（崩溃定位）

### 问题

两个原生进程都是 `#![windows_subsystem = "windows"]` 的 **GUI 程序** ——
**没有控制台**。打包后的 Win7 上：

- `eprintln!` / `println!` 的输出**没有任何地方可看**；
- panic hook 写文件的前提是 **panic 发生了**，而访问违例（`0xC0000005`）
  是**硬崩溃**，不走 panic 通道，hook 根本不会被调用；
- 若是更早的加载期失败，连 Rust 运行时都还没接管。

结果就是进程**静默消失**，Electron 侧只能看到一个退出码 `3221225477`。

### 方案：不依赖崩溃处理器，改成**主动打点**

每个阶段**进入之前**先写一行到日志并 `flush` 到磁盘。进程若在下一步死掉，
日志的**最后一行就是「最后成功进入的阶段」**，直接圈定崩溃区间。

```
[+     0ms] STEP   启动器已进入 main（Rust 运行时启动成功）
[+     1ms] INFO   可执行文件：D:\SilverMoon\resources\silvermoon-splash.exe
[+     2ms] STEP   定位 Electron 主程序
[+     3ms] INFO   Electron = D:\SilverMoon\SilverMoon.exe
[+     3ms] STEP   创建命名管道（handshake::listen）
[+     4ms] INFO   命名管道已就绪                       ← 若日志到此为止，
[+     4ms] STEP   解析主题偏好（读 %APPDATA% 设置 + 注册表亮暗）  ← 崩溃点就在这一段
```

### 日志落在哪

**优先写到可执行文件旁边**（用户知道应用装在哪，一眼能找到），
同时**额外**写一份到 `%TEMP%` 兜底：

| 进程 | 文件名 | 位置（按优先级） |
| --- | --- | --- |
| 启动器 | `silvermoon-boot-splash.log` | ① `silvermoon-splash.exe` 同目录 ② 当前目录 ③ `%TEMP%` |
| 后端 | `silvermoon-boot-backend.log` | ① `silvermoon-server.exe` 同目录 ② `<数据目录>\logs\` ③ `%TEMP%` |

> **设计权衡**：第一版只写 `%TEMP%`，但 `%TEMP%` 在 Win7 上是
> `C:\Users\<用户>\AppData\Local\Temp`，**资源管理器默认不显示隐藏目录**。
> 多写几份的代价是每次启动几十字节，换来的是「无论权限与习惯如何，总有线索在」。
>
> 文件用**追加**模式（两次崩溃可对照），每次启动会写一条醒目的
> `===== SilverMoon <tag> 启动会话 =====` 分隔头，避免把两次启动的行读串。

### 覆盖的阶段

**启动器**（`splash/src/main.rs`）：

```
进入 main → 定位 Electron → 建命名管道 → 读主题设置（文件 + 注册表）
→ 创建窗口（RegisterClassW / CreateWindowExW / GDI）→ 拉起 Electron
→ 后台等 READY → 消息循环（每帧绘制）→ 销毁窗口
```

**后端**（`backend/src/main.rs` + `lib.rs`）：

```
进入 main → 安装 panic hook → run() 开始
→ setup 闭包进入 → open_db（细分：解析路径 / 建目录 / 开库 / 建表）
→ SMTC（Win7 版会显式记「跳过」）→ 扩展框架 → 托盘 → 番剧 → Pixiv
→ IPC 服务启动并阻塞 → run() 返回
```

`open_db` 之所以拆得最细：`rusqlite` 开了 **`bundled`**，SQLite 的 C 代码被
静态编进二进制，其中的 `GetSystemTimePreciseAsFileTime` 等 Win8+ 调用
**不会出现在 PE 导入表里**（由 CRT 动态解析），第 5 节的 `objdump` 闸门
原理上就查不出来 —— 只能靠运行期定位。

### 崩溃时应用会做什么

Electron 在侧车 `exit` 事件里自动：

1. 收集三份文件（后端轨迹 / 启动器轨迹 / `lumiluna_login_debug.log`）+ `main.log` 尾部；
2. 从轨迹里**提取最后一行 `STEP`** 写进日志；
3. **落盘**到 `<数据目录>\logs\boot-diagnostics.txt`；
4. 在崩溃弹窗里**直接显示**「崩溃前最后阶段」与诊断文件路径。

这样用户不需要去 `%TEMP%` 里翻文件、也不需要判断该看哪一份。

若轨迹文件**一个都没有**，说明崩溃发生在进程进入 `main` 之前
（加载期 / 运行时初始化）—— 这与「跑到一半崩」是完全不同的两类问题，
日志里会明确标注。

### 怎么用（Win7 收尾步骤）

1. 装上带诊断的构建，**双击快捷方式**，等它崩（或正常起来）；
2. 打开**安装目录**（安装时若改过路径，就是那个目录），找
   `silvermoon-boot-splash.log` 与 `silvermoon-boot-backend.log`；
   找不到就去 `%TEMP%`（在地址栏直接粘 `%TEMP%` 回车即可）；
   或者看 `<数据目录>\logs\boot-diagnostics.txt`（应用崩溃弹窗里给了完整路径）；
3. 把日志**最后 20 行**发回来即可 —— 最后一行 `STEP` 就是崩溃区间下界。

### 如何彻底关闭

设环境变量 `SILVERMOON_BOOT_TRACE=0`（`false` / `off` 同样识别）。
默认**开启**：开销是每次启动写十几行，而 Win7 排查期正需要它。
