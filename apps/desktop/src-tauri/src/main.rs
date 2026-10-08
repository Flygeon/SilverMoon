// 发布构建下不弹控制台窗口（Windows）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 将 panic 信息写入 <系统临时目录>/lumiluna_login_debug.log（与登录调试共享同一文件）。
///
/// 文件名是历史遗留（与前端若干诊断日志共用），改名会牵动多个模块，故保持不动。
fn write_panic_log(info: &dyn std::fmt::Display) {
    use std::io::Write;
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

/// SilverMoon 桌面端入口（Tauri 2 主程序）。
///
/// 迁回 Tauri 后，宿主与后端重新合为一个进程：窗口、托盘、热键、对话框与
/// 154 条命令都跑在这里（对照：Electron 版是「主进程 + Rust sidecar 两个进程，
/// 经本地 HTTP /cmd + SSE /events 通信」）。
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
