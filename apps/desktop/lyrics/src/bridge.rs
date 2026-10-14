//! 宿主消息 → WebView 内的 JS 调用。
//!
//! ## 为什么用 \`evaluate_script\` 而不是 \`postMessage\`
//!
//! wry 没有跨进程的 \`postMessage\` 通道（那是 Electron 的 IPC 概念）。
//! 标准做法是在页面里挂一个全局函数（本进程注入 \`window.__smLyrics.*\`），
//! 宿主侧用 \`evaluate_script\` 调用它。
//!
//! ## 为什么不在 Rust 侧解析完再传
//!
//! 解析出「这是什么消息」是**纯逻辑**（见 ipc.rs，有单测），但把歌词数据
//! 转成 JS 对象交给页面渲染，交给页面自己做更直接 —— 页面已经有一套
//! 成熟的渲染（逐字填充、频谱绘制），Rust 侧只负责**搬运与调度**。
//!
//! ## 注入方式：把 JSON 原样嵌进 JS 字面量
//!
//! \`JSON.parse\` 的输入是**字符串字面量**，所以要再套一层 JSON 编码
//! （把 \`"\` 转义成 \`\\"\`）。直接拼 \`JSON.parse(<原 JSON>)\` 会在
//! 遇到引号时语法错误 —— 这是最容易犯的错，所以单独抽成函数并加测试。

use crate::ipc::{message_parts, parse_incoming, Incoming};

/// 把一行宿主 JSON 转成要在页面里执行的 JS。无法识别时返回 None。
///
/// 产物形如：\`window.__smLyrics&&window.__smLyrics.state({...})\`
/// —— 带 \`&&\` 守卫：页面还没加载完时静默忽略，不抛错（否则控制台刷满异常）。
/// 两步走，各有各的用：
/// 1. \`parse_incoming\` **校验** —— 宿主推来的东西必须先在 Rust 侧确认结构合法，
///    否则畸形数据会被原样送进页面、在那边炸成难查的 JS 错误；
/// 2. \`message_parts\` **透传** —— 页面消费的就是宿主那份 JSON，原样转发既省一次
///    序列化，也天然前向兼容（宿主加字段，页面立刻能用，不必改 Rust）。
///
/// 之所以不把校验结果直接序列化出去：那样要为每个结构体实现 Serialize，
/// 而 serde derive 是 proc-macro（需要宿主链接器）—— 正是要避开的东西。
pub fn line_to_js(line: &str) -> Option<String> {
    let msg = parse_incoming(line)?;
    if msg == Incoming::Quit {
        return Some("window.__smLyrics&&window.__smLyrics.quit()".to_string());
    }
    let (kind, payload) = message_parts(line)?;
    match kind.as_str() {
        "state" | "spectrum" | "settings" => Some(build_call(&kind, &payload)),
        // parse_incoming 已经挡掉未知类型，这里只是防御
        _ => None,
    }
}

/// 构造 \`window.__smLyrics.<fn>(<json>)\` 形式的 JS。
fn build_call(fn_name: &str, payload: &serde_json::Value) -> String {
    let json = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string());
    // 把 JSON 再编码成一个 JS 字符串字面量，交给页面自己 JSON.parse。
    // 这样**不必担心 JSON 里出现的引号/换行/反斜杠**破坏 JS 语法。
    let literal = js_string_literal(&json);
    format!("window.__smLyrics&&window.__smLyrics.{fn_name}(JSON.parse({literal}))")
}

/// 把任意字符串编码成 JS 字符串字面量（含两侧引号）。
///
/// 只转义 JS 里真正有歧义的字符。**不转义 \`/\`**：它不需要转义，
/// 而转义后 \`</script>\` 之类的序列反而更难读。
fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // 行分隔符与段分隔符在 JS 里是换行符，必须转义
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_line_becomes_guarded_call() {
        let line = r#"{"type":"state","payload":{"lines":[],"currentTime":0,"playing":false}}"#;
        let js = line_to_js(line).expect("should produce js");
        // 必须有 && 守卫：页面未加载完时静默忽略
        assert!(js.starts_with("window.__smLyrics&&window.__smLyrics.state("));
        assert!(js.contains("JSON.parse("));
    }

    #[test]
    fn spectrum_line_becomes_call() {
        let line = r#"{"type":"spectrum","payload":{"bins":[1,2,3]}}"#;
        let js = line_to_js(line).expect("should produce js");
        assert!(js.contains(".spectrum("));
    }

    #[test]
    fn settings_line_becomes_call() {
        let line = r#"{"type":"settings","payload":{"fontSize":30}}"#;
        let js = line_to_js(line).expect("should produce js");
        assert!(js.contains(".settings("));
    }

    #[test]
    fn quit_line_becomes_quit_call() {
        let js = line_to_js(r#"{"type":"quit"}"#).expect("should produce js");
        assert_eq!(js, "window.__smLyrics&&window.__smLyrics.quit()");
    }

    #[test]
    fn malformed_line_yields_none() {
        assert!(line_to_js("").is_none());
        assert!(line_to_js("garbage").is_none());
        assert!(line_to_js(r#"{"type":"nope"}"#).is_none());
    }

    #[test]
    fn quotes_in_lyrics_do_not_break_js() {
        // 歌词里出现引号是常态（英文歌、对话式歌词），必须不破坏语法
        // 注意 JSON 里要转义引号：text 的值是 say "hello"
        let line = `{"type":"state","payload":{"lines":[{"time":0,"text":"say \"hello\""}],"currentTime":0,"playing":false}}`;
        let js = line_to_js(line).expect("should produce js");
        // 原始引号必须已被转义，不能裸露在 JS 字面量里
        assert!(js.contains("\\\"hello\\\""), "quotes must be escaped: {js}");
    }

    #[test]
    fn backslash_and_newline_are_escaped() {
        let lit = js_string_literal("a\\b\nc");
        assert_eq!(lit, "\"a\\\\b\\nc\"");
    }

    #[test]
    fn js_literal_escapes_line_separators() {
        // U+2028/U+2029 在 JS 里是换行符，会截断语句
        let lit = js_string_literal("a\u{2028}b");
        assert!(lit.contains("\\u2028"));
        assert!(!lit.contains('\u{2028}'));
    }

    #[test]
    fn js_literal_escapes_control_chars() {
        let lit = js_string_literal("a\u{0001}b");
        assert!(lit.contains("\\u0001"));
    }

    #[test]
    fn js_literal_wraps_in_quotes() {
        assert_eq!(js_string_literal("x"), "\"x\"");
        assert_eq!(js_string_literal(""), "\"\"");
    }
}
