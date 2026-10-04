//! MD3 风格 splash 窗口：无边框、圆角、自绘动画。
//!
//! 绘制用 **GDI 图元**（RoundRect / Ellipse / DrawTextW），整帧在内存 DC 上画完
//! 再 BitBlt 上屏（双缓冲，防闪烁）；淡入淡出用分层窗口的 `SetLayeredWindowAttributes`
//! 整体 alpha。
//!
//! 为什么不用手写像素光栅化：本模块无法在 Linux 上做视觉验证（Windows GUI），
//! 系统图元行为确定，比自研 SDF 光栅化更不容易留隐藏缺陷。

use std::cell::RefCell;
use std::time::Instant;

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::handshake::FADE_MS;
use crate::theme::{self, *};

/// 无限进度指示器转一圈的周期（毫秒）
const SPIN_PERIOD_MS: u64 = 1400;
/// 窗口入场淡入时长（毫秒）：避免"啪"地跳出
const FADE_IN_MS: u64 = 180;

thread_local! {
    /// 窗口状态。Win32 的 WndProc 是 C 回调、没有 self，只能放线程局部。
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

struct State {
    start: Instant,
    /// 收到 READY 的时刻；None = 仍在等待
    ready_at: Option<Instant>,
    hwnd: HWND,
    width: i32,
    height: i32,
}

impl State {
    /// 等待阶段的循环进度（0..1），用于推进指示器
    fn spin(&self) -> f64 {
        let elapsed = self.start.elapsed().as_millis() as u64;
        (elapsed % SPIN_PERIOD_MS) as f64 / SPIN_PERIOD_MS as f64
    }

    /// 淡出进度（0..1）；None = 还没收到 READY
    fn fade_out(&self) -> Option<f64> {
        self.ready_at.map(|at| {
            let e = at.elapsed().as_millis() as u64;
            (e as f64 / FADE_MS as f64).min(1.0)
        })
    }

    /// 整体不透明度（0..255）：入场淡入 x 出场淡出
    fn opacity(&self) -> u8 {
        let fade_in = {
            let e = self.start.elapsed().as_millis() as u64;
            if e >= FADE_IN_MS {
                1.0
            } else {
                emphasized(e as f64 / FADE_IN_MS as f64)
            }
        };
        let fade_out = self.fade_out().map(|t| 1.0 - t).unwrap_or(1.0);
        ((fade_in * fade_out) * 255.0).round().clamp(0.0, 255.0) as u8
    }

    /// 是否已淡出完毕
    fn is_done(&self) -> bool {
        self.fade_out().map(|t| t >= 1.0).unwrap_or(false)
    }
}

/// 创建并显示 splash 窗口（居中、无边框、圆角）。
pub fn create(width: i32, height: i32) -> windows::core::Result<HWND> {
    unsafe {
        let hinstance = GetModuleHandleW(None)?;
        let class_name = windows::core::w!("SilverMoonSplash");

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: HINSTANCE(hinstance.0),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            lpszClassName: class_name,
            ..Default::default()
        };
        RegisterClassW(&wc);

        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        let x = (screen_w - width) / 2;
        let y = (screen_h - height) / 2;

        // WS_POPUP          无边框无标题栏
        // WS_EX_LAYERED     整体 alpha 淡入淡出
        // WS_EX_TOOLWINDOW  不占任务栏（它只是个过场）
        // WS_EX_TOPMOST     冷启动时盖在其它窗口之上
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class_name,
            windows::core::w!("SilverMoon"),
            WS_POPUP,
            x,
            y,
            width,
            height,
            None,
            None,
            HINSTANCE(hinstance.0),
            None,
        )?;

        apply_round_region(hwnd, width, height, CORNER);

        STATE.with(|s| {
            *s.borrow_mut() = Some(State {
                start: Instant::now(),
                ready_at: None,
                hwnd,
                width,
                height,
            });
        });

        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = UpdateWindow(hwnd);
        Ok(hwnd)
    }
}

/// 用圆角矩形 Region 裁掉窗口四角。
fn apply_round_region(hwnd: HWND, w: i32, h: i32, radius: i32) {
    unsafe {
        let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius);
        if !rgn.is_invalid() {
            // SetWindowRgn 成功后由系统接管该 Region，不要再 DeleteObject
            let _ = SetWindowRgn(hwnd, rgn, TRUE);
        }
    }
}

/// 告知窗口「Electron 已就绪」，进入淡出阶段
pub fn notify_ready() {
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            if st.ready_at.is_none() {
                st.ready_at = Some(Instant::now());
            }
        }
    });
}

/// 是否已淡出完毕
pub fn is_done() -> bool {
    STATE.with(|s| s.borrow().as_ref().map(|st| st.is_done()).unwrap_or(false))
}

/// 请求重绘一帧，并同步更新整体透明度
pub fn repaint() {
    let snap = STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (st.hwnd, st.opacity(), st.is_done()))
    });
    if let Some((hwnd, opacity, done)) = snap {
        unsafe {
            // 分层窗口整体 alpha（0 = 全透明，255 = 不透明）
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), opacity, LWA_ALPHA);
            if done {
                let _ = ShowWindow(hwnd, SW_HIDE);
            } else {
                let _ = InvalidateRect(hwnd, None, FALSE);
            }
        }
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        // 全量重绘，不需要系统擦背景（否则会闪）
        WM_ERASEBKGND => LRESULT(1),
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 整帧绘制：内存 DC 画完再一次 BitBlt 上屏（双缓冲）
fn paint(hwnd: HWND) {
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        if hdc.is_invalid() {
            return;
        }

        let snap = STATE.with(|s| {
            s.borrow()
                .as_ref()
                .map(|st| (st.width, st.height, st.spin(), st.fade_out().is_some()))
        });
        let (width, height, spin, fading) = match snap {
            Some(v) => v,
            None => {
                let _ = EndPaint(hwnd, &ps);
                return;
            }
        };

        // 内存 DC + 兼容位图（双缓冲）
        let mem_dc = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, width, height);
        let old_bmp = SelectObject(mem_dc, bmp);

        draw(mem_dc, width, height, spin, fading);

        let _ = BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);

        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem_dc);
        let _ = EndPaint(hwnd, &ps);
    }
}

/// 在给定 DC 上画一帧内容
fn draw(dc: HDC, width: i32, height: i32, spin: f64, fading: bool) {
    unsafe {
        // 背景：M3 surface 铺满客户区
        let bg = theme::brush(SURFACE);
        let full = RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        FillRect(dc, &full, bg);
        let _ = DeleteObject(bg);

        let cx = width / 2;
        let cy = height / 2 - 18;

        // ---- 中央品牌块：primary container 圆角方 + 月牙（呼应 SilverMoon）----
        let block = theme::brush(PRIMARY_CONTAINER);
        let old_brush = SelectObject(dc, block);
        let null_pen = GetStockObject(NULL_PEN);
        let old_pen = SelectObject(dc, null_pen);
        let _ = RoundRect(dc, cx - 34, cy - 34, cx + 34, cy + 34, 18, 18);

        // 月牙：画一个圆，再用背景色"咬"掉一块
        let _ = Ellipse(dc, cx - 14, cy - 18, cx + 20, cy + 16);
        let cut = theme::brush(SURFACE);
        SelectObject(dc, cut);
        let _ = Ellipse(dc, cx - 2, cy - 26, cx + 32, cy + 8);
        let _ = DeleteObject(cut);

        SelectObject(dc, old_brush);
        SelectObject(dc, old_pen);
        let _ = DeleteObject(block);

        // ---- 标题 ----
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(ON_SURFACE));
        let title_font = create_font(20, true);
        let old_font = SelectObject(dc, title_font);
        let mut title: Vec<u16> = "SilverMoon".encode_utf16().collect();
        let mut tr = RECT {
            left: 0,
            top: cy + 48,
            right: width,
            bottom: cy + 78,
        };
        DrawTextW(
            dc,
            &mut title,
            &mut tr,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER,
        );
        SelectObject(dc, old_font);
        let _ = DeleteObject(title_font);

        // ---- 副标题 ----
        SetTextColor(dc, COLORREF(ON_SURFACE_VARIANT));
        let sub_font = create_font(12, false);
        let old_sub = SelectObject(dc, sub_font);
        let mut sub: Vec<u16> = "正在启动…".encode_utf16().collect();
        let mut sr = RECT {
            left: 0,
            top: cy + 78,
            right: width,
            bottom: cy + 100,
        };
        DrawTextW(
            dc,
            &mut sub,
            &mut sr,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER,
        );
        SelectObject(dc, old_sub);
        let _ = DeleteObject(sub_font);

        // ---- M3 不确定进度条 ----
        let bar_w = 240;
        let bar_h = 4;
        let bar_x = cx - bar_w / 2;
        let bar_y = height - 56;

        // 轨道
        let track = theme::brush(OUTLINE_VARIANT);
        let old_tb = SelectObject(dc, track);
        let old_tp = SelectObject(dc, GetStockObject(NULL_PEN));
        let _ = RoundRect(dc, bar_x, bar_y, bar_x + bar_w, bar_y + bar_h, bar_h, bar_h);
        SelectObject(dc, old_tb);
        SelectObject(dc, old_tp);
        let _ = DeleteObject(track);

        // 主动段：两段相位差半周期的短棒往复（M3 indeterminate 的观感）
        let seg = theme::brush(PRIMARY);
        let old_sb = SelectObject(dc, seg);
        let old_sp = SelectObject(dc, GetStockObject(NULL_PEN));
        if fading {
            // 淡出时把条走满：给出"已完成"的收束感
            let _ = RoundRect(dc, bar_x, bar_y, bar_x + bar_w, bar_y + bar_h, bar_h, bar_h);
        } else {
            draw_segment(dc, bar_x, bar_y, bar_w, bar_h, emphasized(spin), 0.40);
            draw_segment(
                dc,
                bar_x,
                bar_y,
                bar_w,
                bar_h,
                emphasized((spin + 0.5) % 1.0),
                0.28,
            );
        }
        SelectObject(dc, old_sb);
        SelectObject(dc, old_sp);
        let _ = DeleteObject(seg);
    }
}

/// 画进度条的一段（progress = 0..1 的位置，seg = 占轨道宽度的比例）
fn draw_segment(dc: HDC, bar_x: i32, bar_y: i32, bar_w: i32, bar_h: i32, progress: f64, seg: f64) {
    // 两端各留 20px 余量，视觉上是"滑入滑出"而不是硬切
    let travel = bar_w as f64 + 40.0;
    let start = progress * travel - 20.0;
    let seg_w = seg * bar_w as f64;
    let sx = bar_x + start.max(0.0) as i32;
    let ex = bar_x + (start + seg_w).min(bar_w as f64).max(0.0) as i32;
    if ex <= sx {
        return;
    }
    unsafe {
        let _ = RoundRect(dc, sx, bar_y, ex, bar_y + bar_h, bar_h, bar_h);
    }
}

/// 造一个字体（调用方负责 DeleteObject）
fn create_font(size: i32, bold: bool) -> HFONT {
    unsafe {
        let mut lf = LOGFONTW {
            lfHeight: -size,
            lfWeight: if bold {
                FW_SEMIBOLD.0 as i32
            } else {
                FW_NORMAL.0 as i32
            },
            lfCharSet: DEFAULT_CHARSET,
            lfQuality: CLEARTYPE_QUALITY,
            ..Default::default()
        };
        // 字体名是定长数组，逐字符写入
        for (i, ch) in "Microsoft YaHei UI".encode_utf16().take(31).enumerate() {
            lf.lfFaceName[i] = ch;
        }
        CreateFontIndirectW(&lf)
    }
}
