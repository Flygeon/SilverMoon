//! 与 Electron 主进程之间的消息协议。
//!
//! ## 为什么走 stdin/stdout 而不是 HTTP
//!
//! 歌词窗口是**常驻进程**，消息频率不高。用行分隔的 JSON 走 stdin/stdout：
//! 1. **零端口** —— 不必担心端口占用、防火墙、被别的进程连上；
//! 2. **生命周期天然绑定** —— 父进程一死 stdin 就 EOF，我们能立刻退出，
//!    不会像 HTTP 那样留下孤儿进程；
//! 3. 复用 splash 已经验证过的握手范式（stdout 打印一行 \`READY <json>\`）。
//!
//! ## 为什么手动解析、不用 serde derive
//!
//! \`serde_derive\` 是 proc-macro，编译它需要**宿主链接器**（MSVC）——
//! 本机没有。一旦引入，宿主的 \`cargo test --lib\` 会在编译阶段就挂掉，
//! 纯逻辑测试在 CI 上也跑不起来。splash 的 prefs.rs 同样只用
//! \`serde_json::Value\` 手动取值，这里沿用同一套做法。
//!
//! 手写解析多花几十行，但换来「**协议的所有分支都能在 CI 上真跑断言**」——
//! 本机没有 MSVC，这个交易很划算。

use serde_json::{json, Map, Value};

/// 下行消息（宿主 → 本进程）。
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// 歌词状态：lines 与 current_time 由宿主推送，本进程据此自走时钟。
    State(StatePayload),
    /// 频谱数据（无歌词时的替代显示）。
    Spectrum(Vec<u8>),
    /// 外观设置（字段都可选，缺省表示「不变」）。
    Settings(SettingsPayload),
    /// 请求退出。
    Quit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StatePayload {
    pub lines: Vec<LyricLine>,
    pub current_time: f64,
    pub playing: bool,
    pub title: String,
    pub artist: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LyricLine {
    pub time: f64,
    pub text: String,
    pub translation: Option<String>,
    pub bg: Option<String>,
    /// 逐字时间轴（秒）。空 = 整行高亮。
    pub units: Vec<Unit>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Unit {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SettingsPayload {
    pub font_size: Option<f64>,
    pub opacity: Option<f64>,
    pub show_translation: Option<bool>,
    pub show_next: Option<bool>,
    pub word_by_word: Option<bool>,
    pub align: Option<String>,
    pub offset_x: Option<i32>,
    pub offset_y: Option<i32>,
}

/// 握手行前缀（与 splash 的 SILVERMOON_READY 同风格，载荷是 JSON）。
pub const READY_PREFIX: &str = "LYRICS_READY";

/// 取出消息的 (type, payload)，**payload 原样透传**。
///
/// 为什么要有这个而不只用 parse_incoming：后者把 payload 解析成具名结构体，
/// 要再发出去就得实现 Serialize —— 那需要 serde derive（proc-macro，需宿主链接器），
/// 正是我们要避开的东西。而页面消费的就是**宿主原始那一份 JSON**，
/// 原样透传既省一次序列化，也天然前向兼容（宿主加字段，页面立刻能用）。
pub fn message_parts(line: &str) -> Option<(String, Value)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let root: Value = serde_json::from_str(trimmed).ok()?;
    let kind = root.get("type")?.as_str()?.to_string();
    let payload = root.get("payload").cloned().unwrap_or(Value::Null);
    Some((kind, payload))
}

/// 解析一行下行消息。空行与无法解析的行都返回 None（静默忽略）。
///
/// 为什么不让调用方处理错误：宿主可能在窗口还没就绪时就开始推消息，
/// 丢掉几帧无害；而**因为一行坏数据就崩掉整个窗口**是不可接受的。
pub fn parse_incoming(line: &str) -> Option<Incoming> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let root: Value = serde_json::from_str(trimmed).ok()?;
    let kind = root.get("type")?.as_str()?;
    match kind {
        "state" => parse_state(root.get("payload")?).map(Incoming::State),
        "spectrum" => parse_spectrum(root.get("payload")?).map(Incoming::Spectrum),
        "settings" => parse_settings(root.get("payload")?).map(Incoming::Settings),
        "quit" => Some(Incoming::Quit),
        _ => None,
    }
}

fn parse_state(payload: &Value) -> Option<StatePayload> {
    let lines = payload
        .get("lines")?
        .as_array()?
        .iter()
        .filter_map(parse_line)
        .collect();
    Some(StatePayload {
        lines,
        current_time: payload
            .get("currentTime")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        playing: payload
            .get("playing")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        title: payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        artist: payload
            .get("artist")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// 解析单行歌词。缺 text 或 time 的行**跳过**（返回 None）而不是让整包失败 ——
/// 一行坏数据不该让整首歌的歌词都不显示。
fn parse_line(value: &Value) -> Option<LyricLine> {
    let time = value.get("time")?.as_f64()?;
    let text = value.get("text")?.as_str()?.to_string();
    let units = value
        .get("units")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|u| {
                    Some(Unit {
                        start: u.get("start")?.as_f64()?,
                        end: u.get("end")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(LyricLine {
        time,
        text,
        translation: value
            .get("translation")
            .and_then(Value::as_str)
            .map(str::to_string),
        bg: value.get("bg").and_then(Value::as_str).map(str::to_string),
        units,
    })
}

fn parse_spectrum(payload: &Value) -> Option<Vec<u8>> {
    let arr = payload.get("bins")?.as_array()?;
    // 越界的值夹到 0..=255：宿主可能因为浮点误差推出 256，
    // 那种情况下宁可夹住也不要丢掉整帧频谱。
    Some(
        arr.iter()
            .map(|v| v.as_f64().unwrap_or(0.0).clamp(0.0, 255.0).round() as u8)
            .collect(),
    )
}

fn parse_settings(payload: &Value) -> Option<SettingsPayload> {
    Some(SettingsPayload {
        font_size: payload.get("fontSize").and_then(Value::as_f64),
        opacity: payload.get("opacity").and_then(Value::as_f64),
        show_translation: payload.get("showTranslation").and_then(Value::as_bool),
        show_next: payload.get("showNext").and_then(Value::as_bool),
        word_by_word: payload.get("wordByWord").and_then(Value::as_bool),
        align: payload
            .get("align")
            .and_then(Value::as_str)
            .map(str::to_string),
        offset_x: payload
            .get("offsetX")
            .and_then(Value::as_i64)
            .map(|v| v as i32),
        offset_y: payload
            .get("offsetY")
            .and_then(Value::as_i64)
            .map(|v| v as i32),
    })
}

/// 构造一行上行 JSON（含换行）。
pub fn encode_line(value: &Value) -> String {
    match serde_json::to_string(value) {
        Ok(json) => format!("{json}\n"),
        // 序列化 Value 不会失败；真失败了也不能 panic（会拖垮窗口）
        Err(_) => String::new(),
    }
}

/// 构造播放控制消息。
///
/// 暂未接线：窗口内控制栏（上一首/播放/下一首）还在页面侧，尚未通过
/// wry 的 IPC handler 回传到这里。先保留这条协议面与其单测 —— 它是
/// 「原生窗口也能控制播放」的既定接口，删了下次还得重写。
#[allow(dead_code)]
pub fn encode_control(action: &str) -> String {
    let mut m = Map::new();
    m.insert("type".into(), json!("control"));
    m.insert("action".into(), json!(action));
    encode_line(&Value::Object(m))
}

/// 构造错误上报消息。
pub fn encode_error(message: &str) -> String {
    let mut m = Map::new();
    m.insert("type".into(), json!("error"));
    m.insert("message".into(), json!(message));
    encode_line(&Value::Object(m))
}

/// 构造握手行（含换行）。
///
/// embedded 是重要信号：false 表示真嵌入没成功，宿主可以提示用户
/// 或回退到浮贴模式，而不是让用户对着一个飘走的窗口发呆。
pub fn encode_ready(hwnd: i64, embedded: bool) -> String {
    let mut m = Map::new();
    m.insert("hwnd".into(), json!(hwnd));
    m.insert("embedded".into(), json!(embedded));
    match serde_json::to_string(&Value::Object(m)) {
        Ok(json) => format!("{READY_PREFIX} {json}\n"),
        Err(_) => format!("{READY_PREFIX} {{\"hwnd\":0,\"embedded\":false}}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_state_message() {
        let json = r#"{"type":"state","payload":{"lines":[{"time":1.5,"text":"明月","units":[{"start":1.5,"end":2.0}]}],"currentTime":1.6,"playing":true,"title":"T","artist":"A"}}"#;
        match parse_incoming(json).expect("should parse") {
            Incoming::State(s) => {
                assert_eq!(s.lines.len(), 1);
                assert_eq!(s.lines[0].text, "明月");
                assert_eq!(s.lines[0].units.len(), 1);
                assert!((s.current_time - 1.6).abs() < 1e-9);
                assert!(s.playing);
                assert_eq!(s.title, "T");
                assert_eq!(s.artist, "A");
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn parses_state_without_optional_fields() {
        let json = r#"{"type":"state","payload":{"lines":[{"time":0,"text":"x"}],"currentTime":0,"playing":false}}"#;
        match parse_incoming(json).expect("should parse") {
            Incoming::State(s) => {
                assert!(s.lines[0].units.is_empty());
                assert_eq!(s.lines[0].translation, None);
                assert_eq!(s.title, "");
                assert_eq!(s.artist, "");
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn skips_malformed_lines_but_keeps_the_rest() {
        // 一行坏数据不该让整首歌的歌词都不显示
        let json = r#"{"type":"state","payload":{"lines":[{"time":0,"text":"ok"},{"time":"bad"},{"text":"no time"}],"currentTime":0,"playing":false}}"#;
        match parse_incoming(json).expect("should parse") {
            Incoming::State(s) => {
                assert_eq!(s.lines.len(), 1);
                assert_eq!(s.lines[0].text, "ok");
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn parses_spectrum_and_clamps_out_of_range() {
        let json = r#"{"type":"spectrum","payload":{"bins":[0,128,255,256,-5]}}"#;
        match parse_incoming(json).expect("should parse") {
            Incoming::Spectrum(bins) => assert_eq!(bins, vec![0, 128, 255, 255, 0]),
            other => panic!("expected Spectrum, got {other:?}"),
        }
    }

    #[test]
    fn parses_settings_with_partial_fields() {
        let json = r#"{"type":"settings","payload":{"fontSize":32}}"#;
        match parse_incoming(json).expect("should parse") {
            Incoming::Settings(s) => {
                assert_eq!(s.font_size, Some(32.0));
                assert_eq!(s.opacity, None);
                assert_eq!(s.word_by_word, None);
            }
            other => panic!("expected Settings, got {other:?}"),
        }
    }

    #[test]
    fn parses_full_settings() {
        let json = r#"{"type":"settings","payload":{"fontSize":30,"opacity":80,"showTranslation":true,"showNext":false,"wordByWord":true,"align":"right","offsetX":10,"offsetY":-5}}"#;
        match parse_incoming(json).expect("should parse") {
            Incoming::Settings(s) => {
                assert_eq!(s.font_size, Some(30.0));
                assert_eq!(s.opacity, Some(80.0));
                assert_eq!(s.show_translation, Some(true));
                assert_eq!(s.show_next, Some(false));
                assert_eq!(s.word_by_word, Some(true));
                assert_eq!(s.align.as_deref(), Some("right"));
                assert_eq!(s.offset_x, Some(10));
                assert_eq!(s.offset_y, Some(-5));
            }
            other => panic!("expected Settings, got {other:?}"),
        }
    }

    #[test]
    fn parses_quit() {
        assert_eq!(parse_incoming(r#"{"type":"quit"}"#), Some(Incoming::Quit));
    }

    #[test]
    fn ignores_blank_and_malformed_lines() {
        // 坏数据必须静默忽略，绝不能崩掉窗口
        assert_eq!(parse_incoming(""), None);
        assert_eq!(parse_incoming("   "), None);
        assert_eq!(parse_incoming("not json at all"), None);
        assert_eq!(parse_incoming(r#"{"type":"unknown_kind"}"#), None);
        assert_eq!(parse_incoming(r#"{"type":"state"}"#), None); // 缺 payload
        assert_eq!(parse_incoming(r#"{"type":"state","payload":{}}"#), None); // 缺 lines
        assert_eq!(parse_incoming("{}"), None); // 缺 type
    }

    #[test]
    fn encodes_control_as_single_line() {
        let line = encode_control("next");
        assert!(line.ends_with('\n'));
        // 必须**恰好一行** —— 多行会破坏行分隔协议
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains(r#""type":"control""#));
        assert!(line.contains(r#""action":"next""#));
    }

    #[test]
    fn encodes_error_as_single_line() {
        let line = encode_error("boom");
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains(r#""message":"boom""#));
    }

    #[test]
    fn encodes_ready_line() {
        let line = encode_ready(12345, true);
        assert!(line.starts_with(READY_PREFIX));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains(r#""hwnd":12345"#));
        assert!(line.contains(r#""embedded":true"#));
    }

    #[test]
    fn ready_reports_failed_embed() {
        // 嵌入失败必须如实上报，宿主据此回退
        let line = encode_ready(7, false);
        assert!(line.contains(r#""embedded":false"#));
    }

    #[test]
    fn error_message_with_quotes_stays_valid_json() {
        let line = encode_error(r#"say "hi""#);
        let v: Value = serde_json::from_str(line.trim()).expect("must stay valid json");
        assert_eq!(
            v.get("message").and_then(Value::as_str),
            Some(r#"say "hi""#)
        );
    }
}
