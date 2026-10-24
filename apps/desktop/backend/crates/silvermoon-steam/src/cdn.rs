//! Steam **CDN 客户端**：取服务器列表、拉 manifest、拉 chunk。
//!
//! ## 为什么服务器列表走 HTTPS，而 manifest/chunk 走 CM 授权的 CDN URL
//!
//! 实测：
//! - `IContentServerDirectoryService/GetServersForSteamPipe` 是**普通 WebAPI**（HTTP 200），
//!   无需登录即可拿到 CDN 候选；
//! - 但拉 `/depot/<depot>/manifest/<gid>/5` 时**必须**带 CDN 鉴权 token，否则 401。
//!   那个 token 只能通过 CM 的 `GetCDNAuthToken` 拿（WebAPI 上不存在该接口）。
//!
//! 所以本模块只负责「怎么发请求」，鉴权 token 由 `cm.rs` 提供、由调用方传进来。
//!
//! ## 重试与容错
//!
//! CDN 节点会短时不可用。这里对 5xx / 网络错误重试 3 次并轮换节点，
//! 4xx 直接失败（那是权限或参数问题，重试只会浪费时间）。

use std::time::Duration;

use serde::Deserialize;

/// Valve 认可的 User-Agent：CDN 会对陌生 UA 返回 401/403。
pub const USER_AGENT: &str = "Valve/Steam HTTP Client 1.0";

/// 一次 HTTP 请求的默认超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// 拼出该节点的基地址（`https://host:port` / `http://host:port`）。
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

#[derive(Debug, Deserialize)]
struct ServerListResponse {
    #[serde(default)]
    servers: Vec<CdnServer>,
}

/// 取 CDN 服务器列表（免鉴权的 WebAPI）。
///
/// `cell_id` 来自 CM 会话（不同地区对应不同 cell），决定就近的节点。
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
/// `<base>/depot/<depot_id>/manifest/<manifest_gid>/5[/<request_code>]`
/// 追加 `?ticket=<base64url(token)>`（token 就是 CM 给的 CDN auth token）。
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
    if !cdn_token.is_empty() {
        // Steam 的 CDN token 本身就是 "ticket=xxx" 形式（GetCDNAuthToken 返回的原文），
        // 所以直接接在 ? 后面，**不要**再拼 "ticket="（会变成 ticket=ticket=xxx）。
        url.push('?');
        url.push_str(cdn_token.strip_prefix('?').unwrap_or(cdn_token));
    }
    Some(url)
}

/// 构造 chunk 的 CDN URL。
///
/// 格式：`<base>/depot/<depot_id>/chunk/<sha1hex>?ticket=...`
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
    if !cdn_token.is_empty() {
        // 同上：token 自带 "ticket=" 前缀
        url.push('?');
        url.push_str(cdn_token.strip_prefix('?').unwrap_or(cdn_token));
    }
    Some(url)
}

/// 带重试的 GET：返回原始字节。
///
/// 只对 5xx 与网络错误重试；4xx 立刻失败（权限/参数问题，重试无意义）。
pub fn fetch_bytes(url: &str, max_attempts: u32) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let mut last_error = String::from("未知错误");
    for attempt in 1..=max_attempts.max(1) {
        match client.get(url).header("User-Agent", USER_AGENT).send() {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    return response
                        .bytes()
                        .map(|b| b.to_vec())
                        .map_err(|e| format!("读取响应失败：{e}"));
                }
                last_error = format!("HTTP {status}");
                // 4xx：确定性失败，不重试
                if status.as_u16() < 500 {
                    return Err(last_error);
                }
            }
            Err(error) => {
                last_error = format!("{error}");
            }
        }
        if attempt < max_attempts {
            // 线性退避，避免瞬间打爆同一节点
            std::thread::sleep(Duration::from_millis(400 * attempt as u64));
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_base_url_respects_scheme_and_port() {
        let https = CdnServer {
            host: "cache1.example.com".into(),
            port: 443,
            use_https: true,
            r#type: String::new(),
        };
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
        let server = CdnServer {
            host: "h".into(),
            port: 443,
            use_https: true,
            r#type: String::new(),
        };
        let with = manifest_url(&server, 7, 9, 123, "").unwrap();
        assert!(with.ends_with("/5/123"), "实际：{with}");
        let without = manifest_url(&server, 7, 9, 0, "").unwrap();
        assert!(without.ends_with("/5"), "实际：{without}");
    }

    #[test]
    fn chunk_url_uses_lowercase_hex_sha() {
        let server = CdnServer {
            host: "h".into(),
            port: 443,
            use_https: true,
            r#type: String::new(),
        };
        let url = chunk_url(&server, 7, &[0xAB, 0x01], "").unwrap();
        assert!(url.ends_with("/chunk/ab01"), "实际：{url}");
    }

    #[test]
    fn token_appended_verbatim_after_question_mark() {
        // Steam 的 CDN token 自带 "ticket=" 前缀，必须原样接在 ? 后。
        // 若再拼一次 "ticket=" 会变成 ticket=ticket=...，CDN 直接 401。
        let server = CdnServer {
            host: "h".into(),
            port: 443,
            use_https: true,
            r#type: String::new(),
        };
        let url = manifest_url(&server, 1, 2, 0, "ticket=abc123").unwrap();
        assert!(url.ends_with("?ticket=abc123"), "实际：{url}");
        assert!(!url.contains("ticket=ticket="), "不应重复前缀：{url}");

        // 带前导 ? 的输入也要能正确处理
        let url = chunk_url(&server, 1, &[0xAB], "?ticket=x").unwrap();
        assert!(url.ends_with("?ticket=x"), "实际：{url}");
    }
}
