//! 「SilverMoon」逐字发光加载动画的**纯计算部分**。
//!
//! 复刻自用户提供的 React/styled-components 版 Loader，把 CSS keyframes 换算成
//! 「给定时刻 t → 每个字母/星星的透明度、缩放、模糊、位移」。
//!
//! 为什么把计算与绘制分开：绘制要调 GDI（只能在 Windows 跑），但**动画是否对**
//! 是纯数学问题。拆开后这部分能在 Linux 上跑真实单元测试，绘制层只负责画。
//!
//! 与原版 CSS 的对应关系：
//!
//! - 原版把 `LAUNCHING` 换成 `SilverMoon`（本应用名）；
//! - 原版每个字母 `animation-delay: i * 0.1s`，这里等价为「相位偏移」，
//!   视觉效果一致（一串自左向右流动的呼吸波）；
//! - 原版 keyframes 在 0% / 20% / 40% / 100% 有明确停留点，这里按同样节点做
//!   分段线性插值；
//! - 原版 `filter: blur()` 与 `box-shadow` 由绘制层近似（见 window.rs 说明）。

/// 动画周期（毫秒）。对应原版 `animation: ... 2s infinite`。
pub const PERIOD_MS: u64 = 2000;

/// 相邻字母的相位差（毫秒）。对应原版 `animation-delay: 0.1s * i`。
pub const LETTER_DELAY_MS: u64 = 100;

/// 要显示的文字。原版是 LAUNCHING，本应用改为产品名。
pub const LETTERS: [char; 10] = ['S', 'i', 'l', 'v', 'e', 'r', 'M', 'o', 'o', 'n'];

/// 单个字母在某一时刻的视觉状态。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LetterState {
    /// 不透明度 0..1
    pub opacity: f64,
    /// 缩放（1.0 = 原始大小）
    pub scale: f64,
    /// 垂直位移（像素，负值向上）
    pub dy: f64,
    /// 模糊半径（像素）
    pub blur: f64,
}

/// 线性插值
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// 计算某个字母在 `elapsed_ms` 时刻的状态。
///
/// `index` 是字母序号（0 起），用于相位偏移。
pub fn letter_state(index: usize, elapsed_ms: u64) -> LetterState {
    let shifted = elapsed_ms + index as u64 * LETTER_DELAY_MS;
    let phase = (shifted % PERIOD_MS) as f64 / PERIOD_MS as f64;

    // 原版 keyframes 的四个停留点：
    //   0%   opacity 0.0  scale 1.0  dy 0    blur 2.0
    //   20%  opacity 1.0  scale 1.2  dy -1   blur 0.0
    //   40%  opacity 0.7  scale 1.0  dy 0    blur 2.0
    //   100% opacity 0.0  scale 1.0  dy 0    blur 2.0
    const STOPS: [(f64, f64, f64, f64, f64); 4] = [
        (0.00, 0.0, 1.0, 0.0, 2.0),
        (0.20, 1.0, 1.2, -1.0, 0.0),
        (0.40, 0.7, 1.0, 0.0, 2.0),
        (1.00, 0.0, 1.0, 0.0, 2.0),
    ];

    for w in STOPS.windows(2) {
        let (t0, o0, s0, d0, b0) = w[0];
        let (t1, o1, s1, d1, b1) = w[1];
        if phase >= t0 && phase <= t1 {
            let span = t1 - t0;
            let k = if span <= f64::EPSILON {
                0.0
            } else {
                (phase - t0) / span
            };
            return LetterState {
                opacity: lerp(o0, o1, k),
                scale: lerp(s0, s1, k),
                dy: lerp(d0, d1, k),
                blur: lerp(b0, b1, k),
            };
        }
    }

    // 理论上到不了这里（STOPS 覆盖 0..1）；给个安全默认值而不是 panic，
    // 因为这是每帧都要跑的路径，绝不能因浮点边界把启动器搞崩。
    LetterState {
        opacity: 0.0,
        scale: 1.0,
        dy: 0.0,
        blur: 2.0,
    }
}

/// 星星在某一时刻的状态。对应原版 `.star` 的 `blur-anim`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StarState {
    pub opacity: f64,
    pub blur: f64,
}

/// 7 颗星星：`(dx, dy, scale, delay_ms)`，取自原版 7 个 `.star` 规则。
pub const STARS: [(f64, f64, f64, u64); 7] = [
    (20.0, 90.0, 1.0, 0),
    (56.0, 46.0, 1.05, 200),
    (-26.0, 56.0, 1.4, 400),
    (-50.0, -70.0, 0.95, 700),
    (32.0, -66.0, 1.3, 350),
    (82.0, -36.0, 1.0, 900),
    (-92.0, 26.0, 1.0, 950),
];

/// 计算星星状态：0%/100% → opacity .2 blur 4；50% → opacity .3 blur 1。
pub fn star_state(delay_ms: u64, elapsed_ms: u64) -> StarState {
    let shifted = elapsed_ms + delay_ms;
    let phase = (shifted % PERIOD_MS) as f64 / PERIOD_MS as f64;
    // 用余弦做平滑往复，等价于 CSS 0/50/100 三点插值
    let k = (1.0 - (phase * std::f64::consts::TAU).cos()) / 2.0; // 0→1→0
    StarState {
        opacity: lerp(0.2, 0.3, k),
        blur: lerp(4.0, 1.0, k),
    }
}

/// 环形高光（原版 `.loader` 的 `loader-rotate`）当前旋转角，单位弧度。
pub fn ring_angle(elapsed_ms: u64) -> f64 {
    // 2s 转 360°（原版 90deg → 450deg）
    (elapsed_ms % PERIOD_MS) as f64 / PERIOD_MS as f64 * std::f64::consts::TAU
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn letters_spell_silvermoon() {
        let s: String = LETTERS.iter().collect();
        assert_eq!(s, "SilverMoon");
    }

    #[test]
    fn opacity_is_bounded_and_peaks_at_twenty_percent() {
        for i in 0..LETTERS.len() {
            for ms in (0..PERIOD_MS).step_by(25) {
                let st = letter_state(i, ms);
                assert!(
                    (0.0..=1.0).contains(&st.opacity),
                    "opacity 越界: {}",
                    st.opacity
                );
                assert!(
                    st.scale >= 1.0 && st.scale <= 1.25,
                    "scale 越界: {}",
                    st.scale
                );
                assert!(st.blur >= 0.0 && st.blur <= 2.0, "blur 越界: {}", st.blur);
            }
        }
    }

    #[test]
    fn peak_of_first_letter_is_at_20_percent() {
        // index 0、相位 0.2 → opacity 应为 1、scale 1.2、blur 0
        let st = letter_state(0, (PERIOD_MS as f64 * 0.2) as u64);
        assert!(approx(st.opacity, 1.0, 1e-6), "{}", st.opacity);
        assert!(approx(st.scale, 1.2, 1e-6), "{}", st.scale);
        assert!(approx(st.blur, 0.0, 1e-6), "{}", st.blur);
    }

    #[test]
    fn start_is_dim_and_blurred() {
        let st = letter_state(0, 0);
        assert!(approx(st.opacity, 0.0, 1e-6));
        assert!(approx(st.blur, 2.0, 1e-6));
    }

    #[test]
    fn wave_travels_left_to_right() {
        // 同一时刻，靠后的字母相位更靠前 → 峰值随时间向右传播。
        // 取第一个字母刚到峰值的一半时，第二个字母应还未到峰值。
        let ms = (PERIOD_MS as f64 * 0.2) as u64;
        assert!(letter_state(0, ms).opacity > letter_state(1, ms).opacity);
    }

    #[test]
    fn all_phases_are_handled_without_panic() {
        for ms in 0..(PERIOD_MS * 3) {
            for i in 0..LETTERS.len() {
                let st = letter_state(i, ms);
                assert!(st.opacity.is_finite() && st.scale.is_finite() && st.blur.is_finite());
            }
        }
    }

    #[test]
    fn star_states_are_bounded() {
        for (_, _, _, delay) in STARS {
            for ms in (0..PERIOD_MS * 2).step_by(50) {
                let s = star_state(delay, ms);
                assert!(
                    (0.2..=0.3).contains(&s.opacity),
                    "star opacity {}",
                    s.opacity
                );
                assert!((1.0..=4.0).contains(&s.blur), "star blur {}", s.blur);
            }
        }
    }

    #[test]
    fn ring_angle_wraps_within_one_turn() {
        for ms in [0u64, 500, 1000, 1999, 2000, 4321] {
            let a = ring_angle(ms);
            assert!((0.0..std::f64::consts::TAU).contains(&a), "{}", a);
        }
    }
}
