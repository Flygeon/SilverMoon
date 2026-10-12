//! WBI 签名（B 站网页端接口的请求签名）。
//!
//! 与前端 `src/utils/bilibili.ts` 的 `mixinFromNav` / `signedQuery` 逐字对齐：
//!
//! 1. 由 `wbi_img.img_url` + `sub_url` 的**文件名**拼出 64 位原文；
//! 2. 按固定置换表 `MIXIN_KEY_ENC_TAB` 取出 32 位 `mixin_key`；
//! 3. 请求参数按 key 升序排序，值先剔除 `!'()*` 再做 URL 编码；
//! 4. 追加 `wts`（秒级时间戳），对 `query + mixin_key` 取 MD5 作为 `w_rid`。

use md5::{Digest, Md5};

/// WBI 混淆表（标准 64 项的前 32 位，与前端 `MIXIN_KEY_ENC_TAB` 逐项一致）。
pub const MIXIN_KEY_ENC_TAB: [usize; 32] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13,
];

/// 签名前要从参数值里剔除的字符（对应前端的 `/[!'()*]/g`）。
const CHR_FILTER: &str = "!'()*";

/// 取 URL 路径最后一段的文件名并去掉扩展名（对应前端 `fileNameOf`）。
pub fn file_name_of(url: &str) -> String {
    let no_query = url.split('?').next().unwrap_or("");
    let name = no_query.rsplit('/').next().unwrap_or("");
    match name.rfind('.') {
        // `dot > 0`：以点开头的隐藏文件名不做截断（与前端一致）
        Some(dot) if dot > 0 => name[..dot].to_string(),
        _ => name.to_string(),
    }
}

/// 由 `img_url` / `sub_url` 推导 mixin key；原文不足 64 位时返回空串（视为失败）。
pub fn mixin_key_from_urls(img_url: &str, sub_url: &str) -> String {
    let orig = format!("{}{}", file_name_of(img_url), file_name_of(sub_url));
    if orig.chars().count() < 64 {
        return String::new();
    }
    let chars: Vec<char> = orig.chars().collect();
    MIXIN_KEY_ENC_TAB
        .iter()
        .map(|&i| chars.get(i).copied().unwrap_or_default())
        .collect()
}

/// 从 `/x/web-interface/nav` 的响应里取 mixin key（该接口无需登录）。
pub fn mixin_key_from_nav(nav: &serde_json::Value) -> String {
    let img = nav.get("data").and_then(|d| d.get("wbi_img"));
    let img_url = img
        .and_then(|i| i.get("img_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let sub_url = img
        .and_then(|i| i.get("sub_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    mixin_key_from_urls(img_url, sub_url)
}

/// 与 `encodeURIComponent` 等价，但先剔除 `!'()*`（WBI 的要求）。
///
/// 剔除后仍需转义的就是「非 `A-Za-z0-9-_.~`」的字符；多字节字符按 UTF-8 逐字节转义，
/// 与 `encodeURIComponent` 的行为一致。
pub fn encode_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if CHR_FILTER.contains(ch) {
            continue;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for b in ch.encode_utf8(&mut buf).as_bytes() {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// 生成签名后的查询串（含 `wts` / `w_rid`）。
///
/// 返回值里的值**已经编码**，拼 URL 时不要再交给会二次编码的工具。
///
/// 空 `mixin_key` 直接返回 `Err`：拿空 key 去签，`w_rid` 必然错误，上游只会回
/// `-352`「风控校验失败」，那会把「密钥没取到」误报成风控。
pub fn signed_query(
    params: &[(String, String)],
    mixin_key: &str,
    wts: u64,
) -> Result<String, String> {
    if mixin_key.is_empty() {
        return Err("WBI 密钥获取失败，无法签名请求（可能被风控或网络异常）".to_string());
    }
    let mut all: Vec<(String, String)> = params.to_vec();
    all.push(("wts".to_string(), wts.to_string()));
    all.sort_by(|a, b| a.0.cmp(&b.0));

    let query = all
        .iter()
        .map(|(k, v)| format!("{}={}", encode_value(k), encode_value(v)))
        .collect::<Vec<_>>()
        .join("&");

    let mut hasher = Md5::new();
    hasher.update(query.as_bytes());
    hasher.update(mixin_key.as_bytes());
    let rid = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    Ok(format!("{}&w_rid={}", query, rid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_of_strips_dir_and_extension() {
        assert_eq!(
            file_name_of("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png"),
            "7cd084941338484aae1ad9425b84077c"
        );
        assert_eq!(file_name_of("https://x/a/b.png?t=1"), "b");
        assert_eq!(file_name_of("noext"), "noext");
    }

    #[test]
    fn mixin_key_matches_canonical_example() {
        // B 站官方文档广泛引用的示例：这两个 URL 推导出的 mixin key 是固定的。
        // 它同时钉住了「置换表没写错」这件事。
        let key = mixin_key_from_urls(
            "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
        );
        assert_eq!(key, "ea1db124af3c7062474693fa704f4ff8");
    }

    #[test]
    fn mixin_key_rejects_short_source() {
        assert_eq!(
            mixin_key_from_urls("https://x/short.png", "https://x/a.png"),
            ""
        );
    }

    #[test]
    fn encode_value_matches_encode_uri_component_with_filter() {
        assert_eq!(encode_value("hello world"), "hello%20world");
        assert_eq!(encode_value("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_value("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode_value("a!b'c(d)e*f"), "abcdef");
        assert_eq!(encode_value("中"), "%E4%B8%AD");
    }

    #[test]
    fn signed_query_is_sorted_and_carries_rid() {
        let params = vec![
            ("bvid".to_string(), "BV1xx411c7mD".to_string()),
            ("aid".to_string(), "123".to_string()),
        ];
        let q = signed_query(&params, "ea1db124af3c7062474693fa704f4ff8", 1700000000).unwrap();
        assert!(q.starts_with("aid=123&bvid=BV1xx411c7mD&wts=1700000000&w_rid="));
        let rid = q.rsplit("w_rid=").next().unwrap();
        assert_eq!(rid.len(), 32, "w_rid 应是 32 位十六进制 MD5");
        assert!(rid
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn signed_query_is_deterministic() {
        let p = vec![("x".to_string(), "1".to_string())];
        let key = "k".repeat(32);
        assert_eq!(
            signed_query(&p, &key, 1).unwrap(),
            signed_query(&p, &key, 1).unwrap()
        );
    }

    #[test]
    fn signed_query_rejects_empty_key() {
        let err = signed_query(&[], "", 1).unwrap_err();
        assert!(
            err.contains("WBI 密钥获取失败"),
            "错误信息要指向真正的原因：{err}"
        );
    }

    #[test]
    fn mixin_key_from_nav_reads_nested_urls() {
        let nav = serde_json::json!({
            "code": 0,
            "data": { "wbi_img": {
                "img_url": "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
                "sub_url": "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
            }}
        });
        assert_eq!(mixin_key_from_nav(&nav), "ea1db124af3c7062474693fa704f4ff8");
        assert_eq!(mixin_key_from_nav(&serde_json::json!({})), "");
    }
}
