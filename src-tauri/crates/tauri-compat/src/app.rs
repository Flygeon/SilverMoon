//! 应用句柄 / 托管状态 / 事件广播 / Builder。
//!
//! 这层是整块兼容层的地基：业务代码里的 `app: tauri::AppHandle`、
//! `state: State<'_, DbState>`、`app.emit(..)`、`app.path().app_data_dir()`
//! 全部由这里提供具体实现。

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use serde::Serialize;
use serde_json::Value;

use crate::host::{self, HostOp};
use crate::private::CommandDef;
use crate::window::WebviewWindow;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/// 兼容 `tauri::Error`。业务代码只用到 [`Error::AssetNotFound`]，
/// 其余变体供兼容层内部使用。
#[derive(Debug)]
pub enum Error {
    /// 托盘图标等资源缺失（`tray.rs` 唯一用到的变体）
    AssetNotFound(String),
    /// 窗口不存在或宿主机拒绝操作
    Window(String),
    /// 状态未托管
    StateNotManaged(String),
    /// 宿主机（Electron）不可达
    Host(String),
    /// 其它
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::AssetNotFound(what) => write!(f, "资源不存在：{what}"),
            Error::Window(msg) => write!(f, "窗口错误：{msg}"),
            Error::StateNotManaged(msg) => write!(f, "状态未托管：{msg}"),
            Error::Host(msg) => write!(f, "宿主通信失败：{msg}"),
            Error::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Other(e.to_string())
    }
}

/// 等价 `tauri::Result`。
pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------------------
// 托管状态
// ---------------------------------------------------------------------------

/// 托管状态表。
///
/// # 为什么允许把引用延长到 `'static`
///
/// 业务代码里 `State<'_, T>` 会被捕获进 `async` 块（进而被装箱成 `'static`
/// future），所以命令层必须能拿到 `'static` 引用。这里依赖三条不变量：
///
/// 1. 状态表本体随 `AppInner` 一同被 `Box::leak`，生命周期等于进程；
/// 2. 值以 `Box<dyn Any>` 存放在堆上，`HashMap` 扩容只搬指针、不搬对象；
/// 3. `manage()` 只增不删，条目地址恒定。
///
/// 由第 2、3 点可知 `&T` 指向的堆对象在进程存活期间地址稳定，故延长生命周期成立。
pub struct StateMap(RwLock<HashMap<TypeId, Box<dyn Any + Send + Sync>>>);

impl Default for StateMap {
    fn default() -> Self {
        StateMap(RwLock::new(HashMap::new()))
    }
}

impl StateMap {
    fn insert<T: Send + Sync + 'static>(&self, value: T) {
        let mut guard = self.0.write().expect("state map poisoned");
        guard.insert(TypeId::of::<T>(), Box::new(value));
    }

    fn get_ref<T: Send + Sync + 'static>(&self) -> Option<&T> {
        let guard = self.0.read().expect("state map poisoned");
        let boxed = guard.get(&TypeId::of::<T>())?;
        // SAFETY: 见 `StateMap` 文档中的三条不变量。
        Some(unsafe { &*(boxed.as_ref() as *const T) })
    }
}

/// 等价 `tauri::State`：托管状态的只读借用。
pub struct State<'r, T: Send + Sync + 'static>(pub(crate) &'r T);

impl<T: Send + Sync + 'static> std::ops::Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}

impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        State(self.0)
    }
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/// 等价 `tauri::path::PathResolver`。只实现业务代码用到的两个目录。
pub struct PathResolver {
    data_dir: PathBuf,
    cache_dir: PathBuf,
}

impl PathResolver {
    /// 应用数据目录（`library.db` / settings / extensions / pixuv.json 等都落在这里）
    pub fn app_data_dir(&self) -> Result<PathBuf> {
        Ok(self.data_dir.clone())
    }

    /// 应用缓存目录（缩略图缓存落在其下的 `thumbs/`）
    pub fn app_cache_dir(&self) -> Result<PathBuf> {
        Ok(self.cache_dir.clone())
    }
}

/// 解析应用数据/缓存目录。
///
/// 宿主（Electron）通过 `SILVERMOON_DATA_DIR` / `SILVERMOON_CACHE_DIR` 显式指定，
/// 保证两侧指向同一份数据；独立运行（无宿主）时按平台惯例回退。
fn resolve_dirs(identifier: &str) -> (PathBuf, PathBuf) {
    let data = std::env::var_os("SILVERMOON_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| platform_data_dir(identifier));

    let cache = std::env::var_os("SILVERMOON_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| platform_cache_dir(identifier));

    (data, cache)
}

#[cfg(windows)]
fn platform_data_dir(identifier: &str) -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
}

#[cfg(windows)]
fn platform_cache_dir(identifier: &str) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
        .join("cache")
}

#[cfg(target_os = "macos")]
fn platform_data_dir(identifier: &str) -> PathBuf {
    home_subdir("Library/Application Support").join(identifier)
}

#[cfg(target_os = "macos")]
fn platform_cache_dir(identifier: &str) -> PathBuf {
    home_subdir("Library/Caches").join(identifier)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_data_dir(identifier: &str) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_subdir(".local/share"))
        .join(identifier)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_cache_dir(identifier: &str) -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_subdir(".cache"))
        .join(identifier)
}

#[cfg(not(windows))]
fn home_subdir(sub: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(sub)
}

// ---------------------------------------------------------------------------
// 事件总线
// ---------------------------------------------------------------------------

/// 事件总线：`emit` 出去的载荷经 SSE 推给宿主，由宿主再分发给各渲染窗口。
#[derive(Default)]
struct EventBus {
    tx: OnceLock<tokio::sync::broadcast::Sender<String>>,
}

impl EventBus {
    fn install(&self, tx: tokio::sync::broadcast::Sender<String>) {
        let _ = self.tx.set(tx);
    }

    fn publish(&self, event: &str, target: Option<&str>, payload: &Value) {
        let Some(tx) = self.tx.get() else {
            // 服务尚未起来（例如 setup 阶段就 emit）——丢弃即可，前端此刻还没订阅
            return;
        };
        let frame = serde_json::json!({
            "event": event,
            "target": target,
            "payload": payload,
        });
        let _ = tx.send(frame.to_string());
    }

    /// 订阅事件流（SSE 用）。服务未起来时返回一个立即挂起的接收端。
    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        match self.tx.get() {
            Some(tx) => tx.subscribe(),
            None => tokio::sync::broadcast::channel(1).1,
        }
    }
}

// ---------------------------------------------------------------------------
// 内部共享状态
// ---------------------------------------------------------------------------

/// 全应用共享状态。除 `Mutex` 保护的少数几项外皆只读。
pub struct AppInner {
    pub(crate) identifier: String,
    pub(crate) product_name: String,
    pub(crate) states: StateMap,
    pub(crate) events: EventBus,
    pub(crate) paths: PathResolver,
    pub(crate) windows: Mutex<HashMap<String, WebviewWindow>>,
    pub(crate) shortcuts: Mutex<Vec<crate::plugins::RegisteredShortcut>>,
    pub(crate) tray_ready: Mutex<bool>,
}

impl AppInner {
    /// 取托管状态引用；未托管则 panic（与 Tauri 行为一致）。
    pub(crate) fn state_ref<T: Send + Sync + 'static>(&self) -> &T {
        self.states.get_ref::<T>().unwrap_or_else(|| {
            panic!(
                "状态 `{}` 未托管：请在 setup 阶段调用 app.manage(..)",
                std::any::type_name::<T>()
            )
        })
    }

    /// 取托管状态引用，未托管返回 `None`。
    pub(crate) fn try_state_ref<T: Send + Sync + 'static>(&self) -> Option<&T> {
        self.states.get_ref::<T>()
    }

    /// 订阅事件流（供 SSE 使用）。
    pub(crate) fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.events.subscribe()
    }
}

// ---------------------------------------------------------------------------
// Manager / Emitter
// ---------------------------------------------------------------------------

/// 等价 `tauri::Manager`。
pub trait Manager {
    /// 内部共享状态
    #[doc(hidden)]
    fn app_inner(&self) -> &Arc<AppInner>;

    /// 注册托管状态
    fn manage<T: Send + Sync + 'static>(&self, state: T) {
        self.app_inner().states.insert(state);
    }

    /// 取托管状态
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        State(self.app_inner().state_ref::<T>())
    }

    /// 目录解析器
    fn path(&self) -> &PathResolver {
        &self.app_inner().paths
    }

    /// 按 label 取已存在的窗口。
    ///
    /// 宿主可能在兼容层之外就创建了窗口（主窗口 `main`、桌面歌词窗），
    /// 因此本地表未命中时向宿主确认一次，命中则缓存。
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow> {
        let inner = self.app_inner();
        if let Some(win) = inner.windows.lock().expect("windows poisoned").get(label) {
            return Some(win.clone());
        }
        let exists = host::op(
            inner,
            HostOp::WebviewExists,
            serde_json::json!({ "label": label }),
        )?
        .as_bool()?;
        if !exists {
            return None;
        }
        let win = WebviewWindow::adopt(inner, label);
        inner
            .windows
            .lock()
            .expect("windows poisoned")
            .insert(label.to_string(), win.clone());
        Some(win)
    }
}

/// 等价 `tauri::Emitter`。
pub trait Emitter {
    #[doc(hidden)]
    fn app_inner(&self) -> &Arc<AppInner>;

    /// 广播给全部窗口
    fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<()> {
        let value = serde_json::to_value(payload).map_err(|e| Error::Other(e.to_string()))?;
        self.app_inner().events.publish(event, None, &value);
        Ok(())
    }

    /// 只发给指定 label 的窗口
    fn emit_to<S: Serialize>(&self, label: &str, event: &str, payload: S) -> Result<()> {
        let value = serde_json::to_value(payload).map_err(|e| Error::Other(e.to_string()))?;
        self.app_inner().events.publish(event, Some(label), &value);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// AppHandle / App
// ---------------------------------------------------------------------------

/// 等价 `tauri::AppHandle`。可 `Clone`、`Send`、`Sync`、`'static`，常用于跨线程持有。
#[derive(Clone)]
pub struct AppHandle {
    pub(crate) inner: Arc<AppInner>,
}

impl AppHandle {
    /// 退出应用。优先交给宿主（宿主负责关窗并回收 sidecar 进程）。
    pub fn exit(&self, code: i32) {
        let handled = host::op(
            &self.inner,
            HostOp::AppExit,
            serde_json::json!({ "code": code }),
        );
        if handled.is_none() {
            // 宿主不可达（独立运行/已退出）时直接结束本进程，避免留下孤儿
            std::process::exit(code);
        }
    }

    /// 托盘图标：返回应用图标的句柄，宿主据此设置原生托盘图标。
    pub fn default_window_icon(&self) -> Option<&'static crate::image::Image> {
        crate::image::app_icon()
    }
}

impl Manager for AppHandle {
    fn app_inner(&self) -> &Arc<AppInner> {
        &self.inner
    }
}

impl Emitter for AppHandle {
    fn app_inner(&self) -> &Arc<AppInner> {
        &self.inner
    }
}

/// 等价 `tauri::App`：`setup` 闭包收到的对象。
pub struct App {
    inner: Arc<AppInner>,
    handle: AppHandle,
}

impl App {
    /// 取句柄，用于跨线程持有或传给命令函数
    pub fn handle(&self) -> &AppHandle {
        &self.handle
    }
}

impl Manager for App {
    fn app_inner(&self) -> &Arc<AppInner> {
        &self.inner
    }
}

impl Emitter for App {
    fn app_inner(&self) -> &Arc<AppInner> {
        &self.inner
    }
}

// ---------------------------------------------------------------------------
// Context（替代 tauri::generate_context!）
// ---------------------------------------------------------------------------

/// 应用元信息。由 `generate_context!` 在编译期从 `silvermoon.config.json` 烘焙。
#[derive(Debug, Clone)]
pub struct ContextConfig {
    pub identifier: String,
    pub product_name: String,
    pub window_title: String,
    pub window_width: u32,
    pub window_height: u32,
    pub window_min_width: u32,
    pub window_min_height: u32,
}

/// 等价 `tauri::Context`。
pub struct Context {
    pub config: ContextConfig,
}

impl Context {
    pub fn new(config: ContextConfig) -> Self {
        Context { config }
    }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type SetupFn =
    Box<dyn FnOnce(&mut App) -> std::result::Result<(), Box<dyn std::error::Error>> + Send>;

/// 等价 `tauri::Builder`。
///
/// 与真 Tauri 的差异：不再注册插件（插件能力改由 Electron 宿主机承担），
/// `run()` 不再拉起窗口，而是启动本地命令服务并阻塞。
pub struct Builder {
    setup: Option<SetupFn>,
    commands: Vec<CommandDef>,
}

impl Default for Builder {
    fn default() -> Self {
        Builder {
            setup: None,
            commands: Vec::new(),
        }
    }
}

impl Builder {
    /// 空操作：保留链式调用形态，便于日后需要时接回插件机制。
    pub fn plugin<P>(self, _plugin: P) -> Self {
        self
    }

    /// 注册 setup 回调
    pub fn setup<F>(mut self, f: F) -> Self
    where
        F: FnOnce(&mut App) -> std::result::Result<(), Box<dyn std::error::Error>> + Send + 'static,
    {
        self.setup = Some(Box::new(f));
        self
    }

    /// 注册命令路由表（由 `generate_handler!` 生成）
    pub fn invoke_handler(mut self, commands: Vec<CommandDef>) -> Self {
        self.commands = commands;
        self
    }

    /// 启动命令服务并阻塞当前线程。
    ///
    /// 顺序有意为之：**先**向宿主登记已存在的窗口 → **再**跑 setup
    /// （`anime::setup` 会依赖 `get_webview_window` 与创建隐藏窗口）→
    /// **最后**才开始监听端口。
    pub fn run(self, ctx: Context) -> Result<()> {
        let inner = build_inner(&ctx)?;

        // 1. 登记宿主机已有窗口
        if let Some(value) = host::op(&inner, HostOp::WindowList, Value::Null) {
            if let Some(labels) = value.as_array() {
                let mut guard = inner.windows.lock().expect("windows poisoned");
                for label in labels.iter().filter_map(|v| v.as_str()) {
                    guard
                        .entry(label.to_string())
                        .or_insert_with(|| WebviewWindow::adopt(&inner, label));
                }
            }
        }

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("silvermoon-rt")
            .build()
            .map_err(|e| Error::Other(format!("创建 tokio 运行时失败：{e}")))?;

        let handle = AppHandle {
            inner: Arc::clone(&inner),
        };

        rt.block_on(async move {
            // 2. 事件总线先装好，setup 期间 emit 的事件才不会丢
            let (tx, _rx) = tokio::sync::broadcast::channel::<String>(1024);
            inner.events.install(tx);

            // 3. 跑 setup
            if let Some(setup) = self.setup {
                let mut app = App {
                    inner: Arc::clone(&inner),
                    handle: handle.clone(),
                };
                if let Err(err) = setup(&mut app) {
                    eprintln!("[silvermoon] setup 失败：{err}");
                }
            }

            // 4. 启动命令服务，永不返回
            crate::server::serve(inner, self.commands).await
        })
    }
}

/// 组装共享状态：解析目录、`Box::leak` 出进程级生命周期。
fn build_inner(ctx: &Context) -> Result<Arc<AppInner>> {
    let (data_dir, cache_dir) = resolve_dirs(&ctx.config.identifier);
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| Error::Other(format!("创建数据目录 {data_dir:?} 失败：{e}")))?;
    let _ = std::fs::create_dir_all(&cache_dir);

    let inner = Arc::new(AppInner {
        identifier: ctx.config.identifier.clone(),
        product_name: ctx.config.product_name.clone(),
        states: StateMap::default(),
        events: EventBus::default(),
        paths: PathResolver {
            data_dir,
            cache_dir,
        },
        windows: Mutex::new(HashMap::new()),
        shortcuts: Mutex::new(Vec::new()),
        tray_ready: Mutex::new(false),
    });

    // 泄漏一份 Arc<AppInner> 供命令层取得 `&'static` 引用。
    // 这是刻意的：见 `StateMap` 的安全性说明——应用本身就是进程级单例。
    let leaked: &'static Arc<AppInner> = Box::leak(Box::new(Arc::clone(&inner)));
    let _ = leaked;

    Ok(inner)
}
