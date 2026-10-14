//! SilverMoon 桌面歌词窗口（Rust 原生 + 任务栏真嵌入 + 内嵌 WebView2）。
//!
//! ## 为什么是独立进程
//!
//! 与 splash 同一取舍（见 apps/desktop/splash）：
//! - 歌词窗口**常驻**，独立进程崩了不影响主应用与播放；
//! - 真嵌入要改窗口样式、抢 Win32 消息循环，塞进 Electron 主进程会与
//!   Chromium 的窗口管理打架（实测：Electron 的 BrowserWindow 被 SetParent
//!   后位置被抢回、渲染变黑）。
//!
//! ## 生命周期
//!
//! 由 Electron 主进程 spawn（见 electron/lyrics-window.ts），通过
//! **stdin/stdout 行分隔 JSON** 通信：
//!
//! \`\`\`text
//! 宿主 --stdin  JSON 行--> 本进程（歌词状态 / 频谱 / 设置 / 退出）
//! 宿主 <--stdout JSON 行-- 本进程（握手 / 播放控制 / 错误）
//! \`\`\`
//!
//! **stdin EOF = 宿主退出**，本进程立刻关闭窗口退出 —— 不会留下孤儿窗口。
//! 这比 HTTP 轮询干净，也不用担心端口占用。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod embed;
#[cfg(windows)]
mod window;

use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::channel;

use crate::window::HostMessage;

fn main() {
    // 非 Windows 目标：本窗口只服务 Windows 桌面，其它平台直接退出
    #[cfg(not(windows))]
    {
        eprintln!("[lyrics] 仅支持 Windows");
        return;
    }

    #[cfg(windows)]
    run_windows();
}

#[cfg(windows)]
fn run_windows() {
    // 1) 定位歌词页资源
    let here = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let web_dir = match silvermoon_lyrics::pathfind::pick_web_dir(&here, |p| p.is_file()) {
        Some(d) => d,
        None => {
            // 资源缺失是**致命**的：没有页面就没有歌词可显示。
            // 报错退出而不是留一个空窗口 —— 空窗口会让用户以为功能坏了。
            eprintln!(
                "[lyrics] 找不到歌词页资源（期望 {}/{}），已尝试：{:?}",
                silvermoon_lyrics::pathfind::WEB_DIR,
                silvermoon_lyrics::pathfind::WEB_ENTRY,
                silvermoon_lyrics::pathfind::web_dir_candidates(&here)
            );
            report_error("找不到歌词页资源");
            return;
        }
    };

    // 2) 起 stdin 读线程 → 投递到窗口线程
    let (tx, rx) = channel::<HostMessage>();
    let _ = window::HOST_TX.set(tx.clone());
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = BufReader::new(stdin.lock());
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(HostMessage::Line(l)).is_err() {
                        return;
                    }
                }
                // 读失败（含 EOF）：通知窗口线程退出
                Err(_) => break,
            }
        }
        let _ = tx.send(HostMessage::Eof);
    });

    // 3) 建窗 + 嵌入 + 挂 WebView2，然后进入消息循环（阻塞）
    if let Err(e) = window::run(web_dir, window::DEFAULT_WIDTH, window::DEFAULT_HEIGHT, rx) {
        eprintln!("[lyrics] 窗口创建失败：{e}");
        report_error(&format!("窗口创建失败：{e}"));
    }
}

/// 往 stdout 打一行错误（宿主会记日志）。
#[cfg(windows)]
fn report_error(message: &str) {
    let msg = silvermoon_lyrics::ipc::Outgoing::Error(silvermoon_lyrics::ipc::ErrorPayload {
        message: message.to_string(),
    });
    let line = silvermoon_lyrics::ipc::encode_outgoing(&msg);
    let mut out = std::io::stdout();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

/// 上报握手（窗口就绪 + 是否真嵌入成功）。
///
/// 由 window::run 在嵌入完成后调用；\`embedded=false\` 是重要信号，
/// 宿主据此可以提示用户或回退到浮贴。
#[cfg(windows)]
pub(crate) fn report_ready(hwnd: i64, embedded: bool) {
    let payload = silvermoon_lyrics::ipc::ReadyPayload { hwnd, embedded };
    let line = silvermoon_lyrics::ipc::encode_ready(&payload);
    let mut out = std::io::stdout();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}
