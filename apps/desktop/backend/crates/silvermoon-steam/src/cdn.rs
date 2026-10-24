//! Steam **CDN 客户端**：取服务器列表、拉 manifest、拉 chunk。

use std::fmt;
use std::time::Duration;

use serde::Deserialize;

pub const USER_AGENT: &str = "Valve/Steam HTTP Client 1.0";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const BODY_PREFIX_LEN: usize = 120;

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

#[derive(Debug, Clone, Default)]
pub struct CdnFetchError {
    pub status: Option<u16>,
    pub body_prefix: String,
    pub transport: Option<String>,
}

impl CdnFetchError {
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
        let hex: String = head.iter().take(16).map(|b| format!("{b:02x}")).collect();
        format!("二进制 0x{hex}（共 {} 字节）", bytes.len())
    }
}

#[derive(Debug, Deserialize, Default)]
struct ServerListResponse {
    #[serde(default)]
    servers: Vec<CdnServer>,
}

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

fn append_token(url: &mut String, cdn_token: &str) {
    if cdn_token.is_empty() {
        return;
    }
    url.push('?');
    url.push_str(cdn_token.strip_prefix('?').unwrap_or(cdn_token));
}

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
                let body = response.bytes().map(|b| b.to_vec()).unwrap_or_default();
                last = CdnFetchError {
                    status: Some(code),
                    body_prefix: describe_body_prefix(&body, BODY_PREFIX_LEN),
                    transport: None,
                };
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
        let server = https_server("h");
        let url = manifest_url(&server, 1, 2, 0, "ticket=abc123").unwrap();
        assert!(url.ends_with("?ticket=abc123"), "实际：{url}");
        assert!(!url.contains("ticket=ticket="), "不应重复前缀：{url}");

        let url = chunk_url(&server, 1, &[0xAB], "?ticket=x").unwrap();
        assert!(url.ends_with("?ticket=x"), "实际：{url}");
    }

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
        let transport = CdnFetchError {
            transport: Some("timed out".into()),
            ..Default::default()
        };
        assert!(!transport.is_auth_denied());
    }

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
        assert!(!text.contains('\n'), "不应保留换行：{text}");
    }

    #[test]
    fn describe_body_prefix_hexes_binary() {
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
        assert!(text.contains("aaaaaaaaaa"), "实际：{text}");
        assert!(!text.contains("aaaaaaaaaaa"), "应截断：{text}");
    }
}
