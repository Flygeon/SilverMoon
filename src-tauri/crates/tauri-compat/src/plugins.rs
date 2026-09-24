//! 原 `tauri-plugin-opener` 与原 `tauri-plugin-global-shortcut` 的替身。
//!
//! 两者在业务代码里各只有一个调用点（`commands/extension.rs`），因此这里只
//! 提供所需的最小 API。真正的系统调用由宿主机执行。

use std::fmt;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

use serde_json::json;

use crate::app::{AppHandle, AppInner, Result};
use crate::host::{self, HostOp};

// ---------------------------------------------------------------------------
// opener
// ---------------------------------------------------------------------------

/// `tauri_plugin_opener::Error` 的替身。
#[derive(Debug)]
pub struct OpenerError(String);

impl fmt::Display for OpenerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OpenerError {}

/// 打开系统程序 / 定位文件。
#[derive(Clone)]
pub struct Opener {
    pub(crate) inner: Arc<AppInner>,
}

impl Opener {
    /// 在文件管理器中定位文件
    pub fn reveal_item_in_dir<P: AsRef<Path>>(
        &self,
        path: P,
    ) -> std::result::Result<(), OpenerError> {
        let path = path.as_ref().to_string_lossy().into_owned();
        match host::op(&self.inner, HostOp::OpenerReveal, json!({ "path": path })) {
            Some(_) => Ok(()),
            None => Err(OpenerError("宿主未能定位该文件".into())),
        }
    }

    /// 用系统默认程序打开文件
    pub fn open_path<P: AsRef<Path>>(
        &self,
        path: P,
        _with: Option<impl AsRef<str>>,
    ) -> std::result::Result<(), OpenerError> {
        let path = path.as_ref().to_string_lossy().into_owned();
        match host::op(&self.inner, HostOp::OpenerOpenPath, json!({ "path": path })) {
            Some(_) => Ok(()),
            None => Err(OpenerError("宿主未能打开该文件".into())),
        }
    }

    /// 打开 URL
    pub fn open_url(&self, url: &str) -> std::result::Result<(), OpenerError> {
        match host::op(&self.inner, HostOp::OpenerOpenPath, json!({ "url": url })) {
            Some(_) => Ok(()),
            None => Err(OpenerError("宿主未能打开该链接".into())),
        }
    }
}

/// 等价 `tauri_plugin_opener::OpenerExt`。
pub trait OpenerExt {
    /// 取 opener
    fn opener(&self) -> Opener;
}

impl OpenerExt for AppHandle {
    fn opener(&self) -> Opener {
        Opener {
            inner: Arc::clone(&self.inner),
        }
    }
}

// ---------------------------------------------------------------------------
// global shortcut
// ---------------------------------------------------------------------------

/// 热键解析失败。
#[derive(Debug)]
pub struct ShortcutParseError(String);

impl fmt::Display for ShortcutParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ShortcutParseError {}

/// 等价 `tauri_plugin_global_shortcut::Shortcut`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
    accelerator: String,
}

impl Shortcut {
    /// 加速器原文
    pub fn as_str(&self) -> &str {
        &self.accelerator
    }
}

impl FromStr for Shortcut {
    type Err = ShortcutParseError;

    /// 接受 `Ctrl+Shift+A` / `Alt+F1` / `Super+Space` 这类形式。
    ///
    /// 这里只做形状校验（至少要有一个修饰键 + 一个主键），合法性最终由宿主
    /// `globalShortcut.register` 判定——Electron 的校验与平台一致，比在 Rust 侧
    /// 复制一份键名表更可靠。
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err(ShortcutParseError("热键为空".into()));
        }
        let parts: Vec<&str> = trimmed.split('+').map(str::trim).collect();
        if parts.iter().any(|p| p.is_empty()) {
            return Err(ShortcutParseError(format!("热键格式非法：{s}")));
        }
        if parts.len() < 2 {
            return Err(ShortcutParseError(format!("热键至少需要一个修饰键：{s}")));
        }
        Ok(Shortcut {
            accelerator: trimmed.to_string(),
        })
    }
}

impl fmt::Display for Shortcut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.accelerator)
    }
}

/// 按键状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutState {
    Pressed,
    Released,
}

/// 热键事件。
#[derive(Debug, Clone, Copy)]
pub struct ShortcutEvent {
    /// 按下或释放
    pub state: ShortcutState,
}

/// `tauri_plugin_global_shortcut::Error` 的替身。
#[derive(Debug)]
pub struct GlobalShortcutError(String);

impl fmt::Display for GlobalShortcutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GlobalShortcutError {}

pub(crate) type ShortcutHandler = Arc<dyn Fn(&AppHandle, &Shortcut, ShortcutEvent) + Send + Sync>;

pub(crate) struct RegisteredShortcut {
    pub(crate) accelerator: String,
    pub(crate) handler: ShortcutHandler,
}

/// 全局热键注册器。
#[derive(Clone)]
pub struct GlobalShortcut {
    pub(crate) inner: Arc<AppInner>,
}

impl GlobalShortcut {
    /// 注册热键并绑定回调。
    pub fn on_shortcut<S, F>(
        &self,
        shortcut: S,
        handler: F,
    ) -> std::result::Result<(), GlobalShortcutError>
    where
        S: Into<Shortcut>,
        F: Fn(&AppHandle, &Shortcut, ShortcutEvent) + Send + Sync + 'static,
    {
        let shortcut = shortcut.into();
        let accelerator = shortcut.accelerator.clone();
        {
            let mut list = self.inner.shortcuts.lock().expect("shortcuts poisoned");
            list.push(RegisteredShortcut {
                accelerator: accelerator.clone(),
                handler: Arc::new(handler),
            });
        }
        let ok = host::op(
            &self.inner,
            HostOp::ShortcutRegister,
            json!({ "accelerator": accelerator }),
        )
        .is_some();
        if ok {
            Ok(())
        } else {
            Err(GlobalShortcutError(format!(
                "宿主未能注册热键 `{accelerator}`"
            )))
        }
    }
}

/// 等价 `tauri_plugin_global_shortcut::GlobalShortcutExt`。
pub trait GlobalShortcutExt {
    /// 取全局热键注册器
    fn global_shortcut(&self) -> GlobalShortcut;
}

impl GlobalShortcutExt for AppHandle {
    fn global_shortcut(&self) -> GlobalShortcut {
        GlobalShortcut {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// 宿主回调入口：某个全局热键被按下 / 释放。
pub fn dispatch_shortcut(inner: &Arc<AppInner>, accelerator: &str, pressed: bool) {
    let (handler, shortcut) = {
        let list = inner.shortcuts.lock().expect("shortcuts poisoned");
        let found = list.iter().find(|s| s.accelerator == accelerator);
        match found {
            Some(entry) => (
                Arc::clone(&entry.handler),
                Shortcut {
                    accelerator: accelerator.to_string(),
                },
            ),
            None => return,
        }
    };
    let app = AppHandle {
        inner: Arc::clone(inner),
    };
    handler(
        &app,
        &shortcut,
        ShortcutEvent {
            state: if pressed {
                ShortcutState::Pressed
            } else {
                ShortcutState::Released
            },
        },
    );
}

/// 便于在 `Result` 语境里使用
#[allow(dead_code)]
pub(crate) fn opener_unavailable() -> Result<()> {
    Err(crate::app::Error::Host("opener 不可用".into()))
}
