//! Steam **depot manifest** 解析。
//!
//! ## manifest 的容器格式
//!
//! 不是普通 protobuf，而是 Valve 自己的分节容器：
//!
//! ```text
//! [u32 magic][u32 len][section bytes]   ← 重复
//! [u32 END_MAGIC]
//! ```
//!
//! 三种 section：
//! | magic | 内容 |
//! |---|---|
//! | `0x71f617d0` | payload：每个文件一项（FileMapping） |
//! | `0x1f4812be` | metadata：depot id / gid / 是否加密文件名 / 总大小 |
//! | `0x1b81b817` | signature |
//! | `0x32c415ab` | EOF 标记 |
//!
//! 每个 section 内部才是 protobuf（且**不带** tag 长度前缀，直接是字段流）。
//! 这个格式照 `GameNative-master` 的 `store_dl/steam/content_manifest.rs` 实现，
//! 字段号与 Valve 的 `content_manifest.proto` 一致。
//!
//! ## 为什么自己写 protobuf wire 解析
//!
//! 只需要「读 varint / 跳过未知字段」两件事，用 `prost`/`protobuf` 反而要
//! 为这些私有结构生成代码。手写 200 行更可控，也能在本机单测覆盖。

use std::io::{Cursor, Read};

use crate::crypto::{decrypt_filename, DEPOT_KEY_LEN};

/// payload section 的 magic
const PAYLOAD_MAGIC: u32 = 0x71f6_17d0;
/// metadata section 的 magic
const METADATA_MAGIC: u32 = 0x1f48_12be;
/// signature section 的 magic
const SIGNATURE_MAGIC: u32 = 0x1b81_b817;
/// 结束标记
const END_MAGIC: u32 = 0x32c4_15ab;

/// 一个 chunk：depot 里按内容寻址的数据块。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Chunk {
    /// chunk 的 SHA-1（CDN 用它寻址）
    pub sha: Vec<u8>,
    /// 校验用 CRC（小端 32 位）
    pub crc: u32,
    /// 在文件内的偏移
    pub offset: u64,
    /// 解压后的字节数
    pub cb_original: u32,
    /// 压缩后的字节数
    pub cb_compressed: u32,
}

/// 一个文件条目。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileMapping {
    /// 相对安装目录的路径（Windows 风格反斜杠，解密后统一成 `/`）
    pub filename: String,
    /// 文件字节数
    pub size: u64,
    /// 标志位（1 = 目录 / 64 = 可执行等，见 Valve 定义）
    pub flags: u32,
    pub sha_filename: Vec<u8>,
    pub sha_content: Vec<u8>,
    /// 组成该文件的 chunk（按顺序）
    pub chunks: Vec<Chunk>,
    /// 符号链接目标（Windows 上基本为空）
    pub linktarget: String,
}

/// manifest 的元信息。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestMetadata {
    pub depot_id: u32,
    pub gid_manifest: u64,
    pub creation_time: u32,
    /// 文件名是否被 depot_key 加密（绝大多数 depot 都是）
    pub filenames_encrypted: bool,
    pub cb_disk_original: u64,
    pub cb_disk_compressed: u64,
    pub unique_chunks: u32,
}

/// 解析完成的一份 manifest。
#[derive(Debug, Clone, Default)]
pub struct ContentManifest {
    pub metadata: ManifestMetadata,
    pub files: Vec<FileMapping>,
    pub signature: Vec<u8>,
}

/// 文件标志：这是一个目录。
///
/// ## 这个值不能猜（线上事故 2026-10-25）
///
/// 曾写成 `1`，导致**所有目录条目都被当成普通文件**：
/// 先是写出上千个 0 字节文件（`Aliya_Data` 就是其中之一），
/// 随后建目录时撞上同名文件报 `os error 183`，整个 depot 失败。
///
/// Valve 的 `EDepotFileFlag` 取值：`Directory = 64`、`CustomExecutable = 256`、
/// `Executable = 32`、`Symlink = 512`。
///
/// 实测依据：本机 Steam `depotcache` 的 40 份真实 manifest、55520 个条目里，
/// `flags=64` 有 2461 个（全是 `audio` / `bin` / `cfg` 这类目录），
/// **`flags` 带 1 位的条目为 0 个** —— 1 在这个字段里根本不会出现。
pub const FLAG_DIRECTORY: u32 = 64;

/// 剥掉 CDN 可能加在 manifest 外层的封装，返回内层字节。
///
/// 依次尝试：单条目 zip、gzip。都没有命中返回 `None`（调用方据此报「不是 manifest」）。
fn unwrap_container(raw: &[u8]) -> Option<Vec<u8>> {
    if raw.starts_with(b"PK\x03\x04") {
        return unzip_first_entry(raw);
    }
    // gzip：1f 8b
    if raw.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(Cursor::new(raw))
            .read_to_end(&mut out)
            .ok()?;
        return Some(out);
    }
    None
}

/// 取单条目 zip 的第一个条目。
///
/// Valve 的 manifest 包固定是「一个条目」，所以不必遍历：
/// 直接 by_index(0)。读取失败返回 None，由上层报错。
fn unzip_first_entry(raw: &[u8]) -> Option<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(raw)).ok()?;
    if archive.is_empty() {
        return None;
    }
    let mut entry = archive.by_index(0).ok()?;
    let mut out = Vec::new();
    entry.read_to_end(&mut out).ok()?;
    Some(out)
}

impl ContentManifest {
    /// CDN 的 HTTP 响应体 → manifest。
    ///
    /// CDN 对 `/depot/<id>/manifest/<gid>/5/<code>` 返回的**不是**裸 manifest：
    /// 主流节点会套一层单条目 zip（响应首 4 字节为 `PK\x03\x04`），
    /// 少数边缘节点会直接给明文或 gzip。直接把响应体交给 parse 会失败，
    /// 报错里只剩一串二进制 —— GameNative 的 cdn_client 也是先 unzip 再解析。
    ///
    /// 返回 `None` 表示「不是 manifest」；调用方应把响应体前缀带进错误文案。
    pub fn parse_response(raw: &[u8]) -> Option<Self> {
        if let Some(direct) = Self::parse(raw) {
            return Some(direct);
        }
        let unpacked = unwrap_container(raw)?;
        Self::parse(&unpacked)
    }

    /// 解析原始字节。格式不对返回 `None`（不 panic）。
    pub fn parse(raw: &[u8]) -> Option<Self> {
        let mut manifest = Self::default();
        let mut have_payload = false;
        let mut have_metadata = false;
        let mut pos = 0usize;

        loop {
            let magic = read_u32_le(raw, &mut pos)?;
            if magic == END_MAGIC {
                break;
            }
            let len = read_u32_le(raw, &mut pos)? as usize;
            // 用 checked_add：损坏的 len 可能大到让 pos+len 回绕
            let end = pos.checked_add(len)?;
            if end > raw.len() {
                return None;
            }
            let section = &raw[pos..end];
            pos = end;

            match magic {
                PAYLOAD_MAGIC => {
                    parse_payload(section, &mut manifest.files)?;
                    have_payload = true;
                }
                METADATA_MAGIC => {
                    manifest.metadata = parse_metadata(section)?;
                    have_metadata = true;
                }
                SIGNATURE_MAGIC => {
                    manifest.signature = parse_signature(section);
                }
                // 未知 section：整份作废（宁可失败，也不装一半）
                _ => return None,
            }
        }

        // 两者都必须在场，否则这份 manifest 不可用
        if have_payload && have_metadata {
            Some(manifest)
        } else {
            None
        }
    }

    /// 用 depot_key 解密文件名。
    ///
    /// 解密后统一把 `\\` 换成 `/`，便于后续按目录建树（Windows 上两种都能用，
    /// 但混用会让 `ParentDir` 判定出错）。
    pub fn decrypt_filenames(&mut self, depot_key: &[u8]) -> bool {
        if self.metadata.filenames_encrypted {
            if depot_key.len() != DEPOT_KEY_LEN {
                return false;
            }
            for file in &mut self.files {
                let Some(clear) = decrypt_filename(depot_key, &file.filename) else {
                    return false;
                };
                file.filename = clear;
                if !file.linktarget.is_empty() {
                    let Some(clear) = decrypt_filename(depot_key, &file.linktarget) else {
                        return false;
                    };
                    file.linktarget = clear;
                }
            }
            self.metadata.filenames_encrypted = false;
        }
        for file in &mut self.files {
            file.filename = file.filename.replace('\\', "/");
            file.linktarget = file.linktarget.replace('\\', "/");
        }
        // 按路径排序：写入时先建目录再写文件，顺序稳定也便于断点续传比对
        self.files.sort_by(|a, b| {
            a.filename
                .to_ascii_lowercase()
                .cmp(&b.filename.to_ascii_lowercase())
        });
        true
    }

    /// 文件总字节数（解压后）。
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

// ---------------------------------------------------------------------------
// protobuf wire 读取（最小实现）
// ---------------------------------------------------------------------------

/// protobuf 的 wire type。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireType {
    Varint = 0,
    Fixed64 = 1,
    LengthDelimited = 2,
    Fixed32 = 5,
}

/// 一个 tag（字段号 + wire type）。
struct Tag {
    field_number: u32,
    wire_type: WireType,
}

/// 极简 protobuf 读取器。
///
/// 只支持 depot manifest 里出现的 wire type；
/// 遇到 group（3/4）直接判失败 —— 那不该出现在这里。
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn eof(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn varint(&mut self) -> Option<u64> {
        let mut result = 0u64;
        for i in 0..10 {
            let byte = *self.buf.get(self.pos)?;
            self.pos += 1;
            result |= ((byte & 0x7f) as u64) << (i * 7);
            if byte & 0x80 == 0 {
                return Some(result);
            }
        }
        None // 超过 10 字节：非法
    }

    fn next_tag(&mut self) -> Option<Tag> {
        if self.eof() {
            return None;
        }
        let raw = self.varint()? as u32;
        let wire_type = match raw & 0x07 {
            0 => WireType::Varint,
            1 => WireType::Fixed64,
            2 => WireType::LengthDelimited,
            5 => WireType::Fixed32,
            _ => return None, // 3/4 (group) 与 6/7 非法
        };
        let field_number = raw >> 3;
        if field_number == 0 {
            return None;
        }
        Some(Tag {
            field_number,
            wire_type,
        })
    }

    fn skip(&mut self, wire_type: WireType) -> bool {
        match wire_type {
            WireType::Varint => self.varint().is_some(),
            WireType::Fixed64 => self.advance(8),
            WireType::Fixed32 => self.advance(4),
            WireType::LengthDelimited => match self.varint() {
                Some(len) => self.advance(len as usize),
                None => false,
            },
        }
    }

    fn advance(&mut self, n: usize) -> bool {
        match self.pos.checked_add(n) {
            Some(end) if end <= self.buf.len() => {
                self.pos = end;
                true
            }
            _ => false,
        }
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.varint()? as usize;
        let start = self.pos;
        let end = start.checked_add(len)?;
        if end > self.buf.len() {
            return None;
        }
        self.pos = end;
        Some(&self.buf[start..end])
    }

    fn string(&mut self) -> Option<String> {
        Some(String::from_utf8_lossy(self.bytes()?).into_owned())
    }

    fn u32(&mut self) -> Option<u32> {
        Some(self.varint()? as u32)
    }

    fn u64(&mut self) -> Option<u64> {
        self.varint()
    }

    fn boolean(&mut self) -> Option<bool> {
        Some(self.varint()? != 0)
    }

    fn fixed32(&mut self) -> Option<u32> {
        let start = self.pos;
        if !self.advance(4) {
            return None;
        }
        Some(u32::from_le_bytes(
            self.buf[start..start + 4].try_into().ok()?,
        ))
    }
}

/// 读小端 u32。
fn read_u32_le(buf: &[u8], pos: &mut usize) -> Option<u32> {
    let end = pos.checked_add(4)?;
    if end > buf.len() {
        return None;
    }
    let value = u32::from_le_bytes(buf[*pos..end].try_into().ok()?);
    *pos = end;
    Some(value)
}

// ---------------------------------------------------------------------------
// 各 section 的解析
// ---------------------------------------------------------------------------

fn parse_payload(body: &[u8], out: &mut Vec<FileMapping>) -> Option<()> {
    let mut reader = Reader::new(body);
    while !reader.eof() {
        let tag = reader.next_tag()?;
        if tag.field_number == 1 {
            out.push(parse_file_mapping(reader.bytes()?)?);
        } else if !reader.skip(tag.wire_type) {
            return None;
        }
    }
    Some(())
}

fn parse_file_mapping(body: &[u8]) -> Option<FileMapping> {
    let mut reader = Reader::new(body);
    let mut file = FileMapping::default();
    while !reader.eof() {
        let tag = reader.next_tag()?;
        match tag.field_number {
            1 => file.filename = reader.string()?,
            2 => file.size = reader.u64()?,
            3 => file.flags = reader.u32()?,
            4 => file.sha_filename = reader.bytes()?.to_vec(),
            5 => file.sha_content = reader.bytes()?.to_vec(),
            6 => file.chunks.push(parse_chunk(reader.bytes()?)?),
            7 => file.linktarget = reader.string()?,
            _ => {
                if !reader.skip(tag.wire_type) {
                    return None;
                }
            }
        }
    }
    Some(file)
}

fn parse_chunk(body: &[u8]) -> Option<Chunk> {
    let mut reader = Reader::new(body);
    let mut chunk = Chunk::default();
    while !reader.eof() {
        let tag = reader.next_tag()?;
        match tag.field_number {
            1 => chunk.sha = reader.bytes()?.to_vec(),
            2 => {
                if tag.wire_type != WireType::Fixed32 {
                    return None;
                }
                chunk.crc = reader.fixed32()?;
            }
            3 => chunk.offset = reader.u64()?,
            4 => chunk.cb_original = reader.u32()?,
            5 => chunk.cb_compressed = reader.u32()?,
            _ => {
                if !reader.skip(tag.wire_type) {
                    return None;
                }
            }
        }
    }
    Some(chunk)
}

fn parse_metadata(body: &[u8]) -> Option<ManifestMetadata> {
    let mut reader = Reader::new(body);
    let mut meta = ManifestMetadata::default();
    while !reader.eof() {
        let tag = reader.next_tag()?;
        match tag.field_number {
            1 => meta.depot_id = reader.u32()?,
            2 => meta.gid_manifest = reader.u64()?,
            3 => meta.creation_time = reader.u32()?,
            4 => meta.filenames_encrypted = reader.boolean()?,
            5 => meta.cb_disk_original = reader.u64()?,
            6 => meta.cb_disk_compressed = reader.u64()?,
            7 => meta.unique_chunks = reader.u32()?,
            _ => {
                if !reader.skip(tag.wire_type) {
                    return None;
                }
            }
        }
    }
    Some(meta)
}

fn parse_signature(body: &[u8]) -> Vec<u8> {
    let mut reader = Reader::new(body);
    let mut signature = Vec::new();
    while !reader.eof() {
        let Some(tag) = reader.next_tag() else {
            break;
        };
        if tag.field_number == 1 {
            match reader.bytes() {
                Some(bytes) => signature = bytes.to_vec(),
                None => break,
            }
        } else if !reader.skip(tag.wire_type) {
            break;
        }
    }
    signature
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工拼一个最小 manifest（未加密文件名），验证容器与字段解析。
    fn build_manifest() -> Vec<u8> {
        // chunk 的 protobuf body
        let mut chunk = Vec::new();
        // field 1: sha (length-delimited)
        chunk.push(1 << 3 | 2);
        chunk.push(20);
        chunk.extend_from_slice(&[0xABu8; 20]);
        // field 2: crc (fixed32)
        chunk.push(2 << 3 | 5);
        chunk.extend_from_slice(&0x1234_5678u32.to_le_bytes());
        // field 3: offset
        chunk.push(3 << 3);
        chunk.push(0);
        // field 4: cb_original
        chunk.push(4 << 3);
        chunk.push(11);
        // field 5: cb_compressed
        chunk.push(5 << 3);
        chunk.push(22);

        // file mapping body
        let mut file = Vec::new();
        // field 1: filename
        // ⚠️ 长度必须与字面量一致：`game.exe` 是 **8** 字节。
        // 曾写成 9，后面所有字段跟着错位，整份 manifest 解析失败 ——
        // 表现像「解析器坏了」，其实是测试数据写错。
        file.push(1 << 3 | 2);
        file.push(8);
        file.extend_from_slice(b"game.exe");
        // field 2: size
        file.push(2 << 3);
        file.push(11);
        // field 3: flags
        file.push(3 << 3);
        file.push(64);
        // field 6: chunk（嵌套 message）
        file.push(6 << 3 | 2);
        file.push(chunk.len() as u8);
        file.extend_from_slice(&chunk);

        // payload body：field 1 = file mapping
        let mut payload = Vec::new();
        payload.push(1 << 3 | 2);
        payload.push(file.len() as u8);
        payload.extend_from_slice(&file);

        // metadata body
        let mut meta = Vec::new();
        meta.push(1 << 3); // depot_id
        meta.push(7);
        meta.push(2 << 3); // gid_manifest
        meta.push(9);
        // filenames_encrypted = false：**整个字段不写**即可。
        // 曾写成「只有 tag 没有值」—— 解析时 varint() 会吞掉下一个字节
        // （越过 section 边界），导致整份 manifest 判失败。

        // 拼容器
        let mut out = Vec::new();
        out.extend_from_slice(&PAYLOAD_MAGIC.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&METADATA_MAGIC.to_le_bytes());
        out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        out.extend_from_slice(&meta);
        out.extend_from_slice(&END_MAGIC.to_le_bytes());
        out
    }

    #[test]
    fn parses_container_and_fields() {
        let raw = build_manifest();
        let manifest = ContentManifest::parse(&raw).expect("应能解析");
        assert_eq!(manifest.metadata.depot_id, 7);
        assert_eq!(manifest.metadata.gid_manifest, 9);
        assert_eq!(manifest.files.len(), 1);
        let file = &manifest.files[0];
        assert_eq!(file.filename, "game.exe");
        assert_eq!(file.size, 11);
        assert_eq!(file.flags, 64);
        assert_eq!(file.chunks.len(), 1);
        let chunk = &file.chunks[0];
        assert_eq!(chunk.sha, vec![0xAB; 20]);
        assert_eq!(chunk.crc, 0x1234_5678);
        assert_eq!(chunk.cb_original, 11);
        assert_eq!(chunk.cb_compressed, 22);
    }

    /// 线上事故（2026-10-25）：`FLAG_DIRECTORY` 写成 1，导致所有目录被当文件写，
    /// 先造出一堆 0 字节文件，再在建目录时撞车报 `os error 183`。
    ///
    /// 这条用例钉死数值本身。依据是本机 Steam `depotcache` 的 40 份真实 manifest
    /// （55520 个条目）：`flags=64` 有 2461 个，全是 `audio`/`bin`/`cfg` 这类目录；
    /// `flags` 带 1 位的条目为 **0** —— 1 在该字段里根本不会出现。
    #[test]
    fn directory_flag_is_64_not_1() {
        assert_eq!(
            FLAG_DIRECTORY, 64,
            "Valve 的 EDepotFileFlag::Directory 是 64"
        );
        // 目录条目: 应被判为目录
        assert_ne!(64 & FLAG_DIRECTORY, 0, "flags=64 必须命中目录位");
        // 普通文件 / 可执行标记: 不应被判为目录
        assert_eq!(0 & FLAG_DIRECTORY, 0, "flags=0 是普通文件");
        assert_eq!(32 & FLAG_DIRECTORY, 0, "flags=32 是可执行，不是目录");
        assert_eq!(
            256 & FLAG_DIRECTORY,
            0,
            "flags=256 是 CustomExecutable，不是目录"
        );
    }

    #[test]
    fn rejects_truncated_input() {
        let raw = build_manifest();
        assert!(ContentManifest::parse(&raw[..raw.len() - 8]).is_none());
        assert!(ContentManifest::parse(&[]).is_none());
    }

    #[test]
    fn rejects_unknown_magic() {
        let mut raw = build_manifest();
        raw[0] ^= 0xFF; // 破坏 payload magic
        assert!(ContentManifest::parse(&raw).is_none());
    }

    #[test]
    fn normalizes_backslashes_and_sorts() {
        let raw = build_manifest();
        let mut manifest = ContentManifest::parse(&raw).unwrap();
        manifest.files[0].filename = "bin\\game.exe".to_string();
        assert!(manifest.decrypt_filenames(&[])); // 未加密 → 只需归一化
        assert_eq!(manifest.files[0].filename, "bin/game.exe");
    }

    #[test]
    fn total_bytes_sums_file_sizes() {
        let raw = build_manifest();
        let manifest = ContentManifest::parse(&raw).unwrap();
        assert_eq!(manifest.total_bytes(), 11);
    }

    /// 把字节包成单条目 zip，模拟 CDN 的真实响应。
    ///
    /// 用默认选项（Stored）即可：这条用例要验证的是「能被解封装」，
    /// 不是压缩算法；写成 Deflated 还要多依赖一个写入侧 feature。
    fn wrap_zip(inner: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
            writer
                .start_file("manifest", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut writer, inner).unwrap();
            writer.finish().unwrap();
        }
        out
    }

    fn wrap_gzip(inner: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, inner).unwrap();
        encoder.finish().unwrap()
    }

    /// CDN 返回的是 zip 包（首 4 字节 50 4b 03 04）。
    /// 直接喂给 parse 会失败，用户看到的就是一串二进制 —— 线上报错正是这个。
    #[test]
    fn parse_response_unwraps_zip() {
        let raw = build_manifest();
        let zipped = wrap_zip(&raw);
        assert_eq!(&zipped[..4], b"PK\x03\x04");
        // 裸 parse 必须失败，证明「不解封装真的不行」
        assert!(ContentManifest::parse(&zipped).is_none());
        let manifest = ContentManifest::parse_response(&zipped).expect("解 zip 后应能解析");
        assert_eq!(manifest.metadata.depot_id, 7);
        assert_eq!(manifest.metadata.gid_manifest, 9);
        assert_eq!(manifest.files.len(), 1);
    }

    #[test]
    fn parse_response_unwraps_gzip() {
        let raw = build_manifest();
        let gz = wrap_gzip(&raw);
        assert_eq!(&gz[..2], &[0x1f, 0x8b]);
        let manifest = ContentManifest::parse_response(&gz).expect("解 gzip 后应能解析");
        assert_eq!(manifest.metadata.depot_id, 7);
    }

    /// 明文（部分边缘节点直出）必须照常走通 —— 不能为了支持 zip 把原路径弄坏。
    #[test]
    fn parse_response_accepts_plain_bytes() {
        let raw = build_manifest();
        let manifest = ContentManifest::parse_response(&raw).expect("明文应能解析");
        assert_eq!(manifest.metadata.depot_id, 7);
    }

    /// 既不是 manifest 也不是可识别的封装 → None（调用方据此报「不是 manifest」）。
    #[test]
    fn parse_response_rejects_garbage() {
        assert!(ContentManifest::parse_response(b"<html>error</html>").is_none());
        assert!(ContentManifest::parse_response(&[]).is_none());
    }
}
