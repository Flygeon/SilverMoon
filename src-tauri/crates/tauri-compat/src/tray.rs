//! 托盘图标：`TrayIconBuilder` / `TrayIcon` / `TrayIconEvent`。
//!
//! 原生托盘由宿主机（Electron `Tray`）创建；Rust 侧只保留「菜单结构」与
//! 「事件处理器」。用户点击托盘项时，宿主机回调 `/_host`，再由本模块分发到
//! `on_menu_event` / `on_tray_icon_event` 注册的闭包。

use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;

use crate::app::{AppHandle, Error, Result};
use crate::host::{self, HostOp};
use crate::image::Image;
use crate::menu::{Menu, MenuEvent, MenuId};

/// 鼠标按键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// 按键状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButtonState {
    Up,
    Down,
}

/// 托盘图标 id。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayIconId(pub String);

/// 托盘图标事件。业务代码只匹配 `Click` 的 `button` / `button_state`。
#[derive(Debug, Clone)]
pub enum TrayIconEvent {
    /// 单击
    Click {
        id: TrayIconId,
        button: MouseButton,
        button_state: MouseButtonState,
    },
    /// 双击
    DoubleClick { id: TrayIconId, button: MouseButton },
    /// 进入
    Enter { id: TrayIconId },
    /// 离开
    Leave { id: TrayIconId },
}

type MenuHandler = Arc<dyn Fn(&AppHandle, MenuEvent) + Send + Sync>;
type IconHandler = Arc<dyn Fn(&TrayIcon, TrayIconEvent) + Send + Sync>;

static MENU_HANDLER: Mutex<Option<MenuHandler>> = Mutex::new(None);
static ICON_HANDLER: Mutex<Option<IconHandler>> = Mutex::new(None);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static TRAY_ID: OnceLock<String> = OnceLock::new();

/// 托盘图标句柄。
#[derive(Clone)]
pub struct TrayIcon {
    id: String,
    app: AppHandle,
}

impl TrayIcon {
    /// 托盘 id
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 显示 / 隐藏
    pub fn set_visible(&self, visible: bool) -> Result<()> {
        host::op(
            &self.app.inner,
            HostOp::TraySetVisible,
            json!({ "id": self.id, "visible": visible }),
        )
        .ok_or_else(|| Error::Host("设置托盘可见性失败".into()))?;
        Ok(())
    }

    /// 取应用句柄（`TrayIconEvent` 回调里用到）
    pub fn app_handle(&self) -> &AppHandle {
        &self.app
    }
}

/// 托盘构造器。
pub struct TrayIconBuilder {
    id: String,
    icon_path: Option<String>,
    menu: Option<serde_json::Value>,
    tooltip: Option<String>,
    show_menu_on_left_click: bool,
    on_menu_event: Option<MenuHandler>,
    on_tray_icon_event: Option<IconHandler>,
}

impl TrayIconBuilder {
    /// 新建构造器
    pub fn new() -> Self {
        TrayIconBuilder {
            id: "main-tray".to_string(),
            icon_path: None,
            menu: None,
            tooltip: None,
            show_menu_on_left_click: true,
            on_menu_event: None,
            on_tray_icon_event: None,
        }
    }

    /// 带 id 的构造器
    pub fn with_id(id: impl Into<String>) -> Self {
        let mut b = TrayIconBuilder::new();
        b.id = id.into();
        b
    }

    /// 图标
    pub fn icon(mut self, icon: Image) -> Self {
        self.icon_path = Some(icon.path.to_string_lossy().into_owned());
        self
    }

    /// 菜单
    pub fn menu(mut self, menu: &Menu) -> Self {
        self.menu = Some(menu.to_payload());
        self
    }

    /// 悬停提示
    pub fn tooltip(mut self, tooltip: impl Into<String>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// 左键是否也弹菜单
    pub fn show_menu_on_left_click(mut self, show: bool) -> Self {
        self.show_menu_on_left_click = show;
        self
    }

    /// 菜单事件处理器
    pub fn on_menu_event<F>(mut self, f: F) -> Self
    where
        F: Fn(&AppHandle, MenuEvent) + Send + Sync + 'static,
    {
        self.on_menu_event = Some(Arc::new(f));
        self
    }

    /// 图标事件处理器
    pub fn on_tray_icon_event<F>(mut self, f: F) -> Self
    where
        F: Fn(&TrayIcon, TrayIconEvent) + Send + Sync + 'static,
    {
        self.on_tray_icon_event = Some(Arc::new(f));
        self
    }

    /// 创建托盘
    pub fn build(self, app: &AppHandle) -> Result<TrayIcon> {
        if let Some(handler) = self.on_menu_event {
            *MENU_HANDLER.lock().expect("tray handler poisoned") = Some(handler);
        }
        if let Some(handler) = self.on_tray_icon_event {
            *ICON_HANDLER.lock().expect("tray handler poisoned") = Some(handler);
        }
        let _ = APP_HANDLE.set(app.clone());
        let _ = TRAY_ID.set(self.id.clone());

        let ok = host::op(
            &app.inner,
            HostOp::TrayCreate,
            json!({
                "id": self.id,
                "iconPath": self.icon_path,
                "menu": self.menu,
                "tooltip": self.tooltip,
                "showMenuOnLeftClick": self.show_menu_on_left_click,
            }),
        )
        .is_some();

        (*app.inner.tray_ready.lock().expect("tray flag poisoned")) = ok;

        Ok(TrayIcon {
            id: self.id,
            app: app.clone(),
        })
    }
}

impl Default for TrayIconBuilder {
    fn default() -> Self {
        TrayIconBuilder::new()
    }
}

/// 宿主回调入口：托盘菜单项被点击。
pub fn dispatch_menu_event(id: &str) {
    let Some(app) = APP_HANDLE.get().cloned() else {
        eprintln!("[silvermoon] 托盘尚未初始化，忽略菜单事件 `{id}`");
        return;
    };
    let handler = MENU_HANDLER.lock().expect("tray handler poisoned").clone();
    match handler {
        Some(f) => f(
            &app,
            MenuEvent {
                id: MenuId::from(id),
            },
        ),
        None => eprintln!("[silvermoon] 收到托盘菜单事件 `{id}`，但尚未注册处理器"),
    }
}

/// 宿主回调入口：托盘图标被点击。
pub fn dispatch_icon_event(button: &str, state: &str) {
    let (Some(app), Some(id)) = (APP_HANDLE.get().cloned(), TRAY_ID.get().cloned()) else {
        return;
    };
    let button = match button {
        "left" => MouseButton::Left,
        "right" => MouseButton::Right,
        _ => MouseButton::Middle,
    };
    let button_state = if state == "down" {
        MouseButtonState::Down
    } else {
        MouseButtonState::Up
    };
    let handler = ICON_HANDLER.lock().expect("tray handler poisoned").clone();
    if let Some(f) = handler {
        let tray = TrayIcon {
            id,
            app: app.clone(),
        };
        f(
            &tray,
            TrayIconEvent::Click {
                id: TrayIconId(tray.id.clone()),
                button,
                button_state,
            },
        );
    }
}
