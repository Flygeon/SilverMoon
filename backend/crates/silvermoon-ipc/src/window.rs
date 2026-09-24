//! 窗口层：`Window` / `WindowBuilder` / `WindowUrl` / `Cookie`。
//!
//! 窗口实体全部由 Electron 宿主机持有（`BrowserWindow`），这里只是按 label
//! 定向的句柄，方法一律转发给宿主机。
//!
//! # `on_navigation` 的拦截时机
//!
//! 直觉上 `on_navigation` 应该能同步拒绝一次导航，但 Electron 主进程无法同步地
//! Electron 的 `will-navigate` 虽然也是同步事件，但主进程无法同步地跨进程问 Rust
//! 「这次该不该放行」。因此实现改成：
//!
//! 1. 宿主机照常放行导航，同时把 URL 异步回传 Rust；
//! 2. Rust 侧回调返回 `false` 时，宿主机收到 `webview.blockNavigation`，
//!    执行 `webContents.stop()` 并回退到上一个已提交的 URL。
//!
//! 对现有唯一的调用点（pixiv 登录拦截回调 URL）效果一致：回调 URL 不会停留在窗口里。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use url::Url;

use crate::app::{AppInner, Error, Host, Result};
use crate::host::{self, HostOp};

/// 导航拦截回调表（label → 回调）。
pub type NavigationGuard = Arc<dyn Fn(&Url) -> bool + Send + Sync>;

/// 进程级回调表。`WindowBuilder::on_navigation` 注册，宿主回调时查询。
static NAVIGATION_GUARDS: Mutex<Option<HashMap<String, NavigationGuard>>> = Mutex::new(None);

fn with_guards<T>(f: impl FnOnce(&mut HashMap<String, NavigationGuard>) -> T) -> T {
    let mut guard = NAVIGATION_GUARDS
        .lock()
        .expect("navigation guards poisoned");
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// 宿主回调入口：某个窗口发生了导航，问 Rust 是否放行。
pub fn dispatch_navigation(label: &str, url: &str) -> bool {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return true,
    };
    let cb = with_guards(|map| map.get(label).cloned());
    match cb {
        Some(f) => f(&parsed),
        None => true,
    }
}

/// 宿主回调入口：托盘菜单项被点击。
pub fn dispatch_tray_menu(id: &str) {
    crate::tray::dispatch_menu_event(id);
}

/// 宿主回调入口：托盘图标被点击。
pub fn dispatch_tray_click(button: &str, state: &str) {
    crate::tray::dispatch_icon_event(button, state);
}

// ---------------------------------------------------------------------------
// WindowUrl
// ---------------------------------------------------------------------------

/// 等价 `silvermoon_ipc::WindowUrl`。只用到两个变体。
#[derive(Debug, Clone)]
pub enum WindowUrl {
    /// 外部网页
    External(Url),
    /// 应用自带页面（前端 dist 里的路径）
    App(PathBuf),
}

impl WindowUrl {
    fn to_payload(&self) -> Value {
        match self {
            WindowUrl::External(url) => json!({ "kind": "external", "url": url.as_str() }),
            WindowUrl::App(path) => json!({
                "kind": "app",
                "path": path.to_string_lossy().replace('\\', "/"),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/// 等价 `silvermoon_ipc::webview::Cookie` 的只读视图。
#[derive(Debug, Clone)]
pub struct Cookie {
    name: String,
    value: String,
}

impl Cookie {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Cookie {
            name: name.into(),
            value: value.into(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/// 等价 `silvermoon_ipc::Window`。`Clone + Send + Sync`，可跨线程持有。
#[derive(Clone)]
pub struct Window {
    inner: Arc<AppInner>,
    label: String,
}

impl Window {
    /// 把宿主已存在的窗口（或刚创建的窗口）纳管。
    pub(crate) fn adopt(inner: &Arc<AppInner>, label: &str) -> Self {
        Window {
            inner: Arc::clone(inner),
            label: label.to_string(),
        }
    }

    /// 窗口 label
    pub fn label(&self) -> &str {
        &self.label
    }

    fn call(&self, op: HostOp, args: Value) -> Result<Value> {
        let mut payload = json!({ "label": self.label });
        if let (Some(dst), Some(src)) = (payload.as_object_mut(), args.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        host::op(&self.inner, op, payload).ok_or_else(|| {
            Error::Window(format!(
                "宿主未响应 `{}`（label={}）",
                op.as_str(),
                self.label
            ))
        })
    }

    fn call_unit(&self, op: HostOp, args: Value) -> Result<()> {
        self.call(op, args).map(|_| ())
    }

    /// 单向执行脚本（不等待/不接收返回值）。为保证与后续 `navigate` 的先后顺序，
    /// 这里是同步等待宿主回执的。
    pub fn eval(&self, script: &str) -> Result<()> {
        self.call_unit(
            HostOp::WebviewEval,
            json!({ "script": script, "wantResult": false }),
        )
    }

    /// 执行脚本并回调结果（结果是 JS 值的 JSON 文本）。
    ///
    /// 回调类型是 `Fn`（可能被多次调用，只有第一次能拿到 oneshot 的 Sender），因此把闭包放进
    /// `Arc` 并允许重复触发。真正的取值在独立线程里完成，本方法立即返回，
    /// 不会阻塞调用方的 `async` 任务。
    pub fn eval_with_callback<F>(&self, script: &str, callback: F) -> Result<()>
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        let me = self.clone();
        let script = script.to_string();
        let callback = Arc::new(callback);
        std::thread::Builder::new()
            .name(format!("silvermoon-eval-{}", self.label))
            .spawn(move || {
                match me.call(
                    HostOp::WebviewEval,
                    json!({ "script": script, "wantResult": true }),
                ) {
                    Ok(value) => {
                        // 宿主把 JS 结果以 JSON 文本放在 `result` 字段里
                        let text = value
                            .get("result")
                            .and_then(Value::as_str)
                            .unwrap_or("null")
                            .to_string();
                        callback(text);
                    }
                    Err(e) => eprintln!("[silvermoon] eval_with_callback 失败：{e}"),
                }
            })
            .map_err(|e| Error::Window(e.to_string()))?;
        Ok(())
    }

    /// 导航
    pub fn navigate(&self, url: Url) -> Result<()> {
        self.call_unit(HostOp::WebviewNavigate, json!({ "url": url.as_str() }))
    }

    /// 让宿主机放弃当前导航并回退到上一个已提交地址（配合 `on_navigation` 返回 false）
    pub fn block_navigation(&self) -> Result<()> {
        self.call_unit(HostOp::WebviewNavigate, json!({ "block": true }))
    }

    /// 显示 + 取消最小化 + 置前
    pub fn show(&self) -> Result<()> {
        self.call_unit(HostOp::WebviewShow, json!({ "action": "show" }))
    }

    /// 取消最小化
    pub fn unminimize(&self) -> Result<()> {
        self.call_unit(HostOp::WebviewShow, json!({ "action": "unminimize" }))
    }

    /// 置前
    pub fn set_focus(&self) -> Result<()> {
        self.call_unit(HostOp::WebviewShow, json!({ "action": "focus" }))
    }

    /// 关闭窗口
    pub fn close(&self) -> Result<()> {
        self.call_unit(HostOp::WebviewClose, Value::Null)
    }

    /// 可见性
    pub fn is_visible(&self) -> Result<bool> {
        self.call(HostOp::WebviewIsVisible, Value::Null)
            .map(|v| v.as_bool().unwrap_or(false))
    }

    /// 打开开发者工具
    pub fn open_devtools(&self) {
        let _ = self.call_unit(HostOp::WebviewOpenDevtools, Value::Null);
    }

    /// 读取该窗口 session 的全量 cookie（含 httpOnly）
    pub fn cookies(&self) -> Result<Vec<Cookie>> {
        let value = self.call(HostOp::WebviewCookies, Value::Null)?;
        let list = value.as_array().cloned().unwrap_or_default();
        Ok(list
            .iter()
            .filter_map(|c| {
                let name = c.get("name")?.as_str()?.to_string();
                let value = c.get("value").and_then(Value::as_str)?.to_string();
                Some(Cookie { name, value })
            })
            .collect())
    }
}

// ---------------------------------------------------------------------------
// WindowBuilder
// ---------------------------------------------------------------------------

/// 等价 `silvermoon_ipc::WindowBuilder`。
pub struct WindowBuilder {
    label: String,
    url: WindowUrl,
    inner: Arc<AppInner>,
    visible: bool,
    title: Option<String>,
    user_agent: Option<String>,
    initialization_script: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    resizable: Option<bool>,
    decorations: Option<bool>,
    minimizable: Option<bool>,
    always_on_top: Option<bool>,
    center: bool,
    on_navigation: Option<NavigationGuard>,
}

impl WindowBuilder {
    /// 新建一个窗口 builder
    pub fn new(app: &Host, label: &str, url: WindowUrl) -> Self {
        WindowBuilder {
            label: label.to_string(),
            url,
            inner: Arc::clone(&app.inner),
            visible: true,
            title: None,
            user_agent: None,
            initialization_script: None,
            width: None,
            height: None,
            resizable: None,
            decorations: None,
            minimizable: None,
            always_on_top: None,
            center: false,
            on_navigation: None,
        }
    }

    /// 是否可见
    pub fn visible(mut self, visible: bool) -> Self {
        self.visible = visible;
        self
    }

    /// 窗口标题
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// User-Agent 覆盖
    pub fn user_agent(mut self, ua: impl Into<String>) -> Self {
        self.user_agent = Some(ua.into());
        self
    }

    /// 页面加载前注入的脚本
    pub fn initialization_script(mut self, script: impl Into<String>) -> Self {
        self.initialization_script = Some(script.into());
        self
    }

    /// 初始尺寸（逻辑像素）
    pub fn inner_size(mut self, width: f64, height: f64) -> Self {
        self.width = Some(width);
        self.height = Some(height);
        self
    }

    /// 是否可缩放
    pub fn resizable(mut self, resizable: bool) -> Self {
        self.resizable = Some(resizable);
        self
    }

    /// 是否显示系统标题栏
    pub fn decorations(mut self, decorations: bool) -> Self {
        self.decorations = Some(decorations);
        self
    }

    /// 是否可最小化
    pub fn minimizable(mut self, minimizable: bool) -> Self {
        self.minimizable = Some(minimizable);
        self
    }

    /// 是否置顶
    pub fn always_on_top(mut self, always_on_top: bool) -> Self {
        self.always_on_top = Some(always_on_top);
        self
    }

    /// 居中
    pub fn center(mut self) -> Self {
        self.center = true;
        self
    }

    /// 导航拦截回调
    pub fn on_navigation<F>(mut self, f: F) -> Self
    where
        F: Fn(&Url) -> bool + Send + Sync + 'static,
    {
        self.on_navigation = Some(Arc::new(f));
        self
    }

    /// 创建窗口（交给宿主机）。
    pub fn build(self) -> Result<Window> {
        let mut payload = json!({
            "label": self.label,
            "url": self.url.to_payload(),
            "visible": self.visible,
            "center": self.center,
        });
        if let Some(map) = payload.as_object_mut() {
            if let Some(v) = self.title {
                map.insert("title".into(), Value::String(v));
            }
            if let Some(v) = self.user_agent {
                map.insert("userAgent".into(), Value::String(v));
            }
            if let Some(v) = self.initialization_script {
                map.insert("initializationScript".into(), Value::String(v));
            }
            if let Some(v) = self.width {
                map.insert("width".into(), json!(v));
            }
            if let Some(v) = self.height {
                map.insert("height".into(), json!(v));
            }
            if let Some(v) = self.resizable {
                map.insert("resizable".into(), Value::Bool(v));
            }
            if let Some(v) = self.decorations {
                map.insert("decorations".into(), Value::Bool(v));
            }
            if let Some(v) = self.minimizable {
                map.insert("minimizable".into(), Value::Bool(v));
            }
            if let Some(v) = self.always_on_top {
                map.insert("alwaysOnTop".into(), Value::Bool(v));
            }
            // Rust 侧只关心「有没有 on_navigation」，决策在 Rust 完成，
            // 宿主机只需要知道要回传导航事件。
            map.insert(
                "watchNavigation".into(),
                Value::Bool(self.on_navigation.is_some()),
            );
        }

        if let Some(guard) = self.on_navigation {
            with_guards(|map| {
                map.insert(self.label.clone(), guard);
            });
        }

        host::op(&self.inner, HostOp::WebviewCreate, payload).ok_or_else(|| {
            Error::Window(format!("创建窗口失败（宿主未响应，label={}）", self.label))
        })?;

        let window = Window::adopt(&self.inner, &self.label);
        self.inner
            .windows
            .lock()
            .expect("windows poisoned")
            .insert(self.label.clone(), window.clone());
        Ok(window)
    }
}
