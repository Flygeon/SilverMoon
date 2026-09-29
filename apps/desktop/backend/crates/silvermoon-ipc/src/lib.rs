//! # silvermoon-ipc
//!
//! SilverMoon 的 **IPC 层**：把后端暴露的命令、事件与宿主能力收成一个 crate，
//! 让 `backend/src` 下的业务模块只依赖它，而不关心宿主是谁。
//!
//! ## 它在链路里的位置
//!
//! ```text
//! ┌ Electron 主进程 ────────────────────────────────┐
//! │  窗口 / 托盘 / 热键 / 对话框 / app:// 与 asset:// │
//! │  宿主 HTTP 服务（POST /rpc）←── 反向调用 ────────┼──┐
//! └───────▲──────────────────────────────┬───────────┘  │
//!         │ preload 桥（渲染进程）        │ HTTP /cmd    │
//!         │                              │ SSE /events  │
//!   渲染进程（Vue）                 本 crate（后端进程） │
//!                                                       │
//!   反向：`host` 模块 ──POST /rpc──> 宿主 HTTP 服务 <────┘
//! ```
//!
//! ## 提供什么
//!
//! | 能力 | 入口 |
//! |---|---|
//! | 命令注册 | `#[command]` + `generate_handler!`，汇总成一张路由表由 `server` 暴露 |
//! | 应用句柄 | [`Host`]（可 `Clone + Send + Sync + 'static`，跨线程持有） |
//! | 托管状态 | `app.manage(..)` / `app.state::<T>()`（[`HostApi`]） |
//! | 事件 | [`EventEmitter`] 的 `emit` / `emit_to`，经 SSE 推给宿主 |
//! | 窗口 | [`Window`] / [`WindowBuilder`]，实体在 Electron 侧，这里按 label 定向操作 |
//! | 托盘与菜单 | `tray` / `menu` 模块，菜单结构由本进程构造，宿主负责创建原生托盘 |
//! | 异步运行时 | `rt` 模块（真 tokio；业务码里还有 26 处直接调 `tokio::task::spawn_blocking`） |
//! | 宿主回调 | `server` 的 `POST /_host`：导航拦截、托盘点击、全局热键 |
//!
//! ## 设计取舍
//!
//! 1. **命令用 HTTP 而不是 stdio/管道**：便于宿主并发处理，也让 `curl` 直接可调试。
//!    服务只绑 `127.0.0.1`，两侧共用 `X-SilverMoon-Token` 鉴权。
//! 2. **状态表允许把引用延长到 `'static`**：业务码里 `State<'_, T>` 会被捕获进装箱的
//!    `async` 块，必须拿到 `'static` 引用。安全性论证见 [`app::StateMap`] 文档。
//! 3. **`on_navigation` 改为「先放行、判定为否时回退」**：Electron 主进程无法同步地
//!    跨进程询问本进程，详见 [`window`] 模块文档。
//! 4. **不实现多 webview 的事件循环**：窗口实体全部在 Electron 侧，这里只是定向句柄。
//! 5. **不提供插件机制**：宿主能力按需在 `plugins` 模块里直接实现最小子集。

pub mod app;
pub mod host;
pub mod image;
pub mod internal;
pub mod menu;
pub mod plugins;
pub mod rt;
pub mod server;
pub mod tray;
pub mod window;

pub use crate::app::{
    App, Builder, Context, ContextConfig, Error, EventEmitter, Host, HostApi, PathResolver, Result,
    State,
};
pub use crate::image::Image;
pub use crate::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};
pub use crate::plugins::{
    GlobalShortcut, GlobalShortcutExt, Opener, OpenerExt, Shortcut, ShortcutEvent, ShortcutState,
};
pub use crate::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
pub use crate::window::{Cookie, Window, WindowBuilder, WindowUrl};

/// 宏：`#[command]` / `generate_handler!` / `generate_context!` / `mobile_entry_point`。
pub use silvermoon_ipc_macros::{command, generate_context, generate_handler, mobile_entry_point};

/// 宏展开代码使用的内部命名空间。业务代码不应直接引用。
pub use crate::internal as __internal;
