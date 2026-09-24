//! 迁移说明（原 LumiLuna / Tauri 版本此处是 `tauri_build::build()`）。
//!
//! `tauri-build` 负责生成 `gen/schemas/`、校验 capabilities、注入 `mobile` 等 cfg。
//! 迁到 Electron 后这些概念都不存在了：
//!
//! * 窗口与 ACL 由 Electron 的 preload + contextIsolation 承担；
//! * 应用元信息改为 `silvermoon.config.json`，由 `generate_context!` 在编译期读取，
//!   Electron 主进程运行时读同一份文件。
//!
//! 但有一条**必须保留**：`lib.rs` 里的
//! `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 引用了 `cfg(mobile)`，
//! 而 rustc 1.80+ 的 `unexpected_cfgs` 检查会把它报成未知 cfg —— 在 CI 的
//! `cargo clippy -- -D warnings` 下会直接失败。原来这条声明由 tauri-build 发出，
//! 现在得由我们自己声明。

fn main() {
    // 桌面端不会定义该 cfg，仅用于让 `cfg(mobile)` 合法。
    println!("cargo::rustc-check-cfg=cfg(mobile)");
}
