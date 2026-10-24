//! **PICS appinfo**：查一款游戏包含哪些 depot。
//!
//! ## 为什么需要它
//!
//! 下载前必须知道「这个 app 有哪些 depot、各自的 manifest gid 是多少」。
//! 这份信息在 PICS（Product Info Cache System）的 appinfo 里，只走 CM 老式消息：
//!
//! ```text
//! CMsgClientPICSProductInfoRequest   k_EMsgClientPICSProductInfoRequest  = 8903
//! CMsgClientPICSProductInfoResponse  k_EMsgClientPICSProductInfoResponse = 8904
//! ```
//!
//! ## 响应是 VDF 文本
//!
//! `buffer` 字段是 Valve 的 KeyValues 文本：
//!
//! ```text
//! appinfo { appid "413150" depots { "413151" { manifests { public { gid "4278..." } } } } }
//! ```
//!
//! 这里配一个极简 VDF 解析器（与 `electron/steam/local.ts` 同构），
//! 只抽 `depots` 下的数字 key 及其 `manifests.public.gid`。

use std::io::Write;

use bytes::BytesMut;
use steam_vent::message::{EncodableMessage, MalformedBody};
use steam_vent::{NetMessage, NetMessageHeader};
use steam_vent_proto_common::protobuf::Message as _;
use steam_vent_proto_steam::enums_clientserver::EMsg;
use steam_vent_proto_steam::steammessages_clientserver_appinfo::{
    cmsg_client_picsproduct_info_request, CMsgClientPICSProductInfoRequest,
    CMsgClientPICSProductInfoResponse,
};

use crate::cm::{CmError, CmSession};

/// 请求包装（老式消息，需自实现 NetMessage 才能用 job 发）。
#[derive(Debug)]
pub struct PicsRequest(pub CMsgClientPICSProductInfoRequest);

impl EncodableMessage for PicsRequest {
    fn write_body<W: Write>(&self, mut writer: W) -> Result<(), std::io::Error> {
        self.0
            .write_to_writer(&mut writer)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))
    }

    fn encode_size(&self) -> usize {
        self.0.compute_size() as usize
    }
}

impl NetMessage for PicsRequest {
    type KindEnum = EMsg;
    const KIND: Self::KindEnum = EMsg::k_EMsgClientPICSProductInfoRequest;
    const IS_PROTOBUF: bool = true;
}

/// 响应包装。
#[derive(Debug)]
pub struct PicsResponse(pub CMsgClientPICSProductInfoResponse);

impl EncodableMessage for PicsResponse {
    fn read_body(data: BytesMut, _header: &NetMessageHeader) -> Result<Self, MalformedBody> {
        CMsgClientPICSProductInfoResponse::parse_from_bytes(&data)
            .map(PicsResponse)
            .map_err(|e| MalformedBody::new(Self::KIND, e))
    }
}

impl NetMessage for PicsResponse {
    type KindEnum = EMsg;
    const KIND: Self::KindEnum = EMsg::k_EMsgClientPICSProductInfoResponse;
    const IS_PROTOBUF: bool = true;
}

/// 一个 depot 及其 public 分支的 manifest gid。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDepot {
    pub depot_id: u32,
    pub manifest_gid: u64,
}

/// 极简 VDF 节点：要么是字符串叶子，要么是子节点集合。
#[derive(Debug, Default, Clone)]
pub struct VdfNode {
    /// 子节点（有序，保留原始顺序）
    pub children: Vec<(String, VdfNode)>,
    /// 叶子值（有子节点时为 None）
    pub value: Option<String>,
}

impl VdfNode {
    fn get(&self, key: &str) -> Option<&VdfNode> {
        let lowered = key.to_ascii_lowercase();
        self.children
            .iter()
            .find(|(k, _)| k.to_ascii_lowercase() == lowered)
            .map(|(_, v)| v)
    }

    fn as_str(&self) -> Option<&str> {
        self.value.as_deref()
    }

    fn entries(&self) -> impl Iterator<Item = (&str, &VdfNode)> {
        self.children.iter().map(|(k, v)| (k.as_str(), v))
    }
}

/**
 * 解析 Valve KeyValues 文本。
 *
 * 单遍扫描，用「待定 key」+ 栈管理嵌套：
 * - 读到带引号的串：若没有待定 key，它是新 key；否则是 `key value` 对，立刻入库
 * - 读到 `{`：用待定 key 开一个新节点，压栈
 * - 读到 `}`：把当前节点挂到父节点上，出栈
 *
 * 这样**不需要**「闭合时回头找空节点」那种容易配错的做法。
 */
pub fn parse_vdf(text: &str) -> VdfNode {
    // 栈元素：(节点名, 节点本身)
    let mut stack: Vec<(Option<String>, VdfNode)> = vec![(None, VdfNode::default())];
    let mut pending_key: Option<String> = None;
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if ch.is_whitespace() {
            index += 1;
            continue;
        }
        // 行注释
        if ch == '/' && index + 1 < chars.len() && chars[index + 1] == '/' {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if ch == '{' {
            let key = pending_key.take().unwrap_or_default();
            stack.push((Some(key), VdfNode::default()));
            index += 1;
            continue;
        }
        if ch == '}' {
            if stack.len() > 1 {
                if let Some((key, node)) = stack.pop() {
                    if let Some((_, parent)) = stack.last_mut() {
                        parent.children.push((key.unwrap_or_default(), node));
                    }
                }
            }
            pending_key = None;
            index += 1;
            continue;
        }
        if ch == '"' {
            let mut value = String::new();
            index += 1;
            while index < chars.len() && chars[index] != '"' {
                if chars[index] == '\\' && index + 1 < chars.len() {
                    value.push(chars[index + 1]);
                    index += 2;
                    continue;
                }
                value.push(chars[index]);
                index += 1;
            }
            index += 1; // 跳过收尾引号
            match pending_key.take() {
                None => pending_key = Some(value),
                Some(key) => {
                    if let Some((_, node)) = stack.last_mut() {
                        node.children.push((
                            key,
                            VdfNode {
                                children: Vec::new(),
                                value: Some(value),
                            },
                        ));
                    }
                }
            }
            continue;
        }
        index += 1;
    }

    // 未闭合的节点：自底向上补挂到父（容错，不 panic）
    while stack.len() > 1 {
        if let Some((key, node)) = stack.pop() {
            if let Some((_, parent)) = stack.last_mut() {
                parent.children.push((key.unwrap_or_default(), node));
            }
        }
    }
    stack.pop().map(|(_, node)| node).unwrap_or_default()
}

/// 从 appinfo 的 VDF 里抽出 depot 列表。
///
/// 只取 `depots` 下「数字 key」，并从其 `manifests.public.gid` 取 gid。
/// 没有 public gid 的（某些 DLC/测试分支）跳过 —— 下不了。
pub fn depots_from_appinfo(node: &VdfNode) -> Vec<AppDepot> {
    let Some(appinfo) = node.get("appinfo") else {
        return Vec::new();
    };
    let Some(depots) = appinfo.get("depots") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (key, value) in depots.entries() {
        let Ok(depot_id) = key.parse::<u32>() else {
            continue; // branches 等非数字 key
        };
        let Some(gid_text) = value
            .get("manifests")
            .and_then(|m| m.get("public"))
            .and_then(|p| p.get("gid"))
            .and_then(|g| g.as_str())
        else {
            continue;
        };
        let Ok(gid) = gid_text.parse::<u64>() else {
            continue;
        };
        out.push(AppDepot {
            depot_id,
            manifest_gid: gid,
        });
    }
    out.sort_by_key(|d| d.depot_id);
    out
}

/// 查某个 app 的 depot 列表。
pub async fn fetch_app_depots(session: &CmSession, app_id: u32) -> Result<Vec<AppDepot>, CmError> {
    let mut app_info = cmsg_client_picsproduct_info_request::AppInfo::new();
    app_info.set_appid(app_id);
    app_info.set_only_public_obsolete(false);

    let mut request = CMsgClientPICSProductInfoRequest::new();
    request.apps.push(app_info);
    request.set_meta_data_only(false);
    request.set_single_response(true);

    let response: PicsResponse = session
        .job(PicsRequest(request))
        .await
        .map_err(|e| CmError::Rpc(format!("{e}")))?;

    for info in &response.0.apps {
        if info.appid() != app_id {
            continue;
        }
        if info.missing_token() {
            return Err(CmError::Rpc(format!(
                "当前账号没有 app {app_id} 的访问权限（未购买或共享受限）"
            )));
        }
        let buffer = info.buffer();
        if buffer.is_empty() {
            return Err(CmError::Rpc(format!("app {app_id} 的 appinfo 为空")));
        }
        let text = String::from_utf8_lossy(buffer);
        let node = parse_vdf(&text);
        let depots = depots_from_appinfo(&node);
        if depots.is_empty() {
            return Err(CmError::Rpc(format!(
                "app {app_id} 的 appinfo 里没有可用 depot"
            )));
        }
        return Ok(depots);
    }
    Err(CmError::Rpc(format!(
        "Steam 未返回 app {app_id} 的 appinfo"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
"appinfo"
{
    "appid"     "413150"
    "common"
    {
        "name"      "Stardew Valley"
    }
    "depots"
    {
        "413151"
        {
            "manifests"
            {
                "public"
                {
                    "gid"       "4278718763097142923"
                }
            }
        }
        "413152"
        {
            "manifests"
            {
                "public"
                {
                    "gid"       "1234567890"
                }
            }
        }
        "branches"
        {
            "public"
            {
                "buildid"   "16826371"
            }
        }
    }
}
"#;

    #[test]
    fn parses_depots_with_public_gid() {
        let node = parse_vdf(SAMPLE);
        let depots = depots_from_appinfo(&node);
        assert_eq!(depots.len(), 2, "应解析出 2 个 depot（branches 不算）");
        assert_eq!(depots[0].depot_id, 413151);
        assert_eq!(depots[0].manifest_gid, 4278718763097142923);
        assert_eq!(depots[1].depot_id, 413152);
    }

    #[test]
    fn skips_depot_without_public_gid() {
        let text = r#""appinfo" { "depots" { "1" { "manifests" { "beta" { "gid" "9" } } } } }"#;
        let node = parse_vdf(text);
        assert!(
            depots_from_appinfo(&node).is_empty(),
            "没有 public gid 应跳过"
        );
    }

    #[test]
    fn missing_depots_yields_empty() {
        let node = parse_vdf(r#""appinfo" { "appid" "1" }"#);
        assert!(depots_from_appinfo(&node).is_empty());
    }

    #[test]
    fn parses_nested_structure() {
        let node = parse_vdf(SAMPLE);
        let appinfo = node.get("appinfo").expect("应有 appinfo");
        let name = appinfo.get("common").and_then(|c| c.get("name"));
        assert_eq!(name.and_then(|n| n.as_str()), Some("Stardew Valley"));
    }

    #[test]
    fn unclosed_braces_do_not_panic() {
        // 少了收尾 } —— 只要求**不 panic**。
        // 不保证能解出内容：未闭合时节点还在栈上，语义上就是不完整的输入，
        // 真实性由 Steam 保证（appinfo 一定是闭合的 VDF）。
        let node =
            parse_vdf(r#""appinfo" { "depots" { "1" { "manifests" { "public" { "gid" "7" } } } }"#);
        let _ = depots_from_appinfo(&node); // 不 panic 即可
                                            // 顶层节点本身仍应存在
        assert!(node.get("appinfo").is_some());
    }
}
