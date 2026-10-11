//! KMP 桌面端（Compose Multiplatform）与 Rust 后端之间的本机回环桥。
//!
//! 设计取舍：**业务逻辑零重写**。现有 186 条 #[tauri::command] 原样复用，桥只做两件事：
//!   1. 在 127.0.0.1 上开一个带令牌校验的 JSON-RPC/HTTP 端点；
//!   2. 把命令名 + camelCase 参数派发回同一批函数（派发表见 dispatch.generated.rs，
//!      由 scripts/gen-bridge-dispatch.mjs 从源码机械生成）。
//!
//! 与 Tauri 自带 IPC 的差别只有一层传输：Tauri 走 WebView2 的 postMessage，
//! 这里走 HTTP，参数/返回值语义完全一致（含 camelCase 键名约定）。
//!
//! 事件方向：Tauri 侧 app.emit(...) 的事件经 app.listen_any 捕获后推给 SSE 客户端；
//! Kotlin 侧只需订阅 /events 即可拿到与前端 listen() 等价的事件流。

use std::collections::HashSet;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::Listener;

#[path = "dispatch.generated.rs"]
mod generated;

pub use generated::{COMMANDS, COMMAND_COUNT};

/// 协议版本：Kotlin 侧握手时校验，避免两侧版本错配后行为诡异。
pub const PROTOCOL: u32 = 1;

/// 握手信息：Kotlin 侧拿到端口与令牌后才能发请求。
#[derive(serde::Serialize, Clone)]
pub struct BridgeInfo {
    pub protocol: u32,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub commands: usize,
}

fn header(name: &str, value: &str) -> Option<tiny_http::Header> {
    format!("{name}: {value}").parse().ok()
}

fn random_token() -> String {
    // 只用于本机回环鉴权，不需要密码学强度，但不能可预测
    let mut bytes = [0u8; 24];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 事件广播中心：SSE 客户端各自持有一个 mpsc 接收端。
struct Hub {
    next_id: AtomicUsize,
    clients: Mutex<Vec<(usize, Sender<String>)>>,
    subscribed: Mutex<HashSet<String>>,
}

impl Hub {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicUsize::new(1),
            clients: Mutex::new(Vec::new()),
            subscribed: Mutex::new(HashSet::new()),
        })
    }

    fn subscribe(&self) -> (usize, Receiver<String>) {
        let (tx, rx) = channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut list) = self.clients.lock() {
            list.push((id, tx));
        }
        (id, rx)
    }

    fn unsubscribe(&self, id: usize) {
        if let Ok(mut list) = self.clients.lock() {
            list.retain(|(cid, _)| *cid != id);
        }
    }

    fn broadcast(&self, event: &str, payload: serde_json::Value) {
        let frame = format!(
            "data: {}\n\n",
            json!({ "type": "event", "event": event, "payload": payload })
        );
        if let Ok(mut list) = self.clients.lock() {
            list.retain(|(_, tx)| tx.send(frame.clone()).is_ok());
        }
    }
}

/// 默认转发的 Tauri 事件名（与前端 src/ipc/events.ts 里 listen 的名字一一对应）。
pub const DEFAULT_EVENTS: &[&str] = &[
    "scan:progress",
    "smtc:command",
    "app:player-command",
    "osu:progress",
    "ext:navigate",
    "updater:status",
    "silvermoon:log",
];

fn register_events(app: &tauri::AppHandle, hub: &Arc<Hub>, names: &[String]) {
    for name in names {
        let known = hub
            .subscribed
            .lock()
            .map(|set| set.contains(name))
            .unwrap_or(true);
        if known {
            continue;
        }
        let hub_inner = hub.clone();
        let event_name = name.clone();
        app.listen_any(event_name.clone(), move |event| {
            let payload = serde_json::from_str::<serde_json::Value>(event.payload())
                .unwrap_or(serde_json::Value::Null);
            hub_inner.broadcast(&event_name, payload);
        });
        if let Ok(mut set) = hub.subscribed.lock() {
            set.insert(name.clone());
        }
    }
}

/// 启动桥服务。返回握手信息；调用方负责把它交给前端进程。
pub fn start(app: tauri::AppHandle) -> Result<BridgeInfo, String> {
    let server =
        tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("桥服务监听失败: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let token = random_token();
    let hub = Hub::new();

    let defaults: Vec<String> = DEFAULT_EVENTS.iter().map(|s| s.to_string()).collect();
    register_events(&app, &hub, &defaults);

    let info = BridgeInfo {
        protocol: PROTOCOL,
        port,
        token: token.clone(),
        pid: std::process::id(),
        commands: COMMAND_COUNT,
    };

    let server = Arc::new(server);
    {
        let server = server.clone();
        let app = app.clone();
        let hub = hub.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let app = app.clone();
                let hub = hub.clone();
                let token = token.clone();
                std::thread::spawn(move || {
                    if let Err(error) = handle(app, hub, &token, request) {
                        eprintln!("[bridge] 请求处理失败: {error}");
                    }
                });
            }
        });
    }

    let handshake = serde_json::to_string(&info).map_err(|e| e.to_string())?;
    if let Ok(path) = std::env::var("SILVERMOON_BRIDGE_HANDSHAKE") {
        let tmp = format!("{path}.tmp");
        if std::fs::write(&tmp, handshake.as_bytes()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
    // 兜底通道：父进程也可以直接读标准输出的一行握手
    println!("SILVERMOON-BRIDGE-READY {handshake}");

    // 父进程退出（stdin 关闭）即自行退出，避免留下孤儿后端进程
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 256];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            eprintln!("[bridge] 父进程已退出，后端随之关闭");
            app.exit(0);
        });
    }

    Ok(info)
}

fn respond_json(
    request: tiny_http::Request,
    status: u16,
    value: serde_json::Value,
) -> Result<(), String> {
    let text = value.to_string();
    let len = text.len();
    let mut headers = Vec::new();
    if let Some(h) = header("Content-Type", "application/json; charset=utf-8") {
        headers.push(h);
    }
    if let Some(h) = header("Access-Control-Allow-Origin", "*") {
        headers.push(h);
    }
    let body = std::io::Cursor::new(text.into_bytes());
    let response = tiny_http::Response::new(tiny_http::StatusCode(status), headers, body, Some(len), None);
    request.respond(response).map_err(|e| e.to_string())
}

fn token_ok(request: &tiny_http::Request, token: &str) -> bool {
    request
        .headers()
        .iter()
        .any(|h| h.field.equiv("x-silvermoon-token") && h.value.as_str() == token)
}

/// 极简 percent-decode：只处理事件名里可能出现的 : 与 ,
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(code) = u8::from_str_radix(hex, 16) {
                out.push(code as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn parse_event_names(query: &str) -> Vec<String> {
    for pair in query.split('&') {
        if let Some(rest) = pair.strip_prefix("events=") {
            return percent_decode(rest)
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    DEFAULT_EVENTS.iter().map(|s| s.to_string()).collect()
}

/// SSE 数据源：把广播中心收到的帧按块吐给 tiny_http。
struct SseReader {
    rx: Receiver<String>,
    hub: Arc<Hub>,
    id: usize,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for SseReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.recv_timeout(Duration::from_secs(15)) {
                Ok(message) => {
                    self.buf = message.into_bytes();
                    self.pos = 0;
                }
                Err(RecvTimeoutError::Timeout) => {
                    // 心跳：让代理/客户端知道连接还活着
                    self.buf = b": ping\n\n".to_vec();
                    self.pos = 0;
                }
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = std::cmp::min(out.len(), self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl Drop for SseReader {
    fn drop(&mut self) {
        self.hub.unsubscribe(self.id);
    }
}

fn handle(
    app: tauri::AppHandle,
    hub: Arc<Hub>,
    token: &str,
    mut request: tiny_http::Request,
) -> Result<(), String> {
    let url = request.url().to_string();
    let mut split = url.splitn(2, '?');
    let path = split.next().unwrap_or("/").to_string();
    let query = split.next().unwrap_or("").to_string();
    let method = request.method().clone();
    let authorized = token_ok(&request, token);

    if matches!(method, tiny_http::Method::Get) && path == "/health" {
        return respond_json(
            request,
            200,
            json!({ "ok": true, "protocol": PROTOCOL, "commands": COMMAND_COUNT, "pid": std::process::id() }),
        );
    }
    if !authorized {
        return respond_json(request, 401, json!({ "ok": false, "error": "令牌无效" }));
    }

    match (method, path.as_str()) {
        (tiny_http::Method::Post, "/rpc") => {
            let mut body = String::new();
            if let Err(error) = request.as_reader().read_to_string(&mut body) {
                return respond_json(
                    request,
                    400,
                    json!({ "ok": false, "error": format!("读取请求体失败: {error}") }),
                );
            }
            let parsed: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(error) => {
                    return respond_json(
                        request,
                        400,
                        json!({ "ok": false, "error": format!("请求体解析失败: {error}") }),
                    )
                }
            };
            let cmd = parsed.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if cmd.is_empty() {
                return respond_json(
                    request,
                    400,
                    json!({ "ok": false, "error": "缺少 cmd 字段" }),
                );
            }
            let args = parsed
                .get("args")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            match generated::dispatch(&app, &cmd, &args) {
                Ok(data) => respond_json(request, 200, json!({ "ok": true, "data": data })),
                Err(error) => respond_json(request, 200, json!({ "ok": false, "error": error })),
            }
        }
        (tiny_http::Method::Get, "/events") => {
            register_events(&app, &hub, &parse_event_names(&query));
            let (id, rx) = hub.subscribe();
            let mut headers = vec![];
            if let Some(h) = header("Content-Type", "text/event-stream; charset=utf-8") {
                headers.push(h);
            }
            if let Some(h) = header("Cache-Control", "no-cache") {
                headers.push(h);
            }
            if let Some(h) = header("Connection", "keep-alive") {
                headers.push(h);
            }
            if let Some(h) = header("Access-Control-Allow-Origin", "*") {
                headers.push(h);
            }
            let reader = SseReader {
                rx,
                hub,
                id,
                buf: Vec::new(),
                pos: 0,
            };
            let response =
                tiny_http::Response::new(tiny_http::StatusCode(200), headers, reader, None, None);
            request.respond(response).map_err(|e| e.to_string())
        }
        _ => respond_json(request, 404, json!({ "ok": false, "error": "未知端点" })),
    }
}


