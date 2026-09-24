//! # tauri（兼容层）
//!
//! 这是 **SilverMoon** 用的 `tauri` 同名替身 crate。
//!
//! ## 为什么要这么做
//!
//! 原项目 LumiLuna 是 Tauri 2 应用。迁移到 Electron 时，如果按常规做法去改
//! `src-tauri/src` 下那 19 个业务文件里 190+ 处 `tauri::` 引用，diff 会非常庞大、
//! 回归风险也高。这里换个思路：**保持业务源码零改动**，只在依赖层把真正的
//! `tauri` crate 换成这个兼容层。
//!
//! ```toml
//! # src-tauri/Cargo.toml
//! tauri = { path = "crates/tauri-compat" }
//! ```
//!
//! 于是：
//!
//! * `use tauri::Manager;`、`app: tauri::AppHandle`、`#[tauri::command]` 全部照旧；
//! * 命令不再走 Tauri IPC，而是被注册进一张路由表，由本地 HTTP 服务（`POST /cmd`）暴露；
//! * `app.emit(..)` 改走 SSE（`GET /events`），由宿主转发给渲染窗口；
//! * 窗口、托盘、全局热键这些宿主能力，通过反向 RPC（`host` 模块）落到 Electron。
//!
//! ## 实测覆盖的 API 面
//!
//! | 项 | 数量 |
//! |---|---|
//! | `#[tauri::command]` 命令 | 154 |
//! | `AppHandle` 引用 | 190+ |
//! | `State<'_, T>` 注入 | 29 |
//! | `async_runtime::spawn_blocking` | 42 |
//! | `WebviewWindowBuilder::new` | 4 |
//! | `emit` / `emit_to` | 8 |
//! | tray / menu 构造点 | 1 |
//!
//! ## 与原版 Tauri 的已知差异
//!
//! 1. **不提供插件机制**。原 `tauri-plugin-*` 能力改由 Electron 宿主机承担：
//!    `opener` / `global-shortcut` 在本 crate 的 `plugins` 模块里重做了最小实现，
//!    其余（dialog / fs / store / http）只在前端用到，由前端 shim 负责。
//! 2. **`on_navigation` 的拦截时机**。Tauri 是同步拦截；这里改为「先放行、Rust 判定为
//!    不放行时再回退」，详见 `window` 模块文档。
//! 3. **不实现多 webview / 多窗口的事件循环**。窗口实体全部在 Electron 侧。

pub mod app;
pub mod async_runtime;
pub mod host;
pub mod image;
pub mod menu;
pub mod plugins;
pub mod private;
pub mod server;
pub mod tray;
pub mod window;

pub use crate::app::{
    App, AppHandle, Builder, Context, ContextConfig, Emitter, Error, Manager, PathResolver, Result,
    State,
};
pub use crate::image::Image;
pub use crate::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};
pub use crate::plugins::{
    GlobalShortcut, GlobalShortcutExt, Opener, OpenerExt, Shortcut, ShortcutEvent, ShortcutState,
};
pub use crate::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
pub use crate::window::{Cookie, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 宏：`#[command]` / `generate_handler!` / `generate_context!` / `mobile_entry_point`。
pub use tauri_compat_macros::{command, generate_context, generate_handler, mobile_entry_point};

/// 宏展开代码使用的内部命名空间。业务代码不应直接引用。
pub use crate::private as __private;
