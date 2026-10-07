//! 上游 JSON → 模型。
//!
//! 目前只覆盖**列表型**条目（推荐流 / 搜索结果）——它们字段最多、最容易写错，
//! 且被多个页面共用。详情 / 取流 / 评论等解析随对应命令一起迁移，
//! 迁移时**必须在同一提交里删掉前端的同名函数**，否则又变成两套。

use serde_json::Value;

use crate::model::BiliVideo;
use crate::text::{clock_or_num, image_url, num, str_of, str_or, strip_html};

/// `m.aid ?? m.id`：aid 为 null / 缺失时退回 id。
fn pick_id(m: &Value) -> String {
    match m.get("aid") {
        Some(v) if !v.is_null() => str_of(v),
        _ => m.get("id").map(str_of).unwrap_or_default(),
    }
}

/// 推荐流条目归一化。
pub fn video_from_feed(m: &Value) -> BiliVideo {
    let owner = m.get("owner");
    let stat = m.get("stat");
    let reason = m.get("rcmd_reason");
    let get = |v: Option<&Value>, k: &str| -> Option<Value> { v.and_then(|o| o.get(k)).cloned() };
    BiliVideo {
        aid: pick_id(m),
        bvid: str_of(m.get("bvid").unwrap_or(&Value::Null)),
        cid: str_of(m.get("cid").unwrap_or(&Value::Null)),
        title: strip_html(&str_of(m.get("title").unwrap_or(&Value::Null))),
        cover: image_url(m.get("pic").unwrap_or(&Value::Null)),
        duration: num(m.get("duration").unwrap_or(&Value::Null)),
        owner_name: str_of(&get(owner, "name").unwrap_or(Value::Null)),
        owner_face: image_url(&get(owner, "face").unwrap_or(Value::Null)),
        owner_mid: num(&get(owner, "mid").unwrap_or(Value::Null)),
        view: num(&get(stat, "view").unwrap_or(Value::Null)),
        danmaku: num(&get(stat, "danmaku").unwrap_or(Value::Null)),
        like: num(&get(stat, "like").unwrap_or(Value::Null)),
        pubdate: num(m.get("pubdate").unwrap_or(&Value::Null)),
        reason: str_of(&get(reason, "content").unwrap_or(Value::Null)),
        goto: str_or(m.get("goto").unwrap_or(&Value::Null), "av"),
    }
}

/// 搜索结果条目归一化。
pub fn video_from_search(m: &Value) -> BiliVideo {
    let video_review = m.get("video_review").unwrap_or(&Value::Null);
    let danmaku_raw = if video_review.is_null() {
        m.get("danmaku").unwrap_or(&Value::Null)
    } else {
        video_review
    };
    BiliVideo {
        aid: str_of(m.get("id").unwrap_or(&Value::Null)),
        bvid: str_of(m.get("bvid").unwrap_or(&Value::Null)),
        cid: String::new(),
        title: strip_html(&str_of(m.get("title").unwrap_or(&Value::Null))),
        cover: image_url(m.get("pic").unwrap_or(&Value::Null)),
        duration: clock_or_num(m.get("duration").unwrap_or(&Value::Null)) as f64,
        owner_name: str_of(m.get("author").unwrap_or(&Value::Null)),
        owner_face: String::new(),
        owner_mid: num(m.get("mid").unwrap_or(&Value::Null)),
        view: num(m.get("play").unwrap_or(&Value::Null)),
        danmaku: num(danmaku_raw),
        like: num(m.get("like").unwrap_or(&Value::Null)),
        pubdate: num(m.get("senddate").unwrap_or(&Value::Null)),
        reason: String::new(),
        goto: "av".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn feed_entry_maps_all_fields() {
        let m = json!({
            "id": 111,
            "bvid": "BV1xx411c7mD",
            "cid": 222,
            "title": "<em class="keyword">标题</em>",
            "pic": "//i0.hdslb.com/a.jpg",
            "duration": 125,
            "owner": { "name": "UP", "face": "http://i0.hdslb.com/f.jpg", "mid": 9 },
            "stat": { "view": 1000, "danmaku": 20, "like": 30 },
            "pubdate": 1700000000,
            "rcmd_reason": { "content": "因为你看了" },
            "goto": "av"
        });
        let v = video_from_feed(&m);
        assert_eq!(v.aid, "111", "aid 缺失时退回 id");
        assert_eq!(v.bvid, "BV1xx411c7mD");
        assert_eq!(v.title, "标题");
        assert_eq!(v.cover, "https://i0.hdslb.com/a.jpg");
        assert_eq!(v.duration, 125.0);
        assert_eq!(v.owner_name, "UP");
        assert_eq!(v.owner_face, "https://i0.hdslb.com/f.jpg");
        assert_eq!(v.owner_mid, 9.0);
        assert_eq!(v.view, 1000.0);
        assert_eq!(v.reason, "因为你看了");
    }

    #[test]
    fn feed_prefers_aid_over_id() {
        let m = json!({ "aid": 5, "id": 6 });
        assert_eq!(video_from_feed(&m).aid, "5");
        // aid 为 null 时退回 id
        let m2 = json!({ "aid": null, "id": 6 });
        assert_eq!(video_from_feed(&m2).aid, "6");
    }

    #[test]
    fn feed_defaults_goto_to_av() {
        assert_eq!(video_from_feed(&json!({})).goto, "av");
        assert_eq!(
            video_from_feed(&json!({ "goto": "bangumi" })).goto,
            "bangumi"
        );
    }

    #[test]
    fn feed_tolerates_missing_nested_objects() {
        let v = video_from_feed(&json!({ "title": "t" }));
        assert_eq!(v.title, "t");
        assert_eq!(v.owner_name, "");
        assert_eq!(v.view, 0.0);
        assert_eq!(v.cover, "");
    }

    #[test]
    fn search_entry_maps_fields_and_parses_clock_duration() {
        let m = json!({
            "id": 7,
            "bvid": "BV1yy411c7mE",
            "title": "标题",
            "pic": "http://i0.hdslb.com/b.jpg",
            "duration": "12:34",
            "author": "作者",
            "mid": 8,
            "play": 42,
            "video_review": 3,
            "like": 1,
            "senddate": 1699999999
        });
        let v = video_from_search(&m);
        assert_eq!(v.aid, "7");
        assert_eq!(v.duration, 754.0, ""12:34" 应换算成秒");
        assert_eq!(v.owner_name, "作者");
        assert_eq!(v.danmaku, 3.0);
        assert_eq!(v.cid, "");
        assert_eq!(v.goto, "av");
    }

    #[test]
    fn search_falls_back_to_danmaku_when_video_review_absent() {
        let m = json!({ "id": 1, "danmaku": 12 });
        assert_eq!(video_from_search(&m).danmaku, 12.0);
    }
}
