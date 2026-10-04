//! Material Design 3 设计令牌与自绘基元。
//!
//! 取值与 `apps/desktop/src/tokens/theme.css` 的浅色主题**逐项对齐**，
//! 让 splash 与应用首屏颜色连续 —— 否则会看到"白色跳成另一种白"。

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;

/// 32 位颜色（0x00BBGGRR，GDI 的 COLORREF 布局）
pub const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

// ---- 颜色（对齐 theme.css 的 --md-sys-color-*，浅色）----
pub const SURFACE: u32 = rgb(0xFC, 0xFC, 0xFC);
pub const ON_SURFACE: u32 = rgb(0x1A, 0x1C, 0x1E);
pub const ON_SURFACE_VARIANT: u32 = rgb(0x44, 0x47, 0x4E);
pub const PRIMARY: u32 = rgb(0x1A, 0x5C, 0x9E);
pub const PRIMARY_CONTAINER: u32 = rgb(0xD2, 0xE4, 0xFF);
pub const OUTLINE_VARIANT: u32 = rgb(0xC4, 0xC6, 0xCF);

// ---- 尺寸 ----
pub const WIN_W: i32 = 420;
pub const WIN_H: i32 = 260;
pub const CORNER: i32 = 28;

/// M3 emphasized 缓动 `cubic-bezier(0.2, 0, 0, 1)`。
///
/// 用于淡出与进度推进，比线性"更有质感"。
pub fn emphasized(t: f64) -> f64 {
    cubic_bezier(t, 0.2, 0.0, 0.0, 1.0)
}

/// 求解三次贝塞尔缓动曲线在 x=t 处的 y。
///
/// 曲线由 (0,0)-(x1,y1)-(x2,y2)-(1,1) 定义：先对 x 二分求参数 s，再取 y(s)。
/// 每帧只调用个位数次，20 次二分足够，无需牛顿迭代的导数处理。
fn cubic_bezier(t: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    let mut s = t;
    for _ in 0..20 {
        s = (lo + hi) / 2.0;
        if bezier_axis(s, x1, x2) < t {
            lo = s;
        } else {
            hi = s;
        }
    }
    bezier_axis(s, y1, y2)
}

/// 三次贝塞尔单轴取值（P0=0, P3=1）
fn bezier_axis(s: f64, p1: f64, p2: f64) -> f64 {
    let inv = 1.0 - s;
    3.0 * inv * inv * s * p1 + 3.0 * inv * s * s * p2 + s * s * s
}

/// 创建实心画刷（调用方负责 DeleteObject）
pub fn brush(color: u32) -> HBRUSH {
    unsafe { CreateSolidBrush(COLORREF(color)) }
}
