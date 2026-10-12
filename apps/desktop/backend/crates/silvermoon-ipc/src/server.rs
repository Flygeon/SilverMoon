//! 本地命令服务（HTTP + SSE）。
//!
//! 命令走 HTTP，事件走 SSE。宿主（Electron 主进程）
//! 通过环境变量拿到端口与令牌后：
//!
//! * 渲染进程发起的 `invoke` → 宿主转发到 `POST /cmd`
//! * 宿主订阅 `GET /events`，把事件再分发给对应 label 的窗口
//! * 窗口导航、托盘点击、热键等宿主侧事件 → `POST /_host`
//!
//! 服务只绑 `127.0.0.1`，并且要求 `X-SilverMoon-Token` 匹配（令牌由宿主随机生成）。

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::app::{AppInner, Error, Result};
use crate::internal::{Args, CommandDef, Ctx};

#[derive(Clone)]
struct ServerState {
    inner: Arc<AppInner>,
    table: Arc<HashMap<String, CommandDef>>,
    ctx: Ctx,
    token: Arc<String>,
}

/// 启动服务并阻塞。
pub async fn serve(inner: Arc<AppInner>, commands: Vec<CommandDef>) -> Result<()> {
    // 命令层需要 `&'static` 的应用引用：应用本身是进程级单例，这里刻意泄漏一份。
    let leaked: &'static Arc<AppInner> = Box::leak(Box::new(Arc::clone(&inner)));
    let ctx = Ctx::new(leaked);

    let mut table = HashMap::with_capacity(commands.len());
    for def in commands {
        if table.insert(def.name.to_string(), def).is_some() {
            eprintln!("[silvermoon] 命令名重复注册，后者覆盖前者");
        }
    }

    let state = ServerState {
        inner: Arc::clone(&inner),
        table: Arc::new(table),
        ctx,
        token: Arc::new(std::env::var("SILVERMOON_TOKEN").unwrap_or_default()),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/cmd", post(handle_command))
        .route("/batch", post(handle_batch))
        .route("/events", get(handle_events))
        .route("/_host", post(handle_host_callback))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| Error::Other(format!("绑定命令服务端口失败：{e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| Error::Other(e.to_string()))?
        .port();

    // 宿主据此解析端口；格式固定，勿随意改动（脚本侧按前缀解析）。
    println!("SILVERMOON_READY {{\"port\":{port}}}");
    use std::io::Write;
    let _ = std::io::stdout().flush();

    // 宿主退出后 stdin 会到达 EOF —— 借此保证 sidecar 不会变成孤儿进程。
    spawn_stdin_watchdog();

    axum::serve(listener, app)
        .await
        .map_err(|e| Error::Other(format!("命令服务异常退出：{e}")))
}

fn spawn_stdin_watchdog() {
    std::thread::Builder::new()
        .name("silvermoon-stdin".into())
        .spawn(|| {
            use std::io::Read;
            let mut buf = [0u8; 256];
            loop {
                match std::io::stdin().read(&mut buf) {
                    Ok(0) => {
                        eprintln!("[silvermoon] 宿主已关闭 stdin，退出");
                        std::process::exit(0);
                    }
                    Ok(_) => {}
                    Err(_) => std::process::exit(0),
                }
            }
        })
        .ok();
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    if token.is_empty() {
        // 未配置令牌：默认**拒绝**。
        //
        // 这里此前是 `return true`（"独立调试模式"）。但令牌由宿主用 randomBytes(24)
        // 生成后经环境变量传入，**正常运行永远非空**；空令牌只可能出现在「有人手动
        // 直接起后端」的场景。原来的写法意味着：只要 SILVERMOON_TOKEN 缺失或被清空，
        // 本机任意进程（含被 DNS rebinding 的网页）都能无凭据调用全部命令。
        // 独立调试后端时显式设 SILVERMOON_ALLOW_NO_TOKEN=1 才放行。
        return std::env::var("SILVERMOON_ALLOW_NO_TOKEN").is_ok_and(|v| v == "1");
    }
    headers
        .get("x-silvermoon-token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == token)
        .unwrap_or(false)
}

/// Host 必须是环回地址。
///
/// 服务只绑 `127.0.0.1`，但这挡不住 **DNS rebinding**：攻击者把自己的域名解析到
/// 127.0.0.1，浏览器发出的请求就带上了攻击者控制的 `Host`。只认环回字面量即可挡住。
fn host_is_loopback(headers: &HeaderMap) -> bool {
    let Some(raw) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let host = raw.trim();
    // 去掉端口：`127.0.0.1:1234` / `[::1]:1234`
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

/// Origin 检查。
///
/// 主进程用 Node 的 `fetch` 调用本服务，**不带 Origin** → 放行；
/// 浏览器发起的请求一定带 Origin，只认自家前端的两个来源（打包态 `app://`，
/// 开发态 Vite）。这样即使 token 泄漏，网页也无法直接驱动后端。
fn origin_is_trusted(headers: &HeaderMap) -> bool {
    let Some(raw) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let origin = raw.trim().to_ascii_lowercase();
    // 打包态 app://，开发态 Vite（localhost 与 127.0.0.1 两种写法）
    origin == "app://silvermoon"
        || origin == "http://localhost:1420"
        || origin == "http://127.0.0.1:1420"
}

/// 统一的请求守卫：Host → Origin → 令牌，逐项给出拒绝原因。
fn deny_reason(headers: &HeaderMap, token: &str) -> Option<&'static str> {
    if !host_is_loopback(headers) {
        Some("Host 非环回地址")
    } else if !origin_is_trusted(headers) {
        Some("Origin 不受信任")
    } else if !authorized(headers, token) {
        Some("令牌无效")
    } else {
        None
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn host_accepts_loopback_forms() {
        for host in ["127.0.0.1", "127.0.0.1:51234", "localhost:9", "[::1]:9"] {
            let mut map = HeaderMap::new();
            map.insert("host", HeaderValue::from_static(host));
            assert!(host_is_loopback(&map), "应接受环回 Host：{host}");
        }
    }

    #[test]
    fn host_rejects_rebinding_and_missing() {
        // 攻击者域名解析到 127.0.0.1 → Host 仍是攻击者域名，必须拒绝
        let evil = headers(&[("host", "evil.example.com")]);
        assert!(!host_is_loopback(&evil));

        // 带端口的写法同样必须拒绝
        let evil_with_port = headers(&[("host", "evil.example.com:80")]);
        assert!(!host_is_loopback(&evil_with_port));

        // 完全没有 Host 头
        let missing = headers(&[]);
        assert!(!host_is_loopback(&missing));
    }

    #[test]
    fn origin_allows_node_client_and_own_frontend() {
        // 主进程 fetch 不带 Origin
        let absent = headers(&[]);
        assert!(origin_is_trusted(&absent));

        let app = headers(&[("origin", "app://silvermoon")]);
        assert!(origin_is_trusted(&app));

        let dev = headers(&[("origin", "http://localhost:1420")]);
        assert!(origin_is_trusted(&dev));

        let dev_upper = headers(&[("origin", "APP://SilverMoon")]);
        assert!(origin_is_trusted(&dev_upper));

        // 网页来源必须拒绝
        let evil = headers(&[("origin", "https://evil.example.com")]);
        assert!(!origin_is_trusted(&evil));
    }

    #[test]
    fn empty_token_is_rejected_by_default() {
        // 没有 SILVERMOON_TOKEN 时不得放行（除非显式 opt-in，测试内不设该变量）
        assert!(!authorized(&headers(&[]), ""));
    }

    #[test]
    fn token_mismatch_is_rejected() {
        let wrong = headers(&[("x-silvermoon-token", "nope")]);
        assert!(!authorized(&wrong, "secret"));

        let right = headers(&[("x-silvermoon-token", "secret")]);
        assert!(authorized(&right, "secret"));
    }

    #[test]
    fn deny_reason_reports_first_failing_check() {
        let token = "secret";

        // Host 先失败
        let bad_host = headers(&[("host", "evil.example.com")]);
        assert_eq!(deny_reason(&bad_host, token), Some("Host 非环回地址"));

        // Host 通过、Origin 失败
        let origin_pairs = [
            ("host", "127.0.0.1:1"),
            ("origin", "https://evil.example.com"),
        ];
        let bad_origin = headers(&origin_pairs);
        assert_eq!(deny_reason(&bad_origin, token), Some("Origin 不受信任"));

        // Host/Origin 通过、令牌失败
        let no_token = headers(&[("host", "127.0.0.1:1")]);
        assert_eq!(deny_reason(&no_token, token), Some("令牌无效"));

        // 全部通过
        let ok = headers(&[("host", "127.0.0.1:1"), ("x-silvermoon-token", "secret")]);
        assert_eq!(deny_reason(&ok, token), None);
    }
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "silvermoon", "version": env!("CARGO_PKG_VERSION") }))
}

// ---------------------------------------------------------------------------
// POST /cmd
// ---------------------------------------------------------------------------

async fn handle_command(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Some(reason) = deny_reason(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": reason })),
        );
    }

    let Some(cmd) = body.get("cmd").and_then(Value::as_str) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺少 `cmd`" })),
        );
    };

    let args = body
        .get("args")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);

    let Some(def) = state.table.get(cmd) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": format!("未知命令 `{cmd}`") })),
        );
    };

    let payload = (def.invoke)(&state.ctx, Args::new(args)).await;
    let result = match payload {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    (StatusCode::OK, Json(result))
}

// ---------------------------------------------------------------------------
// POST /batch —— 一次往返执行多条命令
// ---------------------------------------------------------------------------

/// 单次批量上限。批量通道是为了省往返，不该被当成无界扇出的入口。
const MAX_BATCH_CALLS: usize = 256;

/// 请求体：`{ "calls": [ { "cmd": "...", "args": {..} }, ... ] }`
///
/// 响应体：`{ "ok": true, "data": [ { "ok": true, "data": .. } | { "ok": false, "error": ".." } ] }`
///
/// **逐条独立成败**：某一条失败不影响其它条，结果数组与请求数组按下标一一对应。
/// 这样调用方（如网格按可视区批量取缩略图）不必因为一张图失败就整批重来。
async fn handle_batch(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Some(reason) = deny_reason(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": reason })),
        );
    }

    let Some(calls) = body.get("calls").and_then(Value::as_array) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺少 `calls` 数组" })),
        );
    };

    if calls.len() > MAX_BATCH_CALLS {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": format!("单次批量上限 {MAX_BATCH_CALLS} 条，收到 {}", calls.len())
            })),
        );
    }

    let mut results = Vec::with_capacity(calls.len());
    for call in calls {
        let cmd = call.get("cmd").and_then(Value::as_str).unwrap_or_default();
        let Some(def) = state.table.get(cmd) else {
            results.push(json!({ "ok": false, "error": format!("未知命令 `{cmd}`") }));
            continue;
        };
        let args = call
            .get("args")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(Map::new);
        let payload = (def.invoke)(&state.ctx, Args::new(args)).await;
        results.push(match payload {
            Ok(data) => json!({ "ok": true, "data": data }),
            Err(error) => json!({ "ok": false, "error": error }),
        });
    }

    (StatusCode::OK, Json(json!({ "ok": true, "data": results })))
}

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

async fn handle_events(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    // 守卫放在最前：SSE 是长连接，一旦建立就会持续泄漏事件，必须先拦。
    if let Some(reason) = deny_reason(&headers, &state.token) {
        let denied = Json(json!({ "ok": false, "error": reason }));
        return (StatusCode::UNAUTHORIZED, denied).into_response();
    }

    let rx = state.inner.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        // 显式标注错误类型：否则 `None` 分支无从定型，`Sse` 推断不出 `Infallible`
        Ok(msg) => Some(Ok::<Event, Infallible>(Event::default().data(msg))),
        // 落后于环形缓冲时只丢帧，不中断连接
        Err(_) => None,
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

// ---------------------------------------------------------------------------
// POST /_host —— 宿主 → Rust 的回调
// ---------------------------------------------------------------------------

async fn handle_host_callback(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Some(reason) = deny_reason(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": reason })),
        );
    }

    let kind = body.get("kind").and_then(Value::as_str).unwrap_or_default();
    let data = match kind {
        "navigation" => {
            let label = body
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let url = body.get("url").and_then(Value::as_str).unwrap_or_default();
            let allow = crate::window::dispatch_navigation(label, url);
            json!({ "allow": allow })
        }
        "tray-menu" => {
            let id = body.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::tray::dispatch_menu_event(id);
            Value::Null
        }
        "tray-click" => {
            let button = body
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let btn_state = body
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default();
            crate::tray::dispatch_icon_event(button, btn_state);
            Value::Null
        }
        "shortcut" => {
            let accelerator = body
                .get("accelerator")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let pressed = body.get("pressed").and_then(Value::as_bool).unwrap_or(true);
            crate::plugins::dispatch_shortcut(&state.inner, accelerator, pressed);
            Value::Null
        }
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": format!("未知回调 `{other}`") })),
            );
        }
    };

    (StatusCode::OK, Json(json!({ "ok": true, "data": data })))
}
