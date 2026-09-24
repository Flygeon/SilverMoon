//! 迁移说明（原 LumiLuna / Tauri 版本此处是 `tauri_build::build()`）。
//!
//! `tauri-build` 负责生成 `gen/schemas/`、校验 capabilities、注入 `mobile` 等 cfg。
//! 迁到 Electron 后这些概念都不存在了：
//!
//! * 窗口与 ACL 由 Electron 的 preload + contextIsolation 承担；
//! * 应用元信息改为 `silvermoon.config.json`，由 `generate_context!` 在编译期读取，
//!   Electron 主进程运行时读同一份文件。
//!
//! 因此这里保留一个空的构建脚本即可——真正需要它的地方已经没有了。

fn main() {}
