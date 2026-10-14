//! 动画数学（**纯计算，不碰任何 Win32**）。
//!
//! ## 为什么单独成模块
//!
//! 与 splash 的 animation.rs 同一理由：**「动画是否对」是纯数学问题**，
//! 绘制才是平台相关的。拆开后这部分能在 Linux/CI 上跑真实断言 ——
//! 本机没有 MSVC、`cargo build` 跑不了，所以「能在 CI 上真跑」的部分要尽量多。
//!
//! ## 缓动曲线从哪来
//!
//! 直接取自参考项目 TaskbarLyrics 的 `Web/Lyrics/style.css`（实测统计）：
//!
//! | 曲线 | 出现次数 | 用途 |
//! | --- | --- | --- |
//! | `cubic-bezier(0.22, 0.72, 0.24, 1)` | 7 | 图层切换 / 频谱进出（最常用） |
//! | `cubic-bezier(0.2, 0.9, 0.1, 1)` | 6 | 歌词行滚动 |
//! | `cubic-bezier(0.16, 1, 0.3, 1)` | 4 | 行淡入淡出（≈ easeOutExpo） |
//!
//! 时长也照抄它的取值：行滚动 560ms、翻译对 760ms、图层切换 300ms、
//! 逐字平滑 90ms linear、行淡入 520ms。**这些数字是它调出来的手感**，
//! 不要凭感觉改。
//!
//! ## 贝塞尔怎么算
//!
//! CSS 的 `cubic-bezier(x1,y1,x2,y2)` 是**参数曲线**：给定时间 t 要先解出
//! 参数 u 使得 `Bx(u)=t`，再取 `By(u)` 作为进度。这里用二分法求 u ——
//! 20 次迭代精度足够（误差 < 1e-6），比牛顿法稳（不会因导数接近 0 而发散）。

/// 参考项目的三条缓动曲线（控制点）。
pub const EASE_LAYER: [f64; 4] = [0.22, 0.72, 0.24, 1.0];
pub const EASE_ROLL: [f64; 4] = [0.2, 0.9, 0.1, 1.0];
pub const EASE_FADE: [f64; 4] = [0.16, 1.0, 0.3, 1.0];

/// 参考项目的时长（毫秒）。
pub const DURATION_ROLL_MS: f64 = 560.0;
pub const DURATION_TRANSLATION_ROLL_MS: f64 = 760.0;
pub const DURATION_LAYER_MS: f64 = 300.0;
pub const DURATION_FADE_MS: f64 = 520.0;
/// 逐字扫描的平滑跟随：90ms linear（不是缓动 —— 它要贴着进度走）
pub const DURATION_WORD_SMOOTH_MS: f64 = 90.0;

/// 三次贝塞尔在参数 u 处的值（一维）。
fn bezier(a: f64, b: f64, u: f64) -> f64 {
    // B(u) = 3(1-u)²u·P1 + 3(1-u)u²·P2 + u³
    // （P0=0、P3=1 已代入）
    let inv = 1.0 - u;
    3.0 * inv * inv * u * a + 3.0 * inv * u * u * b + u * u * u
}

/// 求解给定时间 `t` 下的参数 u，使 `Bx(u) = t`。
///
/// 二分法：`Bx` 在 [0,1] 上单调（CSS 保证 x 控制点在 [0,1] 内），
/// 因此二分必定收敛，且不会像牛顿法那样在导数接近 0 时发散。
fn solve_u(x1: f64, x2: f64, t: f64) -> f64 {
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if bezier(x1, x2, mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// 按给定控制点求缓动进度（输入输出都是 0..1）。
pub fn cubic_bezier(control: [f64; 4], t: f64) -> f64 {
    // NaN 是「无意义」→ 0；而 +∞/-∞ 是「远超两端」→ 按端点取值。
    // 两者不能混为一谈：用 !is_finite() 会把 ∞ 也判成 0，
    // 那意味着「动画早该播完」却被当成「还没开始」。
    if t.is_nan() {
        return 0.0;
    }
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let u = solve_u(control[0], control[2], t);
    bezier(control[1], control[3], u).clamp(0.0, 1.0)
}

/// 按时间（毫秒）与总时长求缓动进度。时长非正时直接返回 1（已完成）。
pub fn eased(control: [f64; 4], elapsed_ms: f64, duration_ms: f64) -> f64 {
    if duration_ms <= 0.0 {
        return 1.0;
    }
    cubic_bezier(control, elapsed_ms / duration_ms)
}

/// 线性插值。
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// 逐字扫描进度：把填充比例换算成 `clip-path: inset()` 要用的百分比字符串。
///
/// 参考项目用**双文字层**做逐字：
/// - 底层 = 未唱部分（暗色），`clip-path: inset(0 0 0 <progress>)`
/// - 上层 = 已唱部分（亮色），`clip-path: inset(0 <100%-progress> 0 0)`
///
/// 两层的裁切边界严格互补，所以**不需要羽化**就有干净的分界；
/// 羽化（mask-image）是它的可选增强，用于让边界更柔。
/// 这里先做「硬边界」版：它没有依赖、在所有 WebView2 版本上行为一致。
pub fn scan_inset_percent(progress: f64) -> (f64, f64) {
    let p = progress.clamp(0.0, 1.0) * 100.0;
    // (底层左内缩, 上层右内缩)
    (p, 100.0 - p)
}

/// 频谱柱的下落平滑。
///
/// 参考项目与前端一致的做法：**上升立即跟手、下降做缓动**。
/// 5-20Hz 的数据源不做插值会明显一格一格跳。
pub fn smooth_bar(previous: f64, target: f64, falloff: f64) -> f64 {
    if target > previous {
        target
    } else {
        previous * falloff + target * (1.0 - falloff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_endpoints_are_exact() {
        for c in [EASE_LAYER, EASE_ROLL, EASE_FADE] {
            assert_eq!(cubic_bezier(c, 0.0), 0.0);
            assert_eq!(cubic_bezier(c, 1.0), 1.0);
        }
    }

    #[test]
    fn bezier_is_monotonic() {
        // 缓动函数必须单调递增，否则动画会「倒退」
        let mut prev = -1.0;
        for i in 0..=100 {
            let t = i as f64 / 100.0;
            let v = cubic_bezier(EASE_LAYER, t);
            assert!(v >= prev - 1e-9, "not monotonic at t={t}: {v} < {prev}");
            prev = v;
        }
    }

    #[test]
    fn fade_curve_is_fast_at_start() {
        // cubic-bezier(0.16,1,0.3,1) ≈ easeOutExpo：t=0.5 时进度应已过半很多
        let v = cubic_bezier(EASE_FADE, 0.5);
        assert!(v > 0.8, "expected fast-out, got {v}");
    }

    #[test]
    fn roll_curve_is_smooth_at_both_ends() {
        // (0.2,0.9,0.1,1)：起步不慢、收尾极缓 —— 中段应该已经走完大半
        assert!(cubic_bezier(EASE_ROLL, 0.5) > 0.6);
        assert!(cubic_bezier(EASE_ROLL, 0.9) > 0.98);
    }

    #[test]
    fn layer_curve_differs_from_roll() {
        // 两条曲线不能是同一个（否则说明控制点抄错了）
        let a = cubic_bezier(EASE_LAYER, 0.4);
        let b = cubic_bezier(EASE_ROLL, 0.4);
        assert!((a - b).abs() > 1e-6);
    }

    #[test]
    fn eased_handles_zero_and_negative_duration() {
        assert_eq!(eased(EASE_LAYER, 100.0, 0.0), 1.0);
        assert_eq!(eased(EASE_LAYER, 100.0, -5.0), 1.0);
    }

    #[test]
    fn eased_clamps_beyond_duration() {
        assert_eq!(eased(EASE_LAYER, 9999.0, 300.0), 1.0);
    }

    #[test]
    fn bezier_rejects_non_finite() {
        assert_eq!(cubic_bezier(EASE_LAYER, f64::NAN), 0.0);
        assert_eq!(cubic_bezier(EASE_LAYER, f64::INFINITY), 1.0);
    }

    #[test]
    fn scan_inset_is_complementary() {
        // 两层的裁切必须严格互补，否则中间会出现缝隙或重叠
        for p in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let (base_left, scan_right) = scan_inset_percent(p);
            assert!((base_left + scan_right - 100.0).abs() < 1e-9);
        }
    }

    #[test]
    fn scan_inset_clamps_out_of_range() {
        assert_eq!(scan_inset_percent(-1.0), (0.0, 100.0));
        assert_eq!(scan_inset_percent(2.0), (100.0, 0.0));
    }

    #[test]
    fn smooth_bar_rises_instantly() {
        // 上升必须立即跟手，否则鼓点会「软」
        assert_eq!(smooth_bar(0.1, 0.9, 0.75), 0.9);
    }

    #[test]
    fn smooth_bar_falls_gradually() {
        let v = smooth_bar(1.0, 0.0, 0.75);
        assert!(v > 0.0 && v < 1.0, "expected gradual fall, got {v}");
        // 连续下落应逐步逼近 0
        let mut cur = 1.0;
        for _ in 0..50 {
            cur = smooth_bar(cur, 0.0, 0.75);
        }
        assert!(cur < 0.01);
    }

    #[test]
    fn lerp_works() {
        assert_eq!(lerp(0.0, 10.0, 0.5), 5.0);
        assert_eq!(lerp(10.0, 0.0, 0.25), 7.5);
    }
}
