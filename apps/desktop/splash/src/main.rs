//! SilverMoon 启动动画（MD3 自绘 splash）。
//!
//! ## 谁来启动它
//!
//! **主程序（Tauri 应用）自己 spawn 本程序**，并把管道名通过
//! --splash-pipe=<name> 传进来。这样快捷方式、安装布局、开发态都不用改，
//! 启动器只是个「早几秒出画面」的附属品 —— 它没起来也不影响应用能不能用。
//!
//! ## 流程
//!
//! 1. 收到 --splash-pipe=<name>；
//! 2. **先建命名管道**，再显窗口 —— 主程序一起来就会连，管道必须先就绪；
//! 3. 显示 splash 窗口（原生、毫秒级出画面）；
//! 4. 主线程跑消息循环 + 动画；后台线程等管道上的 READY；
//! 5. 收到 READY → 回发 FADING:<ms> → 淡出 → 销毁窗口 → 退出。
//!    主程序收到 FADING 后再等 <ms> 才显示主窗口，两端视觉交叠。
//!
//! ## 设计取舍
//!
//! - **等待必须在后台线程**：窗口要一直跑动画，不能被阻塞等待卡住；
//! - **多道超时兜底**：主程序没连上（CONNECT_TIMEOUT）或连上但不报就绪
//!   （READY_TIMEOUT）都必须开始淡出，否则用户会对着无限转圈的动画进不去应用；
//! - **管道先于窗口**：主程序可能在窗口显示前就尝试连接；
//! - **绝不拉起应用**：应用是父进程，启动器只负责「被叫出来的那几秒」。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod animation;
mod handshake;
mod prefs;
mod theme;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

use handshake::{Handshake, CONNECT_TIMEOUT, FADE_MS, READY_TIMEOUT};

/// 应用数据目录名（与 `backend/silvermoon.config.json` 的 identifier 一致）。
/// 用于定位 `%APPDATA%\<identifier>\settings.json`。
const APP_IDENTIFIER: &str = "cn.cool.silvermoon";

/// 读应用设置里的主题偏好（`settings.json` 的 `settings.theme`）。
///
/// 与 `electron/config.ts` 的 `dataDir()` 对齐：`%APPDATA%\<identifier>`。
/// 读不到就返回 None，由调用方回退系统亮暗 —— 启动器绝不因为读不到设置而失败。
fn read_theme_pref() -> Option<&'static str> {
    let appdata = std::env::var("APPDATA").ok()?;
    let path = std::path::Path::new(&appdata)
        .join(APP_IDENTIFIER)
        .join("settings.json");
    let text = std::fs::read_to_string(path).ok()?;
    prefs::theme_from_settings(&text)
}

/// 读系统亮暗（Windows「应用模式」）。任何失败都当作亮色（系统默认）。
fn system_is_dark() -> bool {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };

    unsafe {
        let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let value: Vec<u16> = "AppsUseLightTheme"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let mut key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut key,
        ) != ERROR_SUCCESS
        {
            return false;
        }

        let mut kind = REG_DWORD;
        let mut buf = [0u8; 4];
        let mut size = buf.len() as u32;
        let status = RegQueryValueExW(
            key,
            windows::core::PCWSTR(value.as_ptr()),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(key);

        // AppsUseLightTheme == 0 表示深色
        status == ERROR_SUCCESS && size >= 4 && u32::from_le_bytes(buf) == 0
    }
}

/// 调试入口：把若干动画帧渲染成 BMP 后退出（仅 debug 构建）。
///
/// 用法：`silvermoon-splash.exe --dump-frame=D:\\out\\f`
/// 会输出 `f0.bmp`..`f7.bmp`，用于在**不依赖窗口截图**的前提下检查绘制结果。
/// 这在 Wine 下尤其重要：`xwd` 抓分层窗口不可靠，而这里拿的是 GDI 真实像素。
#[cfg(debug_assertions)]
fn dump_frames(arg: &str) {
    let base = arg.trim_start_matches("--dump-frame=");
    // 亮/暗各出一组，方便对比主题
    for (label, palette) in [
        ("light", theme::Palette::LIGHT),
        ("dark", theme::Palette::DARK),
    ] {
        for i in 0..8u64 {
            let elapsed = i * (animation::PERIOD_MS / 8);
            let path = format!("{base}-{label}-{i}.bmp");
            match window::dump_frame_to_bmp(&path, theme::WIN_W, theme::WIN_H, elapsed, palette) {
                Ok(()) => println!("wrote {path}"),
                Err(e) => eprintln!("dump 失败 {path}: {e}"),
            }
        }
    }
}

/// 决定 splash 的亮/暗：**跟随应用设置**，设置缺失才跟系统。
fn resolve_mode() -> prefs::Mode {
    prefs::resolve(read_theme_pref(), system_is_dark())
}

/// 握手通道。
///
/// 主线程创建后放进来，后台等待线程取走 —— 用 static 而不是 thread_local：
/// 后台线程访问不到主线程的 TLS。
static HANDSHAKE: OnceLock<Mutex<Option<Handshake>>> = OnceLock::new();

fn handshake_slot() -> &'static Mutex<Option<Handshake>> {
    HANDSHAKE.get_or_init(|| Mutex::new(None))
}

fn main() {
    // debug 构建支持 --dump-frame=<前缀>：渲染动画帧后退出，便于检查绘制。
    // 放在最前，避免走窗口/管道流程。
    #[cfg(debug_assertions)]
    if let Some(arg) = std::env::args().find(|a| a.starts_with("--dump-frame=")) {
        dump_frames(&arg);
        return;
    }

    // 管道名由**主程序（父进程）**生成并传入：它是握手的客户端，我们是服务端。
    // 拿不到就没有可等的对象，直接退出 —— 主程序有自己的超时兜底会显示窗口。
    let Some(name) =
        std::env::args().find_map(|a| a.strip_prefix("--splash-pipe=").map(str::to_owned))
    else {
        eprintln!("[splash] 缺少 --splash-pipe，退出（主程序会自行显示窗口）");
        return;
    };

    // 1) 先建管道：主程序一起来就会连，管道必须先就绪
    let hs = match Handshake::listen(&name) {
        Ok(h) => h,
        Err(e) => {
            // 管道建不起来（极罕见）：退出即可，主程序会自己把窗口显示出来
            eprintln!("[splash] 命名管道创建失败：{e}；退出（主程序会自行显示窗口）");
            return;
        }
    };
    *handshake_slot().lock().unwrap() = Some(hs);

    // 2) 显示 splash（亮/暗跟随应用设置，与主界面首屏连续）
    let mode = resolve_mode();
    let hwnd = match window::create(theme::WIN_W, theme::WIN_H, mode) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[splash] 窗口创建失败：{e}；退出（主程序会自行显示窗口）");
            return;
        }
    };

    // 3) 后台等 READY，收到就回发 FADING
    let ready = Arc::new(AtomicBool::new(false));
    {
        let ready_bg = Arc::clone(&ready);
        std::thread::spawn(move || {
            let got = wait_and_ack(READY_TIMEOUT);
            ready_bg.store(got, Ordering::SeqCst);
        });
    }

    // 硬兜底：无论握手线程卡在什么状态，到达 CONNECT_TIMEOUT 就必须开始淡出。
    // 没有这道保险，主程序异常时用户会对着无限转圈的 splash 且进不去应用。
    //
    // 与旧版的差别：那时应用是子进程，它一退出管道就断开、能立刻感知；
    // 现在应用是**父进程**，它若在连上管道之前就崩了，我们收不到断开事件。
    // 因此把「完全没有客户端连上」的上限从 45s 收到 15s —— 正常情况下主程序
    // 起来后几百毫秒内就会连上，15s 只在它真的挂了时才用得上。
    {
        let ready_timeout = Arc::clone(&ready);
        std::thread::spawn(move || {
            std::thread::sleep(CONNECT_TIMEOUT);
            ready_timeout.store(true, Ordering::SeqCst);
        });
    }

    // 4) 消息循环 + 动画（阻塞直到淡出完成）
    animation_loop(hwnd, &ready);

    // 5) 收尾：销毁窗口。主程序是长期运行的应用，**不**杀它。
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
        // 告知主程序：我要淡出了，你等 FADE_MS 再显示主窗口
        let _ = hs.send(&format!("FADING:{FADE_MS}"));
    }
    got
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
