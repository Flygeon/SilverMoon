//! KMP（Compose Multiplatform）桌面端的后端进程入口。
//!
//! 与主程序 silvermoon.exe 共用同一个 crate 的全部业务模块 —— 唯一的区别是这个
//! 入口不创建窗口，改为在 127.0.0.1 上开一条带令牌的 JSON-RPC 通道（见 bridge 模块）。
//!
//! 由 Kotlin 侧作为子进程拉起：
//!   silvermoon-bridge.exe  <stdin 保持打开；父进程一退出，本进程随之退出>
//!
//! 环境变量：
//!   SILVERMOON_BRIDGE_HANDSHAKE  握手 JSON（端口 + 令牌）落盘路径
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    silvermoon_lib::run_bridge();
}
