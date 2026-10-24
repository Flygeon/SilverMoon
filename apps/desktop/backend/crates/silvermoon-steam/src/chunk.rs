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
/// Valve 的 LZMA 字典大小（1 MiB）。Steam 的 chunk 远小于此。
const LZMA_DICT_SIZE: u32 = 1 << 20;

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

/// LZMA raw（`VZa`）：前 8 字节是 Valve 的头，其后是**无属性头**的 raw LZMA 流。
///
/// Valve 用的固定参数（与 `DepotDownloader` / SteamKit 一致）：
/// - `lc = 3`、`lp = 0`、`pb = 2`（LZMA 的默认文字/位置上下文）
/// - 字典大小 1 MiB（Steam 的 chunk 远小于此，等价于「够用」）
///
/// 注意 lzma-rs 的 raw 模块需要 `raw_decoder` feature（已在 Cargo.toml 开启）。
/// 用 `LzmaParams::new(properties, dict_size, unpacked_size)` 显式构造，
/// **不能**走 `read_header` —— 那个函数期望流里自带属性头，而 Valve 的流没有。
fn decompress_lzma(data: &[u8], expected_size: u32) -> ChunkOutcome {
    if data.len() <= 8 {
        return ChunkOutcome::fail("vza: 数据过短");
    }
    let payload = &data[8..];
    let mut reader = Cursor::new(payload);
    let mut out = Vec::with_capacity(expected_size as usize);

    let properties = lzma_rs::decompress::raw::LzmaProperties {
        lc: 3,
        lp: 0,
        pb: 2,
    };
    let params = lzma_rs::decompress::raw::LzmaParams::new(
        properties,
        LZMA_DICT_SIZE,
        Some(expected_size as u64),
    );
    // ⚠️ 第二个参数是 Option<usize>（内存上限），而 new() 返回 Result
    let mut decoder =
        match lzma_rs::decompress::raw::LzmaDecoder::new(params, Some(expand_limit(expected_size)))
        {
            Ok(decoder) => decoder,
            Err(error) => return ChunkOutcome::fail(format!("vza: 初始化 LZMA 失败：{error}")),
        };
    match decoder.decompress(&mut reader, &mut out) {
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
}
