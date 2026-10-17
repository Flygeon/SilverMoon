//! 唯一的请求分发器（进程内调用）。裁剪自 fqapp 的 `dispatch.rs`
//! （原版同时服务 flutter_rust_bridge 桥与 loopback HTTP 适配器两条路径）。
//!
//! 现在只有一条路径：sidecar 的 stdio 协议把 `{path, query, method}` 交给
//! [`dispatch`]，拿回 `Response`。业务实现仍然只有一份。

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::endpoints::{router, Params, RawOut, Server};
use crate::error::ApiError;

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Vec<u8>,
    /// Request headers, lower-cased by the adapter. Only the static file path
    /// consumes them today (Range/HEAD); business endpoints are unaffected.
    pub headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Response body: either bytes already in memory, or a byte range of a file
/// the loopback adapter streams without reading it into memory.
#[derive(Debug, Clone)]
pub enum ResponseBody {
    Bytes(Vec<u8>),
    File {
        path: PathBuf,
        offset: u64,
        length: u64,
        total: u64,
    },
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: ResponseBody,
}

const JSON_CT: &str = "application/json; charset=utf-8";

impl Response {
    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Response {
            status,
            content_type: JSON_CT.to_string(),
            headers: Vec::new(),
            body: ResponseBody::Bytes(serde_json::to_vec(value).unwrap_or_default()),
        }
    }

    pub fn text(status: u16, content_type: impl Into<String>, body: Vec<u8>) -> Self {
        Response {
            status,
            content_type: content_type.into(),
            headers: Vec::new(),
            body: ResponseBody::Bytes(body),
        }
    }

    pub fn not_found(message: String) -> Self {
        Response::json(404, &json!({ "success": false, "error": message }))
    }

    /// Materialises the body into bytes.
    ///
    /// 原项目这里还要处理 `ResponseBody::File`（loopback 适配器把静态文件
    /// 流式吐出去，不读进内存）。裁剪后没有静态文件服务，`File` 变体只可能
    /// 由漫画/视频缓存路径产生，那些路径返回的是 `/src/xxx` 字符串而不是
    /// 文件体，所以这里保留分支做兜底读取即可。
    pub async fn into_bytes(self) -> Result<Vec<u8>, String> {
        match self.body {
            ResponseBody::Bytes(b) => Ok(b),
            ResponseBody::File {
                path,
                offset,
                length,
                ..
            } => read_range(&path, offset, length).await,
        }
    }
}

async fn read_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    if offset > 0 {
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut out = vec![0u8; length as usize];
    file.read_exact(&mut out).await.map_err(|e| e.to_string())?;
    Ok(out)
}

/// APIs that submit user actions under the device identity (comments add /
/// digg / reply; the danmaku add route reuses `playlet_comment_add`).
///
/// 原项目用这份清单来防止 loopback 适配器把 GET 变成上游 POST。裁剪后没有
/// HTTP 适配器，但 sidecar 的 stdio 协议同样可能被误用，所以保留这份门禁：
/// 这些 api 必须显式声明 POST，否则拒绝。
const DEVICE_BOUND_WRITE_APIS: &[&str] = &[
    "playlet_comment_add",
    "playlet_comment_digg",
    "playlet_comment_reply",
];

pub async fn dispatch(server: &Server, req: &Request) -> Response {
    let path = req.path.as_str();
    let ctx = &server.ctx;

    if path == "/health" {
        let devices = ctx.pool.count().await;
        return Response::json(200, &json!({ "status": "ok", "devices": devices }));
    }

    let mut params = Params::parse(&req.query);
    let m = match router::match_rest_path(path, &params) {
        Some(m) => m,
        None => {
            if ctx.cfg.anti_crawler.enabled && !ctx.cfg.anti_crawler.redirect_url.is_empty() {
                // A 302 without Location is not a redirect; clients just show
                // the body. The URL stays in the body for the FFI transport,
                // which surfaces status and body only.
                let url = ctx.cfg.anti_crawler.redirect_url.clone();
                let mut response =
                    Response::text(302, "text/plain; charset=utf-8", url.clone().into_bytes());
                response.headers.push(("location".to_string(), url));
                return response;
            }
            return Response::json(
                404,
                &json!({ "success": false, "error": format!("not found: {path}") }),
            );
        }
    };
    params = m.params;

    // Method enforcement for device-bound writes: see DEVICE_BOUND_WRITE_APIS
    // and the note it references.
    if DEVICE_BOUND_WRITE_APIS.contains(&m.api) && !req.method.eq_ignore_ascii_case("POST") {
        let mut response = Response::json(
            405,
            &json!({ "success": false, "error": "method not allowed" }),
        );
        response
            .headers
            .push(("allow".to_string(), "POST".to_string()));
        return response;
    }

    // HTML page endpoints write their own response and bypass the envelope.
    if let Some(raw) = server.raw_handler(m.api) {
        return match raw(ctx, &params).await {
            Ok(RawOut {
                status,
                content_type,
                body,
            }) => Response::text(status, content_type, body),
            Err(e) => {
                log::warn!("api {} failed: {}", m.api, e.message());
                error_response(&e)
            }
        };
    }

    let Some(ep) = server.handler(m.api) else {
        return Response::json(
            404,
            &json!({ "success": false, "error": format!("unsupported api type: {}", m.api) }),
        );
    };

    // Sessions opened by recommend pagination are bound to the device that
    // opened them; pin it so page N+1 does not rotate to a different device.
    if let Some(pin) = router::pin_from_session(&mut params, &ctx.pool).await {
        params.set(crate::endpoints::INTERNAL_DEVICE_PIN_KEY, pin);
    }

    match ep(ctx, &params).await {
        Ok(mut data) => {
            data = ctx.filters.apply(path, data);
            Response::json(200, &data)
        }
        Err(e) => {
            // Release builds have no console; this is the only trace a
            // business failure leaves in logcat (tag fqapi_core).
            log::warn!("api {} failed: {}", m.api, e.message());
            error_response(&e)
        }
    }
}

fn error_response(e: &ApiError) -> Response {
    Response::json(
        e.status(),
        &json!({ "success": false, "error": e.message() }),
    )
}
