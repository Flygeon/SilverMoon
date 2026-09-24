#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;

/// 将 panic 信息写入 <系统临时目录>/lumiluna_login_debug.log（与登录调试共享同一文件）。
/// 同步 command（如 novel_content / novel_detail）一旦 panic，整个后端进程会退出，
/// 前端 JS 错误处理器无法捕获——必须在原生层留痕。
///
/// 注：迁到 Electron 后本进程是 sidecar，文件名为历史遗留（与前端若干诊断日志
/// 共用），改名会牵动多个模块，故保持不动。
fn write_panic_log(info: &dyn std::fmt::Display) {
    let path = std::env::temp_dir().join("lumiluna_login_debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let _ = writeln!(f, "[{:.3}] [PANIC] {}", t, info);
        let bt = std::backtrace::Backtrace::force_capture();
        let _ = writeln!(f, "[{:.3}] [PANIC-BACKTRACE] {}", t, bt);
    }
}

/// SilverMoon 后端入口（Electron sidecar）。
///
/// 与迁移前的差异只有两点：
/// 1. crate 名从 `lumiluna_lib` 改为 `silvermoon_lib`；
/// 2. `run()` 内部不再拉起窗口 —— 它改为启动本地命令服务（HTTP + SSE）并阻塞，
///    窗口由 Electron 主进程负责。详见 `crates/silvermoon-ipc/src/server.rs`。
fn main() {
    // 捕获 Rust panic：先写日志再走默认行为，
    // 用于定位「点击书籍闪退」这类同步 command 崩溃。
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_panic_log(info);
        default_hook(info);
    }));
    silvermoon_lib::run()
}
