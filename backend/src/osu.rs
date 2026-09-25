//! osu! 谱面源（链路移植自 ECHO 参考实现）。
//!
//! 完整链路：多源搜索（Sayobot → osu! 官方 → Catboy）→ 多镜像下载 `.osz`
//!           → 解压解析 `.osu` 元数据 → 音频转 mp3 → 写 ID3 标签（含封面）→ 入库。
//!
//! 命令：
//! - `osu_search`         关键词 / 谱面链接 / 谱面集 ID → 结果列表（三源聚合去重打分）
//! - `osu_download`       按谱面集 ID 下载并导入曲库（async，事件 `osu:progress`）
//! - `osu_import_archive` 导入本地 `.osz` 文件
//! - `osu_cover_url`      封面图本地代理 URL（assets.ppy.sh 校验 Referer，浏览器直连会被拒）
//!
//! 说明：不依赖 osu! 账号（ECHO 的 OsuAccountProvider 同样是空壳），全程匿名。
//! 音频非 mp3 时需要 ffmpeg，缺失时给出明确中文提示而非静默失败。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use silvermoon_ipc::{EventEmitter, HostApi};

use crate::commands::{metadata, now_ms, now_secs, DbState};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0";
/// 下载镜像对 UA 有要求的站点（Sayobot / NeriNyan）用它，避免被当成浏览器请求拒掉
const OSU_DL_UA: &str = "SilverMoon osu! downloader";
const OSU_ARCHIVE_ACCEPT: &str =
    "application/x-osu-beatmap-archive,application/zip,application/octet-stream,*/*";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const COVER_TIMEOUT: Duration = Duration::from_secs(20);

/// 解压 + 转码 + 落库是重 I/O，串行化避免临时文件互相踩踏
static IMPORT_LOCK: Mutex<()> = Mutex::new(());

fn http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            // 与 anime 一致：保留系统代理（GFW 环境下 osu.ppy.sh / assets.ppy.sh 常需代理）
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_max_idle_per_host(8)
            .build()
            .expect("osu http client")
    })
}

// ---- 响应结构（与前端 @shared/types 对应）----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OsuBeatmapset {
    pub id: String,
    /// 完整展示名：`Artist - Title`
    pub title: String,
    pub artist: String,
    pub song_title: String,
    pub uploader: Option<String>,
    /// 已经过本地代理的封面 URL（浏览器直连 assets.ppy.sh 会被 Referer 校验拒掉）
    pub cover_url: Option<String>,
    pub page_url: String,
    /// 结果来自哪个源（sayobot / official / catboy / direct）
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsuSearchResult {
    pub items: Vec<OsuBeatmapset>,
    /// 部分源失败时先给出结果，同时回传失败原因（前端可提示「某源不可用」）
    pub errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsuImportResult {
    pub file_id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub beatmapset_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OsuProgress {
    beatmapset_id: String,
    /// downloading | extracting | converting | tagging | importing | done | error
    stage: String,
    message: String,
    percent: f64,
}

fn emit_progress(app: &silvermoon_ipc::Host, id: &str, stage: &str, message: &str, percent: f64) {
    let _ = app.emit(
        "osu:progress",
        OsuProgress {
            beatmapset_id: id.to_string(),
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

// ---- 小工具 ----

fn xxh3_hex(s: &str) -> String {
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(s.as_bytes()))
}

fn b64url(s: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
}

fn b64url_decode(s: &str) -> Option<String> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

fn ext_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 归档内路径归一化：`\` → `/`、去前导 `/`、转小写
fn normalize_archive_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_ascii_lowercase()
}

/// 文件名安全化：去掉 Windows 非法字符与控制字符，压缩空白
fn sanitize_file_part(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || c.is_ascii_control()
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    let squashed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = squashed.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "Untitled osu beatmap".to_string()
    } else {
        trimmed.chars().take(160).collect()
    }
}

/// 输出路径去重：`name.mp3` → `name (2).mp3` …
fn unique_output_path(dir: &Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (file_name.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn parse_bpm_string(bpm: f64) -> String {
    // 保留两位小数（180.0 → "180"、179.972 → "179.97"）
    let rounded = (bpm * 100.0).round() / 100.0;
    rounded.to_string()
}

// ---- 谱面集 ID 解析 ----

/// 支持：纯数字（≥3 位）、`https://osu.ppy.sh/beatmapsets/<id>`、`/s/<id>`
fn parse_beatmapset_id(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if v.chars().all(|c| c.is_ascii_digit()) {
        return if v.len() >= 3 {
            Some(v.to_string())
        } else {
            None
        };
    }
    let parsed = url::Url::parse(v).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "osu.ppy.sh" && host != "www.osu.ppy.sh" {
        return None;
    }
    let path = parsed.path();
    let rest = path
        .strip_prefix("/beatmapsets/")
        .or_else(|| path.strip_prefix("/s/"))?;
    let id: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

// ---- 封面本地代理 ----
//
// assets.ppy.sh 会校验 Referer，Electron（app:// 源）直连会拿到 403；
// 用一个独立的小 HTTP 服务转发并补上 Referer（与 anime/webdav 的 tiny_http 模式一致）。

static COVER_PROXY_BASE: OnceLock<String> = OnceLock::new();

fn cover_proxy_base() -> Option<String> {
    if let Some(b) = COVER_PROXY_BASE.get() {
        return Some(b.clone());
    }
    let server = tiny_http::Server::http("127.0.0.1:0").ok()?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let srv = std::sync::Arc::new(server);
    let srv2 = srv.clone();
    std::thread::spawn(move || {
        for request in srv2.incoming_requests() {
            std::thread::spawn(move || {
                if let Err(e) = handle_cover_proxy(request) {
                    eprintln!("[osu] 封面代理请求失败: {e}");
                }
            });
        }
    });
    let base = format!("http://127.0.0.1:{port}");
    let _ = COVER_PROXY_BASE.set(base.clone());
    Some(base)
}

fn referer_for_host(host: &str) -> String {
    let h = host.to_ascii_lowercase();
    if h.ends_with("ppy.sh") {
        "https://osu.ppy.sh/".to_string()
    } else if h.ends_with("catboy.best") {
        "https://catboy.best/".to_string()
    } else if h.ends_with("nerinyan.moe") {
        "https://nerinyan.moe/".to_string()
    } else if h.ends_with("sayobot.cn") {
        "https://sayobot.cn/".to_string()
    } else {
        format!("https://{host}/")
    }
}

/// 把远端封面 URL 换成代理 URL（代理不可用时原样返回，不阻断搜索）
fn proxy_cover(raw: &str) -> String {
    let Ok(parsed) = url::Url::parse(raw) else {
        return raw.to_string();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return raw.to_string();
    }
    let Some(base) = cover_proxy_base() else {
        return raw.to_string();
    };
    let referer = referer_for_host(parsed.host_str().unwrap_or_default());
    format!("{base}/osu-img?u={}&r={}", b64url(raw), b64url(&referer))
}

fn proxy_header(name: &str, value: &str) -> Option<tiny_http::Header> {
    format!("{name}: {value}").parse().ok()
}

fn respond_text(request: tiny_http::Request, status: u16, text: String) {
    let len = text.len();
    let mut headers = Vec::new();
    if let Some(h) = proxy_header("Access-Control-Allow-Origin", "*") {
        headers.push(h);
    }
    if let Some(h) = proxy_header("Content-Type", "text/plain; charset=utf-8") {
        headers.push(h);
    }
    let body = std::io::Cursor::new(text.into_bytes());
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        headers,
        body,
        Some(len),
        None,
    );
    let _ = request.respond(response);
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
}

fn handle_cover_proxy(request: tiny_http::Request) -> Result<(), String> {
    if !matches!(request.method(), tiny_http::Method::Get) {
        respond_text(request, 405, "method not allowed".into());
        return Ok(());
    }
    let (path, query) = match request.url().split_once('?') {
        Some((p, q)) => (p, q),
        None => (request.url(), ""),
    };
    if path != "/osu-img" {
        respond_text(request, 404, "not found".into());
        return Ok(());
    }
    let remote = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .and_then(b64url_decode)
        .unwrap_or_default();
    let referer = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("r="))
        .and_then(b64url_decode)
        .unwrap_or_default();
    if remote.is_empty() {
        respond_text(request, 400, "bad request".into());
        return Ok(());
    }
    let parsed = match url::Url::parse(&remote) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => {
            respond_text(request, 400, "bad url".into());
            return Ok(());
        }
    };
    if parsed.host_str().map(is_loopback_host).unwrap_or(true) {
        respond_text(request, 403, "forbidden".into());
        return Ok(());
    }

    let mut builder = http_client()
        .get(&remote)
        .timeout(COVER_TIMEOUT)
        .header(
            reqwest::header::ACCEPT,
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        )
        .header(reqwest::header::USER_AGENT, UA);
    if !referer.is_empty() {
        builder = builder.header(reqwest::header::REFERER, referer);
    }
    let resp = match builder.send() {
        Ok(r) => r,
        Err(e) => {
            respond_text(request, 502, format!("upstream error: {e}"));
            return Ok(());
        }
    };
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        respond_text(request, status, format!("upstream {status}"));
        return Ok(());
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp
        .bytes()
        .map_err(|e| format!("读取封面失败：{e}"))?
        .to_vec();

    let mut headers = Vec::new();
    if let Some(h) = proxy_header("Content-Type", &content_type) {
        headers.push(h);
    }
    if let Some(h) = proxy_header("Access-Control-Allow-Origin", "*") {
        headers.push(h);
    }
    if let Some(h) = proxy_header("Cache-Control", "public, max-age=86400") {
        headers.push(h);
    }
    let len = bytes.len();
    // tiny_http 的 R 需要 `std::io::Read`；`Vec<u8>` 并未实现它（只有 `&[u8]` 有），
    // 必须先包一层 Cursor（anime/webdav 的代理同样这么做）。
    let body = std::io::Cursor::new(bytes);
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        headers,
        body,
        Some(len),
        None,
    );
    request.respond(response).map_err(|e| e.to_string())
}

// ---- HTTP 小工具 ----

fn get_json(
    url: &str,
    referer: &str,
    ua: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let resp = http_client()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::USER_AGENT, ua)
        .timeout(timeout)
        .send()
        .map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let text = resp.text().map_err(|e| format!("读取响应失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败：{e}"))
}

fn jstr(v: &serde_json::Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn jprefer(v: &serde_json::Value, first: &str, second: &str) -> Option<String> {
    jstr(v, first).or_else(|| jstr(v, second))
}

fn jnum(v: &serde_json::Value, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok().map(|f| f as i64),
        _ => None,
    }
}

fn jnum_pos(v: &serde_json::Value, key: &str) -> Option<i64> {
    let n = jnum(v, key)?;
    if n > 0 {
        Some(n)
    } else {
        None
    }
}

fn page_url_for(id: &str) -> String {
    format!("https://osu.ppy.sh/beatmapsets/{id}")
}

fn fallback_cover_for(id: &str) -> String {
    format!("https://assets.ppy.sh/beatmaps/{id}/covers/card@2x.jpg")
}

// ---- 搜索：三源聚合 ----

fn map_sayobot(v: &serde_json::Value) -> Option<OsuBeatmapset> {
    let id = jnum_pos(v, "sid")?;
    let title = jprefer(v, "titleU", "title")?;
    let artist = jprefer(v, "artistU", "artist").unwrap_or_default();
    Some(build_beatmapset(
        &id.to_string(),
        &artist,
        &title,
        jstr(v, "creator"),
        "sayobot",
    ))
}

fn map_catboy(v: &serde_json::Value) -> Option<OsuBeatmapset> {
    let id = jnum_pos(v, "SetID")?;
    let title = jstr(v, "Title")?;
    let artist = jstr(v, "Artist").unwrap_or_default();
    Some(build_beatmapset(
        &id.to_string(),
        &artist,
        &title,
        jstr(v, "Creator"),
        "catboy",
    ))
}

fn map_official(v: &serde_json::Value) -> Option<OsuBeatmapset> {
    let id = jnum_pos(v, "id")?;
    let title = jprefer(v, "title_unicode", "title")?;
    let artist = jprefer(v, "artist_unicode", "artist").unwrap_or_default();
    let covers = v.get("covers");
    let cover = covers.and_then(|c| {
        ["card@2x", "card", "cover@2x", "cover", "list@2x", "list"]
            .iter()
            .find_map(|k| jstr(c, *k))
    });
    let mut item = build_beatmapset(
        &id.to_string(),
        &artist,
        &title,
        jstr(v, "creator"),
        "official",
    );
    if let Some(c) = cover {
        let raw = if c.starts_with("//") {
            format!("https:{c}")
        } else {
            c
        };
        item.cover_url = Some(proxy_cover(&raw.replace("http://", "https://")));
    }
    Some(item)
}

fn build_beatmapset(
    id: &str,
    artist: &str,
    song_title: &str,
    uploader: Option<String>,
    source: &str,
) -> OsuBeatmapset {
    let artist = artist.trim();
    let song_title = song_title.trim();
    let full = match (artist.is_empty(), song_title.is_empty()) {
        (true, _) => song_title.to_string(),
        (false, true) => artist.to_string(),
        _ => format!("{artist} - {song_title}"),
    };
    OsuBeatmapset {
        id: id.to_string(),
        title: full,
        artist: artist.to_string(),
        song_title: song_title.to_string(),
        uploader,
        cover_url: Some(proxy_cover(&fallback_cover_for(id))),
        page_url: page_url_for(id),
        source: source.to_string(),
    }
}

fn search_sayobot(query: &str, limit: u32) -> Result<Vec<OsuBeatmapset>, String> {
    let mut url =
        url::Url::parse("https://api.sayobot.cn/beatmaplist").map_err(|e| e.to_string())?;
    let n = (limit.saturating_mul(2)).max(20).to_string();
    url.query_pairs_mut()
        .append_pair("0", &n)
        .append_pair("1", "0")
        .append_pair("2", "4")
        .append_pair("3", query);
    let val = get_json(
        url.as_str(),
        "https://sayobot.cn/",
        OSU_DL_UA,
        SEARCH_TIMEOUT,
    )?;
    let arr = val
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(arr.iter().filter_map(map_sayobot).collect())
}

fn search_official(query: &str, limit: u32) -> Result<Vec<OsuBeatmapset>, String> {
    let mut url =
        url::Url::parse("https://osu.ppy.sh/beatmapsets/search").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("q", query);
    let val = get_json(
        url.as_str(),
        "https://osu.ppy.sh/beatmapsets",
        UA,
        SEARCH_TIMEOUT,
    )?;
    let arr = val
        .get("beatmapsets")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(map_official)
        .take((limit.saturating_mul(2)) as usize)
        .collect())
}

fn search_catboy(query: &str, limit: u32) -> Result<Vec<OsuBeatmapset>, String> {
    let mut url = url::Url::parse("https://catboy.best/api/search").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("q", query);
    let val = get_json(url.as_str(), "https://catboy.best/", UA, SEARCH_TIMEOUT)?;
    let arr = val.as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(map_catboy)
        .take((limit.saturating_mul(2)) as usize)
        .collect())
}

/// 直接按 ID 取谱面集信息（Sayobot 的 beatmapinfo；失败则构造最小结果，不阻断下载）
fn fetch_beatmapset_by_id(id: &str) -> OsuBeatmapset {
    let found = url::Url::parse("https://api.sayobot.cn/v2/beatmapinfo")
        .ok()
        .and_then(|mut u| {
            u.query_pairs_mut().append_pair("K", id);
            get_json(u.as_str(), "https://sayobot.cn/", OSU_DL_UA, SEARCH_TIMEOUT).ok()
        })
        .and_then(|v| v.get("data").cloned())
        .and_then(|d| map_sayobot(&d));
    match found {
        Some(mut item) => {
            item.id = id.to_string();
            item.source = "direct".to_string();
            item.page_url = page_url_for(id);
            item
        }
        None => fallback_beatmapset(id),
    }
}

fn fallback_beatmapset(id: &str) -> OsuBeatmapset {
    OsuBeatmapset {
        id: id.to_string(),
        title: format!("osu! beatmapset {id}"),
        artist: String::new(),
        song_title: String::new(),
        uploader: None,
        cover_url: Some(proxy_cover(&fallback_cover_for(id))),
        page_url: page_url_for(id),
        source: "direct".to_string(),
    }
}

fn normalize_search_text(value: &str) -> String {
    let lowered = value.to_ascii_lowercase();
    let cleaned: String = lowered
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect();
    // CJK 字符不会被 `to_ascii_lowercase` 影响，原样保留
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn score_result(query_norm: &str, terms: &[String], item: &OsuBeatmapset) -> Option<i64> {
    let haystack = normalize_search_text(&format!(
        "{} {}",
        item.title,
        item.uploader.clone().unwrap_or_default()
    ));
    if !terms.iter().all(|t| haystack.contains(t.as_str())) {
        return None;
    }
    let artist = normalize_search_text(&item.artist);
    let title = normalize_search_text(&item.song_title);
    let uploader = normalize_search_text(item.uploader.as_deref().unwrap_or(""));
    let mut score = 0i64;
    if !uploader.is_empty() && uploader == query_norm {
        score += 100;
    }
    if !artist.is_empty() && artist == query_norm {
        score += 90;
    } else if artist.starts_with(query_norm) {
        score += 65;
    }
    if !title.is_empty() && title == query_norm {
        score += 70;
    } else if title.starts_with(query_norm) {
        score += 50;
    }
    if haystack.contains(query_norm) {
        score += 20;
    }
    Some(score)
}

fn select_results(query: &str, items: Vec<OsuBeatmapset>, limit: u32) -> Vec<OsuBeatmapset> {
    let query_norm = normalize_search_text(query);
    let terms: Vec<String> = query_norm
        .split(' ')
        .filter(|t| !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()))
        .map(|t| t.to_string())
        .collect();

    let mut scored: Vec<(i64, usize, OsuBeatmapset)> = items
        .into_iter()
        .enumerate()
        .filter_map(|(i, item)| {
            if terms.is_empty() {
                Some((0i64, i, item))
            } else {
                score_result(&query_norm, &terms, &item).map(|s| (s, i, item))
            }
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<OsuBeatmapset> = Vec::new();
    for (_, _, item) in scored {
        if seen.contains(&item.id) {
            continue;
        }
        seen.push(item.id.clone());
        out.push(item);
        if out.len() >= limit as usize {
            break;
        }
    }
    out
}

fn osu_search_blocking(query: String, limit: u32) -> Result<OsuSearchResult, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("请输入关键词 / 谱面链接 / 谱面集 ID".into());
    }
    let mut errors: Vec<String> = Vec::new();

    // 链接 / 纯数字 → 直接定位谱面集
    if let Some(id) = parse_beatmapset_id(&q) {
        return Ok(OsuSearchResult {
            items: vec![fetch_beatmapset_by_id(&id)],
            errors,
        });
    }

    let mut items: Vec<OsuBeatmapset> = Vec::new();
    let mut successful = 0u32;
    let searchers: [fn(&str, u32) -> Result<Vec<OsuBeatmapset>, String>; 3] =
        [search_sayobot, search_official, search_catboy];
    for searcher in searchers {
        match searcher(&q, limit) {
            Ok(mut v) => {
                successful += 1;
                items.append(&mut v);
            }
            Err(e) => errors.push(e),
        }
        let selected = select_results(&q, items.clone(), limit);
        if selected.len() >= limit as usize {
            return Ok(OsuSearchResult {
                items: selected,
                errors,
            });
        }
    }

    let selected = select_results(&q, items, limit);
    if selected.is_empty() && successful == 0 && !errors.is_empty() {
        return Err(format!("osu! 搜索失败：{}", errors.join(" | ")));
    }
    Ok(OsuSearchResult {
        items: selected,
        errors,
    })
}

// ---- 下载 ----

struct DownloadSource {
    mirror: &'static str,
    label: &'static str,
    url: String,
    referer: &'static str,
    ua: &'static str,
}

fn download_sources(id: &str, mirror: Option<&str>) -> Vec<DownloadSource> {
    let all = vec![
        DownloadSource {
            mirror: "official",
            label: "osu! 官方",
            url: format!("https://osu.ppy.sh/beatmapsets/{id}/download?noVideo=1"),
            referer: "https://osu.ppy.sh/",
            ua: UA,
        },
        DownloadSource {
            mirror: "sayobot",
            label: "Sayobot",
            url: format!("https://dl.sayobot.cn/beatmaps/download/novideo/{id}"),
            referer: "https://sayobot.cn/",
            ua: OSU_DL_UA,
        },
        DownloadSource {
            mirror: "catboy",
            label: "Catboy / Mino",
            url: format!("https://catboy.best/d/{id}"),
            referer: "https://catboy.best/",
            ua: UA,
        },
        DownloadSource {
            mirror: "nerinyan",
            label: "NeriNyan",
            url: format!("https://api.nerinyan.moe/d/{id}"),
            referer: "https://nerinyan.moe/",
            ua: OSU_DL_UA,
        },
    ];
    match mirror {
        Some(m) if matches!(m, "official" | "sayobot" | "catboy" | "nerinyan") => {
            all.into_iter().filter(|s| s.mirror == m).collect()
        }
        _ => all,
    }
}

fn download_archive(source: &DownloadSource, to: &Path) -> Result<(), String> {
    let mut resp = http_client()
        .get(&source.url)
        .header(reqwest::header::ACCEPT, OSU_ARCHIVE_ACCEPT)
        .header(reqwest::header::REFERER, source.referer)
        .header(reqwest::header::USER_AGENT, source.ua)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("text/html") || content_type.contains("application/json") {
        return Err(format!("返回了非压缩包内容（{content_type}）"));
    }
    {
        let mut file = std::fs::File::create(to).map_err(|e| format!("创建临时文件失败：{e}"))?;
        std::io::copy(&mut resp, &mut file).map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.flush().map_err(|e| format!("写入临时文件失败：{e}"))?;
    }
    // 校验 zip 魔数（PK\x03\x04 / PK\x05\x06 空归档）
    let mut head = [0u8; 2];
    let mut f = std::fs::File::open(to).map_err(|e| format!("读取临时文件失败：{e}"))?;
    f.seek(SeekFrom::Start(0))
        .map_err(|e| format!("读取临时文件失败：{e}"))?;
    let n = f
        .read(&mut head)
        .map_err(|e| format!("读取临时文件失败：{e}"))?;
    if n < 2 || head != [b'P', b'K'] {
        return Err("下载内容不是 zip/.osz".into());
    }
    Ok(())
}

// ---- .osz 归档解析 ----

#[derive(Default)]
struct OsuArchiveMetadata {
    audio_filename: Option<String>,
    cover_filename: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    creator: Option<String>,
    version: Option<String>,
    beatmap_id: Option<String>,
    beatmap_set_id: Option<String>,
    bpm: Option<f64>,
}

const AUDIO_EXTS: &[&str] = &["mp3", "ogg", "wav", "m4a", "flac", "aac", "opus"];
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// 解析 `.osu` 的 CSV 行（支持双引号包裹与 `""` 转义）
fn parse_osu_csv_line(line: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            if quoted && chars.get(i + 1) == Some(&'"') {
                current.push('"');
                i += 1;
            } else {
                quoted = !quoted;
            }
        } else if c == ',' && !quoted {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
        i += 1;
    }
    parts.push(current);
    parts
}

fn parse_osu_background(line: &str) -> Option<String> {
    let parts = parse_osu_csv_line(line);
    let kind = parts.first()?.trim().to_ascii_lowercase();
    if kind != "0" && kind != "background" {
        return None;
    }
    let filename = parts.get(2)?.trim();
    if filename.is_empty() {
        return None;
    }
    if COVER_EXTS.contains(&ext_lower(filename).as_str()) {
        Some(filename.to_string())
    } else {
        None
    }
}

fn parse_osu_timing_bpm(line: &str) -> Option<f64> {
    let parts = parse_osu_csv_line(line);
    let beat_length: f64 = parts.get(1)?.trim().parse().ok()?;
    if !beat_length.is_finite() || beat_length <= 0.0 {
        return None;
    }
    if let Some(uninherited) = parts.get(6) {
        let t = uninherited.trim();
        if !t.is_empty() && t != "1" {
            return None;
        }
    }
    let bpm = 60000.0 / beat_length;
    if bpm.is_finite() && bpm > 0.0 && bpm <= 400.0 {
        Some((bpm * 100.0).round() / 100.0)
    } else {
        None
    }
}

fn parse_osu_file(content: &str) -> OsuArchiveMetadata {
    let mut meta = OsuArchiveMetadata::default();
    let mut section = String::new();
    for raw_line in content.split(['\r', '\n']) {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') && line.len() > 2 {
            section = line[1..line.len() - 1].trim().to_ascii_lowercase();
            continue;
        }
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if section == "events" && meta.cover_filename.is_none() {
            if let Some(name) = parse_osu_background(line) {
                meta.cover_filename = Some(name);
            }
            continue;
        }
        if section == "timingpoints" && meta.bpm.is_none() {
            meta.bpm = parse_osu_timing_bpm(line);
            continue;
        }
        let Some(idx) = line.find(':') else { continue };
        if idx == 0 {
            continue;
        }
        let key = line[..idx].trim().to_string();
        let value = line[idx + 1..].trim().to_string();
        if value.is_empty() {
            continue;
        }
        if section == "general" && key == "AudioFilename" {
            meta.audio_filename = Some(value);
        } else if section == "metadata" {
            match key.as_str() {
                "TitleUnicode" => meta.title = Some(value),
                "Title" => {
                    if meta.title.is_none() {
                        meta.title = Some(value);
                    }
                }
                "ArtistUnicode" => meta.artist = Some(value),
                "Artist" => {
                    if meta.artist.is_none() {
                        meta.artist = Some(value);
                    }
                }
                "Creator" => meta.creator = Some(value),
                "Version" => meta.version = Some(value),
                "BeatmapID" => {
                    let t = value.trim();
                    if t.chars().all(|c| c.is_ascii_digit()) && t != "0" {
                        meta.beatmap_id = Some(t.to_string());
                    }
                }
                "BeatmapSetID" => {
                    let t = value.trim();
                    if t.chars().all(|c| c.is_ascii_digit()) && t != "0" {
                        meta.beatmap_set_id = Some(t.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    meta
}

fn decode_osu_text(bytes: &[u8]) -> String {
    // .osu 一律 UTF-8；带 BOM 时去掉
    let raw = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    };
    String::from_utf8_lossy(raw).to_string()
}

fn pick_audio_index(entries: &[(String, Vec<u8>)], audio_filename: Option<&str>) -> Option<usize> {
    let candidates: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| AUDIO_EXTS.contains(&ext_lower(&entry.0).as_str()))
        .map(|(i, _)| i)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    if let Some(want) = audio_filename.map(normalize_archive_path) {
        let suffix = format!("/{want}");
        if let Some(&i) = candidates.iter().find(|&&i| {
            let n = normalize_archive_path(&entries[i].0);
            n == want || n.ends_with(&suffix)
        }) {
            return Some(i);
        }
    }
    // 兜底：取体积最大的音频项（.osu 里常混有多个 preview/短音）
    candidates.into_iter().max_by_key(|&i| entries[i].1.len())
}

fn pick_cover_index(entries: &[(String, Vec<u8>)], cover_filename: Option<&str>) -> Option<usize> {
    let candidates: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| COVER_EXTS.contains(&ext_lower(&entry.0).as_str()))
        .map(|(i, _)| i)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    if let Some(want) = cover_filename.map(normalize_archive_path) {
        let suffix = format!("/{want}");
        if let Some(&i) = candidates.iter().find(|&&i| {
            let n = normalize_archive_path(&entries[i].0);
            n == want || n.ends_with(&suffix)
        }) {
            return Some(i);
        }
    }
    candidates.into_iter().max_by_key(|&i| entries[i].1.len())
}

fn to_jpeg_cover(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut buf = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut buf, image::ImageFormat::Jpeg).ok()?;
    Some(buf.into_inner())
}

/// 用 ffmpeg 把非 mp3 音频转成 mp3（`-q:a 0` 最高质量 VBR）
fn run_ffmpeg_to_mp3(input: &Path, output: &Path) -> Result<(), String> {
    let status = crate::commands::ffmpeg::resolve();
    let Some(ffmpeg) = status.ffmpeg_path else {
        return Err("该谱面音频不是 mp3，需要 ffmpeg 转码；请在设置中指定 ffmpeg 路径".into());
    };
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(&ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(input)
        .args(["-vn", "-codec:a", "libmp3lame", "-q:a", "0"])
        .arg(output)
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.trim().chars().take(300).collect();
        return Err(format!("ffmpeg 转码失败：{tail}"));
    }
    Ok(())
}

/// 写入 ID3v2 标签：标题 / 艺术家 / 注释（含谱面集 ID 与 BPM）/ 封面。
/// best-effort——失败只记录日志，不影响已落盘音频与入库。
fn write_tags(
    path: &Path,
    meta: &OsuArchiveMetadata,
    beatmapset_id: &str,
    cover_jpeg: Option<&[u8]>,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::tag::{Accessor, Tag, TagExt, TagType};

    let title = meta
        .title
        .clone()
        .unwrap_or_else(|| format!("osu! beatmapset {beatmapset_id}"));
    let artist = meta
        .artist
        .clone()
        .unwrap_or_else(|| "Unknown Artist".to_string());

    let mut comment = match meta.beatmap_id.as_deref() {
        Some(bid) => format!("beatmap id: {bid}"),
        None => format!("beatmapset id: {beatmapset_id}"),
    };
    if let Some(bpm) = meta.bpm {
        comment.push_str(&format!(" · BPM {}", parse_bpm_string(bpm)));
    }
    if let Some(v) = meta.version.as_deref().filter(|s| !s.is_empty()) {
        comment.push_str(&format!(" · {v}"));
    }
    if let Some(c) = meta.creator.as_deref().filter(|s| !s.is_empty()) {
        comment.push_str(&format!(" · mapped by {c}"));
    }

    let mut tag = Tag::new(TagType::Id3v2);
    tag.set_title(title);
    tag.set_artist(artist);
    tag.set_comment(comment);
    if let Some(cover) = cover_jpeg {
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            cover.to_vec(),
        ));
    }
    tag.save_to_path(path, WriteOptions::new())
        .map_err(|e| format!("写入 ID3 标签失败：{e}"))
}

fn resolve_out_dir(app: &silvermoon_ipc::Host, out_dir: Option<String>) -> Result<PathBuf, String> {
    let dir = match out_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(s) => PathBuf::from(s),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法定位应用数据目录：{e}"))?
            .join("osu"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建输出目录失败：{e}"))?;
    Ok(dir)
}

/// 核心：解压 → 解析 → 转码 → 写标签 → 入库。返回入库后的文件 ID。
fn import_archive(
    app: &silvermoon_ipc::Host,
    archive_path: &Path,
    out_dir: &Path,
    hint_beatmapset_id: Option<&str>,
) -> Result<OsuImportResult, String> {
    let _guard = IMPORT_LOCK.lock().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("创建输出目录失败：{e}"))?;

    let file = std::fs::File::open(archive_path).map_err(|e| format!("打开 .osz 失败：{e}"))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("读取 .osz（zip）失败：{e}"))?;

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
            entries.push((name, buf));
        }
    }
    drop(zip);

    if entries.is_empty() {
        return Err(".osz 内没有任何文件".into());
    }

    // 选一个带 AudioFilename 的 .osu（多个难度共存时取第一个有效项）
    let mut chosen: Option<OsuArchiveMetadata> = None;
    for (name, data) in &entries {
        if !name.to_ascii_lowercase().ends_with(".osu") {
            continue;
        }
        let parsed = parse_osu_file(&decode_osu_text(data));
        let has_audio = parsed.audio_filename.is_some();
        if chosen.is_none() || has_audio {
            chosen = Some(parsed);
        }
        if has_audio {
            break;
        }
    }
    let Some(meta) = chosen else {
        return Err(".osz 内没有 .osu 谱面文件".into());
    };

    let beatmapset_id = hint_beatmapset_id
        .map(|s| s.to_string())
        .or_else(|| meta.beatmap_set_id.clone())
        .unwrap_or_default();

    let audio_index = pick_audio_index(&entries, meta.audio_filename.as_deref())
        .ok_or_else(|| "该谱面归档里没有受支持的音频文件".to_string())?;
    let cover_index = pick_cover_index(&entries, meta.cover_filename.as_deref());

    let title = meta.title.clone().unwrap_or_default();
    let artist = meta.artist.clone().unwrap_or_default();
    let stem = if title.trim().is_empty() {
        format!("osu! beatmapset {beatmapset_id}")
    } else if artist.trim().is_empty() || artist.eq_ignore_ascii_case("unknown artist") {
        title.trim().to_string()
    } else {
        format!("{} - {}", artist.trim(), title.trim())
    };
    let out_path = unique_output_path(out_dir, &format!("{}.mp3", sanitize_file_part(&stem)));

    // 音频落盘
    let (audio_name, audio_bytes) = &entries[audio_index];
    let audio_ext = ext_lower(audio_name);
    if audio_ext == "mp3" {
        std::fs::write(&out_path, audio_bytes).map_err(|e| format!("写入音频失败：{e}"))?;
    } else {
        let tmp_dir = std::env::temp_dir().join(format!("silvermoon-osu-src-{}", now_ms()));
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
        let src_ext = if audio_ext.is_empty() {
            "audio".to_string()
        } else {
            audio_ext
        };
        let tmp_in = tmp_dir.join(format!("source.{src_ext}"));
        let write_res =
            std::fs::write(&tmp_in, audio_bytes).map_err(|e| format!("写入音频失败：{e}"));
        let convert_res = write_res.and_then(|_| run_ffmpeg_to_mp3(&tmp_in, &out_path));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        convert_res?;
    }

    // 封面（统一转 JPEG 再内嵌，规避 APIC 的 mime 兼容问题）
    let cover_jpeg = cover_index.and_then(|i| to_jpeg_cover(&entries[i].1));
    if let Err(e) = write_tags(&out_path, &meta, &beatmapset_id, cover_jpeg.as_deref()) {
        eprintln!("[osu] {e}");
    }

    // 入库：写 files + media_metadata（id 与扫描器一致，用路径 xxh3）
    let path_str = out_path.to_string_lossy().to_string();
    let md = std::fs::metadata(&out_path).map_err(|e| format!("读取输出文件信息失败：{e}"))?;
    let size = md.len() as i64;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let file_id = xxh3_hex(&path_str);
    let file_name = out_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = out_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let scanned_at = now_secs();

    {
        let state = app.state::<DbState>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO files (id, path, parent, name, ext, type, size, mtime, scanned_at, parsed_at, deleted)
             VALUES (?1, ?2, ?3, ?4, 'mp3', 'audio', ?5, ?6, ?7, ?7, 0)
             ON CONFLICT(id) DO UPDATE SET
               path=excluded.path, parent=excluded.parent, name=excluded.name,
               ext=excluded.ext, type=excluded.type, size=excluded.size,
               mtime=excluded.mtime, scanned_at=excluded.scanned_at,
               parsed_at=excluded.parsed_at, deleted=0",
            rusqlite::params![file_id, path_str, parent, file_name, size, mtime, scanned_at],
        )
        .map_err(|e| format!("写入索引失败：{e}"))?;

        let meta_row = metadata::extract(&path_str, &file_id, "audio");
        metadata::save(&conn, &meta_row).map_err(|e| format!("写入元数据失败：{e}"))?;
    }

    Ok(OsuImportResult {
        file_id,
        path: path_str,
        title: if title.trim().is_empty() {
            format!("osu! beatmapset {beatmapset_id}")
        } else {
            title
        },
        artist,
        beatmapset_id,
    })
}

fn osu_download_blocking(
    app: &silvermoon_ipc::Host,
    raw_id: String,
    mirror: Option<String>,
    out_dir: Option<String>,
) -> Result<OsuImportResult, String> {
    let id = parse_beatmapset_id(&raw_id).ok_or_else(|| {
        "无效的谱面集 ID / 链接（示例：1234567 或 https://osu.ppy.sh/beatmapsets/1234567）"
            .to_string()
    })?;
    let out = resolve_out_dir(app, out_dir)?;

    emit_progress(app, &id, "downloading", "正在下载 .osz", 3.0);

    let sources = download_sources(&id, mirror.as_deref());
    let tmp = std::env::temp_dir().join(format!("silvermoon-osu-{id}-{}.osz", now_ms()));
    let mut errors: Vec<String> = Vec::new();
    let mut downloaded = false;
    for source in &sources {
        match download_archive(source, &tmp) {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(e) => {
                errors.push(format!("{}：{e}", source.label));
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
    if !downloaded {
        let msg = format!(
            "osu! 谱面下载失败（{} 个镜像均失败）：{}",
            sources.len(),
            errors.join(" | ")
        );
        emit_progress(app, &id, "error", &msg, 0.0);
        return Err(msg);
    }

    emit_progress(app, &id, "extracting", "解压并解析谱面", 65.0);
    let result = import_archive(app, &tmp, &out, Some(id.as_str()));
    let _ = std::fs::remove_file(&tmp);
    match result {
        Ok(r) => {
            emit_progress(app, &id, "done", "导入完成", 100.0);
            Ok(r)
        }
        Err(e) => {
            emit_progress(app, &id, "error", &e, 0.0);
            Err(e)
        }
    }
}

// ---- 命令 ----

/// 搜索谱面集：关键词 / `osu.ppy.sh/beatmapsets/<id>` 链接 / 纯数字 ID
#[silvermoon_ipc::command]
pub async fn osu_search(query: String, limit: Option<u32>) -> Result<OsuSearchResult, String> {
    let lim = limit.unwrap_or(20).clamp(1, 50);
    tokio::task::spawn_blocking(move || osu_search_blocking(query, lim))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 按谱面集 ID 下载 `.osz` 并导入曲库（异步；进度经 `osu:progress` 事件回推）
#[silvermoon_ipc::command]
pub async fn osu_download(
    app: silvermoon_ipc::Host,
    beatmapset_id: String,
    mirror: Option<String>,
    out_dir: Option<String>,
) -> Result<OsuImportResult, String> {
    tokio::task::spawn_blocking(move || osu_download_blocking(&app, beatmapset_id, mirror, out_dir))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 导入本地 `.osz` 文件
#[silvermoon_ipc::command]
pub async fn osu_import_archive(
    app: silvermoon_ipc::Host,
    archive_path: String,
    out_dir: Option<String>,
) -> Result<OsuImportResult, String> {
    tokio::task::spawn_blocking(move || {
        let out = resolve_out_dir(&app, out_dir)?;
        emit_progress(&app, "", "extracting", "解压并解析 .osz", 50.0);
        let result = import_archive(&app, Path::new(&archive_path), &out, None)?;
        emit_progress(&app, &result.beatmapset_id, "done", "导入完成", 100.0);
        Ok(result)
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 远端封面换成走本地代理的 URL（补 Referer，绕开 assets.ppy.sh 的防盗链）
#[silvermoon_ipc::command]
pub fn osu_cover_url(raw_url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&raw_url).map_err(|_| "封面 URL 无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http/https 封面".into());
    }
    Ok(proxy_cover(&raw_url))
}
