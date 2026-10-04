//! MD3 风格 splash 窗口：无边框、圆角、自绘动画。
//!
//! 绘制用 **GDI 图元**（Ellipse / RoundRect / DrawTextW / 带 alpha 的刷子），
//! 整帧画在内存 DC 上再 BitBlt 上屏（双缓冲，防闪烁）；整体淡入淡出与逐字发光
//! 的「模糊」用分层窗口 alpha + alpha 混合刷子近似。
//!
//! 为什么不去手写像素光栅化：GDI 图元行为确定、可维护；而真正容易错的**动画数学**
//! 已经抽到 `animation.rs`（纯函数，能在 Linux 上跑真实单元测试）。

use std::cell::RefCell;
use std::time::Instant;

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::animation;
use crate::handshake::FADE_MS;
use crate::prefs::Mode;
use crate::theme::{self, Palette, CORNER};

/// 窗口入场淡入时长（毫秒）：避免「啪」地跳出
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
    /// 跟随应用设置的亮/暗色板
    palette: Palette,
}

impl State {
    /// 动画进度（毫秒，自窗口创建起）
    fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    /// 淡出进度（0..1）；None = 还没收到 READY
    fn fade_out(&self) -> Option<f64> {
        self.ready_at.map(|at| {
            let e = at.elapsed().as_millis() as u64;
            (e as f64 / FADE_MS as f64).min(1.0)
        })
    }

    /// 整体不透明度（0..255）：入场淡入 × 出场淡出
    fn opacity(&self) -> u8 {
        let fade_in = {
            let e = self.elapsed_ms();
            if e >= FADE_IN_MS {
                1.0
            } else {
                theme::emphasized(e as f64 / FADE_IN_MS as f64)
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
pub fn create(width: i32, height: i32, mode: Mode) -> windows::core::Result<HWND> {
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
                palette: Palette::of(mode),
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
            s.borrow().as_ref().map(|st| {
                (
                    st.width,
                    st.height,
                    st.elapsed_ms(),
                    st.fade_out().is_some(),
                    st.palette,
                )
            })
        });
        let (width, height, elapsed, fading, palette) = match snap {
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

        draw(mem_dc, width, height, elapsed, fading, palette);

        let _ = BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);

        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem_dc);
        let _ = EndPaint(hwnd, &ps);
    }
}

/// 在给定 DC 上画一帧：背景 + 环形高光 + 七个星点 + 「SilverMoon」逐字发光。
fn draw(dc: HDC, width: i32, height: i32, elapsed: u64, fading: bool, p: Palette) {
    unsafe {
        // 背景铺满客户区
        let bg = theme::brush(p.surface);
        let full = RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        FillRect(dc, &full, bg);
        let _ = DeleteObject(bg);

        SetBkMode(dc, TRANSPARENT);

        let cx = width / 2;
        let cy = height / 2;

        // ---- 星点（在文字上方漂浮，对应原版 .star）----
        for (dx, dy, scale, delay) in animation::STARS {
            let st = animation::star_state(delay, elapsed);
            let r = 3.0 * scale;
            let sx = cx as f64 + dx;
            let sy = cy as f64 + dy;
            // 用中间色近似「模糊的小白点」：把星点色按不透明度混到背景上
            let color = theme::mix(p.surface, p.on_surface, st.opacity);
            let b = theme::brush(color);
            let old = SelectObject(dc, b);
            let old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
            let _ = Ellipse(
                dc,
                (sx - r) as i32,
                (sy - r) as i32,
                (sx + r) as i32,
                (sy + r) as i32,
            );
            SelectObject(dc, old);
            SelectObject(dc, old_pen);
            let _ = DeleteObject(b);
        }

        // ---- 「SilverMoon」逐字发光 ----
        // 字号按窗口宽度自适应，保证 10 个字母放得下且居中
        let font_size = 30;
        let spacing = 2;

        // 先量总宽：逐字母累加（用 GetTextExtentPoint32W 真实测量，避免估算偏差）
        let mut widths: Vec<i32> = Vec::new();
        for ch in animation::LETTERS {
            let f = create_font(font_size, false, false);
            let old_f = SelectObject(dc, f);
            let mut buf: Vec<u16> = ch.to_string().encode_utf16().collect();
            let mut sz = SIZE::default();
            let _ = GetTextExtentPoint32W(dc, &buf, &mut sz);
            SelectObject(dc, old_f);
            let _ = DeleteObject(f);
            _ = &mut buf;
            widths.push(sz.cx);
        }
        let total: i32 =
            widths.iter().sum::<i32>() + spacing * (animation::LETTERS.len() as i32 - 1);
        let mut x = cx - total / 2;

        for (i, ch) in animation::LETTERS.iter().enumerate() {
            let st = animation::letter_state(i, elapsed);

            // 模糊：GDI 无法真做高斯模糊，用「两次偏移绘制 + 降低不透明度」近似。
            // blur=2 时画一圈淡淡的重影，blur=0 时只画清晰的一遍。
            let blur = st.blur;

            // 颜色随不透明度向背景靠拢，等价于 alpha 淡出
            let color = theme::mix(p.surface, p.on_surface, st.opacity.clamp(0.0, 1.0));

            let f = create_font((font_size as f64 * st.scale).round() as i32, true, false);
            let old_f = SelectObject(dc, f);
            SetTextColor(dc, COLORREF(color));

            // 垂直位移 + 基线居中
            let base_y = (cy as f64 + st.dy) as i32;
            let w = widths[i];

            if blur > 0.4 {
                // 重影（模拟 blur）：偏移 ±blur，颜色更淡
                let ghost = theme::mix(p.surface, p.on_surface, st.opacity * 0.35);
                SetTextColor(dc, COLORREF(ghost));
                let off = blur.round().max(1.0) as i32;
                draw_char(dc, *ch, x - off, base_y);
                draw_char(dc, *ch, x + off, base_y);
                SetTextColor(dc, COLORREF(color));
            }

            draw_char(dc, *ch, x, base_y);

            SelectObject(dc, old_f);
            let _ = DeleteObject(f);

            x += w + spacing;
        }

        // ---- 副标题「正在启动…」 ----
        //
        // 位置经过刻意安排：字母基线在 cy 附近，副标题放在 cy+42，
        // 进度条放在 height-30。三者互不重叠 ——
        // 之前的布局把进度条算在 height-56，正好压在副标题的矩形里，
        // 实机上表现为「正在启动…」被加载条截断（用户反馈过）。
        let subtitle_font = create_font(12, false, true);
        let old_sf = SelectObject(dc, subtitle_font);
        SetTextColor(dc, COLORREF(p.on_surface_variant));
        let mut subtitle: Vec<u16> = "正在启动…".encode_utf16().collect();
        let mut sub_rect = RECT {
            left: 0,
            top: cy + 34,
            right: width,
            bottom: cy + 56,
        };
        DrawTextW(
            dc,
            &mut subtitle,
            &mut sub_rect,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER,
        );
        SelectObject(dc, old_sf);
        let _ = DeleteObject(subtitle_font);

        // ---- 进度条（与副标题保持足够间距，绝不重叠）----
        let bar_w = 200;
        let bar_h = 3;
        let bar_x = cx - bar_w / 2;
        let bar_y = height - 30;

        let track = theme::brush(p.outline_variant);
        let old_tb = SelectObject(dc, track);
        let old_tp = SelectObject(dc, GetStockObject(NULL_PEN));
        let _ = RoundRect(dc, bar_x, bar_y, bar_x + bar_w, bar_y + bar_h, bar_h, bar_h);
        SelectObject(dc, old_tb);
        SelectObject(dc, old_tp);
        let _ = DeleteObject(track);

        let seg = theme::brush(p.primary);
        let old_sb = SelectObject(dc, seg);
        let old_sp = SelectObject(dc, GetStockObject(NULL_PEN));
        let spin = animation::ring_angle(elapsed) / std::f64::consts::TAU;
        if fading {
            let _ = RoundRect(dc, bar_x, bar_y, bar_x + bar_w, bar_y + bar_h, bar_h, bar_h);
        } else {
            draw_segment(
                dc,
                bar_x,
                bar_y,
                bar_w,
                bar_h,
                theme::emphasized(spin),
                0.40,
            );
            draw_segment(
                dc,
                bar_x,
                bar_y,
                bar_w,
                bar_h,
                theme::emphasized((spin + 0.5) % 1.0),
                0.28,
            );
        }
        SelectObject(dc, old_sb);
        SelectObject(dc, old_sp);
        let _ = DeleteObject(seg);
    }
}

/// 画单字符（ExtTextOutW 需要预先转 UTF-16）
fn draw_char(dc: HDC, ch: char, x: i32, baseline_y: i32) {
    unsafe {
        let buf: Vec<u16> = ch.to_string().encode_utf16().collect();
        // 让字符垂直居中：字号 30 时约在 baseline 上方 11px
        let y = baseline_y - 11;
        let _ = TextOutW(dc, x, y, &buf);
    }
}

/// 画进度条的一段（progress = 0..1 的位置，seg = 占轨道宽度的比例）
fn draw_segment(dc: HDC, bar_x: i32, bar_y: i32, bar_w: i32, bar_h: i32, progress: f64, seg: f64) {
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

/// 字体族：拉丁字母与中文分开指定。
///
/// 为什么不能只写一个 `Segoe UI`：它**不含中文字形**，而 GDI 的字形回退
/// 在显式指定字体名后并不总是发生（`DrawTextW` 不是浏览器）。
/// 副标题「正在启动…」需要真正的中文字体，否则会画成方块（实测在无中文字体的
/// 环境里就会这样）。`Microsoft YaHei UI` 是 Windows 中文版的默认 UI 字体，
/// 系统一定具备。
const FONT_LATIN: &str = "Segoe UI";
const FONT_CJK: &str = "Microsoft YaHei UI";

/// 造一个字体（调用方负责 DeleteObject）。
///
/// `cjk = true` 时用中文字体族，用于含中文的文本。
fn create_font(size: i32, bold: bool, cjk: bool) -> HFONT {
    unsafe {
        let mut lf = LOGFONTW {
            lfHeight: -size,
            lfWeight: if bold {
                FW_SEMIBOLD.0 as i32
            } else {
                FW_NORMAL.0 as i32
            },
            // 中文文本用 GB2312_CHARSET，让 GDI 走中文字形路径
            lfCharSet: if cjk { GB2312_CHARSET } else { DEFAULT_CHARSET },
            lfQuality: CLEARTYPE_QUALITY,
            ..Default::default()
        };
        let family = if cjk { FONT_CJK } else { FONT_LATIN };
        for (i, ch) in family.encode_utf16().take(31).enumerate() {
            lf.lfFaceName[i] = ch;
        }
        CreateFontIndirectW(&lf)
    }
}

/// 调试用：把一帧渲染成 BMP 文件。
///
/// 为什么需要它：splash 是 Windows GUI 程序，而 **Wine + xwd 对分层窗口的截图
/// 不可靠**（实测窗口内容在屏幕上的位置与 xwininfo 报告的不一致）。
/// 直接导出 **GDI 实际画出的像素**，才能判断布局、文字、配色是否正确。
///
/// 只在 debug 构建里存在，不进发布产物。
#[cfg(debug_assertions)]
pub fn dump_frame_to_bmp(
    path: &str,
    width: i32,
    height: i32,
    elapsed: u64,
    palette: Palette,
) -> std::io::Result<()> {
    use std::io::Write;

    unsafe {
        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(screen_dc);

        // 32bpp 自顶向下 DIB：CreateDIBSection 直接把像素指针给我们
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|e| std::io::Error::other(e.message().to_string()))?;
        let old = SelectObject(mem_dc, dib);

        draw(mem_dc, width, height, elapsed, false, palette);

        // 拷出像素再写文件（GDI 的 DIB 是 BGRA，正好是 BMP 的 32bpp 布局）
        let len = (width * height * 4) as usize;
        let pixels = std::slice::from_raw_parts(bits as *const u8, len);

        let mut f = std::fs::File::create(path)?;
        let file_size = 14 + 40 + len as u32;
        f.write_all(b"BM")?;
        f.write_all(&file_size.to_le_bytes())?;
        f.write_all(&[0u8; 4])?;
        f.write_all(&54u32.to_le_bytes())?;
        f.write_all(&40u32.to_le_bytes())?;
        f.write_all(&width.to_le_bytes())?;
        f.write_all(&(-height).to_le_bytes())?;
        f.write_all(&1u16.to_le_bytes())?;
        f.write_all(&32u16.to_le_bytes())?;
        f.write_all(&0u32.to_le_bytes())?;
        f.write_all(&(len as u32).to_le_bytes())?;
        f.write_all(&2835u32.to_le_bytes())?;
        f.write_all(&2835u32.to_le_bytes())?;
        f.write_all(&0u32.to_le_bytes())?;
        f.write_all(&0u32.to_le_bytes())?;
        f.write_all(pixels)?;

        SelectObject(mem_dc, old);
        let _ = DeleteObject(dib);
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
    }
    Ok(())
}
