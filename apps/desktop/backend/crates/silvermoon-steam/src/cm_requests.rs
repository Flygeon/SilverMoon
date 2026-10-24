//! 两个**只能走 CM** 的内容服务请求。
//!
//! | 接口 | 作用 | 为什么要 CM |
//! |---|---|---|
//! | `GetManifestRequestCode` | depot manifest 的访问码 | WebAPI 上**不存在**（实测 404） |
//! | `GetCDNAuthToken` | CDN 拉取的鉴权票据 | 同上；没有它 CDN 返回 401 |
//!
//! 两者都在 `ContentServerDirectory` service 下，属于 `steam-vent-proto-steam`
//! 已生成的类型，直接构造请求即可，不需要自定义 protobuf。

use steam_vent_proto_steam::steammessages_contentsystem_steamclient::{
    CContentServerDirectory_GetCDNAuthToken_Request,
    CContentServerDirectory_GetManifestRequestCode_Request,
};

use crate::cm::{CmError, CmSession};

/// 取 manifest 的 request code。
///
/// 返回 `Ok(0)` 表示「Steam 说这个 depot 这版不需要码」—— 调用方应把 0
/// 直接传给 URL 构造（`manifest_url` 会省略该段）。
///
/// 失败（网络/服务异常）返回 `Err`，调用方可以降级为「不带码尝试」，
/// 但**不能**把 Err 当成 0 静默吞掉 —— 那会让「CDN 401」变成一个无从解释的谜。
pub async fn fetch_manifest_request_code(
    session: &CmSession,
    app_id: u32,
    depot_id: u32,
    manifest_gid: u64,
) -> Result<u64, CmError> {
    let mut request = CContentServerDirectory_GetManifestRequestCode_Request::new();
    request.set_app_id(app_id);
    request.set_depot_id(depot_id);
    request.set_manifest_id(manifest_gid);
    // app_branch 留空 = 默认分支（public）

    let response = session.call(request).await?;
    Ok(response.manifest_request_code())
}

/// 取某个 CDN 节点的拉取票据。
///
/// `host_name` 必须是**裸主机名**（不带 scheme / 端口），
/// Steam 会按 host 绑定票据；传错会让 CDN 一律 401。
pub async fn fetch_cdn_auth_token(
    session: &CmSession,
    app_id: u32,
    depot_id: u32,
    host_name: &str,
) -> Result<String, CmError> {
    if host_name.trim().is_empty() {
        return Err(CmError::Rpc("host_name 为空，无法申请 CDN 票据".into()));
    }
    let mut request = CContentServerDirectory_GetCDNAuthToken_Request::new();
    request.set_app_id(app_id);
    request.set_depot_id(depot_id);
    request.set_host_name(host_name.to_string());

    let response = session.call(request).await?;
    Ok(response.token().to_string())
}
