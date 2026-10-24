//! Steam depot 的**加密原语**。
//!
//! ## 需要哪几种算法
//!
//! | 用途 | 算法 | 密钥来源 |
//! |---|---|---|
//! | 文件名解密 | AES-256-CBC（IV 由 ECB 解首块得到） | depot_key |
//! | manifest filename 加密标记 | AES-256-ECB | depot_key |
//! | chunk 解密 | AES-256-CBC（IV 全零，逐块） | depot_key |
//! | VZ 压缩 | LZMA + 自定义魔数 | —— |
//!
//! ## 为什么手写这些而不是引 GameNative 的实现
//!
//! GameNative 的 `crypto.rs` 依赖 rsa/zeroize 等本 crate 不需要的库；
//! 这里只保留 depot 下载真正用到的三件事，依赖面更小、更容易审计。
//! 算法本身是公开的（Valve 的 depot 格式早已被 SteamKit / DepotDownloader 记录）。

use aes::cipher::block_padding::Pkcs7;
// BlockDecrypt / BlockEncrypt 提供 decrypt_block / encrypt_block（单块，无 padding）
use aes::cipher::{
    BlockDecrypt, BlockDecryptMut, BlockEncrypt, BlockEncryptMut, KeyInit, KeyIvInit,
};
use aes::Aes256;
use sha1::{Digest, Sha1};

/// AES 块长度（字节）
pub const AES_BLOCK: usize = 16;
/// depot key 长度（字节）
pub const DEPOT_KEY_LEN: usize = 32;

type Aes256CbcDec = cbc::Decryptor<Aes256>;
type Aes256CbcEnc = cbc::Encryptor<Aes256>;

/// **AES-256-ECB 解单个块**（不做 padding）。
///
/// 用途：解密文件名时，先 ECB 解前 16 字节得到 CBC 的 IV。
pub fn ecb_decrypt_block(key: &[u8], block: &[u8]) -> Option<[u8; AES_BLOCK]> {
    if key.len() != DEPOT_KEY_LEN || block.len() != AES_BLOCK {
        return None;
    }
    // 对照参考实现（GameNative crypto.rs 的 aes256_ecb_decrypt_block）：
    //   let cipher = Aes256::new_from_slice(key)?;
    //   let mut block = (*input).into();
    //   cipher.decrypt_block(&mut block);
    //
    // 注意 `aes::Block` 是 **非泛型** 别名（`GenericArray<u8, U16>`），
    // 写成 `aes::Block<Aes256>` 会编译失败。
    let cipher = Aes256::new_from_slice(key).ok()?;
    let mut block_ref: aes::Block = {
        let mut arr = [0u8; AES_BLOCK];
        arr.copy_from_slice(block);
        arr.into()
    };
    cipher.decrypt_block(&mut block_ref);
    let mut out = [0u8; AES_BLOCK];
    out.copy_from_slice(&block_ref);
    Some(out)
}

/// **AES-256-CBC 解密**（PKCS7 padding）。
///
/// 用途：文件名解密、chunk 解密（chunk 用全零 IV，调用方自行传入）。
pub fn cbc_decrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    if key.len() != DEPOT_KEY_LEN || iv.len() != AES_BLOCK || data.is_empty() {
        return None;
    }
    if data.len() % AES_BLOCK != 0 {
        return None;
    }
    let cipher = Aes256CbcDec::new_from_slices(key, iv).ok()?;
    cipher.decrypt_padded_vec_mut::<Pkcs7>(data).ok()
}

/// **AES-256-CBC 加密**（PKCS7 padding）。仅测试与将来「写回」用。
pub fn cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    if key.len() != DEPOT_KEY_LEN || iv.len() != AES_BLOCK {
        return None;
    }
    let cipher = Aes256CbcEnc::new_from_slices(key, iv).ok()?;
    Some(cipher.encrypt_padded_vec_mut::<Pkcs7>(data))
}

/// 全零 IV（chunk 解密用）。
pub const ZERO_IV: [u8; AES_BLOCK] = [0u8; AES_BLOCK];

/// 解密一个被加密的**文件名**。
///
/// 格式（Valve）：`AES-256-ECB(密文首块) = IV`，随后整段用 AES-256-CBC 解密。
/// 明文尾部可能带 `\0`，需要去掉。
pub fn decrypt_filename(key: &[u8], encoded: &str) -> Option<String> {
    let blob = base64_decode(encoded)?;
    // 至少要「一个 IV 块 + 一个数据块」
    if blob.len() < AES_BLOCK * 2 {
        return None;
    }
    let iv = ecb_decrypt_block(key, &blob[..AES_BLOCK])?;
    let plain = cbc_decrypt(key, &iv, &blob[AES_BLOCK..])?;
    let mut text = String::from_utf8_lossy(&plain).into_owned();
    while text.ends_with('\0') {
        text.pop();
    }
    Some(text)
}

/// SHA-1（chunk 完整性校验）。
pub fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// 极简 base64 解码（标准字母表，允许 padding）。
///
/// 不引 base64 crate：manifest 里只有文件名用了 base64，
/// 一个几十行的解码器足够，也能避免多一个依赖。
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, &ch) in TABLE.iter().enumerate() {
        lut[ch as usize] = i as u8;
    }

    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for byte in bytes {
        let value = lut[byte as usize];
        if value == 255 {
            return None; // 非法字符
        }
        acc = (acc << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_known_vectors() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
        assert!(base64_decode("!!!").is_none(), "非法字符应返回 None");
    }

    #[test]
    fn sha1_matches_known_vector() {
        // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }

    #[test]
    fn cbc_roundtrip() {
        let key = [7u8; DEPOT_KEY_LEN];
        let iv = [3u8; AES_BLOCK];
        let plain = b"hello steam depot";
        let enc = cbc_encrypt(&key, &iv, plain).expect("加密失败");
        let dec = cbc_decrypt(&key, &iv, &enc).expect("解密失败");
        assert_eq!(dec, plain);
    }

    #[test]
    fn decrypt_filename_rejects_garbage() {
        let key = [1u8; DEPOT_KEY_LEN];
        assert!(decrypt_filename(&key, "not-base64!!!").is_none());
        // 长度不足
        assert!(decrypt_filename(&key, "TWFu").is_none());
    }

    #[test]
    fn ecb_block_requires_exact_sizes() {
        assert!(
            ecb_decrypt_block(&[0u8; 16], &[0u8; 16]).is_none(),
            "key 长度不对"
        );
        assert!(
            ecb_decrypt_block(&[0u8; 32], &[0u8; 8]).is_none(),
            "块长度不对"
        );
    }

    #[test]
    fn cbc_rejects_bad_sizes() {
        assert!(cbc_decrypt(&[0u8; 32], &[0u8; 16], &[0u8; 15]).is_none());
        assert!(cbc_decrypt(&[0u8; 16], &[0u8; 16], &[0u8; 16]).is_none());
        assert!(cbc_decrypt(&[0u8; 32], &[0u8; 8], &[0u8; 16]).is_none());
    }
}
