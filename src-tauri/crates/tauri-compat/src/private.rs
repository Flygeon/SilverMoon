//! 宏生成的代码所依赖的「内部契约」。
//!
//! 这些东西对业务代码是透明的，因此统一收在 `tauri::__private` 命名空间下，
//! 只有 `#[command]` / `generate_handler!` / `generate_context!` 展开出来的代码会用到。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};

use crate::app::{AppHandle, AppInner, State};

pub use crate::app::{Context, ContextConfig};

/// 命令执行上下文。
///
/// 持有 `&'static Arc<AppInner>`：应用是进程级单例，`Builder::run` 会把
/// `Arc<AppInner>` 泄漏一份，因此这里能安全地取到 `'static` 的生命周期，
/// 让宏生成的 `async` 块（需 `'static`）可以捕获托管状态。
#[derive(Clone, Copy)]
pub struct Ctx {
    pub(crate) inner: &'static Arc<AppInner>,
}

impl Ctx {
    /// 由命令服务在启动时构造。
    pub fn new(inner: &'static Arc<AppInner>) -> Self {
        Ctx { inner }
    }

    /// 注入 `AppHandle`（对应形参 `app: AppHandle`）
    pub fn app_handle(&self) -> AppHandle {
        AppHandle {
            inner: Arc::clone(self.inner),
        }
    }

    /// 注入托管状态（对应形参 `state: State<'_, T>`）。
    ///
    /// 返回 `State<'static, T>`；由于 `State<'a, T>` 对 `'a` 协变，
    /// 赋给 `State<'_, T>` 形参不会有问题。
    pub fn state<T: Send + Sync + 'static>(&self) -> State<'static, T> {
        State(self.inner.state_ref::<T>())
    }
}

/// 一次命令调用的参数包（已按 camelCase 键准备好）。
pub struct Args {
    map: Map<String, Value>,
}

impl Args {
    pub fn new(map: Map<String, Value>) -> Self {
        Args { map }
    }

    /// 取必需参数；缺失或类型不符即报错。
    pub fn take<T: DeserializeOwned>(&mut self, key: &str) -> Result<T, String> {
        match self.map.remove(key) {
            None => Err(format!("缺少参数 `{key}`")),
            Some(value) => {
                serde_json::from_value(value).map_err(|e| format!("参数 `{key}` 解析失败：{e}"))
            }
        }
    }

    /// 取可选参数；缺失或为 `null` 都得到 `None`。
    pub fn take_optional<T: DeserializeOwned>(&mut self, key: &str) -> Result<Option<T>, String> {
        match self.map.remove(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value)
                .map(Some)
                .map_err(|e| format!("参数 `{key}` 解析失败：{e}")),
        }
    }
}

/// 命令返回值：业务代码里的 `Result<T, String>` 与非 `Result` 返回值
/// 由宏在展开期分流，最终统一成 `Result<Value, String>`。
pub type InvokeFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;

/// 命令实现签名。
pub type InvokeFn = fn(&Ctx, Args) -> InvokeFuture;

/// 一条命令路由记录。由 `#[command]` 生成注册函数、`generate_handler!` 汇总。
pub struct CommandDef {
    pub name: &'static str,
    pub invoke: InvokeFn,
}

impl CommandDef {
    pub fn new(name: &'static str, invoke: InvokeFn) -> Self {
        CommandDef { name, invoke }
    }
}

/// 把命令返回值序列化成 JSON。
///
/// 失败不致命——退化成 `null` 并打印告警，避免因为一个不可序列化的返回值
/// 让整条 IPC 直接报错（业务侧全部是 plain struct，实际不会走到这里）。
pub fn to_command_value<T: Serialize>(value: &T) -> Result<Value, String> {
    match serde_json::to_value(value) {
        Ok(v) => Ok(v),
        Err(e) => {
            eprintln!("[silvermoon] 命令返回值序列化失败：{e}");
            Ok(Value::Null)
        }
    }
}
