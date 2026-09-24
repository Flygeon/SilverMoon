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
use axum::response::IntoResponse;
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
        return true; // 未配置令牌（独立调试模式）
    }
    headers
        .get("x-silvermoon-token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == token)
        .unwrap_or(false)
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
    if !authorized(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "令牌无效" })),
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
// GET /events
// ---------------------------------------------------------------------------

async fn handle_events(
    State(state): State<ServerState>,
) -> Sse<impl tokio_stream::Stream<Item = std::result::Result<Event, Infallible>>> {
    let rx = state.inner.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        // 显式标注错误类型：否则 `None` 分支无从定型，`Sse` 推断不出 `Infallible`
        Ok(msg) => Some(Ok::<Event, Infallible>(Event::default().data(msg))),
        // 落后于环形缓冲时只丢帧，不中断连接
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ---------------------------------------------------------------------------
// POST /_host —— 宿主 → Rust 的回调
// ---------------------------------------------------------------------------

async fn handle_host_callback(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "令牌无效" })),
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
