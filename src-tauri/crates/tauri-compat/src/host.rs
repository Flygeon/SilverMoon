//! 反向通道：Rust → Electron 宿主机。
//!
//! 兼容层里那些「本质上是宿主能力」的操作（建/查/操作 webview、托盘、全局热键、
//! 系统默认程序打开）都要落到 Electron 主进程执行。宿主在启动 sidecar 前会先监听
//! 一个本地端口，并把 `SILVERMOON_HOST_PORT` / `SILVERMOON_HOST_TOKEN` 通过环境变量传进来。
//!
//! 这里刻意**不引入 reqwest**：本机回环、载荷都是小 JSON，手写一个只支持
//! `POST` + `Connection: close` 的极简客户端更省依赖，也避免 `reqwest::blocking`
//! 与 tokio 运行时的上下文冲突。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::app::AppInner;

/// 宿主机支持的操作用名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOp {
    /// 列出宿主已知的窗口 label
    WindowList,
    /// 查窗口是否存在
    WebviewExists,
    /// 创建窗口
    WebviewCreate,
    /// 在窗口中执行脚本并取回结果
    WebviewEval,
    /// 导航
    WebviewNavigate,
    /// 显示 / 取消最小化 / 置前
    WebviewShow,
    /// 关闭
    WebviewClose,
    /// 取可见性
    WebviewIsVisible,
    /// 打开开发者工具
    WebviewOpenDevtools,
    /// 读取该窗口 session 的全部 cookie（含 httpOnly）
    WebviewCookies,
    /// 设置窗口位置 / 尺寸
    WebviewSetBounds,
    /// 设置窗口的不透明度相关的置顶属性
    WebviewSetAlwaysOnTop,
    /// 设置鼠标穿透
    WebviewSetIgnoreCursorEvents,
    /// 创建系统托盘
    TrayCreate,
    /// 设置托盘可见性
    TraySetVisible,
    /// 退出应用
    AppExit,
    /// 注册全局热键
    ShortcutRegister,
    /// 注销全局热键
    ShortcutUnregister,
    /// 用系统默认程序打开文件 / URL
    OpenerOpenPath,
    /// 在文件管理器中定位
    OpenerReveal,
}

impl HostOp {
    pub fn as_str(self) -> &'static str {
        match self {
            HostOp::WindowList => "window.list",
            HostOp::WebviewExists => "webview.exists",
            HostOp::WebviewCreate => "webview.create",
            HostOp::WebviewEval => "webview.eval",
            HostOp::WebviewNavigate => "webview.navigate",
            HostOp::WebviewShow => "webview.show",
            HostOp::WebviewClose => "webview.close",
            HostOp::WebviewIsVisible => "webview.isVisible",
            HostOp::WebviewOpenDevtools => "webview.openDevtools",
            HostOp::WebviewCookies => "webview.cookies",
            HostOp::WebviewSetBounds => "webview.setBounds",
            HostOp::WebviewSetAlwaysOnTop => "webview.setAlwaysOnTop",
            HostOp::WebviewSetIgnoreCursorEvents => "webview.setIgnoreCursorEvents",
            HostOp::TrayCreate => "tray.create",
            HostOp::TraySetVisible => "tray.setVisible",
            HostOp::AppExit => "app.exit",
            HostOp::ShortcutRegister => "shortcut.register",
            HostOp::ShortcutUnregister => "shortcut.unregister",
            HostOp::OpenerOpenPath => "opener.openPath",
            HostOp::OpenerReveal => "opener.reveal",
        }
    }
}

struct HostConfig {
    port: u16,
    token: String,
}

fn config() -> Option<&'static HostConfig> {
    static CFG: OnceLock<Option<HostConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let port = std::env::var("SILVERMOON_HOST_PORT")
            .ok()?
            .trim()
            .parse::<u16>()
            .ok()?;
        let token = std::env::var("SILVERMOON_HOST_TOKEN").unwrap_or_default();
        Some(HostConfig { port, token })
    })
    .as_ref()
}

/// 宿主是否可用（不可用时相关功能静默降级）。
pub fn available() -> bool {
    config().is_some()
}

/// 发起一次宿主调用。返回 `Some(data)` 表示成功；`None` 表示宿主不可达或拒绝。
pub fn op(_inner: &Arc<AppInner>, op: HostOp, args: Value) -> Option<Value> {
    let cfg = config()?;
    let body = serde_json::json!({ "op": op.as_str(), "args": args }).to_string();
    let raw = match post(cfg, &body) {
        Some(raw) => raw,
        None => {
            if std::env::var_os("SILVERMOON_HOST_DEBUG").is_some() {
                eprintln!("[silvermoon] 宿主调用失败：{}", op.as_str());
            }
            return None;
        }
    };
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Some(parsed.get("data").cloned().unwrap_or(Value::Null))
    } else {
        let err = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("宿主返回未知错误");
        eprintln!("[silvermoon] {} 失败：{err}", op.as_str());
        None
    }
}

// ---------------------------------------------------------------------------
// 极简 HTTP 客户端
// ---------------------------------------------------------------------------

fn post(cfg: &HostConfig, body: &str) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    stream.set_nodelay(true).ok()?;

    let request = format!(
        "POST /rpc HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         X-SilverMoon-Token: {token}\r\n\
         Connection: close\r\n\
         \r\n{body}",
        port = cfg.port,
        len = body.as_bytes().len(),
        token = cfg.token,
        body = body,
    );
    stream.write_all(request.as_bytes()).ok()?;
    stream.flush().ok()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    decode_body(&raw)
}

/// 从原始 HTTP 响应里取出 body，兼容 `Content-Length` 与 `Transfer-Encoding: chunked`。
fn decode_body(raw: &[u8]) -> Option<String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let body = &raw[split + 4..];

    if head.contains("transfer-encoding: chunked") {
        return decode_chunked(body);
    }
    Some(String::from_utf8_lossy(body).into_owned())
}

fn decode_chunked(mut body: &[u8]) -> Option<String> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        let nl = body.windows(2).position(|w| w == b"\r\n")?;
        let size_line = String::from_utf8_lossy(&body[..nl]);
        let size_hex = size_line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_hex, 16).ok()?;
        if size == 0 {
            break;
        }
        let start = nl + 2;
        let end = start.checked_add(size)?;
        out.extend_from_slice(body.get(start..end)?);
        body = body.get(end + 2..)?; // 跳过 chunk 末尾的 CRLF
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_content_length_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
        assert_eq!(decode_body(raw).as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn decodes_chunked_body() {
        let raw =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n";
        assert_eq!(decode_body(raw).as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn op_names_are_stable() {
        assert_eq!(HostOp::WebviewEval.as_str(), "webview.eval");
        assert_eq!(HostOp::TrayCreate.as_str(), "tray.create");
    }
}
