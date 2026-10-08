//! Material Design 3 设计令牌与调色板。
//!
//! 取值与 `apps/desktop/src/tokens/theme.css` **逐项对齐**（浅色取 `:root`，
//! 深色取 `[data-theme="dark"]`），让 splash 与应用首屏颜色连续 ——
//! 否则会看到「白色跳成另一种白」，或者亮色 splash 之后蹦出深色界面。

use windows::Win32::Foundation::COLORREF;
use windows::Win32::Graphics::Gdi::*;

/// 32 位颜色（0x00BBGGRR，GDI 的 COLORREF 布局）
pub const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// 一套主题颜色。
///
/// 用一个结构体而不是一堆 `const`，是为了让「跟随深色/浅色」这件事情
/// 在类型上就成立：`Palette::of(mode)` 一次取全，绘制代码不必到处判模式。
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    /// 窗口底色
    pub surface: u32,
    /// 主文字
    pub on_surface: u32,
    /// 次要文字（副标题、提示）
    pub on_surface_variant: u32,
    /// 强调色（进度条主动段、字母发光）
    pub primary: u32,
    /// 进度条轨道
    pub outline_variant: u32,
}

impl Palette {
    /// 浅色（对齐 theme.css `:root`）
    pub const LIGHT: Self = Self {
        surface: rgb(0xFC, 0xFC, 0xFC),
        on_surface: rgb(0x1A, 0x1C, 0x1E),
        on_surface_variant: rgb(0x44, 0x47, 0x4E),
        primary: rgb(0x1A, 0x5C, 0x9E),
        outline_variant: rgb(0xC4, 0xC6, 0xCF),
    };

    /// 深色（对齐 theme.css `[data-theme="dark"]`）
    pub const DARK: Self = Self {
        surface: rgb(0x0F, 0x0F, 0x11),
        on_surface: rgb(0xE2, 0xE2, 0xE5),
        on_surface_variant: rgb(0xC7, 0xC9, 0xCD),
        primary: rgb(0x8B, 0xB9, 0xF0),
        outline_variant: rgb(0x44, 0x47, 0x4E),
    };

    /// 按模式取色板
    pub fn of(mode: crate::prefs::Mode) -> Self {
        if mode.is_dark() {
            Self::DARK
        } else {
            Self::LIGHT
        }
    }
}

// ---- 尺寸 ----
/// 窗口尺寸：宽度要放得下「SilverMoon」10 个字母 + 字距，高度留出字母动画余量。
pub const WIN_W: i32 = 460;
pub const WIN_H: i32 = 240;
pub const CORNER: i32 = 24;

/// M3 emphasized 缓动 `cubic-bezier(0.2, 0, 0, 1)`。
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

/// 在两个 COLORREF 之间线性插值（用于按 alpha 混色）
pub fn mix(a: u32, b: u32, t: f64) -> u32 {
    let ch = |shift: u32| -> u8 {
        let av = ((a >> shift) & 0xFF) as f64;
        let bv = ((b >> shift) & 0xFF) as f64;
        (av + (bv - av) * t).round().clamp(0.0, 255.0) as u8
    };
    rgb(ch(0), ch(8), ch(16))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palettes_differ_between_modes() {
        assert_ne!(Palette::LIGHT.surface, Palette::DARK.surface);
        assert_ne!(Palette::LIGHT.on_surface, Palette::DARK.on_surface);
    }

    #[test]
    fn of_maps_mode() {
        assert_eq!(
            Palette::of(crate::prefs::Mode::Light).surface,
            Palette::LIGHT.surface
        );
        assert_eq!(
            Palette::of(crate::prefs::Mode::Dark).surface,
            Palette::DARK.surface
        );
    }

    #[test]
    fn mix_endpoints_and_middle() {
        let a = rgb(0, 0, 0);
        let b = rgb(255, 255, 255);
        assert_eq!(mix(a, b, 0.0), a);
        assert_eq!(mix(a, b, 1.0), b);
        assert_eq!(mix(a, b, 0.5), rgb(128, 128, 128));
    }

    #[test]
    fn emphasized_is_monotonic_and_bounded() {
        assert_eq!(emphasized(0.0), 0.0);
        assert_eq!(emphasized(1.0), 1.0);
        let mut prev = -1.0;
        for i in 0..=20 {
            let v = emphasized(i as f64 / 20.0);
            assert!(v >= prev, "emphasized 应单调不减");
            assert!((0.0..=1.0).contains(&v));
            prev = v;
        }
    }
}
