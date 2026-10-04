//! SilverMoon 启动器（MD3 自绘 splash + Electron 宿主）。
//!
//! 流程：
//!
//! 1. 建命名管道 —— 先建，保证 Electron 起来时管道已就绪（否则会连不上）
//! 2. 显示 splash 窗口（原生、毫秒级出画面，盖住 Electron 冷启动空窗）
//! 3. 拉起 Electron，把 --splash-pipe=<name> 传给它（Electron 端窗口先隐藏）
//! 4. 主线程跑消息循环 + 动画；后台线程等管道上的 READY
//! 5. 收到 READY → 回发 FADING:<ms> → 淡出 → 销毁窗口 → 退出；
//!    Electron 收到 FADING 后再等 <ms> 才 show 主窗口，两端视觉交叠
//!
//! 设计取舍：
//! - **等待必须在后台线程**：窗口要一直跑动画，不能被阻塞等待卡住；
//! - **60s 超时兜底**：Electron 起不来（缺文件／被杀）时不能让用户对着 splash
//!   干等，超时即淡出退出，把问题交回 Electron 自己的报错弹窗；
//! - **管道先于窗口**：Electron 可能在窗口显示前就启动并尝试连接。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod handshake;
mod theme;
mod window;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

use handshake::{Handshake, CONNECT_TIMEOUT, FADE_MS, READY_TIMEOUT};

/// Electron 可执行文件名（与 electron-builder 的 productName 一致）
const ELECTRON_EXE: &str = "SilverMoon.exe";

/// 握手通道。
///
/// 主线程创建后放进来，后台等待线程取走 —— 用 static 而不是 thread_local：
/// 后台线程访问不到主线程的 TLS。
static HANDSHAKE: OnceLock<Mutex<Option<Handshake>>> = OnceLock::new();

fn handshake_slot() -> &'static Mutex<Option<Handshake>> {
    HANDSHAKE.get_or_init(|| Mutex::new(None))
}

/// splash 所在目录（安装后它与 Electron 同级）
fn app_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Electron 可执行文件路径（可用 SILVERMOON_ELECTRON_BIN 覆盖，便于开发调试）
fn electron_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("SILVERMOON_ELECTRON_BIN") {
        return std::path::PathBuf::from(p);
    }
    app_dir().join(ELECTRON_EXE)
}

fn main() {
    // 1) 先建管道：Electron 一起来就会连，管道必须先就绪
    let name = handshake::pipe_name();
    let hs = match Handshake::listen(&name) {
        Ok(h) => h,
        Err(e) => {
            // 管道建不起来（极罕见）：退化为「直接拉起 Electron 并退出」，
            // 至少不让用户因为启动器自身故障而完全打不开应用。
            eprintln!("[splash] 命名管道创建失败：{e}；将直接启动主程序");
            let _ = Command::new(electron_path()).spawn();
            return;
        }
    };
    *handshake_slot().lock().unwrap() = Some(hs);

    // 2) 显示 splash
    let hwnd = match window::create(theme::WIN_W, theme::WIN_H) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[splash] 窗口创建失败：{e}；将直接启动主程序");
            let _ = Command::new(electron_path()).spawn();
            return;
        }
    };

    // 3) 拉起 Electron（它的窗口先隐藏，等我们的 FADING 再显示）
    let ready = Arc::new(AtomicBool::new(false));
    if spawn_electron(&name).is_err() {
        // 拉起失败：没有子进程会来握手，立刻收起 splash，别让用户对着动画干等
        eprintln!("[splash] 启动 {ELECTRON_EXE} 失败");
        window::notify_ready();
    } else {
        let ready_bg = Arc::clone(&ready);
        std::thread::spawn(move || {
            let got = wait_and_ack(READY_TIMEOUT);
            ready_bg.store(got, Ordering::SeqCst);
        });

        // 硬兜底：无论握手线程卡在什么状态，到达 CONNECT_TIMEOUT 就必须开始淡出。
        // 没有这道保险，Electron 异常时用户会对着无限转圈的 splash 且进不去应用。
        let ready_timeout = Arc::clone(&ready);
        std::thread::spawn(move || {
            std::thread::sleep(CONNECT_TIMEOUT);
            ready_timeout.store(true, Ordering::SeqCst);
        });
    }

    // 4) 消息循环 + 动画（阻塞直到淡出完成）
    animation_loop(hwnd, &ready);

    // 5) 收尾：销毁窗口；Electron 是长期运行的应用，**不**杀它
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
}

/// 后台线程：等 READY，收到就回发 FADING 告知淡出时长。
fn wait_and_ack(timeout: Duration) -> bool {
    let guard = handshake_slot().lock().unwrap();
    let hs = match guard.as_ref() {
        Some(h) => h,
        None => return false,
    };
    let got = hs.wait_ready(timeout);
    if got {
        // 告知 Electron：我要淡出了，你等 FADE_MS 再 show 主窗口
        let _ = hs.send(&format!("FADING:{FADE_MS}"));
    }
    got
}

/// 拉起 Electron 子进程，并把管道名传给它。
fn spawn_electron(pipe: &str) -> std::io::Result<std::process::Child> {
    Command::new(electron_path())
        .arg(format!("--splash-pipe={pipe}"))
        .current_dir(app_dir())
        .spawn()
}

/// 主消息循环：每帧推进动画；后台报 ready 后进入淡出，淡出完成即退出。
fn animation_loop(hwnd: HWND, ready: &Arc<AtomicBool>) {
    let mut ready_seen = false;
    let _ = hwnd;
    loop {
        // 处理窗口消息（非阻塞抽干队列）
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        // 后台线程报 ready → 通知窗口进入淡出
        if !ready_seen && ready.load(Ordering::SeqCst) {
            ready_seen = true;
            window::notify_ready();
        }

        window::repaint();

        if window::is_done() {
            break;
        }

        std::thread::sleep(Duration::from_millis(16)); // 约 60fps
    }
}
