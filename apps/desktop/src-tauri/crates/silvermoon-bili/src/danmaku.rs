//! 弹幕 XML 解析与模式映射。
//!
//! 与前端 `src/utils/bilibili.ts` 的 `parseDanmakuXml` / `decodeXmlEntities`
//! 以及 `src/utils/danmaku.ts` 的 `mapDanmakuMode` 逐字对齐。
//!
//! 模式映射在仓库里**只有一份语义**：源端 1/2/3 = 滚动、4 = 底部、5 = 顶部；
//! artplayer-plugin-danmuku 期望 0 = 滚动 / 1 = 顶部 / 2 = 底部。
//! 这里曾经在 TS 侧写反过（表现为顶部弹幕从底部飘出来），所以本模块的单测
//! 专门钉住 4→2、5→1。

use regex::Regex;
use std::sync::OnceLock;

/// 单次解析的条数上限。
///
/// 与前端一致：超长弹幕列表对渲染无意义，继续解析只会拖慢首帧。
pub const MAX_DANMAKU: usize = 8000;

/// 一条弹幕（与前端 `ArtDanmu` 同形）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Danmaku {
    pub text: String,
    /// 出现时间（秒）
    pub time: f64,
    /// artplayer 模式：0 滚动 / 1 顶部 / 2 底部
    pub mode: u8,
    /// `#rrggbb`
    pub color: String,
}

/// 源端弹幕模式 → artplayer 模式。
///
/// 6/7/8（逆向 / 高级 / 代码弹幕）没有对应形态，调用方在过滤阶段就应丢弃；
/// 这里对未知值一律按滚动处理，与前端 `mapDanmakuMode` 的兜底一致。
pub fn map_mode(raw: i64) -> u8 {
    match raw {
        4 => 2,
        5 => 1,
        _ => 0,
    }
}

/// 弹幕条目正则（与前端同一条：`<d p="...">text</d>`）。
fn entry_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?s)<d p="([^"]*)"[^>]*>(.*?)</d>"#).expect("弹幕正则必须是合法字面量")
    })
}

/// 解析弹幕 XML。任何单条异常都跳过，绝不 panic。
pub fn parse_danmaku_xml(xml: &str) -> Vec<Danmaku> {
    let mut out: Vec<Danmaku> = Vec::new();
    for cap in entry_re().captures_iter(xml) {
        let attrs: Vec<&str> = cap[1].split(',').collect();
        let time = attrs
            .first()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
        let raw_mode = attrs
            .get(1)
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        // 前端写的是 `Number(attrs[3]) || 0xffffff`：值为 0 时 **也** 落到白色，
        // 因为 0 在 JS 里是 falsy。这里显式保留该语义，否则纯黑弹幕会变成黑色。
        let color_int = attrs
            .get(3)
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|&v| v != 0)
            .unwrap_or(0xffffff);

        let text = decode_xml_entities(&cap[2]).trim().to_string();
        if text.is_empty() {
            continue;
        }
        // 只保留 1..=5（6/7/8 无对应形态）
        if !(1..=5).contains(&raw_mode) {
            continue;
        }
        out.push(Danmaku {
            text,
            time,
            mode: map_mode(raw_mode),
            color: format!("#{:06x}", color_int & 0xffffff),
        });
        if out.len() >= MAX_DANMAKU {
            break;
        }
    }
    out
}

/// 解码弹幕文本里的 XML 实体（`&amp;` 必须最后替换，与前端顺序一致）。
pub fn decode_xml_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_mapping_keeps_top_and_bottom_distinct() {
        // 4 = 底部 → 2；5 = 顶部 → 1。写反过一次，这里钉死。
        assert_eq!(map_mode(4), 2);
        assert_eq!(map_mode(5), 1);
        for rolling in [1, 2, 3] {
            assert_eq!(map_mode(rolling), 0);
        }
        assert_eq!(map_mode(99), 0);
    }

    #[test]
    fn parses_entries_with_attributes() {
        let xml = r#"<?xml version="1.0"?><i>
            <d p="1.5,1,25,16711680,0,0,0,0">滚动弹幕</d>
            <d p="2.0,5,25,255,0,0,0,0">顶部弹幕</d>
            <d p="3.0,4,25,0,0,0,0,0">底部弹幕</d>
        </i>"#;
        let list = parse_danmaku_xml(xml);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].time, 1.5);
        assert_eq!(list[0].mode, 0);
        assert_eq!(list[0].color, "#ff0000");
        assert_eq!(list[1].mode, 1);
        assert_eq!(list[1].color, "#0000ff");
        assert_eq!(list[2].mode, 2);
        // color=0 在前端会落到白色（falsy），这里保持一致
        assert_eq!(list[2].color, "#ffffff");
    }

    #[test]
    fn skips_unsupported_modes_and_empty_text() {
        let xml = r#"<i>
            <d p="1,6,25,16777215,0,0,0,0">逆向</d>
            <d p="2,7,25,16777215,0,0,0,0">高级</d>
            <d p="3,1,25,16777215,0,0,0,0">   </d>
            <d p="4,1,25,16777215,0,0,0,0">留下</d>
        </i>"#;
        let list = parse_danmaku_xml(xml);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].text, "留下");
    }

    #[test]
    fn decodes_xml_entities() {
        let xml = r#"<d p="1,1,25,16777215,0,0,0,0">a&amp;b&lt;c&gt;d&quot;e&#39;f</d>"#;
        let list = parse_danmaku_xml(xml);
        assert_eq!(list[0].text, "a&b<c>d\"e'f");
    }

    #[test]
    fn handles_multiline_text() {
        // `(?s)` 让 . 匹配换行，弹幕正文里偶尔含换行
        let xml = "<d p=\"1,1,25,16777215,0,0,0,0\">line1\nline2</d>";
        let list = parse_danmaku_xml(xml);
        assert_eq!(list.len(), 1);
        assert!(list[0].text.contains("line1"));
    }

    #[test]
    fn empty_or_garbage_input_yields_empty() {
        assert!(parse_danmaku_xml("").is_empty());
        assert!(parse_danmaku_xml("not xml at all").is_empty());
    }

    #[test]
    fn respects_max_cap() {
        let mut xml = String::from("<i>");
        for i in 0..(MAX_DANMAKU + 50) {
            xml.push_str(&format!("<d p=\"{i},1,25,16777215,0,0,0,0\">d{i}</d>"));
        }
        xml.push_str("</i>");
        assert_eq!(parse_danmaku_xml(&xml).len(), MAX_DANMAKU);
    }
}
