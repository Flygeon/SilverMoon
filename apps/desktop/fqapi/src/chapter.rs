//! 章节正文解析：把上游返回的 HTML 富文本转成结构化段落。
//!
//! ## 为什么需要它
//!
//! 番茄的正文接口（`/reading/reader/full/v/`、`batch_full/v`）返回的
//! `data.content` **不是纯文本，而是 HTML 富文本**：
//!
//! ```html
//! <header></header><article><p idx="0">惊蛰那天…</p><p idx="1">…</p></article>
//! ```
//!
//! 原项目把这一步放在 Dart 侧（`lib/services/chapter_text_formatter.dart`，
//! 620 行，依赖 `package:html`）。sidecar 只输出 JSON，解析责任在谁？
//!
//! 结论：**放在 Rust 侧**。理由：
//!   1. SilverMoon 的阅读器（BookReader.vue）要吃的是段落数组，不是 HTML；
//!   2. 若让前端解析，每个调用方都要带一份 HTML 解析器与一套「什么是正文」的
//!      规则，规则一改就要多处同步；
//!   3. 上游会往正文里塞 `{!-- PGC_VOICE:{...} --}` 这类注记（听书时长、
//!      上传 id），原项目踩过「把它当第一段渲染出来」的坑 —— 这类清洗逻辑
//!      属于取数层，不该漏到 UI。
//!
//! ## 规则（对齐原项目 chapter_text_formatter.dart 的语义）
//!
//! * 段落级标签（`p` / `div` / `br` / `h1..h6` …）→ 段落分隔；
//! * 隐藏标签（`head` / `script` / `style` / `template` / `noscript` / `title`）
//!   → 整段丢弃；
//! * `{!-- ... --}` 注记整行丢弃（不跨行，避免两套流漂移）；
//! * 行内标签（`span` / `b` / `i` / `a` …）→ 只留文字；
//! * 实体解码（`&nbsp;` `&lt;` `&gt;` `&amp;` `&quot;` `&#39;` 及数字实体）；
//! * 段落去首尾空白，空段落丢弃；连续空行折叠。

/// 解析结果。`paragraphs` 是可直接渲染的正文段落。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChapterText {
    /// 纯文本正文（段落之间以 `\n` 连接），便于检索 / 字数统计。
    pub text: String,
    /// 分段后的段落。
    pub paragraphs: Vec<String>,
}

impl ChapterText {
    pub fn chars(&self) -> usize {
        self.text.chars().filter(|c| !c.is_whitespace()).count()
    }
}

/// 需要整段丢弃的标签（内容也不保留）。
const HIDDEN_TAGS: &[&str] = &["head", "script", "style", "template", "noscript", "title"];

/// 会产生段落分隔的标签。
const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul",
];

/// 把正文 HTML 解析成段落。
pub fn parse_chapter_content(html: &str) -> ChapterText {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = html.chars().peekable();

    // 处于隐藏标签内部时，跳过其内容直到对应闭合标签。
    let mut hidden_depth: usize = 0;
    let mut hidden_tag = String::new();

    while let Some(ch) = chars.next() {
        if ch != '<' {
            if hidden_depth == 0 {
                cur.push(ch);
            }
            continue;
        }

        // 注释：<!-- ... --> 或 {!-- ... --}（上游注记的变体）
        if chars.peek() == Some(&'!') {
            let mut buf = String::from("<!");
            chars.next();
            if chars.peek() == Some(&'-') {
                buf.push(chars.next().unwrap_or('-'));
                if chars.peek() == Some(&'-') {
                    buf.push(chars.next().unwrap_or('-'));
                    // 消费到 -->
                    let mut prev = '\0';
                    for c in chars.by_ref() {
                        if c == '>' && prev == '-' {
                            break;
                        }
                        prev = c;
                    }
                    continue;
                }
            }
            // 其它 <!DOCTYPE> 之类：丢弃到 >
            for c in chars.by_ref() {
                if c == '>' {
                    break;
                }
            }
            continue;
        }

        // 收集标签名与是否闭合
        let mut tag = String::new();
        let mut closing = false;
        let mut prev = '\0';
        let mut self_closing = false;

        if chars.peek() == Some(&'/') {
            closing = true;
            chars.next();
        }
        for c in chars.by_ref() {
            if c == '>' {
                self_closing = prev == '/';
                break;
            }
            if c == ' ' && !tag.is_empty() {
                // 进入属性区，继续吃到 >
                for c2 in chars.by_ref() {
                    if c2 == '>' {
                        self_closing = prev == '/';
                        break;
                    }
                    prev = c2;
                }
                break;
            }
            tag.push(c);
            prev = c;
        }
        let name = tag.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }

        // 隐藏标签：进入 / 退出
        if HIDDEN_TAGS.contains(&name.as_str()) {
            if closing {
                if hidden_depth > 0 && hidden_tag == name {
                    hidden_depth -= 1;
                }
            } else if !self_closing {
                if hidden_depth == 0 {
                    hidden_tag = name;
                }
                hidden_depth += 1;
            }
            continue;
        }

        if hidden_depth > 0 {
            continue;
        }

        // 段落级标签 → 断段
        if BLOCK_TAGS.contains(&name.as_str()) || name == "br" {
            flush(&mut cur, &mut paragraphs);
            continue;
        }

        // 其余（span / b / i / a / img …）只丢标签留文字
    }

    flush(&mut cur, &mut paragraphs);

    // 过滤上游注记：`{!-- ... --}` 整段丢弃
    let paragraphs: Vec<String> = paragraphs
        .into_iter()
        .filter(|p| !is_content_marker(p))
        .collect();

    let text = paragraphs.join("\n");
    ChapterText { text, paragraphs }
}

/// 把累积的当前段落收尾。
fn flush(cur: &mut String, out: &mut Vec<String>) {
    let cleaned = clean_paragraph(cur);
    if !cleaned.is_empty() {
        out.push(cleaned);
    }
    cur.clear();
}

/// 去首尾空白、折叠内部连续空白、解码实体。
fn clean_paragraph(raw: &str) -> String {
    let decoded = decode_entities(raw);
    let mut out = String::with_capacity(decoded.len());
    let mut last_space = false;
    for ch in decoded.chars() {
        // 零宽字符与 BOM 直接丢
        if matches!(ch, '\u{200B}' | '\u{FEFF}' | '\u{200C}' | '\u{200D}') {
            continue;
        }
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
            continue;
        }
        last_space = false;
        out.push(ch);
    }
    out.trim().to_string()
}

/// 上游的内容注记（听书时长 / 上传 id 等），整段丢弃。
fn is_content_marker(p: &str) -> bool {
    let t = p.trim();
    (t.starts_with("{!--") && t.ends_with("--}")) || (t.starts_with("<!--") && t.ends_with("-->"))
}

/// 解码常见 HTML 实体（含数字实体）。
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;

    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        match tail.find(';') {
            Some(semi) if semi <= 10 => {
                let entity = &tail[1..semi];
                match decode_one(entity) {
                    Some(ch) => {
                        out.push(ch);
                        rest = &tail[semi + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &tail[1..];
                    }
                }
            }
            _ => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_one(entity: &str) -> Option<char> {
    match entity {
        "nbsp" => Some(' '),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "mdash" => Some('—'),
        "ndash" => Some('–'),
        "hellip" => Some('…'),
        "ldquo" => Some('“'),
        "rdquo" => Some('”'),
        "lsquo" => Some('‘'),
        "rsquo" => Some('’'),
        _ => {
            if let Some(hex) = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = entity.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_paragraphs_and_drops_header() {
        let html = "<header></header><article><p idx=\"0\">惊蛰那天，临安城的雨下得发黏。</p><p idx=\"1\">第二段。</p></article>";
        let got = parse_chapter_content(html);
        assert_eq!(
            got.paragraphs,
            vec![
                "惊蛰那天，临安城的雨下得发黏。".to_string(),
                "第二段。".to_string()
            ]
        );
    }

    #[test]
    fn br_splits_paragraphs() {
        let got = parse_chapter_content("第一行<br/>第二行<br>第三行");
        assert_eq!(got.paragraphs, vec!["第一行", "第二行", "第三行"]);
    }

    #[test]
    fn hidden_tags_are_dropped_entirely() {
        let got =
            parse_chapter_content("<p>正文</p><script>alert('x')</script><style>.a{}</style>");
        assert_eq!(got.paragraphs, vec!["正文"]);
    }

    #[test]
    fn content_markers_are_dropped() {
        let got =
            parse_chapter_content("<p>{!-- PGC_VOICE:{\"duration\":123} --}</p><p>真正的正文</p>");
        assert_eq!(got.paragraphs, vec!["真正的正文"]);
    }

    #[test]
    fn inline_tags_keep_text() {
        let got =
            parse_chapter_content("<p>他<b>很</b>生气<span class=\"x\">，但没说</span>。</p>");
        assert_eq!(got.paragraphs, vec!["他很生气，但没说。"]);
    }

    #[test]
    fn entities_are_decoded() {
        let got = parse_chapter_content("<p>a&nbsp;b &lt;c&gt; &amp; &#39;d&#39; &#x4E2D;</p>");
        assert_eq!(got.paragraphs, vec!["a b <c> & 'd' 中"]);
    }

    #[test]
    fn empty_paragraphs_are_dropped() {
        let got = parse_chapter_content("<p></p><p>  </p><p>内容</p><p></p>");
        assert_eq!(got.paragraphs, vec!["内容"]);
    }

    #[test]
    fn zero_width_chars_removed() {
        let got = parse_chapter_content("<p>\u{200B}开始\u{FEFF}结束</p>");
        assert_eq!(got.paragraphs, vec!["开始结束"]);
    }

    #[test]
    fn text_joins_paragraphs_with_newline() {
        let got = parse_chapter_content("<p>一</p><p>二</p>");
        assert_eq!(got.text, "一\n二");
        assert_eq!(got.chars(), 2);
    }

    #[test]
    fn plain_text_without_tags_passes_through() {
        let got = parse_chapter_content("就是一段纯文本");
        assert_eq!(got.paragraphs, vec!["就是一段纯文本"]);
    }
}
