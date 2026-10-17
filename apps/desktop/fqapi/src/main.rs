//! silvermoon-fqapi —— 番茄内容源 sidecar。
//!
//! ## 为什么是独立进程
//!
//! 这个 crate 从 fqapp 的 Rust 核心裁剪而来，依赖 `reqwest 0.13 + rustls`，
//! 而 SilverMoon 主 backend 用的是 `reqwest 0.12 + native-tls`。编进同一个
//! crate 会出现两份 reqwest、编译时间翻倍，且 TLS provider 只能选一个。
//! 独立进程还带来两个附带好处：上游封禁 / 设备池异常不会污染主进程，
//! 崩溃了主应用照常运行。
//!
//! ## 协议
//!
//! 与 `apps/desktop/lyrics` 同构：stdin/stdout 行分隔 JSON，零端口。
//!
//! 启动后先打印一行握手：
//! ```text
//! FQAPI_READY {"pid":1234,"version":"0.1.0"}
//! ```
//!
//! 之后每行一个请求，每行一个响应（id 原样回带）：
//! ```json
//! {"id":1,"path":"/api/v1/books/123","query":"","method":"GET"}
//! {"id":1,"status":200,"body":{...}}
//! ```
//!
//! ## 最小闭环
//!
//! `{"id":1,"op":"selftest"}` 会依次做三件事并逐条汇报：
//!
//! 1. 设备池能否拿到一台设备（需要真实联网注册）；
//! 2. 能否用该设备签名请求上游书详情；
//! 3. 能否解出一章正文。
//!
//! 这是判断「整条路是否成立」的唯一判据 —— 三步任一失败，后面的移植工作
//! 都是白工。

use std::io::{BufRead, Write};

use fqapi_core::config::Config;
use fqapi_core::device::DevicePool;
use fqapi_core::dispatch::{dispatch, Request};
use fqapi_core::endpoints::{Ctx, Server};
use fqapi_core::filter::FilterManager;
use fqapi_core::sign::Manager;
use fqapi_core::upstream::UpstreamClient;
use serde_json::{json, Value};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 运行时目录：设备池、缓存图、日志都落在这里。
///
/// 由宿主用 `SILVERMOON_FQAPI_DATA` 指定；缺省落到系统临时目录，方便
/// 独立跑自检时不污染用户数据。
fn data_dir() -> std::path::PathBuf {
    match std::env::var("SILVERMOON_FQAPI_DATA") {
        Ok(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => std::env::temp_dir().join("silvermoon-fqapi"),
    }
}

struct Core {
    server: std::sync::Arc<Server>,
}

impl Core {
    async fn boot() -> Result<Self, String> {
        let root = data_dir();
        std::fs::create_dir_all(&root).map_err(|e| format!("创建数据目录失败：{e}"))?;
        let src_dir = root.join("src");
        let _ = std::fs::create_dir_all(&src_dir);

        let cfg = std::sync::Arc::new(Config {
            port: 0,
            ..Default::default()
        });
        let pool = DevicePool::new(root.join("device_pool.json"))
            .await
            .map_err(|e| format!("设备池初始化失败：{e}"))?;
        let signer = Manager::new();
        let up = std::sync::Arc::new(
            UpstreamClient::new(pool.clone(), signer)
                .map_err(|e| format!("上游客户端初始化失败：{e}"))?,
        );
        // filter.json 缺失即视为「没有响应改写规则」，与原项目一致。
        let filters = std::sync::Arc::new(FilterManager::default());

        let ctx = std::sync::Arc::new(Ctx {
            up,
            pool,
            cfg,
            src_dir: src_dir.to_string_lossy().into_owned(),
            filters,
        });

        Ok(Core {
            server: std::sync::Arc::new(Server::new(ctx)),
        })
    }

    async fn call(&self, path: &str, query: &str, method: &str) -> Value {
        let req = Request {
            method: method.to_string(),
            path: path.to_string(),
            query: query.to_string(),
            body: Vec::new(),
            headers: Vec::new(),
        };
        let resp = dispatch(&self.server, &req).await;
        let status = resp.status;
        match resp.into_bytes().await {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) => json!({ "status": status, "body": v }),
                Err(_) => json!({
                    "status": status,
                    "bodyText": String::from_utf8_lossy(&bytes).to_string(),
                }),
            },
            Err(e) => json!({ "status": status, "error": e }),
        }
    }

    /// 三步最小闭环。任何一步失败都立刻停下并报告该步。
    async fn selftest(&self) -> Value {
        let mut steps: Vec<Value> = Vec::new();

        // 1) 设备池：真正走一次 get()（首次会触发 check_and_refill → 联网注册）。
        //    注意不能用 count()：它只读内存，池空时直接返回 0，永远不会去注册，
        //    这样的自检测的是「文件里有没有设备」而不是「能不能拿到设备」。
        let got = self.server.ctx.pool.get().await;
        let devices = self.server.ctx.pool.count().await;
        steps.push(match &got {
            Ok(d) => json!({
                "step": "device_pool",
                "ok": true,
                "devices": devices,
                "device_id": d.device_id,
                "has_secret_key": !d.secret_key.is_empty(),
            }),
            Err(e) => json!({
                "step": "device_pool",
                "ok": false,
                "devices": devices,
                "error": e,
            }),
        });
        if got.is_err() {
            return json!({ "ok": false, "failedAt": "device_pool", "steps": steps });
        }

        // 2) 签名请求上游书详情。这里用一本书的真实 id 由调用方传入，
        //    自检模式下一个都没给就跳过，避免把测试书号写死在代码里。
        let probe = std::env::var("SILVERMOON_FQAPI_PROBE_BOOK").unwrap_or_default();
        if probe.trim().is_empty() {
            steps.push(json!({
                "step": "book_detail",
                "ok": null,
                "skipped": "未设置 SILVERMOON_FQAPI_PROBE_BOOK（示例书号）",
            }));
            return json!({ "ok": null, "partial": true, "steps": steps });
        }

        let detail = self
            .call(&format!("/api/v1/books/{probe}"), "", "GET")
            .await;
        let detail_ok = detail.get("status").and_then(|v| v.as_u64()) == Some(200);
        steps.push(json!({ "step": "book_detail", "ok": detail_ok, "result": detail }));
        if !detail_ok {
            return json!({ "ok": false, "failedAt": "book_detail", "steps": steps });
        }

        // 3) 解一章正文：先取目录，再取第一章
        let dir = self
            .call(&format!("/api/v1/books/{probe}/directory"), "", "GET")
            .await;
        let first_item = find_first_item_id(&dir);
        let Some(item_id) = first_item else {
            steps.push(json!({ "step": "directory", "ok": false, "result": dir }));
            return json!({ "ok": false, "failedAt": "directory", "steps": steps });
        };
        let content = self
            .call(&format!("/api/v1/chapters/{item_id}"), "", "GET")
            .await;
        let content_len = content
            .get("body")
            .and_then(|b| b.get("data"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.chars().count())
            .unwrap_or(0);
        steps.push(json!({
            "step": "chapter_content",
            "ok": content_len > 0,
            "chars": content_len,
        }));
        json!({
            "ok": content_len > 0,
            "failedAt": if content_len > 0 { Value::Null } else { json!("chapter_content") },
            "steps": steps,
        })
    }
}

/// 从目录响应里挖出第一个章节的 item_id。
///
/// 上游目录结构不止一种（`data.chapterList` / `data.item_data_list` /
/// `data.volumes[].chapters[]`），这里按优先级逐个试，与前端归一化逻辑一致。
fn find_first_item_id(dir: &Value) -> Option<String> {
    let data = dir.get("body")?.get("data")?;

    fn scan(v: &Value, depth: usize) -> Option<String> {
        if depth > 6 {
            return None;
        }
        match v {
            Value::Object(m) => {
                for key in ["item_id", "itemId", "itemID", "id"] {
                    if let Some(s) = m.get(key).and_then(|x| x.as_str()) {
                        if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
                            return Some(s.to_string());
                        }
                    }
                }
                for key in [
                    "chapterList",
                    "item_data_list",
                    "chapters",
                    "volumes",
                    "list",
                ] {
                    if let Some(found) = m.get(key).and_then(|x| scan(x, depth + 1)) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(a) => a.iter().find_map(|x| scan(x, depth + 1)),
            _ => None,
        }
    }

    scan(data, 0)
}

fn emit(v: &Value) {
    let line = serde_json::to_string(v).unwrap_or_else(|_| "{\"error\":\"encode\"}".to_string());
    println!("{line}");
    let _ = std::io::stdout().flush();
}

#[tokio::main]
async fn main() {
    let core = match Core::boot().await {
        Ok(c) => c,
        Err(e) => {
            emit(&json!({ "error": e }));
            std::process::exit(1);
        }
    };

    // 握手行：宿主据此判定 sidecar 就绪（与 lyrics 的 LYRICS_READY 同构）。
    println!(
        "FQAPI_READY {}",
        json!({ "pid": std::process::id(), "version": VERSION })
    );
    let _ = std::io::stdout().flush();

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            emit(&json!({ "error": "invalid json" }));
            continue;
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);

        // 自检是唯一的非路由 op；其余一律当路径分发。
        if req.get("op").and_then(|v| v.as_str()) == Some("selftest") {
            let result = core.selftest().await;
            emit(&json!({ "id": id, "op": "selftest", "result": result }));
            continue;
        }
        if req.get("op").and_then(|v| v.as_str()) == Some("ping") {
            emit(&json!({ "id": id, "op": "ping", "pong": true, "version": VERSION }));
            continue;
        }

        let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let query = req.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
        if path.is_empty() {
            emit(&json!({ "id": id, "error": "missing path" }));
            continue;
        }
        let mut result = core.call(path, query, method).await;
        if let Some(obj) = result.as_object_mut() {
            obj.insert("id".to_string(), id);
        }
        emit(&result);
    }
}
