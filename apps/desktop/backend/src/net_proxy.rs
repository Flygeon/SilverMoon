//! 全局网络代理配置（设置 → 网络）。
//!
//! ## 为什么 Rust 侧也要单独存一份
//!
//! Electron 的 `session.setProxy` 只影响 Chromium 网络栈（远程图片、<video>、
//! webview），而番剧 / Bangumi 的抓取走本进程的 `reqwest`。两套网络栈互不相通，
//! 用户选「自定义代理」时必须显式告诉 reqwest，否则抓取依旧直连 —— 表现就是
//! 「浏览器里代理开着，应用里番剧页还是超时」。
//!
//! ## 三种模式
//!
//! - `system`（默认）：交给 reqwest 自带的系统代理探测（环境变量 / Windows 注册表）；
//! - `custom`：所有请求走用户填写的 HTTP(S) 代理；
//! - `none`：强制直连（`.no_proxy()`），用于「代理软件只给浏览器用」的场景。
//!
//! 配置变化不需要重启：`anime.rs` 按 [`NetworkProxy::key`] 缓存客户端，
//! 键变化时自动重建 reqwest `Client`。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 代理模式与地址。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkProxy {
    /// system / custom / none
    pub mode: String,
    /// custom 模式下必填，如 `http://127.0.0.1:7890`
    pub url: String,
}

impl NetworkProxy {
    /// 用作 reqwest 客户端缓存的键：模式或地址变化就要重建客户端。
    pub fn key(&self) -> String {
        format!("{}|{}", self.mode, self.url)
    }
}

static PROXY: OnceLock<Mutex<NetworkProxy>> = OnceLock::new();

fn proxy_state() -> &'static Mutex<NetworkProxy> {
    PROXY.get_or_init(|| {
        Mutex::new(NetworkProxy {
            mode: "system".to_string(),
            url: String::new(),
        })
    })
}

/// 当前代理配置（锁中毒时退回默认值，不能让网络设置把整个后端拖死）。
pub fn current() -> NetworkProxy {
    proxy_state()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// 把当前配置应用到 reqwest 客户端构造器。
pub fn apply(builder: reqwest::blocking::ClientBuilder) -> reqwest::blocking::ClientBuilder {
    let cfg = current();
    match cfg.mode.as_str() {
        "none" => builder.no_proxy(),
        "custom" if !cfg.url.trim().is_empty() => match reqwest::Proxy::all(cfg.url.trim()) {
            Ok(proxy) => builder.proxy(proxy),
            // 地址非法时不要整条网络断掉：退回系统代理，前端设置页会提示格式问题
            Err(_) => builder,
        },
        // system / 其它未知值：保持 reqwest 默认的系统代理探测
        _ => builder,
    }
}

/// 设置网络代理（设置页修改后由宿主调用）。
#[silvermoon_ipc::command]
pub fn net_set_proxy(mode: String, url: Option<String>) -> Result<(), String> {
    let mode = match mode.as_str() {
        "system" | "custom" | "none" => mode,
        other => return Err(format!("不支持的代理模式：{other}")),
    };
    let url = url.unwrap_or_default().trim().to_string();
    if mode == "custom" && url.is_empty() {
        return Err("自定义代理缺少地址".to_string());
    }
    let mut guard = proxy_state().lock().map_err(|e| e.to_string())?;
    *guard = NetworkProxy { mode, url };
    Ok(())
}

/// 按当前代理配置构建 / 复用 reqwest 客户端。
///
/// `tag` 区分不同模块的客户端（超时、连接池等构造参数不同，不能混用）；
/// 代理配置一旦变化就整体清空缓存，下一次调用会按新配置重建。
pub fn client(
    tag: &'static str,
    builder: reqwest::blocking::ClientBuilder,
) -> reqwest::blocking::Client {
    static CACHE: OnceLock<Mutex<(String, HashMap<&'static str, reqwest::blocking::Client>)>> =
        OnceLock::new();
    let proxy_key = current().key();
    let cache = CACHE.get_or_init(|| Mutex::new((String::new(), HashMap::new())));
    // 锁中毒也继续：网络设置不值得让整个后端不可用
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if guard.0 != proxy_key {
        guard.0 = proxy_key;
        guard.1.clear();
    }
    if let Some(client) = guard.1.get(tag) {
        return client.clone();
    }
    let client = apply(builder).build().expect("reqwest client");
    guard.1.insert(tag, client.clone());
    client
}
