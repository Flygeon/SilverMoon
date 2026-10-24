//! Steam **CDN 客户端**：取服务器列表、拉 manifest、拉 chunk。
//!
//! ## 鉴权：先不带票据，被拒了再申请
//!
//! 实测（2026-10-24，本机直连 lax2 / hkg1 / sha1 / sgp1 四个 cell 的节点）：
//! 请求 /depot/<id>/manifest/<gid>/5（不带 manifest request code、不带票据），
//! **每个节点都回 HTTP 401 + 98 字节 HTML 错误页**；chunk 路径回 404。
//! 也就是说「没有 request code 就下不了」是硬事实，不是可选的优化。
//!
//! 而 CDN 票据（GetCDNAuthToken）是**另一件事**。参考实现 GameNative 的
//! fetch_cdn_auth_token（gn-download/rust/src/store_dl/steam/jni.rs）注释写得很明确：
//! 它是「on a 401/403」才去取的，不是每次下载前都先要一张。
//!
//! 早先本模块把「先申请票据」当成前置步骤，后果是：票据申请一失败，
//! 本来能下的 public depot 也一起被判死。所以现在的契约是
//! **调用方先不带票据拉，收到 401/403 再来问票据** ——
//! fetch_bytes 返回的 CdnFetchError 带 HTTP 状态码，就是为了让上层能做这个判断。
//!
//! ## 重试与容错
//!
//! CDN 节点会短时不可用。这里对 5xx / 网络错误重试 3 次并轮换节点，
//! 4xx 直接失败（那是权限或参数问题，重试只会浪费时间）。

use std::fmt;
use std::time::Duration;

use serde::Deserialize;

/// Valve 认可的 User-Agent：CDN 会对陌生 UA 返回 401/403。
pub const USER_AGENT: &str = "Valve/Steam HTTP Client 1.0";

/// 一次 HTTP 请求的默认超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 错误文案里最多保留多少字节的响应体前缀。
///
/// 为什么要截断：CDN 的失败响应可能是完整 HTML 页面，整段塞进错误会淹没真正的原因；
/// 而开头一百来字节足够区分「401 错误页」「gzip 魔数」「一段二进制垃圾」。
const BODY_PREFIX_LEN: usize = 120;

/// 单个 CDN 节点的描述。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CdnServer {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub use_https: bool,
    #[serde(default)]
    pub r#type: String,
}

impl CdnServer {
    /// 拼出该节点的基地址（https://host:port 或 http://host:port）。
    pub fn base_url(&self) -> Option<String> {
        if self.host.trim().is_empty() {
            return None;
        }
        let scheme = if self.use_https { "https" } else { "http" };
        let port = if self.port == 0 {
            if self.use_https {
                443
            } else {
                80
            }
        } else {
            self.port
        };
        Some(format!("{scheme}://{}:{port}", self.host))
    }
}

/// CDN 请求失败的**结构化**原因。
///
/// ## 为什么不用 String
///
/// 上层要做两件依赖细节的判断，字符串做不到：
///
/// 1. **该不该去申请票据** —— 只有 401/403 才有意义（见模块注释），
///    超时和 5xx 去申请票据纯属浪费一次 CM 往返；
/// 2. **错误文案必须能定位** —— 只写「HTTP 401」和
///    「HTTP 401，响应体：Unauthorized」在排查时是两回事。
#[derive(Debug, Clone, Default)]
pub struct CdnFetchError {
    /// HTTP 状态码；传输层失败（超时 / DNS / TLS）时为 None
    pub status: Option<u16>,
    /// 响应体开头（已压成一行可读文本）
    pub body_prefix: String,
    /// 传输层错误原文
    pub transport: Option<String>,
}

impl CdnFetchError {
    /// 是不是「CDN 说没鉴权」。
    ///
    /// 只认 401/403：这是 Steam CDN 拒绝匿名拉取的**唯一**表达方式
    /// （实测确认，见模块注释）。其它状态码申请票据也救不回来。
    pub fn is_auth_denied(&self) -> bool {
        matches!(self.status, Some(401) | Some(403))
    }
}

impl fmt::Display for CdnFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.status, self.transport.as_deref()) {
            (Some(code), _) => {
                write!(f, "HTTP {code}")?;
                if !self.body_prefix.is_empty() {
                    write!(f, "，响应体：{}", self.body_prefix)?;
                }
                Ok(())
            }
            (None, Some(error)) => write!(f, "网络错误：{error}"),
            (None, None) => write!(f, "未知错误"),
        }
    }
}

/// 把响应体开头压成一行可读文本。
///
/// 纯函数，单测覆盖（见本文件 tests）。
pub fn describe_body_prefix(bytes: &[u8], max: usize) -> String {
    if bytes.is_empty() {
        return "空响应体".to_string();
    }
    let take = bytes.len().min(max.max(1));
    let head = &bytes[..take];
    let text_like = head
        .iter()
        .all(|b| (0x20..0x7f).contains(b) || matches!(*b, b'\n' | b'\r' | b'\t'));

    if text_like {
        // HTML 错误页的换行/缩进很多，压成一行才塞得进错误文案
        let text: String = head
            .iter()
            .map(|b| {
                if matches!(*b, b'\n' | b'\r' | b'\t') {
                    ' '
                } else {
                    *b as char
                }
            })
            .collect();
        format!(
            "「{}」",
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        )
    } else {
        // 二进制：给十六进制前缀，至少能认出是 gzip(1f 8b) / zip(50 4b) / 还是别的
        let hex: String = head.iter().take(16).map(|b| format!("{b:02x}")).collect();
        format!("二进制 0x{hex}（共 {} 字节）", bytes.len())
    }
}

#[derive(Debug, Deserialize, Default)]
struct ServerListResponse {
    #[serde(default)]
    servers: Vec<CdnServer>,
}

/// 取 CDN 服务器列表（免鉴权的 WebAPI）。
///
/// cell_id 来自 CM 会话（不同地区对应不同 cell），决定就近的节点。
pub fn fetch_servers(cell_id: u32, max: u32) -> Result<Vec<CdnServer>, String> {
    let url = format!(
        "https://api.steampowered.com/IContentServerDirectoryService/GetServersForSteamPipe/v1/?cell_id={cell_id}&max_servers={max}"
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .map_err(|e| format!("请求 CDN 服务器列表失败：{e}"))?;

    if !response.status().is_success() {
        return Err(format!("CDN 服务器列表返回 HTTP {}", response.status()));
    }
    let text = response
        .text()
        .map_err(|e| format!("读取 CDN 服务器列表失败：{e}"))?;
    let parsed: Wrapper =
        serde_json::from_str(&text).map_err(|e| format!("解析 CDN 服务器列表失败：{e}"))?;
    Ok(parsed.response.servers)
}

#[derive(Debug, Deserialize)]
struct Wrapper {
    #[serde(default)]
    response: ServerListResponse,
}

/// 构造 manifest 的 CDN URL。
///
/// 格式（Steam 的 content protocol v5）：
/// /depot/<depot_id>/manifest/<manifest_gid>/5[/<request_code>]
/// 追加 ?<ticket>（token 就是 CM 给的 CDN auth token 原文）。
pub fn manifest_url(
    server: &CdnServer,
    depot_id: u32,
    manifest_gid: u64,
    request_code: u64,
    cdn_token: &str,
) -> Option<String> {
    let base = server.base_url()?;
    let mut url = format!("{base}/depot/{depot_id}/manifest/{manifest_gid}/5");
    if request_code != 0 {
        url.push('/');
        url.push_str(&request_code.to_string());
    }
    append_token(&mut url, cdn_token);
    Some(url)
}

/// 构造 chunk 的 CDN URL。
///
/// 格式：/depot/<depot_id>/chunk/<sha1hex>?<ticket>
pub fn chunk_url(
    server: &CdnServer,
    depot_id: u32,
    chunk_sha: &[u8],
    cdn_token: &str,
) -> Option<String> {
    let base = server.base_url()?;
    let hex = chunk_sha
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let mut url = format!("{base}/depot/{depot_id}/chunk/{hex}");
    append_token(&mut url, cdn_token);
    Some(url)
}

/// 把票据接在 URL 后面。
///
/// Steam 的 CDN token 本身就是 ticket=xxx 形式（GetCDNAuthToken 返回的原文），
/// 所以直接接在 ? 后面，**不要**再拼 ticket=（会变成 ticket=ticket=xxx）。
/// 与参考实现 append_auth_query（GameNative cdn_client.rs）逐字一致。
fn append_token(url: &mut String, cdn_token: &str) {
    if cdn_token.is_empty() {
        return;
    }
    url.push('?');
    url.push_str(cdn_token.strip_prefix('?').unwrap_or(cdn_token));
}

/// 带重试的 GET：返回原始字节。
///
/// 只对 5xx 与网络错误重试；4xx 立刻失败（权限/参数问题，重试无意义）。
pub fn fetch_bytes(url: &str, max_attempts: u32) -> Result<Vec<u8>, CdnFetchError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| CdnFetchError {
            transport: Some(format!("创建 HTTP 客户端失败：{e}")),
            ..Default::default()
        })?;

    let mut last = CdnFetchError::default();
    for attempt in 1..=max_attempts.max(1) {
        match client.get(url).header("User-Agent", USER_AGENT).send() {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    return response
                        .bytes()
                        .map(|b| b.to_vec())
                        .map_err(|e| CdnFetchError {
                            transport: Some(format!("读取响应失败：{e}")),
                            ..Default::default()
                        });
                }
                let code = status.as_u16();
                // 失败响应的正文往往就是原因（401 是 HTML 错误页）。
                // 读它是有代价的，但 CDN 的错误页只有一百来字节；
                // 换来的是「HTTP 401」变成「HTTP 401，响应体：「Unauthorized」」。
                let body = response.bytes().map(|b| b.to_vec()).unwrap_or_default();
                last = CdnFetchError {
                    status: Some(code),
                    body_prefix: describe_body_prefix(&body, BODY_PREFIX_LEN),
                    transport: None,
                };
                // 4xx：确定性失败，不重试
                if code < 500 {
                    return Err(last);
                }
            }
            Err(error) => {
                last = CdnFetchError {
                    status: None,
                    body_prefix: String::new(),
                    transport: Some(format!("{error}")),
                };
            }
        }
        if attempt < max_attempts {
            // 线性退避，避免瞬间打爆同一节点
            std::thread::sleep(Duration::from_millis(400 * attempt as u64));
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn https_server(host: &str) -> CdnServer {
        CdnServer {
            host: host.into(),
            port: 443,
            use_https: true,
            r#type: String::new(),
        }
    }

    #[test]
    fn server_base_url_respects_scheme_and_port() {
        let https = https_server("cache1.example.com");
        assert_eq!(
            https.base_url().as_deref(),
            Some("https://cache1.example.com:443")
        );

        let http = CdnServer {
            host: "cache2.example.com".into(),
            port: 80,
            use_https: false,
            r#type: String::new(),
        };
        assert_eq!(
            http.base_url().as_deref(),
            Some("http://cache2.example.com:80")
        );
    }

    #[test]
    fn empty_host_has_no_url() {
        let server = CdnServer::default();
        assert!(server.base_url().is_none());
    }

    #[test]
    fn manifest_url_includes_request_code_only_when_nonzero() {
        let server = https_server("h");
        let with = manifest_url(&server, 7, 9, 123, "").unwrap();
        assert!(with.ends_with("/5/123"), "实际：{with}");
        let without = manifest_url(&server, 7, 9, 0, "").unwrap();
        assert!(without.ends_with("/5"), "实际：{without}");
    }

    #[test]
    fn chunk_url_uses_lowercase_hex_sha() {
        let server = https_server("h");
        let url = chunk_url(&server, 7, &[0xAB, 0x01], "").unwrap();
        assert!(url.ends_with("/chunk/ab01"), "实际：{url}");
    }

    #[test]
    fn token_appended_verbatim_after_question_mark() {
        // Steam 的 CDN token 自带 ticket= 前缀，必须原样接在 ? 后。
        // 若再拼一次 ticket= 会变成 ticket=ticket=...，CDN 直接 401。
        let server = https_server("h");
        let url = manifest_url(&server, 1, 2, 0, "ticket=abc123").unwrap();
        assert!(url.ends_with("?ticket=abc123"), "实际：{url}");
        assert!(!url.contains("ticket=ticket="), "不应重复前缀：{url}");

        // 带前导 ? 的输入也要能正确处理
        let url = chunk_url(&server, 1, &[0xAB], "?ticket=x").unwrap();
        assert!(url.ends_with("?ticket=x"), "实际：{url}");
    }

    /// 401/403 是「该去申请票据」的唯一信号。
    ///
    /// 这条断言直接守着 download_app 的分支条件：把 5xx / 超时也算成
    /// 「需要票据」的话，弱网下会白打一串 CM 往返，而票据根本救不了超时。
    #[test]
    fn only_401_and_403_count_as_auth_denied() {
        let denied = CdnFetchError {
            status: Some(401),
            ..Default::default()
        };
        assert!(denied.is_auth_denied());
        let forbidden = CdnFetchError {
            status: Some(403),
            ..Default::default()
        };
        assert!(forbidden.is_auth_denied());

        for status in [400u16, 404, 500, 502] {
            let other = CdnFetchError {
                status: Some(status),
                ..Default::default()
            };
            assert!(!other.is_auth_denied(), "HTTP {status} 不该触发申请票据");
        }
        // 传输层失败（status 为 None）同样不算
        let transport = CdnFetchError {
            transport: Some("timed out".into()),
            ..Default::default()
        };
        assert!(!transport.is_auth_denied());
    }

    /// 错误文案必须带状态码与正文，否则「401」无法与「200 + 垃圾正文」区分。
    #[test]
    fn display_keeps_status_and_body() {
        let error = CdnFetchError {
            status: Some(401),
            body_prefix: "「<html> <head> <title>401 Unauthorized</title>」".into(),
            transport: None,
        };
        let text = error.to_string();
        assert!(text.contains("HTTP 401"), "实际：{text}");
        assert!(text.contains("Unauthorized"), "实际：{text}");

        let transport = CdnFetchError {
            transport: Some("connection refused".into()),
            ..Default::default()
        };
        assert!(transport.to_string().contains("connection refused"));
    }

    #[test]
    fn describe_body_prefix_summarizes_html_as_text() {
        let body = b"<html>\n<head>\n<title>401 Unauthorized</title>\n</head>\n</html>";
        let text = describe_body_prefix(body, 120);
        assert!(text.starts_with('「'), "实际：{text}");
        assert!(text.contains("401 Unauthorized"), "实际：{text}");
        // 换行被压成单空格，塞得进一行错误文案
        assert!(!text.contains('\n'), "不应保留换行：{text}");
    }

    #[test]
    fn describe_body_prefix_hexes_binary() {
        // gzip 魔数 1f 8b：人一眼能认出「这是压缩过的东西」，而不是 manifest
        let body = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00];
        let text = describe_body_prefix(&body, 120);
        assert!(text.contains("0x1f8b"), "实际：{text}");
        assert!(text.contains('8'), "应带上总长度：{text}");
    }

    #[test]
    fn describe_body_prefix_handles_empty_and_truncates() {
        assert_eq!(describe_body_prefix(&[], 120), "空响应体");
        let long = vec![b'a'; 500];
        let text = describe_body_prefix(&long, 10);
        // 只保留前 10 个字符（外加引号），不会把 500 字节全塞进错误
        assert!(text.contains("aaaaaaaaaa"), "实际：{text}");
        assert!(!text.contains("aaaaaaaaaaa"), "应截断：{text}");
    }
}
