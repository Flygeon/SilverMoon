//! Steam **CM 能力**的命令层。
//!
//! 只暴露下载所必需的能力，并且**全部可降级**。
//!
//! ## 为什么这里只有连接管理
//!
//! 登录 / 游戏库 / 启动 / 详情都在 Electron 侧走纯 HTTPS（见 `electron/steam/`），
//! 不经过 sidecar。真正需要 CM 的只有「自己下载」：
//! `GetManifestRequestCode` 与 `GetCDNAuthToken` 在 WebAPI 上**不存在**（实测 404），
//! 而没有它们，CDN 的 manifest 请求会返回 **401**（实测）。
//!
//! 所以本模块先把「连接」这条地基做出来并验证：连不上，后面一切都是死代码。
//!
//! ## 凭据
//!
//! refresh_token 由 Electron 侧加密保存（`steam-session.json`），调用时传入。
//! 本进程**不落盘任何凭据**。

use std::sync::OnceLock;

use serde::Serialize;
use tokio::runtime::Runtime;

use silvermoon_steam::CmManager;

/// 全局 CM 管理器（懒建立）。
fn manager() -> &'static CmManager {
    static MANAGER: OnceLock<CmManager> = OnceLock::new();
    MANAGER.get_or_init(CmManager::new)
}

/// 后台 tokio 运行时。
///
/// 不能借用命令级的 runtime：CM 连接是**长生命周期**的，读写循环要一直跑；
/// 命令返回后 runtime 被回收，连接随即失效。这里持有一个独立 runtime，
/// 让 CM 会话有稳定的执行环境。
fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("steam-cm")
            .build()
            .expect("无法创建 Steam CM 运行时")
    })
}

/// CM 连接状态。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CmStatus {
    /// 是否已连接
    pub connected: bool,
    /// 最近一次错误（连接失败时给用户看）
    pub error: Option<String>,
}

/// 查询 CM 是否已连接。
#[silvermoon_ipc::command]
pub async fn steam_cm_status() -> Result<CmStatus, String> {
    let connected = runtime().block_on(manager().is_connected());
    Ok(CmStatus {
        connected,
        error: None,
    })
}

/// 用 **access_token（JWT）** 建立 CM 会话。
///
/// 注意参数不是 refresh_token：`Connection::access` 会把 token 当 JWT 解出 steamid，
/// 而 refresh_token 是不透明字符串。调用方（Electron 侧）应先用 refresh_token
/// 换取 access_token 再传进来。
///
/// 失败时把可读原因回给前端（而不是抛裸错误）——「连不上 CM」是**预期内**的网络状况，
/// 不该让界面崩，只需降级成「唤起 Steam 客户端下载」。
#[silvermoon_ipc::command]
pub async fn steam_cm_connect(
    account_name: String,
    access_token: String,
) -> Result<CmStatus, String> {
    let result = runtime().block_on(async {
        manager()
            .get_or_connect(&account_name, &access_token)
            .await
            .map(|guard| guard.is_some())
    });
    Ok(match result {
        Ok(connected) => CmStatus {
            connected,
            error: None,
        },
        Err(error) => CmStatus {
            connected: false,
            error: Some(error.to_string()),
        },
    })
}

/// 断开 CM 会话（登出 / 切换账号）。
#[silvermoon_ipc::command]
pub async fn steam_cm_disconnect() -> Result<CmStatus, String> {
    runtime().block_on(manager().disconnect());
    Ok(CmStatus {
        connected: false,
        error: None,
    })
}
