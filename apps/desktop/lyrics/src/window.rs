//! 歌词窗口本体：建窗、嵌任务栏、挂 WebView2、跑消息循环。
//!
//! 结构（与参考项目 MainWindow.xaml 同构）：
//!
//! \`\`\`text
//! HWND (我们自己建，可被 SetParent)
//!   └─ WebView2 (wry build_as_child，只是子控件)
//!        └─ lyrics-web/index.html (Vue 构建产物 / 纯 HTML)
//! \`\`\`
//!
//! 关键点：**WebView2 是子控件，不是顶层窗口** —— 这正是 Electron 做不到的。

use std::cell::RefCell;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetSystemMetrics,
    PeekMessageW, RegisterClassW, SetTimer, SetWindowPos, TranslateMessage, CS_HREDRAW, CS_VREDRAW,
    HWND_TOPMOST, MSG, PM_REMOVE, SM_CXSCREEN, SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOSIZE,
    SWP_NOZORDER, SWP_SHOWWINDOW, WM_DESTROY, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

use crate::embed::{self, EmbedResult};
use silvermoon_lyrics::pathfind;

/// 窗口类名（全局唯一，避免与宿主/其它进程冲突）。
const CLASS_NAME: &str = "SilverMoonLyrics";

/// 默认窗口尺寸（DIP）。高度贴合任务栏内高，宽度按参考项目的 560 起步。
pub const DEFAULT_WIDTH: i32 = 560;
pub const DEFAULT_HEIGHT: i32 = 40;

/// 动画/绘制节拍（毫秒）。16ms ≈ 60fps —— 逐字填充与频谱都靠它推进。
///
/// 用 \`SetTimer\` 而不是自旋循环：Windows 的定时器消息会在没有其它消息时
/// 合并派发，空闲时几乎不耗 CPU（自旋会让这个常驻进程一直占一个核）。
const TICK_MS: u32 = 16;

thread_local! {
    /// 窗口状态。WndProc 是 C 回调、没有 self，只能放线程局部（同 splash 做法）。
    static STATE: RefCell<Option<WindowState>> = const { RefCell::new(None) };
}

/// 宿主消息（由 stdin 读线程投递到窗口线程）。
#[derive(Debug, Clone)]
pub enum HostMessage {
    /// 一行原始 JSON（解析在窗口线程做，保持 IO 与解析分离）
    Line(String),
    /// stdin 关闭 —— 宿主退出，我们也该走了
    Eof,
}

/// 跨线程的消息投递器。
static HOST_TX: OnceLock<Sender<HostMessage>> = OnceLock::new();

pub fn host_sender() -> Option<&'static Sender<HostMessage>> {
    HOST_TX.get()
}

struct WindowState {
    hwnd: HWND,
    /// 是否已成功嵌入任务栏
    embedded: bool,
    /// 宿主消息接收端（在窗口线程里轮询）
    rx: Receiver<HostMessage>,
    /// WebView2 实例。必须持有 —— drop 掉它 WebView2 就没了
    webview: Option<wry::WebView>,
}

impl WindowState {
    fn eval(&mut self, js: &str) {
        if let Some(wv) = &self.webview {
            // eval 失败不该让窗口崩掉：WebView2 可能还在初始化
            let _ = wv.evaluate_script(js);
        }
    }
}

/// 建窗 + 嵌入 + 挂 WebView2，然后进入消息循环。阻塞直到窗口销毁。
///
/// \`web_dir\` 是歌词页资源目录；\`url\` 是要加载的页面地址。
pub fn run(
    web_dir: std::path::PathBuf,
    width: i32,
    height: i32,
    rx: Receiver<HostMessage>,
) -> windows::core::Result<()> {
    unsafe {
        let hinstance = GetModuleHandleW(None)?;
        let class_name = w!("SilverMoonLyrics");
        let _ = CLASS_NAME; // 保留常量供调试/查找

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        RegisterClassW(&wc);

        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);

        // 建在屏幕下方外面：嵌入成功后会立刻被摆进任务栏，
        // 万一嵌入失败，它也不会在屏幕中央闪一下。
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            class_name,
            w!("SilverMoon Lyrics"),
            WS_POPUP | WS_VISIBLE,
            0,
            screen_h - height,
            width,
            height,
            None,
            None,
            hinstance,
            None,
        )?;

        // 先挂 WebView2 再嵌入：WebView2 建容器窗口时会以当前父窗口为准，
        // 反过来的话容器会挂到任务栏上，脱离时难以收拾。
        let webview = create_webview(hwnd, &web_dir, width, height);

        // 嵌入任务栏
        let result = embed::embed_into_taskbar(hwnd);
        let embedded = result == EmbedResult::Embedded;
        if embedded {
            // 贴合任务栏内高，靠左留一点边距
            let tb_height = 40; // 任务栏默认高度；真实高度在 layout 里再校正
            embed::place_in_taskbar(hwnd, 8, 2, width, (tb_height - 4).max(24));
        }

        STATE.with(|s| {
            *s.borrow_mut() = Some(WindowState {
                hwnd,
                embedded,
                rx,
                webview,
            });
        });

        // 上报握手：宿主据此知道窗口就绪、以及**真嵌入是否成功**。
        // embedded=false 是重要信号 —— 宿主可以提示用户或回退到浮贴，
        // 而不是让用户对着一个不知道飘到哪去的窗口发呆。
        crate::report_ready(hwnd.0 as i64, embedded);

        // 16ms 节拍：驱动动画、轮询宿主消息、刷新 WebView
        SetTimer(hwnd, 1, TICK_MS, None);

        // 消息循环
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            if msg.message == WM_DESTROY {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Ok(())
    }
}

/// 挂 WebView2 作为子控件。失败返回 None（窗口仍可显示，只是没内容）。
fn create_webview(
    hwnd: HWND,
    web_dir: &std::path::Path,
    width: i32,
    height: i32,
) -> Option<wry::WebView> {
    let url = silvermoon_lyrics::pathfind::file_url(
        &web_dir.join(silvermoon_lyrics::pathfind::WEB_ENTRY),
    );
    // wry 需要一个 HasWindowHandle。裸 HWND 通过 newtype 适配。
    let parent = RawHwnd(hwnd);
    match wry::WebViewBuilder::new()
        .with_url(url)
        .with_transparent(true)
        .with_bounds(wry::Rect {
            position: wry::dpi::Position::Physical(wry::dpi::PhysicalPosition::new(0, 0)),
            size: wry::dpi::Size::Physical(wry::dpi::PhysicalSize::new(
                width.max(1) as u32,
                height.max(1) as u32,
            )),
        })
        .build_as_child(&parent)
    {
        Ok(wv) => Some(wv),
        Err(e) => {
            eprintln!("[lyrics] WebView2 创建失败：{e}");
            None
        }
    }
}

/// 把裸 HWND 适配成 \`HasWindowHandle\`，供 wry 使用。
struct RawHwnd(HWND);

impl raw_window_handle::HasWindowHandle for RawHwnd {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        let mut handle = raw_window_handle::Win32WindowHandle::new(
            std::num::NonZeroIsize::new(self.0 .0 as isize)
                .ok_or(raw_window_handle::HandleError::Unavailable)?,
        );
        handle.hinstance = std::num::NonZeroIsize::new(0);
        let raw = raw_window_handle::RawWindowHandle::Win32(handle);
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(raw) })
    }
}

/// 窗口过程。
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER => {
            tick(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            windows::Win32::UI::WindowsAndMessaging::PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 每个节拍：消费宿主消息、推给 WebView。
fn tick(_hwnd: HWND) {
    STATE.with(|s| {
        let mut guard = s.borrow_mut();
        let Some(state) = guard.as_mut() else {
            return;
        };

        // 一次性把队列里积压的消息全消费掉（避免高频消息时越积越多）
        let mut batch = Vec::new();
        while let Ok(msg) = state.rx.try_recv() {
            batch.push(msg);
            if batch.len() >= 64 {
                break;
            }
        }

        for msg in batch {
            match msg {
                HostMessage::Eof => {
                    // 宿主没了，窗口也该关（避免留下孤儿窗口）
                    unsafe {
                        let _ = DestroyWindow(state.hwnd);
                    }
                    return;
                }
                HostMessage::Line(line) => {
                    if let Some(js) = silvermoon_lyrics::bridge::line_to_js(&line) {
                        state.eval(&js);
                    }
                }
            }
        }
    });
}

/// 让窗口重新贴合任务栏（显示器/任务栏变化时调用）。
pub fn reflow(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) {
    unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

/// 把窗口挪到指定位置（浮贴模式用）。
pub fn move_to(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) {
    unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOZORDER,
        );
    }
}
