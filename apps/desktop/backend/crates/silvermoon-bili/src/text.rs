//! 文本与数值归一化：与前端 `src/utils/bilibili.ts` 的同名函数逐字对齐。
//!
//! 刻意**不含** `biliPubdate`（「3 天前」）：它依赖本机时区，属于展示层，
//! 留在前端。把时区语义塞进协议层只会让服务端行为依赖运行环境。

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// 去标签正则（与前端 `/<[^>]*>/g` 同一条）。
fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").expect("去标签正则必须是合法字面量"))
}

/// 去标签正则的替换结果（`strip_html` 内部用）。
fn strip_tags(s: &str) -> String {
    tag_re().replace_all(s, "").into_owned()
}

/// 去掉搜索接口的 `<em class="keyword">` 高亮与常见实体。
pub fn strip_html(s: &str) -> String {
    strip_tags(s)
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

/// 宽松数值转换：数字 / 数字字符串 → f64，其余 → 0。
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).unwrap_or(0.0),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 宽松字符串转换：null → 空串；数字 / 布尔 → 字面量；对象 / 数组 → 空串。
///
/// 与前端 `str()` 的唯一差别是对象 / 数组：JS 会给 `"[object Object]"`，
/// 这里给空串 —— 上游没有哪个字段真的期望那种值，空串更安全也更好排查。
pub fn str_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// `str_of` + 默认值（对应前端 `str(v, fallback)`）。
pub fn str_or(v: &Value, default: &str) -> String {
    let s = str_of(v);
    if s.is_empty() {
        default.to_string()
    } else {
        s
    }
}

/// 封面地址归一化，并统一升级为 https。
pub fn image_url(v: &Value) -> String {
    let s = str_of(v);
    if s.is_empty() {
        return s;
    }
    if let Some(rest) = s.strip_prefix("//") {
        return format!("https://{rest}");
    }
    if let Some(rest) = s.strip_prefix("http://") {
        return format!("https://{rest}");
    }
    s
}

/// 视频流地址：强制 https（主进程补 Referer 时明文 http 会被 Chromium 拦掉）。
pub fn media_url(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

/// 秒 → `mm:ss` / `h:mm:ss`。
pub fn duration(seconds: f64) -> String {
    let total = if seconds.is_finite() {
        seconds.max(0.0).floor() as i64
    } else {
        0
    };
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// 播放量 / 弹幕数：`1.2万`、`3.4亿`。
pub fn count(n: f64) -> String {
    if !n.is_finite() || n <= 0.0 {
        return "0".to_string();
    }
    if n >= 100_000_000.0 {
        return format!("{:.1}亿", n / 100_000_000.0);
    }
    if n >= 10_000.0 {
        return format!("{:.1}万", n / 10_000.0);
    }
    // 与 JS `String(n)` 对齐：整数值不带小数
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// 画质码 → 中文标签（取不到支持列表时兜底）。
pub fn quality_label(qn: i64) -> String {
    let label = match qn {
        6 => "240P 流畅",
        16 => "360P 清晰",
        32 => "480P 标清",
        64 => "720P 高清",
        74 => "720P60",
        80 => "1080P 高清",
        100 => "智能修复",
        112 => "1080P+ 高码率",
        116 => "1080P60",
        120 => "4K 超清",
        125 => "HDR 真彩",
        126 => "杜比视界",
        127 => "8K 超高清",
        129 => "HDR Vivid",
        _ => return format!("未知({qn})"),
    };
    label.to_string()
}

/// `"12:34"` / `"1:02:03"` → 秒。
pub fn parse_clock(s: &str) -> i64 {
    if s.is_empty() {
        return 0;
    }
    s.split(':').fold(0i64, |acc, part| {
        acc * 60 + part.trim().parse::<i64>().unwrap_or(0)
    })
}

/// 上游时长字段既有数字（秒）也有 `"12:34"` 字符串，统一成秒。
pub fn clock_or_num(v: &Value) -> i64 {
    if let Value::String(s) = v {
        if s.contains(':') {
            return parse_clock(s);
        }
    }
    num(v) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_html_removes_search_highlight() {
        assert_eq!(
            strip_html(r#"<em class="keyword">银月</em> 主题曲"#),
            "银月 主题曲"
        );
        assert_eq!(strip_html("a&amp;b"), "a&b");
        assert_eq!(strip_html("  pad  "), "pad");
    }

    #[test]
    fn num_is_lenient() {
        assert_eq!(num(&json!(12)), 12.0);
        assert_eq!(num(&json!("34")), 34.0);
        assert_eq!(num(&json!("abc")), 0.0);
        assert_eq!(num(&json!(null)), 0.0);
        assert_eq!(num(&json!("")), 0.0);
    }

    #[test]
    fn str_of_and_str_or() {
        assert_eq!(str_of(&json!(null)), "");
        assert_eq!(str_of(&json!("x")), "x");
        assert_eq!(str_of(&json!(7)), "7");
        assert_eq!(str_or(&json!(""), "av"), "av");
        assert_eq!(str_or(&json!("bv"), "av"), "bv");
    }

    #[test]
    fn image_url_upgrades_scheme() {
        assert_eq!(
            image_url(&json!("//i0.hdslb.com/a.jpg")),
            "https://i0.hdslb.com/a.jpg"
        );
        assert_eq!(
            image_url(&json!("http://i0.hdslb.com/a.jpg")),
            "https://i0.hdslb.com/a.jpg"
        );
        assert_eq!(
            image_url(&json!("https://i0.hdslb.com/a.jpg")),
            "https://i0.hdslb.com/a.jpg"
        );
        assert_eq!(image_url(&json!("")), "");
    }

    #[test]
    fn media_url_only_upgrades_http() {
        assert_eq!(media_url("http://x/a.mp4"), "https://x/a.mp4");
        assert_eq!(media_url("https://x/a.mp4"), "https://x/a.mp4");
    }

    #[test]
    fn duration_formats() {
        assert_eq!(duration(0.0), "0:00");
        assert_eq!(duration(65.0), "1:05");
        assert_eq!(duration(3725.0), "1:02:05");
        assert_eq!(duration(-5.0), "0:00");
    }

    #[test]
    fn count_formats_wan_and_yi() {
        assert_eq!(count(0.0), "0");
        assert_eq!(count(999.0), "999");
        assert_eq!(count(12345.0), "1.2万");
        assert_eq!(count(340_000_000.0), "3.4亿");
    }

    #[test]
    fn quality_label_falls_back() {
        assert_eq!(quality_label(80), "1080P 高清");
        assert_eq!(quality_label(120), "4K 超清");
        assert_eq!(quality_label(999), "未知(999)");
    }

    #[test]
    fn parse_clock_handles_both_shapes() {
        assert_eq!(parse_clock("12:34"), 754);
        assert_eq!(parse_clock("1:02:03"), 3723);
        assert_eq!(parse_clock(""), 0);
        assert_eq!(parse_clock("5"), 5);
    }

    #[test]
    fn clock_or_num_picks_by_shape() {
        assert_eq!(clock_or_num(&json!("12:34")), 754);
        assert_eq!(clock_or_num(&json!(90)), 90);
        assert_eq!(clock_or_num(&json!("90")), 90);
    }
}
