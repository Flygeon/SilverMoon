//! 菜单层：`Menu` / `MenuItem` / `PredefinedMenuItem` / `Submenu`。
//!
//! 这里只负责把菜单结构**描述**出来（转成 JSON），真正的原生菜单由宿主机创建。
//! 因此本模块没有「菜单对象」的运行时语义，`append` 也不会触发任何跨进程调用。

use std::sync::Mutex;

use serde_json::{json, Value};

use crate::app::{AppHandle, Result};

/// 菜单项 / 子菜单 id。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuId(String);

impl MenuId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for MenuId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<&str> for MenuId {
    fn from(v: &str) -> Self {
        MenuId(v.to_string())
    }
}

impl From<String> for MenuId {
    fn from(v: String) -> Self {
        MenuId(v)
    }
}

/// 可挂进菜单容器的条目。
pub trait MenuEntry: Send + Sync {
    /// 转换成宿主可消费的 JSON 描述
    fn to_payload(&self) -> Value;
}

/// 普通菜单项。
pub struct MenuItem {
    id: MenuId,
    text: String,
    enabled: bool,
    accelerator: Option<String>,
}

impl MenuItem {
    /// 带显式 id 的菜单项。`accelerator` 传 `None::<&str>` 表示无快捷键。
    pub fn with_id<M: Into<MenuId>, T: Into<String>>(
        _app: &AppHandle,
        id: M,
        text: T,
        enabled: bool,
        accelerator: Option<&str>,
    ) -> Result<MenuItem> {
        Ok(MenuItem {
            id: id.into(),
            text: text.into(),
            enabled,
            accelerator: accelerator.map(str::to_string),
        })
    }

    /// 菜单项 id
    pub fn id(&self) -> &MenuId {
        &self.id
    }
}

impl MenuEntry for MenuItem {
    fn to_payload(&self) -> Value {
        let mut payload = json!({
            "type": "normal",
            "id": self.id.as_str(),
            "text": self.text,
            "enabled": self.enabled,
        });
        if let (Some(map), Some(accel)) = (payload.as_object_mut(), &self.accelerator) {
            map.insert("accelerator".into(), Value::String(accel.clone()));
        }
        payload
    }
}

/// 系统预定义项（当前只用到分隔符）。
pub struct PredefinedMenuItem {
    kind: &'static str,
}

impl PredefinedMenuItem {
    /// 分隔符
    pub fn separator(_app: &AppHandle) -> Result<PredefinedMenuItem> {
        Ok(PredefinedMenuItem { kind: "separator" })
    }
}

impl MenuEntry for PredefinedMenuItem {
    fn to_payload(&self) -> Value {
        json!({ "type": self.kind })
    }
}

/// 子菜单。
pub struct Submenu {
    text: String,
    enabled: bool,
    items: Mutex<Vec<Value>>,
}

impl Submenu {
    /// 新建子菜单
    pub fn new(_app: &AppHandle, text: impl Into<String>, enabled: bool) -> Result<Submenu> {
        Ok(Submenu {
            text: text.into(),
            enabled,
            items: Mutex::new(Vec::new()),
        })
    }

    /// 追加条目
    pub fn append(&self, item: &impl MenuEntry) -> Result<()> {
        self.items
            .lock()
            .expect("submenu poisoned")
            .push(item.to_payload());
        Ok(())
    }
}

impl MenuEntry for Submenu {
    fn to_payload(&self) -> Value {
        json!({
            "type": "submenu",
            "text": self.text,
            "enabled": self.enabled,
            "items": *self.items.lock().expect("submenu poisoned"),
        })
    }
}

/// 顶层菜单。
pub struct Menu {
    items: Mutex<Vec<Value>>,
}

impl Menu {
    /// 新建空菜单
    pub fn new(_app: &AppHandle) -> Result<Menu> {
        Ok(Menu {
            items: Mutex::new(Vec::new()),
        })
    }

    /// 追加条目（菜单项 / 分隔符 / 子菜单）
    pub fn append(&self, item: &impl MenuEntry) -> Result<()> {
        self.items
            .lock()
            .expect("menu poisoned")
            .push(item.to_payload());
        Ok(())
    }

    /// 供托盘构造时读取
    pub fn to_payload(&self) -> Value {
        Value::Array(self.items.lock().expect("menu poisoned").clone())
    }
}

/// 菜单事件。
pub struct MenuEvent {
    /// 被点击条目的 id
    pub id: MenuId,
}

// 说明：菜单事件的处理器由 `tray` 模块统一持有并在宿主回调时分发，
// 这里只提供类型定义，避免出现「两套 handler 表、装了 A 却查 B」的接线错误。
