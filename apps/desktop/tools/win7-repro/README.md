# Win7 崩溃最小复现程序

**结论已经拿到，这个目录是留档 + 回归用的**，平时不需要跑。

## 它复现的是什么

`parking_lot_core` 0.9.12 在探测 Win8+ 的 `WaitOnAddress` 之前，会先按**名字**
取 apiset 模块句柄：

```rust
// src/thread_parker/windows/waitaddress.rs:25
let synch_dll = GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll\0");
if synch_dll == 0 { return None; }        // 看起来有 NULL 检查……
```

`api-ms-win-core-synch-l1-2-0.dll` 是 **API Set 桩名**，API Set 重定向是
**Win8 才引入**的。在 Win7 上，`kernelbase!GetModuleHandleA` 解析 apiset 名时
会读一张未初始化的表 —— **不是返回 NULL，而是直接 `0xC0000005`**。

于是那句 NULL 检查永远执行不到，回退到 `KeyedEvent`（XP+ 可用）的分支
根本没机会跑。进程在 **CRT 静态构造期**死掉，**早于 `main`** ——
所以任何「在 main 里打点」的日志都会一个字节都写不出来。

## 文件

| 文件 | 用途 |
| --- | --- |
| `repro.c` | C 版。隔离「**OS 的** `GetModuleHandleA` 对 apiset 名安不安全」。用 mingw-w64 交叉编译，不依赖 Rust 工具链的目标支持，能干净地把「OS 问题」和「工具链问题」分开 |
| `repro-rs-main.rs` | Rust 版。**逐字照抄** `parking_lot` 的探测序列，复现「parking_lot 的路径是不是崩溃点」 |
| `Cargo.toml.template` | Rust 版的 `Cargo.toml` 模板 |

## 怎么编

### C 版

```bash
# 需要 mingw-w64；64 位和 32 位都编，便于对照
x86_64-w64-mingw32-gcc -O1 -Wall -o repro-x64.exe repro.c
i686-w64-mingw32-gcc   -O1 -Wall -o repro-x86.exe repro.c
```

### Rust 版

把 `repro-rs-main.rs` 放到 `src/main.rs`，`Cargo.toml.template` 放到
`Cargo.toml`（去掉 `.template` 后缀），然后：

```bash
# 关键：用**和 SilverMoon 相同**的 tier-3 target
cargo +nightly build --release -Z build-std=std,panic_abort \
    --target x86_64-win7-windows-gnu

# 对照用：稳定版 target（行为不同，见下）
cargo build --release --target x86_64-pc-windows-gnu
```

## 怎么读结果

程序每步之前先落盘一行并 `flush`，所以**日志最后一行就是崩溃区间的下界**。
日志写两处（exe 同目录 + `%TEMP%`）：

* `repro-trace.log`（C 版）
* `repro-rs-trace.log`（Rust 版）

预期（在真实 Win7 上）：

| 构建 | 预期结果 |
| --- | --- |
| C 版（任一架构） | **能跑完**。C 程序不碰 apiset 名，说明问题不在「OS 不支持这个 API」本身 |
| Rust 版，`x86_64-pc-windows-gnu` | 加载期失败，`0xC0000135`（缺模块）。apiset 名被编成了**静态导入** |
| Rust 版，`x86_64-win7-windows-gnu` | **`0xC0000005`**，且 trace 里连第一行都没有 |

## 为什么这个区别重要

同一份代码，两个 target 的**失败方式完全不同**：

| | `x86_64-pc-windows-gnu`（稳定） | `x86_64-win7-windows-gnu`（本项目） |
| --- | --- | --- |
| apiset 在导入表 | **1 次**（静态导入） | **0 次** |
| 实际行为 | 加载器报缺 DLL，**干净失败** | 运行期探测 apiset → **访问违例** |

**为了 Win7 而选的 tier-3 target，反而把这个 bug 从「干净的加载失败」
变成了「加载期访问违例」。**

验证方法（Linux 上就能做，不需要 Win7）：

```bash
objdump -p repro-rs.exe | grep -c 'api-ms-win-core-synch'          # → 1
objdump -p <win7 target 产物> | grep -c 'api-ms-win-core-synch'    # → 0
```

## 它现在还有什么用

* **回归对照**：`scripts/verify-win7-build.mjs` 的 [4.5] 组检查的是**源码**，
  这个程序可以在真机上**端到端**验证补丁确实解决了问题。
* **新依赖的体检**：以后如果有人引入新的依赖，怀疑它也有运行期 apiset
  探测，可以照 `repro-rs-main.rs` 的写法快速搭一个验证。

## 留档：实测结论（2026-10-05）

在 `OS 6.1.7601` 上：

* SilverMoon 打了诊断构建后，**`silvermoon-boot-backend.log` 与
  `silvermoon-boot-splash.log` 都没有生成** —— 这就是「崩在 `main` 之前」
  的直接证据。
* 静态分析定位到 `parking_lot_core` 的 apiset 探测，见
  `backend/Cargo.toml` 的 `[patch.crates-io]` 注释与
  `doc/win7-electron22.md` 第 6 节。
* 补丁已合入，见 `backend/patches/parking_lot_core/`。
