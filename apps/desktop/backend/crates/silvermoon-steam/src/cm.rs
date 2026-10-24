//! Steam **CM 连接层**：用 refresh_token 登入 CM，并调用 service method。
//!
//! ## 为什么需要它
//!
//! 下载功能的前置条件有两个，都**只能**通过 CM（Connection Manager）拿：
//!
//! | 需要的东西 | 接口 | HTTP 端点 |
//! |---|---|---|
//! | depot manifest 的 request code | `ContentServerDirectory.GetManifestRequestCode` | **没有**（实测 404） |
//! | CDN 拉取的鉴权 token | `ContentServerDirectory.GetCDNAuthToken` | **没有** |
//!
//! 实测证据（见 `doc/LOG.md`）：
//! - CDN 服务器列表能拿到（`GetServersForSteamPipe` 是普通 WebAPI）；
//! - 但不带鉴权直接请求 `/depot/<id>/manifest/<gid>/5` 返回 **401**；
//! - 而那两个 service method 在 WebAPI 上根本不存在。
//!
//! 所以「自己下载」的唯一通路是：**CM 长连接 → service method → 拿 code/token → CDN**。
//!
//! ## 实现方式：复用 `steam-vent`
//!
//! 不自己造 CM 协议（那要上万行：protobuf 编解码、RSA 密钥交换、心跳、重连）。
//! `steam-vent` 是 `Aurelia参考` 同源库，自带完整实现，且支持**用 refresh_token 登录**
//! （`Connection::access`）—— 正好对上我们已经持久化的凭据。
//!
//! ## 连接是可选的
//!
//! 没有 CM 时，登录 / 游戏库 / 启动 / 详情**全部照常工作**（它们只依赖 HTTPS）。
//! 本层只服务「下载」，因此所有失败都必须能被上层忽略，不能让应用起不来。

use std::sync::Arc;
use std::time::Duration;

// ⚠️ 这几个名字只能从 **crate 根**导入。
// steam-vent 的 `serverlist` / `service_method` 是**私有模块**，
// 用 `steam_vent::serverlist::ServerList` 会报 E0603（module is private）。
// crate 根在 lib.rs 里用 `pub use` 重新导出了它们。
//
// `ConnectionTrait` 也必须 import：`service_method` 是**该 trait 的方法**，
// 不是 `Connection` 的固有方法（trait 有 blanket impl，所以 Connection 具备它，
// 但不 import trait 就调不到）。
use steam_vent::{Connection, ConnectionError, ConnectionTrait, ServerList, ServiceMethodRequest};
use tokio::sync::{Mutex, MutexGuard};

/// 一次已建立的 CM 会话。
///
/// 用 `Mutex` 包住：service method 是请求/响应式的，同一时刻只应有一个在飞，
/// 否则响应会串（steam-vent 的连接不保证多路复用安全）。
pub struct CmSession {
    connection: Connection,
}

impl CmSession {
    /// 用 **access_token（JWT）** 登入 CM。
    ///
    /// ## 容易搞错的一点
    ///
    /// `Connection::access` 要求的 token 必须是 **JWT**：它把第二段 base64 解成 JSON，
    /// 校验 `iss == "steam"`，再从 `sub` 取 SteamID64（见 `unauthenticated.rs`）。
    ///
    /// 所以 `refresh_token`（不透明字符串）**不能**直接传进来 ——
    /// 必须先用 `GenerateAccessTokenForApp` 换出 access_token。
    /// 那一步在 Electron 侧已完成（`electron/steam/protocol.ts` 的 `ensureAccessToken`），
    /// 因此这里期望调用方传入**换好的 access_token**。
    pub async fn connect(account_name: &str, access_token: &str) -> Result<Self, CmError> {
        if account_name.trim().is_empty() {
            return Err(CmError::Login("缺少账号名，无法建立 CM 会话".into()));
        }
        if access_token.trim().is_empty() {
            return Err(CmError::Login("缺少 access_token，无法建立 CM 会话".into()));
        }
        // 提前拦掉明显不是 JWT 的输入，给出可读原因（否则 steam-vent 会抛
        // Malformed / InvalidIssuer 这类难懂的错误）
        if !is_probably_jwt(access_token) {
            return Err(CmError::Login(
                "传入的不是 access_token（JWT）。请先用 refresh_token 换取 access_token".into(),
            ));
        }

        let server_list = ServerList::discover()
            .await
            .map_err(|e| CmError::ServerList(e.to_string()))?;

        // 超时给足：CM 握手含 RSA 密钥交换与多轮往返，弱网下 10 秒会误判失败。
        let connection = tokio::time::timeout(
            Duration::from_secs(30),
            Connection::access(&server_list, account_name, access_token),
        )
        .await
        .map_err(|_| CmError::Timeout)?
        .map_err(|e| CmError::Login(describe_connection_error(&e)))?;

        Ok(Self { connection })
    }

    /// 调用一个 service method。
    ///
    /// 泛型由调用方用 `steam_vent_proto_steam` 的请求类型实例化；
    /// 响应类型由 `ServiceMethodRequest::Response` 自动关联。
    pub async fn call<Req>(&self, request: Req) -> Result<Req::Response, CmError>
    where
        Req: ServiceMethodRequest,
    {
        self.connection
            .service_method(request)
            .await
            .map_err(|e| CmError::Rpc(e.to_string()))
    }

    /// 当前会话的 cell id（CDN 选点用）。
    pub fn cell_id(&self) -> u32 {
        self.connection.cell_id()
    }

    /// 连接的 SteamID64（数值形式）。
    ///
    /// 用 `steam64()` 而不是 `u64::from(...)`：两者等价，但前者是 steamid-ng
    /// 明确提供的取值方法，语义更直白、也不会因 trait impl 变化而失效。
    pub fn steam_id(&self) -> u64 {
        self.connection.steam_id().steam64()
    }
}

/// 粗判一个字符串是否像 JWT（三段、以点分隔）。
///
/// 只做形状检查，不验签 —— 真正的校验由 steam-vent 完成。
/// 提前拦一道是为了给出「你传错了凭据类型」这种可读提示。
fn is_probably_jwt(token: &str) -> bool {
    token.split('.').count() == 3
}

/// 把 steam-vent 的连接错误翻译成用户能看懂的中文。
///
/// 这一步很关键：原始错误是 `ConnectionError::...` 的 Debug 文本，
/// 直接抛给界面等于什么都没说。
fn describe_connection_error(error: &ConnectionError) -> String {
    // 变体列表照 steam_vent::session::ConnectionError 的真实定义
    match error {
        ConnectionError::AccessToken(_) => "refresh_token 已失效，请重新登录".to_string(),
        ConnectionError::Network(_) => "网络错误（连接 Steam CM 失败）".to_string(),
        ConnectionError::LoginError(_) => format!("登录被拒：{error}"),
        ConnectionError::Aborted => "登录被中断".to_string(),
        ConnectionError::UnsupportedConfirmationAction(_) => {
            "Steam 要求交互式确认，refresh_token 登录不支持".to_string()
        }
        _ => format!("{error}"),
    }
}

/// CM 层的错误。全部可降级：上层拿到就忽略下载能力，其余功能不受影响。
#[derive(Debug)]
pub enum CmError {
    /// 取 CM 服务器列表失败（网络不通 / 被墙）
    ServerList(String),
    /// 登入失败（token 失效 / 账号问题）
    Login(String),
    /// 握手超时
    Timeout,
    /// service method 调用失败
    Rpc(String),
}

impl std::fmt::Display for CmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ServerList(m) => write!(f, "无法获取 Steam CM 服务器列表：{m}"),
            Self::Login(m) => write!(f, "无法连接 Steam CM（登录被拒）：{m}"),
            Self::Timeout => write!(f, "连接 Steam CM 超时（请检查网络或代理）"),
            Self::Rpc(m) => write!(f, "Steam CM 请求失败：{m}"),
        }
    }
}

impl std::error::Error for CmError {}

/// 全局 CM 会话（懒建立、失败可重试）。
///
/// 为什么持有全局：CM 是**长连接**，每次下载都重连会让 Steam 侧频繁握手、也拖慢首字节。
/// 但它又必须可失败——没网时不能把应用卡住，所以用 `Option` 包着。
pub struct CmManager {
    session: Arc<Mutex<Option<CmSession>>>,
}

impl CmManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
        }
    }

    /// 取得（必要时建立）会话。参数是 **access_token（JWT）**，不是 refresh_token。
    pub async fn get_or_connect(
        &self,
        account_name: &str,
        access_token: &str,
    ) -> Result<MutexGuard<'_, Option<CmSession>>, CmError> {
        let mut guard = self.session.lock().await;
        if guard.is_none() {
            let session = CmSession::connect(account_name, access_token).await?;
            *guard = Some(session);
        }
        Ok(guard)
    }

    /// 断开（登出 / 切换账号时调用）。
    pub async fn disconnect(&self) {
        let mut guard = self.session.lock().await;
        *guard = None;
    }

    /// 是否已连接。
    pub async fn is_connected(&self) -> bool {
        self.session.lock().await.is_some()
    }
}

impl Default for CmManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 参数校验必须在建立连接**之前**完成，
    /// 否则空账号 / 错类型凭据会触发一次无意义的 CM 握手（慢，且浪费 server 资源）。
    #[test]
    fn invalid_credentials_rejected_before_network() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        // 空账号
        let err = rt
            .block_on(CmSession::connect("", "a.b.c"))
            .err()
            .expect("空账号应被拒绝");
        assert!(matches!(err, CmError::Login(_)), "应为 Login 错误");

        // 空 token
        let err = rt
            .block_on(CmSession::connect("user", ""))
            .err()
            .expect("空 token 应被拒绝");
        assert!(matches!(err, CmError::Login(_)), "应为 Login 错误");

        // 传了 refresh_token（不透明字符串）而不是 access_token（JWT）：
        // 必须给出可读提示，而不是让 steam-vent 抛 Malformed
        let err = rt
            .block_on(CmSession::connect("user", "opaque-refresh-token"))
            .err()
            .expect("非 JWT 应被拒绝");
        assert!(matches!(err, CmError::Login(_)), "应为 Login 错误");
        assert!(
            err.to_string().contains("access_token"),
            "错误文案应点明需要 access_token，实际：{err}"
        );
    }

    #[test]
    fn jwt_shape_detection() {
        assert!(is_probably_jwt("a.b.c"));
        assert!(!is_probably_jwt("a.b"));
        assert!(!is_probably_jwt("plain"));
        assert!(!is_probably_jwt(""));
    }
}
