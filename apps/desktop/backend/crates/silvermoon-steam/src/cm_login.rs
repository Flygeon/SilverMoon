//! **CM 侧扫码登录**：拿到能用于 CM logon 的 token。
//!
//! ## 为什么不能复用网页登录的 token
//!
//! 实测（见 LOG 2026-10-24 六）：
//!
//! | token 来源 | `iss` | 能否登 CM |
//! |---|---|---|
//! | WebAPI 扫码（`IAuthenticationService/*` over HTTPS） | WebAPI 返回的 refresh_token | ❌ `invalid credentials` |
//! | **CM 匿名连接 + `Authentication.BeginAuthSessionViaQR`** | `steam` | ✅ |
//!
//! 同样的 `website_id="Client"`、`platform_type=SteamClient`，走 HTTPS 与走 CM
//! 拿到的凭据**受众不同** —— 这一条是参考实现 Aurelia 的做法，
//! 也已由 `cm::tests::anonymous_cm_can_start_qr_login` 在本仓库验证：
//! 匿名 CM 连接 + 该 service method 可以正常拿到挑战 URL。
//!
//! ## 流程
//!
//! ```text
//! begin_qr():  匿名 CM → Authentication.BeginAuthSessionViaQR → challenge_url
//!                     ↓ 用户手机扫码确认
//! poll_qr():   匿名 CM → Authentication.PollAuthSessionStatus → refresh_token
//! ```
//!
//! 两次调用**各建一次匿名连接**（无状态、可重入），不用维护长连接：
//! poll 只需要 `client_id` + `request_id`，与发起时的连接无关。
//!
//! ## 拿到 token 之后
//!
//! 调用方用 `CmManager::get_or_connect(account_name, refresh_token)` 建立正式会话；
//! 那一步会走 `Connection::access`（校验 `iss=steam`），本模块拿到的 token 满足该条件。

use steam_vent::connection::Connection;
use steam_vent::{ConnectionTrait, ServerList};
use steam_vent_proto_steam::steammessages_auth_steamclient::{
    CAuthentication_BeginAuthSessionViaQR_Request, CAuthentication_PollAuthSessionStatus_Request,
    EAuthTokenPlatformType,
};

use crate::cm::CmError;

/// 一次扫码登录的挑战信息。
#[derive(Debug, Clone)]
pub struct QrChallenge {
    /// 交给二维码组件的 URL（`https://s.team/q/...` 形式）
    pub challenge_url: String,
    pub client_id: u64,
    /// 二进制；过桥时用 hex，避免往 JSON 里塞字节数组
    pub request_id: Vec<u8>,
    /// Steam 建议的轮询间隔（秒）
    pub interval: f64,
}

/// 一次轮询的结果。
#[derive(Debug, Clone)]
pub enum PollOutcome {
    /// 还没扫码 / 还没确认 —— 继续轮询
    Pending,
    /// 已授权，拿到凭据
    Authorized {
        account_name: String,
        refresh_token: String,
    },
}

/// 建立一次**匿名** CM 连接。
///
/// 匿名连接不需要任何凭据 —— 这也解释了为什么它能用来做登录本身。
async fn anonymous_connection() -> Result<Connection, CmError> {
    let servers = ServerList::discover()
        .await
        .map_err(|e| CmError::ServerList(e.to_string()))?;
    Connection::anonymous(&servers)
        .await
        .map_err(|e| CmError::Login(format!("建立匿名 CM 连接失败：{e}")))
}

/// 发起扫码登录，返回二维码 URL 与轮询参数。
pub async fn begin_qr(device_name: &str) -> Result<QrChallenge, CmError> {
    let connection = anonymous_connection().await?;

    let mut request = CAuthentication_BeginAuthSessionViaQR_Request::new();
    request.set_device_friendly_name(device_name.to_string());
    // 这两个参数决定 token 受众：必须声明成 Steam 客户端 + Client 站点，
    // 否则拿到的凭据不能用于 CM logon（与 WebAPI 那条路失败的根因一致）。
    request.set_platform_type(EAuthTokenPlatformType::k_EAuthTokenPlatformType_SteamClient);
    request.set_website_id("Client".to_string());

    let response = connection
        .service_method(request)
        .await
        .map_err(|e| CmError::Rpc(format!("发起扫码登录失败：{e}")))?;

    let challenge_url = response.challenge_url().to_string();
    if challenge_url.is_empty() {
        return Err(CmError::Rpc("Steam 未返回二维码 URL".into()));
    }
    Ok(QrChallenge {
        challenge_url,
        client_id: response.client_id(),
        request_id: response.request_id().to_vec(),
        interval: if response.interval() > 0.0 {
            response.interval() as f64
        } else {
            5.0
        },
    })
}

/// 轮询扫码状态。未完成返回 `PollOutcome::Pending`（不是错误）。
pub async fn poll_qr(client_id: u64, request_id: &[u8]) -> Result<PollOutcome, CmError> {
    if client_id == 0 || request_id.is_empty() {
        return Err(CmError::Rpc(
            "轮询参数不完整（client_id / request_id）".into(),
        ));
    }
    let connection = anonymous_connection().await?;

    let mut request = CAuthentication_PollAuthSessionStatus_Request::new();
    request.set_client_id(client_id);
    request.set_request_id(request_id.to_vec());

    let response = connection
        .service_method(request)
        .await
        .map_err(|e| CmError::Rpc(format!("轮询扫码状态失败：{e}")))?;

    let refresh_token = response.refresh_token().to_string();
    let account_name = response.account_name().to_string();
    // Steam 在「未完成」时不报错，只是这两个字段为空 —— 靠它们区分。
    if refresh_token.is_empty() || account_name.is_empty() {
        return Ok(PollOutcome::Pending);
    }
    Ok(PollOutcome::Authorized {
        account_name,
        refresh_token,
    })
}
