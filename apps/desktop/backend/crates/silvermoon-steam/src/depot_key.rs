//! **depot 解密密钥**（`CMsgClientGetDepotDecryptionKey`）。
//!
//! ## 为什么需要单独的模块
//!
//! 解密文件名与 chunk 都要 32 字节 depot key。取它要发一条**老式 CM 消息**
//! （不是 service method）：
//!
//! ```text
//! CMsgClientGetDepotDecryptionKey      k_EMsgClientGetDepotDecryptionKey = 5438
//! CMsgClientGetDepotDecryptionKeyResponse                            = 5439
//! ```
//!
//! `steam-vent 0.5` **没有**为这两条消息实现 `NetMessage`，所以 `service_method`
//! 用不了，`job()` 也调不到。
//!
//! ## 解法：自己实现 `NetMessage`
//!
//! 关键事实：`NetMessage: EncodableMessage` 是**公开 trait**，其方法全都有默认实现，
//! 外部 crate 完全可以为自己的类型实现它（`DroidDeck参考`/GameNative 那边是
//! JavaSteam 的 `SteamApps.getDepotDecryptionKey`，走的就是同一条消息）。
//!
//! 于是这里做两个薄包装：
//! - `DepotKeyRequest`  —— 持有 `CMsgClientGetDepotDecryptionKey`，实现 `NetMessage`
//! - `DepotKeyResponse` —— 持有 `CMsgClientGetDepotDecryptionKeyResponse`，实现 `NetMessage`
//!
//! 然后就可以用 `ConnectionTrait::job::<DepotKeyRequest, DepotKeyResponse>()` 发送。
//!
//! ## 与参考实现对齐
//!
//! `GameNative` 的 `GameDownloadService.kt` 里：
//! `steamApps.getDepotDecryptionKey(depotId, owningAppId)` —— 同样是
//! 「depot_id + app_id」两个参数，返回 32 字节 key。

use std::io::Write;

use bytes::BytesMut;
use steam_vent::message::{EncodableMessage, MalformedBody, NetMessageHeader};
use steam_vent::NetMessage;
use steam_vent_proto_common::protobuf::Message as _;
use steam_vent_proto_steam::enums_clientserver::EMsg;
use steam_vent_proto_steam::steammessages_clientserver_2::{
    CMsgClientGetDepotDecryptionKey, CMsgClientGetDepotDecryptionKeyResponse,
};

use crate::cm::{CmError, CmSession};

/// 请求包装：让 `job()` 能发送这条老式消息。
#[derive(Debug)]
pub struct DepotKeyRequest(pub CMsgClientGetDepotDecryptionKey);

impl EncodableMessage for DepotKeyRequest {
    fn write_body<W: Write>(&self, mut writer: W) -> Result<(), std::io::Error> {
        // 老式消息但 body 是 protobuf：IS_PROTOBUF = true 时 steam-vent 直接写 protobuf
        self.0
            .write_to_writer(&mut writer)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))
    }

    fn encode_size(&self) -> usize {
        self.0.compute_size() as usize
    }
}

impl NetMessage for DepotKeyRequest {
    type KindEnum = EMsg;
    const KIND: Self::KindEnum = EMsg::k_EMsgClientGetDepotDecryptionKey;
    const IS_PROTOBUF: bool = true;
}

/// 响应包装。
#[derive(Debug)]
pub struct DepotKeyResponse(pub CMsgClientGetDepotDecryptionKeyResponse);

impl EncodableMessage for DepotKeyResponse {
    fn read_body(data: BytesMut, _header: &NetMessageHeader) -> Result<Self, MalformedBody> {
        CMsgClientGetDepotDecryptionKeyResponse::parse_from_bytes(&data)
            .map(DepotKeyResponse)
            .map_err(|e| MalformedBody::new(Self::KIND, e))
    }
}

impl NetMessage for DepotKeyResponse {
    type KindEnum = EMsg;
    const KIND: Self::KindEnum = EMsg::k_EMsgClientGetDepotDecryptionKeyResponse;
    const IS_PROTOBUF: bool = true;
}

/// 取一个 depot 的解密密钥。
///
/// 返回 32 字节密钥。失败时给出可读原因：
/// - `EResult != OK`：账号没有该 depot 的授权（未购买 / 家庭共享限制）
/// - 长度不是 32：Steam 返回了异常数据
pub async fn fetch_depot_key(
    session: &CmSession,
    app_id: u32,
    depot_id: u32,
) -> Result<Vec<u8>, CmError> {
    let mut request = CMsgClientGetDepotDecryptionKey::new();
    request.set_depot_id(depot_id);
    request.set_app_id(app_id);

    let response: DepotKeyResponse = session
        .job(DepotKeyRequest(request))
        .await
        .map_err(|e| CmError::Rpc(format!("{e}")))?;

    let inner = response.0;
    let eresult = inner.eresult();
    // EResult::OK == 1
    if eresult != 1 {
        return Err(CmError::Rpc(format!(
            "Steam 拒绝提供 depot {depot_id} 的密钥（EResult {eresult}）—— 当前账号可能没有该 depot 的授权"
        )));
    }
    let key = inner.depot_encryption_key().to_vec();
    if key.len() != 32 {
        return Err(CmError::Rpc(format!(
            "depot {depot_id} 的密钥长度是 {}（应为 32）",
            key.len()
        )));
    }
    Ok(key)
}
