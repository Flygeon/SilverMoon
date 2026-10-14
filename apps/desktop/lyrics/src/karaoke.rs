//! 逐字填充进度计算。
//!
//! 这是 `src/utils/karaokeFill.ts` 的 Rust 版，语义逐条对齐：
//! - 行未开始 → 0，行已结束 → 1；
//! - 有词级时间轴 → 按**字符位置**插值（长词短词填充速度一致）；
//! - 词间空隙 → 停在上一词末尾，不跳到下一词；
//! - 无词级时间轴 → 整行匀速；
//! - emoji / 生僻字按**一个字符**计（用 chars() 而不是字节长度）。
//!
//! 为什么在 Rust 侧重算而不是让前端算完传过来：原生窗口是**独立进程**，
//! 拿不到播放器的实时 `currentTime`（只有 200ms 推一次的权威值）。
//! 让它自己按帧推进本地时钟、再调这里的纯函数算填充比例，
//! 才能做到帧级平滑而**不提高推送频率**。

/// 词级时间轴单位（秒，绝对时间）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Unit {
    pub start: f64,
    pub end: f64,
}

/// 参与填充的歌词行。
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    /// 行起始时间（秒）
    pub time: f64,
    /// 行文本（用于数出字符数）
    pub text: String,
    /// 词级时间轴；空则整行按行起止时间匀速
    pub units: Vec<Unit>,
}

/// 行结束时间：优先下一行起点；末行按文本长度估一个时长。
///
/// 估算口径与前端一致（每字 0.4s，最少 2s），这样原生窗口与主界面的
/// 行切换时机不会打架。
pub fn resolve_line_end(line: &Line, next_time: Option<f64>) -> f64 {
    if let Some(next) = next_time {
        if next > line.time {
            return next;
        }
    }
    if let Some(last) = line.units.last() {
        return last.end;
    }
    line.time + (char_count(&line.text) as f64 * 0.4).max(2.0)
}

/// 数「视觉字符数」。
///
/// 用 chars() 而不是 len()：后者数的是字节，中文一个字 3 字节、emoji 4 字节，
/// 会让填充比例算错（歌词里中英日混排是常态）。
pub fn char_count(text: &str) -> usize {
    text.chars().count()
}

/// 计算某一行在给定时间的填充比例（0 = 未开始，1 = 已唱完）。
pub fn compute_line_fill(line: &Line, next_time: Option<f64>, time: f64) -> f64 {
    let start = line.time;
    let end = resolve_line_end(line, next_time);

    if time <= start {
        return 0.0;
    }
    if time >= end {
        return 1.0;
    }

    if line.units.is_empty() {
        let span = end - start;
        return if span <= 0.0 {
            1.0
        } else {
            clamp01((time - start) / span)
        };
    }

    let total = char_count(&line.text);
    if total == 0 {
        return 0.0;
    }

    let spans = build_char_spans(&line.text, line.units.len());

    for (i, unit) in line.units.iter().enumerate() {
        let span = spans[i];
        if time < unit.start {
            // 落在空隙里：停在上一词的字符位置
            return clamp01(span.0 as f64 / total as f64);
        }
        if time < unit.end {
            let unit_span = unit.end - unit.start;
            let ratio = if unit_span <= 0.0 {
                1.0
            } else {
                (time - unit.start) / unit_span
            };
            let char_pos = span.0 as f64 + (span.1 - span.0) as f64 * ratio;
            return clamp01(char_pos / total as f64);
        }
    }

    // 时间已过最后一个词：停在行尾
    let last = spans[spans.len() - 1];
    clamp01(last.1 as f64 / total as f64)
}

/// 每个词在整行文本里占据的字符区间 [start, end)。
///
/// 均匀分配剩余字符给剩余词：这样即使词数多于字符数（英文按词切分、或
/// 时间轴与文本不完全对应）也不会越界，且整体覆盖整行。
fn build_char_spans(text: &str, unit_count: usize) -> Vec<(usize, usize)> {
    let total = char_count(text);
    let mut spans = Vec::with_capacity(unit_count);
    let mut cursor = 0usize;

    for i in 0..unit_count {
        let remaining_units = unit_count - i;
        let remaining_chars = total.saturating_sub(cursor);
        let take = if remaining_units <= 1 {
            remaining_chars
        } else {
            // 四舍五入到最近整数，与 TS 版一致
            ((remaining_chars as f64) / (remaining_units as f64)).round() as usize
        };
        let size = take.max(1).min(remaining_chars);
        spans.push((cursor, cursor + size));
        cursor += size;
    }
    spans
}

fn clamp01(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    v.max(0.0).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(time: f64, text: &str, units: Vec<Unit>) -> Line {
        Line {
            time,
            text: text.to_string(),
            units,
        }
    }

    #[test]
    fn not_started_is_zero_finished_is_one() {
        let l = line(10.0, "abc", vec![]);
        assert_eq!(compute_line_fill(&l, Some(20.0), 9.0), 0.0);
        assert_eq!(compute_line_fill(&l, Some(20.0), 20.0), 1.0);
        assert_eq!(compute_line_fill(&l, Some(20.0), 25.0), 1.0);
    }

    #[test]
    fn uniform_without_units() {
        let l = line(0.0, "abcd", vec![]);
        assert!((compute_line_fill(&l, Some(4.0), 1.0) - 0.25).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(4.0), 2.0) - 0.5).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(4.0), 3.0) - 0.75).abs() < 1e-9);
    }

    #[test]
    fn interpolates_by_char_position() {
        // 4 个字、4 个词，每词 1 秒
        let l = line(
            0.0,
            "abcd",
            vec![
                Unit {
                    start: 0.0,
                    end: 1.0,
                },
                Unit {
                    start: 1.0,
                    end: 2.0,
                },
                Unit {
                    start: 2.0,
                    end: 3.0,
                },
                Unit {
                    start: 3.0,
                    end: 4.0,
                },
            ],
        );
        assert!((compute_line_fill(&l, Some(5.0), 0.5) - 0.125).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(5.0), 1.0) - 0.25).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(5.0), 2.5) - 0.625).abs() < 1e-9);
    }

    #[test]
    fn long_and_short_words_scale_by_chars() {
        // 5 个字，第一词占 3 字、第二词占 2 字
        let l = line(
            0.0,
            "abcde",
            vec![
                Unit {
                    start: 0.0,
                    end: 2.0,
                },
                Unit {
                    start: 2.0,
                    end: 4.0,
                },
            ],
        );
        assert!((compute_line_fill(&l, Some(6.0), 1.0) - 1.5 / 5.0).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(6.0), 2.0) - 3.0 / 5.0).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(6.0), 4.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn gap_holds_at_previous_word_end() {
        let l = line(
            0.0,
            "abcd",
            vec![
                Unit {
                    start: 0.0,
                    end: 1.0,
                },
                Unit {
                    start: 3.0,
                    end: 4.0,
                },
            ],
        );
        // t=2 落在 1~3 的空隙：停在第一词结束的字符位置（2/4）
        assert!((compute_line_fill(&l, Some(5.0), 2.0) - 0.5).abs() < 1e-9);
        assert!((compute_line_fill(&l, Some(5.0), 3.0) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn cjk_counts_as_single_chars() {
        // 中文一个字算一个字符，不是 3 个字节
        assert_eq!(char_count("明月几时有"), 5);
        let l = line(
            0.0,
            "明月几时有",
            vec![
                Unit {
                    start: 0.0,
                    end: 1.0,
                },
                Unit {
                    start: 1.0,
                    end: 2.0,
                },
                Unit {
                    start: 2.0,
                    end: 3.0,
                },
                Unit {
                    start: 3.0,
                    end: 4.0,
                },
                Unit {
                    start: 4.0,
                    end: 5.0,
                },
            ],
        );
        assert!((compute_line_fill(&l, Some(6.0), 1.0) - 0.2).abs() < 1e-9);
    }

    #[test]
    fn emoji_counts_as_one_char() {
        assert_eq!(char_count("a🎵b"), 3);
        let l = line(
            0.0,
            "a🎵b",
            vec![
                Unit {
                    start: 0.0,
                    end: 1.0,
                },
                Unit {
                    start: 1.0,
                    end: 2.0,
                },
                Unit {
                    start: 2.0,
                    end: 3.0,
                },
            ],
        );
        assert!((compute_line_fill(&l, Some(4.0), 1.0) - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn more_units_than_chars_does_not_overflow() {
        let l = line(
            0.0,
            "ab",
            vec![
                Unit {
                    start: 0.0,
                    end: 1.0,
                },
                Unit {
                    start: 1.0,
                    end: 2.0,
                },
                Unit {
                    start: 2.0,
                    end: 3.0,
                },
            ],
        );
        let v = compute_line_fill(&l, Some(4.0), 2.5);
        assert!((0.0..=1.0).contains(&v));
    }

    #[test]
    fn empty_text_is_finite() {
        let l = line(0.0, "", vec![]);
        assert!(compute_line_fill(&l, Some(4.0), 2.0).is_finite());
    }

    #[test]
    fn line_end_prefers_next_then_units_then_estimate() {
        assert_eq!(resolve_line_end(&line(0.0, "abc", vec![]), Some(5.0)), 5.0);
        let with_units = line(
            0.0,
            "ab",
            vec![
                Unit {
                    start: 0.0,
                    end: 1.0,
                },
                Unit {
                    start: 1.0,
                    end: 2.5,
                },
            ],
        );
        assert_eq!(resolve_line_end(&with_units, None), 2.5);
        // 末行无 units：每字 0.4s，最少 2s
        assert_eq!(resolve_line_end(&line(0.0, "a", vec![]), None), 2.0);
        assert!((resolve_line_end(&line(0.0, "abcdefghij", vec![]), None) - 4.0).abs() < 1e-9);
    }
}
