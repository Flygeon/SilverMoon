//! `app-cover` 自定义协议：在线封面的取图代理与磁盘缓存。
//!
//! ## 为什么需要它
//!
//! 酷狗 / 网易云 / QQ 的图床都不返回 `Access-Control-Allow-Origin`，WebView 里
//! `fetch()` 会被同源策略拦掉；多数图床还做防盗链（校验 `Referer`），
//! `<img>` 直连会 403。把取图搬到 Rust 侧，一次解决三件事：
//!
//! 1. **绕开 CORS**：请求由 Rust 发起，不经页面同源策略；
//! 2. **伪装 Referer/UA**：按域名挑对应的 Referer（见 `referer_for`）；
//! 3. **磁盘缓存**：命中的图不必再打网络，重启后依然有效。
//!
//! ## 前端如何使用
//!
//! `src/utils/onlineCache.ts` 的 `toCoverProxyUrl()` 生成
//! `convertFileSrc(原始URL, "app-cover")`，即：
//! - Windows：`http://app-cover.localhost/<encodeURIComponent(URL)>`
//! - Linux / macOS：`app-cover://localhost/<encodeURIComponent(URL)>`
//!
//! 本模块从请求 URI 里把百分号解码后的 URL 取回来（兼容旧的
//! `app-cover://img/<编码>` 形式），再走缓存 / 网络。
//!
//! ## 缓存布局（`<app_cache_dir>/covers/`）
//!
//! ```text
//! covers/<sha256 前 2 位>/<sha256>.json   meta：{ ct, ts } 或 { fail }
//! covers/<sha256 前 2 位>/<sha256>.img    图体
//! ```
//!
//! 与 Electron 版（`electron/protocols.ts`）的布局、TTL、超时、并发上限
//! 完全一致，因此**旧缓存可以直接复用**，不需要清空重下。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// 负缓存 TTL：取图失败的 URL 在此时间内直接返回失败，不再打网络。
const NEGATIVE_TTL_MS: u128 = 60 * 60 * 1000;

/// 同时在途的封面网络请求上限（与渲染层缩略图池同量级）。
const MAX_CONCURRENT: usize = 8;

/// 单次取图超时。
///
/// 没有它时，一个挂死的连接会**永久占住一个并发槽位**；8 个槽位被占满后
/// 整个封面系统就停摆（表现为「封面全都不出来」）。所以上限与超时必须一起加。
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// 封面缓存容量上限与淘汰水位。
const CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const CACHE_TARGET_BYTES: u64 = 200 * 1024 * 1024;

/// 取图用的 UA（部分图床按 UA 分流派发）。
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 按域名挑 Referer（防盗链）。
fn referer_for(host: &str) -> Option<&'static str> {
    let host = host.to_ascii_lowercase();
    let ends = |suffix: &str| host == suffix.trim_start_matches('.') || host.ends_with(suffix);
    if ends(".126.net") || ends("music.163.com") {
        Some("https://music.163.com/")
    } else if ends(".kugou.com") || ends(".kugou.cn") || ends(".kgimg.com") || ends(".kglink.com") {
        Some("https://www.kugou.com/")
    } else if ends(".qq.com") {
        Some("https://y.qq.com/")
    } else {
        None
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 缓存根目录（`<app_cache_dir>/covers`），并确保它存在。
///
/// 刻意**不接收 AppHandle**：协议回调里的 async 任务不能持有 `AppHandle` 的借用，
/// 因此调用方在**同步阶段**就把这个 PathBuf 解析出来再 move 进去。
fn resolve_root(base: Option<PathBuf>) -> Option<PathBuf> {
    let dir = base?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// 缓存根目录（只需 AppHandle 的场景，如设置页「清理缓存」）。
fn cache_root(app: &AppHandle) -> Option<PathBuf> {
    resolve_root(app.path().app_cache_dir().ok().map(|d| d.join("covers")))
}

/// 缓存文件路径：`<root>/<hash 前 2 位>/<hash>.{json,img}`。
fn cache_paths(root: &Path, url: &str) -> (PathBuf, PathBuf) {
    let hash = format!("{:x}", Sha256::digest(url.as_bytes()));
    let dir = root.join(&hash[..2]);
    (
        dir.join(format!("{hash}.json")),
        dir.join(format!("{hash}.img")),
    )
}

/// meta 文件内容：命中记 ct/ts，失败记 fail（负缓存，落盘后重启仍生效）。
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct CoverMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    ct: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ts: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fail: Option<u128>,
}

/// 磁盘命中：直接返回图体。
fn cache_read(root: &Path, url: &str) -> Option<Vec<u8>> {
    let (meta_p, blob_p) = cache_paths(root, url);
    let meta: CoverMeta = serde_json::from_str(&std::fs::read_to_string(&meta_p).ok()?).ok()?;
    if let Some(fail) = meta.fail {
        // 记录过失败且仍在窗口内 → 负缓存命中
        if now_ms().saturating_sub(fail) < NEGATIVE_TTL_MS {
            return None;
        }
    }
    std::fs::read(&blob_p).ok()
}

/// 取 hit 的内容类型（缺失时按 jpeg 兜底）。
fn cache_content_type(root: &Path, url: &str) -> String {
    let (meta_p, _) = cache_paths(root, url);
    serde_json::from_str::<CoverMeta>(&std::fs::read_to_string(&meta_p).unwrap_or_default())
        .ok()
        .and_then(|m| m.ct)
        .unwrap_or_else(|| "image/jpeg".to_string())
}

fn cache_write(root: &Path, url: &str, ct: &str, body: &[u8]) {
    let (meta_p, blob_p) = cache_paths(root, url);
    if let Some(parent) = meta_p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 先写图体再写 meta：反过来会出现「meta 说命中、图体还没落盘」的窗口
    if std::fs::write(&blob_p, body).is_err() {
        return;
    }
    let meta = CoverMeta {
        ct: Some(ct.to_string()),
        ts: Some(now_ms()),
        fail: None,
    };
    let _ = std::fs::write(&meta_p, serde_json::to_string(&meta).unwrap_or_default());
}

/// 写入负缓存标记（只落 meta，无图体）。
fn cache_write_fail(root: &Path, url: &str) {
    let (meta_p, _) = cache_paths(root, url);
    if let Some(parent) = meta_p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let meta = CoverMeta {
        ct: None,
        ts: None,
        fail: Some(now_ms()),
    };
    let _ = std::fs::write(&meta_p, serde_json::to_string(&meta).unwrap_or_default());
}

/// 从请求 URI 里取回原始封面 URL。
///
/// 兼容两种形式：
/// - `convertFileSrc(url, "app-cover")` → path 就是百分号编码后的 URL；
/// - 旧字面量 `app-cover://img/<编码>` → path 多一层 `img/` 前缀。
fn extract_target(raw_path: &str) -> Option<String> {
    use percent_encoding::percent_decode_str;
    let decoded = percent_decode_str(raw_path)
        .decode_utf8_lossy()
        .into_owned();
    let trimmed = decoded.trim_start_matches('/');
    let target = trimmed.strip_prefix("img/").unwrap_or(trimmed);
    if target.starts_with("http://") || target.starts_with("https://") {
        Some(target.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 并发槽位
// ---------------------------------------------------------------------------

fn active() -> &'static AtomicUsize {
    static ACTIVE: OnceLock<AtomicUsize> = OnceLock::new();
    ACTIVE.get_or_init(|| AtomicUsize::new(0))
}

fn waiters() -> &'static Mutex<Vec<tokio::sync::oneshot::Sender<()>>> {
    static WAITERS: OnceLock<Mutex<Vec<tokio::sync::oneshot::Sender<()>>>> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(Vec::new()))
}

/// 取一个并发槽位；超出上限时排队等待。
async fn acquire_slot() {
    if active().fetch_add(1, Ordering::SeqCst) < MAX_CONCURRENT {
        return;
    }
    // 超限：先把刚才那次自增添回去，再排队
    active().fetch_sub(1, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    waiters().lock().unwrap().push(tx);
    let _ = rx.await;
    active().fetch_add(1, Ordering::SeqCst);
}

fn release_slot() {
    active().fetch_sub(1, Ordering::SeqCst);
    if let Some(tx) = waiters().lock().unwrap().pop() {
        let _ = tx.send(());
    }
}

// ---------------------------------------------------------------------------
// 协议处理
// ---------------------------------------------------------------------------

/// 响应构造助手。
fn respond(status: StatusCode, ct: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", ct)
        // 缓存由本模块自己管（磁盘 + 负缓存），不需要 WebView 再来一层
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// `app-cover` 协议的请求处理器（由 `lib.rs` 在 **Builder** 阶段挂上）。
///
/// ⚠️ 注册必须在 `Builder` 上做，不能放到 `setup` 里用 `AppHandle` ——
/// `register_asynchronous_uri_scheme_protocol` 只存在于 `Builder`（它消费 `self`
/// 并返回新的 `Builder`）；`setup` 拿到的 `AppHandle` 没有这个能力。
///
/// 回调是 `Fn`（可重入），捕获的上下文必须 `Send + Sync + 'static`：
/// 因此这里只在**同步阶段**解析一个 `PathBuf`（`ctx` 的借用不能跨越 `await`），
/// 再把 request 移进 async 任务。
pub fn handle_request<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    // 同步阶段取 app cache dir：ctx 的借用不能跨越 await
    let root = resolve_root(
        ctx.app_handle()
            .path()
            .app_cache_dir()
            .ok()
            .map(|d| d.join("covers")),
    );
    tauri::async_runtime::spawn(async move {
        let response = serve(root, request).await;
        responder.respond(response);
    });
}

/// 处理一次取图请求。
async fn serve(root: Option<PathBuf>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw_path = request.uri().path().to_string();

    let Some(target) = extract_target(&raw_path) else {
        return respond(
            StatusCode::BAD_REQUEST,
            "text/plain",
            b"bad request".to_vec(),
        );
    };

    let Some(root) = root else {
        return respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new());
    };

    // 1. 磁盘缓存
    if let Some(body) = cache_read(&root, &target) {
        let ct = cache_content_type(&root, &target);
        return respond(StatusCode::OK, &ct, body);
    }

    // 2. 网络取图（并发受限 + 超时）
    acquire_slot().await;
    let fetched = fetch_cover(&target).await;
    release_slot();

    match fetched {
        Some((ct, body)) => {
            cache_write(&root, &target, &ct, &body);
            respond(StatusCode::OK, &ct, body)
        }
        None => {
            cache_write_fail(&root, &target);
            respond(StatusCode::NOT_FOUND, "text/plain", Vec::new())
        }
    }
}

/// 单次取图：伪装 Referer/UA，成功返回 (content-type, body)。
async fn fetch_cover(url: &str) -> Option<(String, Vec<u8>)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str().unwrap_or("").to_string();

    let mut req = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .ok()?
        .get(url)
        .header("User-Agent", UA);
    if let Some(referer) = referer_for(&host) {
        req = req.header("Referer", referer);
    }

    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let body = resp.bytes().await.ok()?.to_vec();
    if body.is_empty() {
        return None;
    }
    Some((ct, body))
}

// ---------------------------------------------------------------------------
// 容量上限与清理
// ---------------------------------------------------------------------------

/// 扫描缓存目录，返回（占用字节数，按时间升序的条目）。
fn scan(root: &Path) -> (u64, Vec<(PathBuf, PathBuf, u128, u64)>) {
    let mut items = Vec::new();
    let mut total = 0u64;
    let Ok(shards) = std::fs::read_dir(root) else {
        return (0, items);
    };
    for shard in shards.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for f in files.flatten() {
            let meta_p = f.path();
            if meta_p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let blob_p = meta_p.with_extension("img");
            let Ok(text) = std::fs::read_to_string(&meta_p) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<CoverMeta>(&text) else {
                continue;
            };
            let at = meta.ts.or(meta.fail).unwrap_or(0);
            let len = std::fs::metadata(&blob_p).map(|m| m.len()).unwrap_or(0);
            total += len;
            items.push((meta_p, blob_p, at, len));
        }
    }
    items.sort_by_key(|(_, _, at, _)| *at);
    (total, items)
}

/// 缓存超限时按 LRU 淘汰到目标水位。
fn sweep(root: &Path) {
    let (mut total, items) = scan(root);
    if total <= CACHE_MAX_BYTES {
        return;
    }
    for (meta_p, blob_p, _, len) in items {
        if total <= CACHE_TARGET_BYTES {
            break;
        }
        let _ = std::fs::remove_file(&meta_p);
        let _ = std::fs::remove_file(&blob_p);
        total = total.saturating_sub(len);
    }
}

/// 清空封面缓存，返回释放的字节数（设置页「清理缓存」用）。
pub fn clear(app: &AppHandle) -> u64 {
    let Some(root) = cache_root(app) else {
        return 0;
    };
    let (total, _) = scan(&root);
    if let Ok(shards) = std::fs::read_dir(&root) {
        for shard in shards.flatten() {
            if shard.path().is_dir() {
                let _ = std::fs::remove_dir_all(shard.path());
            }
        }
    }
    total
}

/// 供设置页在大批量取图后惰性触发一次淘汰（目前由 `clear` 之外的路径调用）。
pub fn maybe_sweep(app: &AppHandle) {
    if let Some(root) = cache_root(app) {
        sweep(&root);
    }
}
