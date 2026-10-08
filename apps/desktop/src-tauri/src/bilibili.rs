//! B 站命令层：网络在本模块，协议（签名 / 解析 / 归一化）在 `silvermoon-bili` crate。
//!
//! ## 为什么迁
//!
//! 迁移前，B 站客户端整个在渲染进程的 TypeScript 里
//! （`apps/desktop/src/utils/bilibili.ts`，约 2400 行），而网易云 / 酷狗 / Pixiv /
//! 番剧 / 小说的同类客户端都在 Rust。签名、弹幕解析这类**纯计算**占用渲染主线程
//! 与 JS 堆，且无法单测。本模块按其余平台客户端的同一约定：**重活进 Rust**。
//!
//! ## 迁移节奏
//!
//! 本文件先实现**弹幕**这一条完整链路。其余接口按同一模式逐个迁移，且
//! **每迁一个就在同一提交里删掉前端的同名实现**，避免长期并存两套逻辑
//! （那正是这次要消除的问题）。
//!
//! 选弹幕先迁的理由：单次 GET + 纯解析，无登录态耦合；收益明确
//! （渲染主线程不再解析几千条 XML），且失败可降级（拿到空数组即不显示弹幕）。

use std::io::Read;
use std::sync::OnceLock;

use silvermoon_bili::Danmaku;

/// 与前端 `UA` 常量保持一致（上游对 UA 有形态校验）。
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 弹幕接口（返回 XML，或经 deflate 压缩的 XML）。
const DM_LIST: &str = "https://api.bilibili.com/x/v1/dm/list.so";

/// 视频站 Referer（与前端 `VIDEO_REFERER` 一致）。
const VIDEO_REFERER: &str = "https://www.bilibili.com";

fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            // 与 netease.rs 同约定：忽略系统代理，避免代理不可用时的 tunnel error
            .no_proxy()
            .build()
            .expect("bilibili http client")
    })
}

/// 拉取并解析弹幕。
///
/// `cid` 为空直接返回空数组；网络失败返回 `Err` 由前端降级为「不显示弹幕」，
/// 不影响播放（与前端原先的 `catch { return [] }` 语义一致）。
#[tauri::command]
pub async fn bili_danmaku(cid: String) -> Result<Vec<Danmaku>, String> {
    tauri::async_runtime::spawn_blocking(move || bili_danmaku_sync(&cid))
        .await
        .map_err(|e| format!("B 站弹幕请求异常：{e}"))?
}

fn bili_danmaku_sync(cid: &str) -> Result<Vec<Danmaku>, String> {
    if cid.is_empty() {
        return Ok(Vec::new());
    }
    let resp = client()
        .get(DM_LIST)
        .query(&[("oid", cid)])
        .header("User-Agent", UA)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Referer", VIDEO_REFERER)
        .send()
        .map_err(|e| format!("B 站弹幕请求失败：{e}"))?;

    let bytes = resp.bytes().map_err(|e| format!("B 站弹幕读取失败：{e}"))?;

    let text = decode_payload(&bytes);
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(silvermoon_bili::parse_danmaku_xml(&text))
}

/// 响应体 → XML 文本。
///
/// 上游可能直接返回 XML，也可能返回压缩体；历史上 zlib / gzip / raw-deflate
/// 三种都出现过（前端用 fflate 的 `decompressSync` 一次性兜住）。这里依次尝试，
/// 全部失败则返回空串（调用方视为无弹幕）。
fn decode_payload(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        if s.contains("<d ") || s.contains("<?xml") {
            return s.to_string();
        }
    }
    for out in [try_zlib(bytes), try_gzip(bytes), try_raw_deflate(bytes)]
        .into_iter()
        .flatten()
    {
        if let Ok(s) = String::from_utf8(out) {
            return s;
        }
    }
    String::new()
}

/// 解压失败或结果为空都返回 `None`（交给下一种编码尝试）。
fn try_zlib(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(bytes)
        .read_to_end(&mut out)
        .ok()?;
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn try_gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .ok()?;
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn try_raw_deflate(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(bytes)
        .read_to_end(&mut out)
        .ok()?;
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_xml_passes_through() {
        let xml = r#"<i><d p="1,1,25,16777215,0,0,0,0">hi</d></i>"#;
        assert!(decode_payload(xml.as_bytes()).contains("<d "));
    }

    #[test]
    fn zlib_payload_is_decoded() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let xml = r#"<i><d p="1,1,25,16777215,0,0,0,0">zipped</d></i>"#;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(xml.as_bytes()).unwrap();
        let packed = enc.finish().unwrap();

        let text = decode_payload(&packed);
        assert!(text.contains("zipped"), "zlib 体应被解出：{text}");
        assert_eq!(silvermoon_bili::parse_danmaku_xml(&text).len(), 1);
    }

    #[test]
    fn garbage_yields_empty_text() {
        assert_eq!(decode_payload(&[0xff, 0xfe, 0xfd]), "");
        assert_eq!(decode_payload(b""), "");
    }
}
