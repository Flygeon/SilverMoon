//! 与前端 TS 接口同形的数据结构。
//!
//! 字段名一律 `camelCase`（`#[serde(rename_all = "camelCase")]`），与本仓库其余
//! 命令模块一致 —— 前端拿到的 JSON 键必须与 `src/utils/bilibili.ts` 的接口逐字对应，
//! 否则迁移会静默丢字段。

use serde::{Deserialize, Serialize};

/// 账号信息（`/x/web-interface/nav`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliAccount {
    pub is_login: bool,
    pub mid: i64,
    pub name: String,
    pub face: String,
    pub coins: i64,
    pub level: i64,
    pub vip: bool,
}

/// 推荐流 / 搜索结果归一化后的条目。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliVideo {
    pub aid: String,
    pub bvid: String,
    pub cid: String,
    pub title: String,
    pub cover: String,
    /// 秒
    pub duration: f64,
    pub owner_name: String,
    pub owner_face: String,
    pub owner_mid: f64,
    pub view: f64,
    pub danmaku: f64,
    pub like: f64,
    pub pubdate: f64,
    /// 推荐理由
    pub reason: String,
    pub goto: String,
}

/// 分 P。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliPart {
    pub page: i64,
    pub cid: String,
    pub part: String,
    pub duration: f64,
}

/// UP 主。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliOwner {
    pub mid: i64,
    pub name: String,
    pub face: String,
}

/// 统计。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliStat {
    pub view: f64,
    pub danmaku: f64,
    pub reply: f64,
    pub like: f64,
    pub coin: f64,
    pub favorite: f64,
    pub share: f64,
}

/// 视频详情。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliDetail {
    pub bvid: String,
    pub aid: String,
    pub cid: String,
    pub title: String,
    pub desc: String,
    pub cover: String,
    pub duration: f64,
    pub pubdate: f64,
    pub owner: BiliOwner,
    pub stat: BiliStat,
    pub parts: Vec<BiliPart>,
    pub width: f64,
    pub height: f64,
}
