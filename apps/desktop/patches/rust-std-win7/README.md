# libstd Win7 补丁（`rust-std-win7`）

## 这个补丁修什么

**Rust 标准库自己**在 `target_vendor = "win7"` 时有一段代码，会在 Win7 上
**直接访问违例（0xC0000005）**，且因为它跑在 **CRT 静态构造期**（早于 `main`），
导致：

- 任何链接 libstd 的 exe **双击即「已停止工作」**；
- **一个字节的日志都写不出来**（所以「看日志」这条路一开始就是死的）；
- `objdump -p` 查导入表**完全看不出问题**（用的是 `GetModuleHandleA`，不是静态导入）。

具体位置：`library/std/src/sys/pal/windows/compat.rs` 的 `load_synch_functions()`：

```rust
#[cfg(target_vendor = "win7")]
pub(super) fn load_synch_functions() {
    fn try_load() -> Option<()> {
        const MODULE_NAME: &CStr = c"api-ms-win-core-synch-l1-2-0";
        let library = unsafe { Module::new(MODULE_NAME) }?;   // → GetModuleHandleA
        ...
    }
    try_load();
}
```

`Module::new` 内部是：

```rust
pub unsafe fn new(name: &CStr) -> Option<Self> {
    let module = unsafe { c::GetModuleHandleA(name.as_ptr().cast::<u8>()) };
    NonNull::new(module).map(Self)          // ← 这个 NULL 兜底永远执行不到
}
```

## 为什么在 Win7 上会崩

**API Set 重定向（apiset schema）是 Windows 8 才引入的机制。**

`api-ms-win-core-synch-l1-2-0` 是一个 **apiset 桩名**，不是真实文件名。
Win8+ 的 `kernelbase!BasepGetModuleHandleExW` 会查 apiset schema 表把它
映射到真实模块；Win7 没有这张表，解析时会读一块**未初始化的内存**，
于是 **不是返回 NULL，而是直接抛 `STATUS_ACCESS_VIOLATION`**。

关键在于：代码写了 `NonNull::new(module)` 这个 NULL 兜底，看起来很稳妥，
**但它对 AV 无效** —— 进程在 `GetModuleHandleA` 里就死了，根本轮不到判断。

## 为什么「直接跳过」是语义正确的

`WaitOnAddress` / `WakeByAddressSingle` 是 **Windows 8 才引入的 API**，
对应的 apiset 在 Win7 上**本来就不存在**。

所以在 Win7 上，这段代码唯一正确的结果**本来就是「加载失败」**。
原来的实现把「应当失败」变成了「崩溃」；补丁把它改回「干净地失败」：

```rust
#[cfg(target_vendor = "win7")]
pub(super) fn load_synch_functions() {}
```

下游 `compat_fn_optional!` 生成的 `option()` 会照常返回 `None`
（`PTR` 保持 `null_mut()`），调用方走既有 fallback 路径 ——
**与 Win8 上探测失败的语义完全一致**。

## 为什么不加运行期版本判断

一度考虑过用 `RtlGetVersion` 判断「是不是 Win7 再跳过」。最终没采用：

- 这个函数**只**在 `target_vendor = "win7"` 时参与编译，该 target 的
  唯一目的就是跑在 Win7 上 —— 再加一层运行期判断是多余的；
- 多一层判断就多一个「判断被绕开就重新崩」的隐患；
- 直接 no-op 的攻击面更小。

另外注意 `RtlGetVersion` 才是读真实版本的做法（`GetVersionEx` 从 Win8.1 起
对无 manifest 的进程会撒谎，报 6.2）—— 但这里根本不需要版本判断。

## 怎么工作的

```
scripts/run-win7-build.mjs
  └─ scripts/setup-win7-toolchain.mjs
       ├─ 备份 sysroot 的 library/ → library.silvermoon-orig/
       ├─ 复制一份到 $TMPDIR/silvermoon-win7-std/library
       ├─ patch -p1 < patches/rust-std-win7/compat.rs.patch
       ├─ 校验目标文件里出现标记字符串「SilverMoon patch」
       └─ 把 sysroot/library 换成指向副本的符号链接
  └─ cargo +nightly build ... -Z build-std=std,panic_abort
  └─ 还原 sysroot/library（含 SIGINT 处理）
```

**为什么必须替换 sysroot 目录**：`-Zbuild-std` 没有「指定源码目录」的参数，
它固定读 `$(rustc --print sysroot)/lib/rustlib/src/rust/library`。
试过 `--config` 覆盖 —— 不生效。

**为什么要还原**：不还原会污染本机全局工具链，影响其他项目。
`run-win7-build.mjs` 用 `finally` + `SIGINT` 双保险。
若被强杀，跑 `npm run win7:restore-sysroot` 补救。

## 上游变动后如何重建补丁

补丁用 `patch(1)` 应用（带上下文），上游改了 `compat.rs` 会**显式失败**
而不是静默改错地方 —— 这是刻意的。

重建步骤：

```bash
# 1) 先还原 sysroot，拿到原始文件
npm run win7:restore-sysroot

# 2) 手工编辑一份副本：把 library 复制出来，改 compat.rs 里的
#    load_synch_functions 为 no-op（保留上面那段说明注释）

# 3) 重新生成补丁（注意路径要用相对形式）
diff -u \
  --label a/std/src/sys/pal/windows/compat.rs \
  --label b/std/src/sys/pal/windows/compat.rs \
  <原始 compat.rs> <改过的 compat.rs> \
  > patches/rust-std-win7/compat.rs.patch

# 4) 验证
npm run build:rust:win7
node scripts/verify-win7-build.mjs
```

## 验证方式（不依赖上机）

`scripts/verify-win7-build.mjs` 里有专门的闸门组 `[4.6]`，对**产物**做断言：

- 产物里 **不能**出现 `api-ms-win-core-synch-l1-2-0` 这个字符串；
- 所有 `GetModuleHandleA` 调用的参数**只能是**真实模块名。

这条闸门是**产物级**的，所以即使源码补丁被误删、或被上游改动绕过，
CI 也会红。

## 这个 bug 与 `parking_lot_core` 的关系

**同一个机制，两个不同的受害者。**

`patches/parking_lot_core/` 修的是 crates.io 上的 `parking_lot` crate，
它有**一模一样**的探测代码（`GetModuleHandleA("api-ms-win-core-synch-l1-2-0.dll")`）。

两者互相独立：

| | 触发者 | 何时执行 | 影响 |
| --- | --- | --- | --- |
| `parking_lot_core` | 直接依赖它的 crate（如后端） | 首次用到其 `Mutex` 时 | 只有后端 |
| **libstd `compat.rs`** | **所有链接 libstd 的 exe** | **CRT 静态构造期（早于 `main`）** | **后端 + 启动器** |

在第一轮修复中只打了 `parking_lot_core`，结果启动器仍崩 ——
因为**真正的首发受害者是 libstd**，而它在更早的时机执行。

这两个补丁**都要保留**：libstd 补丁解决「进不了 main」，
`parking_lot_core` 补丁解决「进了 main 之后还可能崩」。
