//! 两个**只能走 CM** 的内容服务请求。

use std::io::Write;

use bytes::{Buf, BytesMut};
use steam_vent::message::{EncodableMessage, MalformedBody};
use steam_vent::{NetMessage, NetMessageHeader};
use steam_vent_proto_common::RpcMessage;
use steam_vent_proto_steam::enums_clientserver::EMsg;
use steam_vent_proto_steam::steammessages_contentsystem_steamclient::{
    CContentServerDirectory_GetCDNAuthToken_Request,
    CContentServerDirectory_GetManifestRequestCode_Request,
};

use crate::cm::{CmError, CmSession};

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

async fn call_non_authed<Req>(session: &CmSession, request: Req) -> Result<Req::Response, CmError>
where
    Req: steam_vent::ServiceMethodRequest + Send,
{
    let response: ServiceMethodResponseBody = session.job(ServiceMethodCall(request)).await?;
    response.into_response::<Req>()
}

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

pub async fn fetch_manifest_request_code(
    session: &CmSession,
    app_id: u32,
    depot_id: u32,
    manifest_gid: u64,
) -> Result<u64, CmError> {
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
