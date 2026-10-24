//! 两个**只能走 CM** 的内容服务请求。
//!
//! | 接口 | 作用 | 为什么要 CM |
//! |---|---|---|
//! | GetManifestRequestCode | depot manifest 的访问码 | WebAPI 上**不存在**（实测 404） |
//! | GetCDNAuthToken | CDN 拉取的鉴权票据 | 同上；只在 CDN 回 401/403 时才需要 |
//!
//! 两者都在 ContentServerDirectory service 下，属于 steam-vent-proto-steam
//! 已生成的类型，直接构造请求即可，不需要自定义 protobuf。
//!
//! ## 为什么还要自己包一层消息（NonAuthed 回退）
//!
//! 事故记录（2026-10-24）：这两个 RPC 都被 Steam 回 EResult=2（Fail），
//! 而同一个 CM 会话上的 GetOwnedGames / PICS / GetDepotDecryptionKey 全部正常。
//! steam-vent 的 service_method 只会发 k_EMsgServiceMethodCallFromClient，
//! 没有切换变体的入口；而参考实现 steamdepot 走的是
//! **k_EMsgServiceMethodCallFromClientNonAuthed**，且它在这两个方法上是通的。
//!
//! 所以这里按 steam-vent 的公开扩展点（EncodableMessage / NetMessage）自己包一条消息，
//! 作为**回退**：已登录路径失败后再用 NonAuthed 试一次。
//! 两条路径都失败时，把两边的真实原因都写进错误 —— 只说一句 Fail 等于没说话。
//!
//! header 的形状不用我们操心：steam-vent 的 NetMessageHeader::proto_header
//! 对 NonAuthed 会把 steamid 置 0、realm 置 1（见 steam-vent 的 net.rs），
//! 正是该变体要求的形态。

use std::io::Write;

use bytes::{Buf, BytesMut};
use steam_vent::message::{EncodableMessage, MalformedBody};
// NetMessageHeader 从 **crate 根**取（与 depot_key.rs 同一写法；写成
// steam_vent::message::NetMessageHeader 会报 E0603）。
use steam_vent::{NetMessage, NetMessageHeader};
// RpcMessage::parse 是 trait 方法，不 import 就调不到响应类型的 parse。
use steam_vent_proto_common::RpcMessage;
use steam_vent_proto_steam::enums_clientserver::EMsg;
use steam_vent_proto_steam::steammessages_contentsystem_steamclient::{
    CContentServerDirectory_GetCDNAuthToken_Request,
    CContentServerDirectory_GetManifestRequestCode_Request,
};

use crate::cm::{CmError, CmSession};

/// 一条自己包装的 service method 请求（固定用 NonAuthed 变体）。
///
/// steam-vent 内部的 ServiceMethodMessage 是 pub(crate)，外部拿不到，
/// 所以这里复刻它的三件事：写 protobuf body、报编码长度、把方法名塞进 header。
#[derive(Debug)]
pub struct ServiceMethodCall<Req>(pub Req);

impl<Req> EncodableMessage for ServiceMethodCall<Req>
where
    Req: steam_vent::ServiceMethodRequest + Send,
{
    fn write_body<W: Write>(&self, mut writer: W) -> Result<(), std::io::Error> {
        self.0
            .write(&mut writer)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))
    }

    fn encode_size(&self) -> usize {
        self.0.encode_size()
    }

    /// CM 靠 target_job_name 找 service，缺了它会被当成无名消息丢掉。
    fn process_header(&self, header: &mut NetMessageHeader) {
        header.target_job_name = Some(Req::REQ_NAME.into());
    }
}

impl<Req> NetMessage for ServiceMethodCall<Req>
where
    Req: steam_vent::ServiceMethodRequest + Send,
{
    type KindEnum = EMsg;
    const KIND: Self::KindEnum = EMsg::k_EMsgServiceMethodCallFromClientNonAuthed;
    const IS_PROTOBUF: bool = true;
}

/// service method 的响应外壳。
///
/// steam-vent 的 ServiceMethodResponseMessage 同样是 pub(crate)，所以这里只保留
/// 「方法名 + 原始 body」，解析交给具体请求类型自己（RpcMessage::parse）。
#[derive(Debug)]
pub struct ServiceMethodResponseBody {
    job_name: String,
    body: BytesMut,
}

impl EncodableMessage for ServiceMethodResponseBody {
    fn read_body(data: BytesMut, header: &NetMessageHeader) -> Result<Self, MalformedBody> {
        Ok(Self {
            job_name: header
                .target_job_name
                .as_deref()
                .unwrap_or_default()
                .to_string(),
            body: data,
        })
    }
}

impl NetMessage for ServiceMethodResponseBody {
    type KindEnum = EMsg;
    const KIND: Self::KindEnum = EMsg::k_EMsgServiceMethodResponse;
    const IS_PROTOBUF: bool = true;
}

impl ServiceMethodResponseBody {
    /// 按请求类型解析响应体。
    ///
    /// 方法名不匹配就明确报错：那说明这条响应不是我们要的
    /// （job id 撞车 / 方法名写错），此时解出来的字段全是垃圾，
    /// 静默接受只会让错误跑到很远的地方才炸。
    fn into_response<Req: steam_vent::ServiceMethodRequest>(
        self,
    ) -> Result<Req::Response, CmError> {
        if self.job_name != Req::REQ_NAME {
            return Err(CmError::Rpc(format!(
                "服务方法名不匹配：期望 {}，收到 {}",
                Req::REQ_NAME,
                self.job_name
            )));
        }
        let mut reader = self.body.reader();
        Req::Response::parse(&mut reader)
            .map_err(|e| CmError::Rpc(format!("解析 {} 的响应失败：{e}", Req::REQ_NAME)))
    }
}

/// 以 NonAuthed 变体发一次 service method。
async fn call_non_authed<Req>(session: &CmSession, request: Req) -> Result<Req::Response, CmError>
where
    Req: steam_vent::ServiceMethodRequest + Send,
{
    let response: ServiceMethodResponseBody = session.job(ServiceMethodCall(request)).await?;
    response.into_response::<Req>()
}

/// 先走已登录路径，失败再用 NonAuthed 回退；两条都失败则合并原因。
///
/// 第二个参数是「构造函数」而不是「请求值」：请求类型不一定实现 Clone，
/// 而且每条路径都要一份全新的请求体，传值反而要额外约束。
async fn call_with_non_authed_fallback<Req, F>(
    session: &CmSession,
    request: F,
    label: &str,
) -> Result<Req::Response, CmError>
where
    Req: steam_vent::ServiceMethodRequest + Send,
    F: Fn() -> Req,
{
    match session.call(request()).await {
        Ok(response) => Ok(response),
        Err(first) => match call_non_authed(session, request()).await {
            Ok(response) => Ok(response),
            Err(second) => Err(CmError::Rpc(format!(
                "{label} 失败：已登录路径「{first}」；NonAuthed 路径「{second}」"
            ))),
        },
    }
}

/// 取 manifest 的 request code。
///
/// ## 返回值语义（别把它当成「有码」）
///
/// - 非 0：Steam 给了码，拼进 URL 的 /5/<code> 段。
/// - **0**：Steam **答复了**，但码是 0。这不是「不需要码」，而是「这个 depot
///   这版没有码」—— 实测不带码时 CDN 对每个节点都回 401，
///   所以拿到 0 基本等于下不了。调用方应把它当成**可疑**并写进错误文案
///   （参考实现 GameNative 的注释：a zero code is not harmless）。
/// - Err：请求本身失败。**绝不能**当成 0 静默吞掉 ——
///   那会让「Steam 拒绝发码」伪装成一个莫名其妙的「CDN 401」。
pub async fn fetch_manifest_request_code(
    session: &CmSession,
    app_id: u32,
    depot_id: u32,
    manifest_gid: u64,
) -> Result<u64, CmError> {
    // app_branch 留空 = 默认分支（public）。
    //
    // 刻意**不**改成 "public"：本次事故里 GetCDNAuthToken 也一起失败，
    // 而它根本没有 branch 字段 —— 所以分支不可能是共同原因，
    // 在没有证据的情况下改它只是增加变量。
    let make_request = || {
        let mut request = CContentServerDirectory_GetManifestRequestCode_Request::new();
        request.set_app_id(app_id);
        request.set_depot_id(depot_id);
        request.set_manifest_id(manifest_gid);
        request
    };

    let label = format!(
        "GetManifestRequestCode（app {app_id} / depot {depot_id} / manifest {manifest_gid}）"
    );
    let response = call_with_non_authed_fallback(session, make_request, &label).await?;
    Ok(response.manifest_request_code())
}

/// 取某个 CDN 节点的拉取票据。
///
/// **只在 CDN 回 401/403 时才需要调用**：公开 depot 的 manifest 拿到
/// request code 就能取，票据是给「账号授权内容」用的额外一层。
/// 早先每个 depot 都先把 10 个节点的票据申请一遍，等于把可选步骤变成硬前置。
///
/// host_name 必须是**裸主机名**（不带 scheme / 端口），
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
    let make_request = || {
        let mut request = CContentServerDirectory_GetCDNAuthToken_Request::new();
        request.set_app_id(app_id);
        request.set_depot_id(depot_id);
        request.set_host_name(host_name.to_string());
        request
    };

    let label = format!("GetCDNAuthToken（app {app_id} / depot {depot_id} / host {host_name}）");
    let response = call_with_non_authed_fallback(session, make_request, &label).await?;
    Ok(response.token().to_string())
}
