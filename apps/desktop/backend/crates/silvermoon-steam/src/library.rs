//! **游戏库**（走 CM，而不是 WebAPI）。
//!
//! ## 为什么搬到 CM
//!
//! 原实现调 HTTPS `IPlayerService/GetOwnedGames/v1/`，需要 WebAPI 的 access_token。
//! 但那个 token 来自**网页扫码登录**，与 CM 登录是两套凭据 —— 用户要扫两次码。
//!
//! CM 本身就提供同一个接口（`CPlayer_GetOwnedGames_Request`）。放在 CM 侧之后：
//!
//! - **一次扫码**即可同时拿到「游戏库」与「下载」两种能力；
//! - 不再需要 WebAPI access_token 那条链路；
//! - 详情 / 成就本来就**不需要登录**（商店 API 与社区 XML 都是公开的），保持原样。
//!
//! ## 与 WebAPI 版的字段对应
//!
//! | CM 字段 | 前端字段 | 说明 |
//! |---|---|---|
//! | `appid` | `appId` | |
//! | `name` | `name` | |
//! | `playtime_forever` | `playtimeMinutes` | 分钟 |
//! | `playtime_2weeks` | `playtimeTwoWeeksMinutes` | |
//! | `img_icon_url` | `iconHash` | 哈希，前端拼 CDN |
//!
//! 注意 `img_icon_url` 是**哈希**不是完整 URL，拼法与 WebAPI 版一致。

use steam_vent_proto_steam::steammessages_player_steamclient::CPlayer_GetOwnedGames_Request;

use crate::cm::{CmError, CmSession};

/// 一款已拥有的游戏。
#[derive(Debug, Clone, Default)]
pub struct OwnedGame {
    pub app_id: u32,
    pub name: String,
    pub playtime_minutes: u32,
    pub playtime_two_weeks_minutes: u32,
    /// 图标哈希（不是 URL）
    pub icon_hash: String,
    pub has_community_stats: bool,
}

/// 查当前账号拥有的全部游戏。
///
/// `language` 传给 Steam 用于本地化游戏名（如 `schinese`）。
pub async fn fetch_owned_games(
    session: &CmSession,
    language: &str,
) -> Result<Vec<OwnedGame>, CmError> {
    let steam_id = session.steam_id();
    let mut request = CPlayer_GetOwnedGames_Request::new();
    request.set_steamid(steam_id);
    request.set_include_appinfo(true);
    request.set_include_played_free_games(true);

    let response = session.call(request).await?;

    let mut out = Vec::with_capacity(response.games.len());
    for game in &response.games {
        let app_id = game.appid().max(0) as u32;
        if app_id == 0 {
            continue;
        }
        out.push(OwnedGame {
            app_id,
            name: {
                let raw = game.name().to_string();
                if raw.is_empty() {
                    format!("App {app_id}")
                } else {
                    raw
                }
            },
            playtime_minutes: game.playtime_forever().max(0) as u32,
            playtime_two_weeks_minutes: game.playtime_2weeks().max(0) as u32,
            icon_hash: game.img_icon_url().to_string(),
            has_community_stats: game.has_community_visible_stats(),
        });
    }

    // 最近玩过的排前面（与 WebAPI 版一致：没有 last_played 字段时，
    // 用 playtime_2weeks 作为「最近活跃」的近似）
    out.sort_by(|a, b| {
        b.playtime_two_weeks_minutes
            .cmp(&a.playtime_two_weeks_minutes)
            .then_with(|| b.playtime_minutes.cmp(&a.playtime_minutes))
    });
    let _ = language; // 预留：CM 版暂不支持按语言本地化游戏名
    Ok(out)
}
