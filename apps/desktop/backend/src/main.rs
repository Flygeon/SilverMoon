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
        let _ = f.flush();
    }
    // 同一份 panic 也进启动轨迹 —— 两处都写是有意的：
    // lumiluna_login_debug.log 是**业务**日志（可能很长、历史混杂），
    // 启动轨迹是**本次启动**的完整画像，排查启动期崩溃时后者的信噪比高得多。
    silvermoon_lib::boot_trace::error(&format!("PANIC：{info}"));
}

/// SilverMoon 后端入口（Electron sidecar）。
///
/// 与迁移前的差异只有两点：
/// 1. crate 名从 `lumiluna_lib` 改为 `silvermoon_lib`；
/// 2. `run()` 内部不再拉起窗口 —— 它改为启动本地命令服务（HTTP + SSE）并阻塞，
///    窗口由 Electron 主进程负责。详见 `crates/silvermoon-ipc/src/server.rs`。
///
/// ## 启动轨迹（诊断用）
///
/// 本进程是 `windows_subsystem = "windows"` 的 GUI 进程，**没有控制台**；
/// 打包后在 Win7 上崩溃时（实测 `0xC0000005`）Electron 侧只能看到
/// `侧车退出：code=3221225477`，没有任何线索。因此这里在**最早的时刻**就开始
/// 写启动轨迹：先于 panic hook、先于任何库初始化。
/// 日志落在 `<%TEMP%>/silvermoon-boot-backend.log`，最后一行即崩溃区间下界。
fn main() {
    // ⚠️ 必须是 main 的第一件事：晚于任何初始化都可能错过崩溃点。
    // 这一步只做「取路径 + 建文件」，不依赖堆分配之外的任何运行时设施。
    let boot_logs = silvermoon_lib::boot_trace::init(silvermoon_lib::boot_trace::TAG_BACKEND);
    silvermoon_lib::boot_trace::mark_session_start(silvermoon_lib::boot_trace::TAG_BACKEND);
    silvermoon_lib::boot_trace::info("后端进程已进入 main（Rust 运行时启动成功）");
    silvermoon_lib::boot_trace::env_probe(
        &std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<未知>".into()),
    );
    silvermoon_lib::boot_trace::env(&format!(
        "命令行参数：{:?}",
        std::env::args().collect::<Vec<_>>()
    ));
    silvermoon_lib::boot_trace::info(&format!(
        "启动轨迹写入：{}",
        boot_logs
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    ));

    // 捕获 Rust panic：先写日志再走默认行为，
    // 用于定位「点击书籍闪退」这类同步 command 崩溃。
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_panic_log(info);
        default_hook(info);
    }));
    silvermoon_lib::boot_trace::step("panic hook 已安装，进入 silvermoon_lib::run()");

    silvermoon_lib::run();
    // run() 正常返回（收到 stdin EOF / 退出指令）—— 记一笔，避免与「崩溃」混淆：
    // 崩溃时日志**不会**有这一行。
    silvermoon_lib::boot_trace::info("run() 正常返回，后端进程即将退出");
}
