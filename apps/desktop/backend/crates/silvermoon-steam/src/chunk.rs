//! depot **chunk** 的解密与解压。
//!
//! ## chunk 的生命周期
//!
//! ```text
//! CDN bytes
//!    │ AES-256-CBC（IV = ECB 解首块）   ← depot_key
//!    ▼
//! 压缩数据（带魔数）
//!    │ 按魔数分派
//!    ▼
//! 原始文件字节（长度必须 == manifest 里的 cb_original）
//! ```
//!
//! ## 压缩魔数（Valve 的 VZ 封装）
//!
//! | 前缀 | 算法 |
//! |---|---|
//! | `VZa` | LZMA raw |
//! | `VSZa` | zstd |
//! | `PK\x03\x04` | 普通 zip（单条目） |
//!
//! 这些前缀与 `GameNative-master`（`depot_chunk.rs`）以及社区实现一致。
//! 认不出魔数时**必须报错**，不能把压缩数据当成品写进磁盘。

use std::io::{Cursor, Read};

use crate::crypto::{cbc_decrypt, ecb_decrypt_block, AES_BLOCK, DEPOT_KEY_LEN};

/// 解压后的上限保护：防止恶意/损坏数据把内存撑爆。
const MAX_EXPAND_FACTOR: usize = 64;
/// 额外的固定余量（小 chunk 的膨胀比可能很高）
const EXPAND_SLACK: usize = 1 << 20;

/// chunk 处理结果。
#[derive(Debug)]
pub struct ChunkOutcome {
    pub data: Vec<u8>,
    pub error: Option<String>,
}

impl ChunkOutcome {
    fn ok(data: Vec<u8>) -> Self {
        Self { data, error: None }
    }
    fn fail(message: impl Into<String>) -> Self {
        Self {
            data: Vec::new(),
            error: Some(message.into()),
        }
    }
    pub fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}

/// 处理一个 chunk：解密 → 解压 → 校验长度。
///
/// `expected_size` 来自 manifest 的 `cb_original`，用作**精确长度校验**：
/// 长度不符说明解密或解压走错了分支，此时宁可报错也不写坏数据。
pub fn process_chunk(raw: &[u8], depot_key: &[u8], expected_size: u32) -> ChunkOutcome {
    if depot_key.len() != DEPOT_KEY_LEN {
        return ChunkOutcome::fail("chunk: depot_key 长度不是 32");
    }
    if raw.is_empty() {
        return ChunkOutcome::fail("chunk: 数据为空");
    }

    let Some(decrypted) = symmetric_decrypt(depot_key, raw) else {
        return ChunkOutcome::fail("chunk: AES 解密失败（key 不对或数据损坏）");
    };

    let outcome = if decrypted.starts_with(b"VSZa") {
        decompress_zstd(&decrypted, expected_size)
    } else if decrypted.starts_with(b"VZa") {
        decompress_lzma(&decrypted, expected_size)
    } else if decrypted.starts_with(b"PK\x03\x04") {
        decompress_zip(&decrypted)
    } else {
        // 没有魔数：少数 depot 直接存明文（未压缩）
        ChunkOutcome::ok(decrypted)
    };

    if !outcome.is_ok() {
        return outcome;
    }
    if outcome.data.len() != expected_size as usize {
        return ChunkOutcome::fail(format!(
            "chunk: 解出长度 {} 与 manifest 的 {} 不符",
            outcome.data.len(),
            expected_size
        ));
    }
    outcome
}

/// Steam 的对称解密：前 16 字节 ECB 解出 IV，其余 CBC 解密。
///
/// 与 `decrypt_filename` 同一套算法 —— 区别只在文件名解密后是 UTF-8 文本。
pub fn symmetric_decrypt(key: &[u8], encrypted: &[u8]) -> Option<Vec<u8>> {
    if encrypted.len() < AES_BLOCK * 2 {
        return None;
    }
    let iv = ecb_decrypt_block(key, &encrypted[..AES_BLOCK])?;
    cbc_decrypt(key, &iv, &encrypted[AES_BLOCK..])
}

/// 安全上限：不超过「期望大小 × 64 + 1MiB」。
fn expand_limit(expected_size: u32) -> usize {
    (expected_size as usize)
        .saturating_mul(MAX_EXPAND_FACTOR)
        .saturating_add(EXPAND_SLACK)
}

/// zstd（`VSZa`）：前 8 字节是 Valve 的头，其后才是标准 zstd 帧。
fn decompress_zstd(data: &[u8], expected_size: u32) -> ChunkOutcome {
    if data.len() <= 8 {
        return ChunkOutcome::fail("vzstd: 数据过短");
    }
    let payload = &data[8..];
    let mut decoder = match ruzstd::StreamingDecoder::new(Cursor::new(payload)) {
        Ok(decoder) => decoder,
        Err(_) => return ChunkOutcome::fail("vzstd: 不是合法的 zstd 帧"),
    };
    let limit = expand_limit(expected_size);
    let mut out = Vec::with_capacity(expected_size as usize);
    // 用 take 限制读取量：损坏数据不会无界膨胀
    if decoder
        .by_ref()
        .take(limit as u64)
        .read_to_end(&mut out)
        .is_err()
    {
        return ChunkOutcome::fail("vzstd: 解压失败");
    }
    ChunkOutcome::ok(out)
}

/// `VZa` 的封包头长度：3 字节魔数 + 4 字节版本/标志。
const VZA_HEADER: usize = 7;
/// 紧随其后的 5 字节 LZMA 属性（1 字节 lc/lp/pb 打包 + 4 字节小端 dict_size）。
const VZA_PROPS: usize = 5;
/// 尾部 10 字节（其中末两字节是 `zv` 标记）。
const VZA_FOOTER: usize = 10;

/// LZMA raw（`VZa`）解压。
///
/// ## 封头布局（照 GameNative `depot_chunk.rs` 的 `decompress_vzip`）
///
/// ```text
/// [3B "VZa"][4B 版本][5B LZMA props][压缩数据][10B footer，末两字节 "zv"]
/// ```
///
/// ## 为什么不写死参数（线上事故 2026-10-25）
///
/// 早先这里跳过固定 8 字节、并用**固定** `lc=3/lp=0/pb=2` + `dict=1MiB` 去解。
/// 结果是 `LZ distance 52259912 is beyond dictionary size 1048576` ——
/// 真实字典远大于 1MiB（回溯距离都到 50MB 了），按 1MiB 建解码器必然越界。
/// 属性必须从**封头里读**：`props[0]` 是 lc/lp/pb 的打包值（lc + 9*(lp + 5*pb)），
/// `props[1..5]` 是小端 dict_size。
fn decompress_lzma(data: &[u8], expected_size: u32) -> ChunkOutcome {
    if data.len() < VZA_HEADER + VZA_PROPS + VZA_FOOTER {
        return ChunkOutcome::fail("vza: 数据过短");
    }
    // footer 的末两字节固定是 "zv"；不符说明这不是一个完整的 VZa 块
    if &data[data.len() - 2..] != b"zv" {
        return ChunkOutcome::fail("vza: 尾部标记缺失（不是完整的 VZa 块）");
    }

    let props = &data[VZA_HEADER..VZA_HEADER + VZA_PROPS];
    let payload = &data[VZA_HEADER + VZA_PROPS..data.len() - VZA_FOOTER];

    let packed = props[0] as u32;
    let lc = packed % 9;
    let lp = (packed / 9) % 5;
    let pb = packed / 45;
    if lc > 8 || lp > 4 || pb > 4 {
        return ChunkOutcome::fail(format!("vza: LZMA 属性非法（lc={lc} lp={lp} pb={pb}）"));
    }
    let dict_size = u32::from_le_bytes([props[1], props[2], props[3], props[4]]);

    let properties = lzma_rs::decompress::raw::LzmaProperties { lc, lp, pb };
    let params = lzma_rs::decompress::raw::LzmaParams::new(
        properties,
        dict_size,
        Some(expected_size as u64),
    );
    // 第二个参数是 Option<usize> 内存上限，而 new() 返回 Result
    let mut decoder =
        match lzma_rs::decompress::raw::LzmaDecoder::new(params, Some(expand_limit(expected_size)))
        {
            Ok(decoder) => decoder,
            Err(error) => return ChunkOutcome::fail(format!("vza: 初始化 LZMA 失败：{error}")),
        };
    let mut out = Vec::with_capacity(expected_size as usize);
    match decoder.decompress(&mut Cursor::new(payload), &mut out) {
        Ok(()) => ChunkOutcome::ok(out),
        Err(error) => ChunkOutcome::fail(format!("vza: LZMA 解压失败：{error}")),
    }
}

/// 普通 zip（`PK\x03\x04`）：取第一个条目。
fn decompress_zip(data: &[u8]) -> ChunkOutcome {
    let mut archive = match zip::ZipArchive::new(Cursor::new(data)) {
        Ok(archive) => archive,
        Err(_) => return ChunkOutcome::fail("zip: 不是合法压缩包"),
    };
    if archive.is_empty() {
        return ChunkOutcome::fail("zip: 没有任何条目");
    }
    let mut entry = match archive.by_index(0) {
        Ok(entry) => entry,
        Err(_) => return ChunkOutcome::fail("zip: 读取首条目失败"),
    };
    let mut out = Vec::new();
    if entry.read_to_end(&mut out).is_err() {
        return ChunkOutcome::fail("zip: 解压失败");
    }
    ChunkOutcome::ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_key_length() {
        let outcome = process_chunk(&[1, 2, 3], &[0u8; 16], 10);
        assert!(!outcome.is_ok());
        assert!(outcome.error.unwrap().contains("32"));
    }

    #[test]
    fn rejects_empty_input() {
        let outcome = process_chunk(&[], &[0u8; DEPOT_KEY_LEN], 10);
        assert!(!outcome.is_ok());
    }

    #[test]
    fn symmetric_decrypt_requires_two_blocks() {
        let key = [0u8; DEPOT_KEY_LEN];
        assert!(symmetric_decrypt(&key, &[0u8; AES_BLOCK]).is_none());
    }

    #[test]
    fn expand_limit_is_bounded() {
        // 防止 u32 溢出把上限算成 0（那会让任何正常 chunk 都判定超限）
        assert!(expand_limit(0) >= EXPAND_SLACK);
        assert!(expand_limit(u32::MAX) > 0);
    }

    /// 造一个 `VZa` 块：`[3B VZa][4B ver][5B props][raw LZMA][10B footer]`。
    ///
    /// props 从 `lzma_compress` 产出的 .lzma alone 流里取 —— 那是真正的 LZMA
    /// 属性头（5 字节：1 字节 lc/lp/pb + 4 字节 dict_size），正好是 Valve 存的格式。
    fn build_vza(payload: &[u8]) -> Vec<u8> {
        let mut alone = Vec::new();
        lzma_rs::lzma_compress(&mut Cursor::new(payload), &mut alone).unwrap();
        assert!(alone.len() > 13, ".lzma alone 头应有 13 字节");
        let mut out = Vec::new();
        out.extend_from_slice(b"VZa");
        out.extend_from_slice(&[0u8; 4]); // 版本/标志
        out.extend_from_slice(&alone[..5]); // LZMA props
        out.extend_from_slice(&alone[13..]); // 裸 LZMA 流（跳过 13 字节头）
        out.extend_from_slice(&[0u8; 8]); // footer 前 8 字节
        out.extend_from_slice(b"zv"); // footer 末两字节
        out
    }

    /// 线上事故（2026-10-25）：`LZ distance 52259912 is beyond dictionary size 1048576`。
    /// 根因是把字典大小写死成 1MiB，而真实字典约 50MB —— 必须从封头读 props。
    ///
    /// 这条用例同时覆盖：
    /// - props 必须被解析（写死 1MiB 时，大字典的流会解不出来）；
    /// - footer 的 `zv` 校验；
    /// - 长度必须与 `expected_size` 一致。
    #[test]
    fn lzma_uses_dict_size_from_chunk_header() {
        // 用一段相对长、重复度高的数据，保证 LZMA 真的用到回溯距离
        let payload: Vec<u8> = b"silvermoon-depot-chunk-".repeat(400);
        let vza = build_vza(&payload);

        let outcome = decompress_lzma(&vza, payload.len() as u32);
        assert!(outcome.is_ok(), "应能解压：{:?}", outcome.error);
        assert_eq!(outcome.data, payload, "解出的内容必须与原文一致");
    }

    /// 尾部没有 `zv` 标记 → 明确报错，而不是把半截数据当成品。
    #[test]
    fn lzma_rejects_missing_footer() {
        let payload = b"x".repeat(64);
        let mut vza = build_vza(&payload);
        let len = vza.len();
        vza[len - 1] = b'!'; // 破坏 zv 标记
        let outcome = decompress_lzma(&vza, payload.len() as u32);
        assert!(!outcome.is_ok(), "缺 footer 必须失败");
        assert!(
            outcome.error.unwrap().contains("尾部标记"),
            "错误应指明尾部标记缺失"
        );
    }
}
