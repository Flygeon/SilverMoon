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

mod animation;
mod boot_trace;
mod handshake;
mod pathfind;
mod prefs;
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

use pathfind::{pick_electron, ELECTRON_EXE};

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
    boot_trace::info(&format!("读主题设置：{}", path.display()));
    let text = std::fs::read_to_string(path).ok()?;
    let theme = prefs::theme_from_settings(&text);
    boot_trace::info(&format!("设置里的 theme = {theme:?}"));
    theme
}

/// 读系统亮暗（Windows「应用模式」）。任何失败都当作亮色（系统默认）。
fn system_is_dark() -> bool {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };

    boot_trace::step("读注册表 AppsUseLightTheme");
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
            boot_trace::warn("注册表键不存在（Win7 无此键是正常的），按亮色处理");
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
        let dark = status == ERROR_SUCCESS && size >= 4 && u32::from_le_bytes(buf) == 0;
        boot_trace::info(&format!("系统亮暗：dark={dark}"));
        dark
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

/// 启动器自身所在目录。
fn self_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// 定位 Electron 主程序，并把「应用根目录」一并返回（后者用作工作目录）。
///
/// 为什么不能只写成「启动器同目录」：**打包后两者的相对位置和人想的不一样**。
/// electron-builder 的 `extraResources` 把文件放进 `resources/`，而 `SilverMoon.exe`
/// 在安装根目录。也就是说实际布局是：
///
/// ```text
/// <安装目录>\SilverMoon.exe
/// <安装目录>\resources\silvermoon-splash.exe   ← 启动器在这里
/// ```
///
/// 这个差异是**实测安装包内容**才发现的（CI 只校验了构建产物，没校验安装后的布局）。
/// 因此这里按候选顺序探测，而不是假设单一位置：
///
/// 1. 启动器同目录 —— 开发/手工摆放的情形；
/// 2. 上一级目录 —— electron-builder extraResources 的真实布局。
///
/// 找不到时回退到「上一级」，因为那才是发布布局，错误信息也更有指向性。
fn locate_electron() -> (std::path::PathBuf, std::path::PathBuf) {
    if let Ok(p) = std::env::var("SILVERMOON_ELECTRON_BIN") {
        let exe = std::path::PathBuf::from(p);
        let root = exe
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        return (exe, root);
    }

    let here = self_dir();

    // 候选顺序与探测逻辑抽在 pathfind.rs —— 那里是**无平台依赖的纯函数**，
    // 能在 Linux 上直接跑单元测试。发布布局缺陷就是靠它钉住的。
    if let Some(exe) = pick_electron(&here, |p| p.is_file()) {
        let root = exe
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| here.clone());
        return (exe, root);
    }

    // 都没找到：按发布布局给出路径，让错误信息指向真实期望位置
    let root = here.parent().map(|d| d.to_path_buf()).unwrap_or(here);
    (root.join(ELECTRON_EXE), root)
}

fn main() {
    // ⚠️ 必须是 main 的第一件事（Win7 上启动器实测以 c0000005 崩溃，而它是
    // 无控制台的 GUI 进程，崩溃后没有任何可见输出）。详见 boot_trace 模块文档。
    let boot_logs = boot_trace::init("splash");
    boot_trace::mark_session_start("splash");
    boot_trace::info("启动器已进入 main（Rust 运行时启动成功）");
    boot_trace::env_probe();
    boot_trace::info(&format!(
        "启动轨迹写入：{}",
        boot_logs
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    ));

    // debug 构建支持 `--dump-frame=<前缀>`：渲染动画帧后退出，便于检查绘制。
    // 放在最前，避免走窗口/管道流程。
    #[cfg(debug_assertions)]
    if let Some(arg) = std::env::args().find(|a| a.starts_with("--dump-frame=")) {
        boot_trace::step("dump-frame 模式：渲染若干帧后退出");
        dump_frames(&arg);
        return;
    }

    // 先解析 Electron 位置（发布布局与直觉不同，见 locate_electron 的说明）
    boot_trace::step("定位 Electron 主程序");
    let (electron_exe, app_root) = locate_electron();
    boot_trace::info(&format!("Electron = {}", electron_exe.display()));
    boot_trace::info(&format!("应用根目录 = {}", app_root.display()));
    if !electron_exe.is_file() {
        // 这是「双击后什么也没发生」类问题的头号原因，必须显式记下来。
        // 注意不能直接返回：启动器仍要把画面画出来再体面退出（见下方流程）。
        boot_trace::warn("Electron 主程序**不存在**于该路径（后续会转交报错）");
    }

    // 1) 先建管道：Electron 一起来就会连，管道必须先就绪
    boot_trace::step("创建命名管道（handshake::listen）");
    let name = handshake::pipe_name();
    boot_trace::info(&format!("管道名 = {name}"));
    let hs = match Handshake::listen(&name) {
        Ok(h) => h,
        Err(e) => {
            boot_trace::error(&format!("命名管道创建失败：{e}；退化为直接拉起主程序"));
            // 管道建不起来（极罕见）：退化为「直接拉起 Electron 并退出」，
            // 至少不让用户因为启动器自身故障而完全打不开应用。
            eprintln!("[splash] 命名管道创建失败：{e}；将直接启动主程序");
            let _ = Command::new(&electron_exe).current_dir(&app_root).spawn();
            return;
        }
    };
    boot_trace::info("命名管道已就绪");
    *handshake_slot().lock().unwrap() = Some(hs);

    // 2) 显示 splash（亮/暗跟随应用设置，与主界面首屏连续）
    //
    // 这一段是 Win7 崩溃的**首要嫌疑区**：resolve_mode 要读注册表、create 要
    // 走 RegisterClassW/CreateWindowExW/GDI，任何一处踩到缺失的入口都会 AV。
    // 因此拆成三个子阶段分别打点，而不是笼统一句「显示窗口」。
    boot_trace::step("解析主题偏好（读 %APPDATA% 设置 + 注册表亮暗）");
    let mode = resolve_mode();
    boot_trace::info(&format!("主题模式 = {mode:?}"));

    boot_trace::step("创建 splash 窗口（RegisterClassW + CreateWindowExW + GDI）");
    let hwnd = match window::create(theme::WIN_W, theme::WIN_H, mode) {
        Ok(h) => h,
        Err(e) => {
            boot_trace::error(&format!("窗口创建失败：{e}；退化为直接拉起主程序"));
            eprintln!("[splash] 窗口创建失败：{e}；将直接启动主程序");
            let _ = Command::new(&electron_exe).current_dir(&app_root).spawn();
            return;
        }
    };
    boot_trace::info(&format!("splash 窗口已显示（hwnd={:?}）", hwnd));

    // 3) 拉起 Electron（它的窗口先隐藏，等我们的 FADING 再显示）
    boot_trace::step("拉起 Electron 子进程");
    let ready = Arc::new(AtomicBool::new(false));
    if spawn_electron(&electron_exe, &app_root, &name).is_err() {
        // 拉起失败：没有子进程会来握手，立刻收起 splash，别让用户对着动画干等
        boot_trace::error(&format!("启动 {ELECTRON_EXE} 失败"));
        eprintln!("[splash] 启动 {ELECTRON_EXE} 失败");
        window::notify_ready();
    } else {
        boot_trace::info("Electron 子进程已拉起，启动后台等待线程");

        let ready_bg = Arc::clone(&ready);
        std::thread::spawn(move || {
            boot_trace::step("后台线程：等待 Electron 的 READY");
            let got = wait_and_ack(READY_TIMEOUT);
            boot_trace::info(&format!("READY 等待结束：got={got}"));
            ready_bg.store(got, Ordering::SeqCst);
        });

        // 硬兜底：无论握手线程卡在什么状态，到达 CONNECT_TIMEOUT 就必须开始淡出。
        // 没有这道保险，Electron 异常时用户会对着无限转圈的 splash 且进不去应用。
        let ready_timeout = Arc::clone(&ready);
        std::thread::spawn(move || {
            std::thread::sleep(CONNECT_TIMEOUT);
            boot_trace::warn("CONNECT_TIMEOUT 兜底触发，强制开始淡出");
            ready_timeout.store(true, Ordering::SeqCst);
        });
    }

    // 4) 消息循环 + 动画（阻塞直到淡出完成）
    boot_trace::step("进入消息循环 + 动画（每帧 GDI 绘制）");
    animation_loop(hwnd, &ready);
    boot_trace::info("消息循环已退出（动画完成）");

    // 5) 收尾：销毁窗口；Electron 是长期运行的应用，**不**杀它
    boot_trace::step("销毁 splash 窗口并退出");
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
    boot_trace::info("启动器正常退出（能走到这一行说明启动器本身没崩）");
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
///
/// 工作目录设为**应用根目录**（Electron 所在处），而不是启动器所在处：
/// Electron 会以 cwd 为基准解析 `resources/`、相对路径资源等，
/// 用错目录可能导致它找不到自己的资源。
fn spawn_electron(
    exe: &std::path::Path,
    app_root: &std::path::Path,
    pipe: &str,
) -> std::io::Result<std::process::Child> {
    Command::new(exe)
        .arg(format!("--splash-pipe={pipe}"))
        .current_dir(app_root)
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
