//! 构建脚本。
//!
//! 这里只需要发出一条 cfg 声明：`src/lib.rs` 里的
//! `#[cfg_attr(mobile, silvermoon_ipc::mobile_entry_point)]` 引用了 `cfg(mobile)`，
//! 而 rustc 1.80+ 的 `unexpected_cfgs` 检查会把它报成未知 cfg —— 在 CI 的
//! `cargo clippy -- -D warnings` 下会直接失败。桌面端不会定义该 cfg，
//! 这里声明它合法即可。

fn main() {
    println!("cargo::rustc-check-cfg=cfg(mobile)");
}
