//! `ext:` 自定义协议：把扩展自带的 web UI 从 `asset:` 迁到**独立 origin**。
//!
//! ## 为什么需要它（安全）
//!
//! 扩展 UI 此前用 `asset://` 加载（前端 `toAssetUrl`）。而 `tauri.conf.json` 里
//! `assetProtocol.scope` 是 `**`，Tauri 的 asset 协议又只按**窗口 origin**放行
//! CORS —— 于是扩展 iframe 自己就站在 `asset.localhost` 上，与**任意** asset URL
//! 同源，可以直接 `fetch()` 读取本机任意文件。
//! 这使 `capabilities/extension.json` 里那条 `fs:allow-read-file`（scope 限
//! `**/extensions/**`）形同虚设。
//!
//! 换到 `ext:` 之后，扩展 UI 的 origin 是 `http://ext.localhost`（Windows），
//! 与 `http://asset.localhost` 不同源；它再去 fetch asset 资源就是**跨域**，
//! 会被 asset 协议那条「ACAO = 窗口 origin」的判据挡下。
//!
//! ## 边界
//!
//! 只服务**已安装扩展根目录之内**的文件，并且：
//! - 拒绝任何含 `..` 的路径（不做「先规范化再比较」那种容易写错的玩法）；
//! - 比较前缀时在 Windows 上忽略大小写（同一路径两侧大小写可能不同）。
//!
//! 这与 `skin.rs` 对 id 做「防御性复检」（id 同时是目录名）是同一思路。
//!
//! ## 注册位置
//!
//! 必须在 `Builder` 阶段注册（`register_asynchronous_uri_scheme_protocol`
//! 只存在于 `Builder`，`setup` 拿到的 `AppHandle` 没有这个能力）——
//! 与 `cover.rs` 的 `app-cover` 完全一致，见 `lib.rs`。

use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};
// `path()` 来自 `Manager`，不导入会报 "no method named path found"，
// 并连带把 `Some(root)` 的绑定推成未知大小类型（E0277 是它的级联错误）。
use tauri::Manager;

/// 把请求路径做百分号解码。
///
/// 自己实现是为了**不引入额外依赖**，同时让这段逻辑能被
/// `scripts/verify-rust-pure.mjs` 抽出来真跑断言（转义处理正是最易错的地方）。
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 路径是否可安全服务：不含 `..`，且落在 `root` 之内。
///
/// ## 为什么全程走字符串、不用 `Path::is_absolute()`
///
/// 最初的实现用 `path.is_absolute()` + `#[cfg(windows)]` 分支，结果
/// **两条路各错一次**：wasm 验证目标下 Windows 路径不算「绝对」，正常请求全被拒；
/// 而分隔符分支在非 Windows 上又把 `/` 换成 `\` 后再拿 `/` 去比，也对不上。
/// 这段是安全边界，不能有平台相关的暗礁，所以改成：
/// **统一分隔符 → 逐段查 `..` → 大小写无关的前缀比较**，三者在任何平台同义。
///
/// 大小写无关在 Linux 上偏宽松，但方向是安全的：最坏只是去读一个「仅大小写不同」
/// 的路径——在区分大小写的文件系统上它并不存在，读失败即 404，不构成逃逸。
///
/// 刻意**不做**「规范化后再比较」（`canonicalize` 解符号链接那类）：路径可能
/// 尚不存在，且规范化在 `C:` 前缀上有平台差异。宁可严一点：扩展 UI 的正常
/// 产物里本来就不该出现 `..`。
pub fn is_servable(root: &Path, decoded: &str) -> Option<PathBuf> {
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    // 反斜杠也视作分隔符：URL 里是 '/'，但 Windows 上可能被写成 '\'
    let unified = trimmed.replace('\\', "/");
    if unified.split('/').any(|seg| seg == "..") {
        return None;
    }
    if !starts_with_ci(root, Path::new(trimmed)) {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// 前缀比较：统一分隔符 + 忽略大小写。
///
/// 注意比较串末尾那个分隔符——没有它，`…/extensions-evil` 会被误判成在
/// `…/extensions` 之内（经典前缀匹配漏洞，已有对应用例守着）。
fn starts_with_ci(root: &Path, path: &Path) -> bool {
    let r = root.to_string_lossy().replace('\\', "/");
    let p = path.to_string_lossy().replace('\\', "/");
    let r = r.trim_end_matches('/').to_ascii_lowercase();
    let p = p.to_ascii_lowercase();
    !r.is_empty() && (p == r || p.starts_with(&format!("{r}/")))
}

/// 按扩展名猜 Content-Type。扩展 UI 是静态产物，够用即可。
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn plain(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// `ext:` 协议的请求处理器（由 `lib.rs` 在 **Builder** 阶段挂上）。
///
/// 与 `cover.rs` 不同的是这里全部是同步小文件读取，因此不 `spawn`——
/// 但仍在**同步阶段**把根目录解析出来（`ctx` 的借用不能跨越 `await`）。
pub fn handle_request<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let root = ctx
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("extensions"));
    let response = match root {
        Some(root) => serve(&root, &request),
        None => plain(StatusCode::INTERNAL_SERVER_ERROR, "无法定位扩展目录"),
    };
    responder.respond(response);
}

fn serve(root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let decoded = percent_decode(request.uri().path());
    let Some(path) = is_servable(root, &decoded) else {
        return plain(StatusCode::FORBIDDEN, "扩展资源路径越权或不存在");
    };
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", content_type_for(&path))
            // 扩展产物随版本更新，交给 WebView 每次校验即可
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "构造响应失败")),
        Err(e) => plain(StatusCode::NOT_FOUND, &format!("读取扩展资源失败：{e}")),
    }
}
