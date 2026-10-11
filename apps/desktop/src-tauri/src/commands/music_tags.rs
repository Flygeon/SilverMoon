//! `musicTags` 通道：本地音频文件写标签 + 在线歌曲标签的磁盘缓存。
//!
//! ## 迁移说明（Electron → Tauri）
//!
//! Electron 版这条通道整个跑在 **Node 主进程**（`electron/tags.ts` +
//! `electron/tag-writer.ts` + `electron/tag-store.ts`），用 `taglib-wasm` 读写音频标签。
//! Tauri 没有 Node 侧，**用 Rust 的 `lofty` 重写**——`lofty` 本来就是这个项目
//! 解析音频元数据的库（`metadata.rs` / `song.rs` 都在用），因此不是新增依赖，
//! 也顺带甩掉了 WASI wasm 胶水与 `@msgpack/msgpack` 的整套打包麻烦。
//!
//! ## 目录布局（与 Electron 版**逐字一致**，旧缓存可直接复用）
//!
//! ```text
//! <app_data_dir>/music-tags/index.json                     在线标签索引（原子写）
//! <app_data_dir>/music-tags/covers/cover-<sha1(key)>.<ext> 在线封面
//! <app_data_dir>/music-tags/lyrics/<sha1(key)>.txt         在线歌词旁路
//! <app_data_dir>/music-tags/local-backup/<sha1(id)>.json   写入前的原始字段快照
//! ```
//!
//! id 对本地文件是**路径**、对在线歌曲是合并 key（`${server ?? "netease"}:${id}`），
//! 两者都走 sha1，与 Electron 版同源。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};

/// 标签缓存根目录下的子目录 / 文件名（与 Electron 版一致）。
const TAGS_DIR: &str = "music-tags";
const LYRICS_DIR: &str = "lyrics";
const COVER_DIR: &str = "covers";
const BACKUP_DIR: &str = "local-backup";
const INDEX_FILE: &str = "index.json";
const INDEX_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/// 音乐标签字段。前端契约见 `shared/types.ts` 的 `MusicTagFields`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTagFields {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub album_artist: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub track: String,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub lyrics: String,
    #[serde(default)]
    pub comment: String,
}

/// 索引里的在线记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlineRecord {
    key: String,
    #[serde(default)]
    fields: MusicTagFields,
    /// 覆盖写入前平台自己的标签（还原默认 / 歌词回退用）
    #[serde(default)]
    original: Option<MusicTagFields>,
    #[serde(default)]
    cover_path: Option<String>,
    #[serde(default)]
    cached_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OnlineIndex {
    version: u32,
    entries: BTreeMap<String, OnlineRecord>,
}

impl Default for OnlineIndex {
    fn default() -> Self {
        OnlineIndex {
            version: INDEX_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// 目录与读写工具（对齐 electron/tag-store.ts）
// ---------------------------------------------------------------------------

fn sha1(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn tags_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(TAGS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 原子写文本：先写 .tmp 再 rename，避免半截 JSON 被后续启动读到。
fn write_text_atomic(file: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

fn read_text_or_null(file: &Path) -> Option<String> {
    std::fs::read_to_string(file).ok()
}

fn read_index(root: &Path) -> OnlineIndex {
    read_text_or_null(&root.join(INDEX_FILE))
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_index(root: &Path, index: &OnlineIndex) -> Result<(), String> {
    write_text_atomic(
        &root.join(INDEX_FILE),
        &serde_json::to_string_pretty(index).map_err(|e| e.to_string())?,
    )
}

fn lyrics_path_for(root: &Path, key: &str) -> PathBuf {
    root.join(LYRICS_DIR).join(format!("{}.txt", sha1(key)))
}

fn backup_path_for(root: &Path, id: &str) -> PathBuf {
    root.join(BACKUP_DIR).join(format!("{}.json", sha1(id)))
}

/// 仅当备份不存在时写入（保留最原始的「写入前」快照）。返回是否新建。
fn create_backup_if_absent(root: &Path, id: &str, payload: &Value) -> bool {
    let file = backup_path_for(root, id);
    if file.exists() {
        return false;
    }
    let text = serde_json::to_string_pretty(payload).unwrap_or_default();
    write_text_atomic(&file, &text).is_ok()
}

fn read_backup(root: &Path, id: &str) -> Option<MusicTagFields> {
    let text = read_text_or_null(&backup_path_for(root, id))?;
    serde_json::from_str(&text).ok()
}

/// 写/清旁路歌词（空串 = 删除）。
fn write_lyrics_sidecar(root: &Path, key: &str, lyrics: &str) -> Result<(), String> {
    let file = lyrics_path_for(root, key);
    if lyrics.is_empty() {
        let _ = std::fs::remove_file(file);
        Ok(())
    } else {
        write_text_atomic(&file, lyrics)
    }
}

fn read_lyrics_sidecar(root: &Path, key: &str) -> Option<String> {
    read_text_or_null(&lyrics_path_for(root, key))
}

// ---------------------------------------------------------------------------
// 封面
// ---------------------------------------------------------------------------

/// 按 mime / dataURL 前缀推断封面扩展名。
fn cover_ext(mime: Option<&str>, base64: Option<&str>) -> &'static str {
    let from_mime = mime.unwrap_or("").to_ascii_lowercase();
    // 先取 mime；mime 为空时退回 dataURL 前缀（与 Electron 版 coverExt 同序）
    let probe = if from_mime.is_empty() {
        base64
            .unwrap_or("")
            .get(..30)
            .unwrap_or("")
            .to_ascii_lowercase()
    } else {
        from_mime.clone()
    };
    if probe.contains("png") {
        "png"
    } else if probe.contains("webp") {
        "webp"
    } else if probe.contains("gif") {
        "gif"
    } else if probe.contains("bmp") {
        "bmp"
    } else {
        "jpg"
    }
}

/// base64（可带 dataURL 前缀）→ 字节。
fn decode_base64(base64: &str) -> Option<Vec<u8>> {
    let raw = if base64.starts_with("data:") {
        base64.split_once(',').map(|(_, r)| r).unwrap_or(base64)
    } else {
        base64
    };
    if raw.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .ok()
        .filter(|b| !b.is_empty())
}

/// 按 coverMode 落地在线封面，返回新的 coverPath（keep 保留 / remove 删除 / set 覆写）。
fn update_cover(
    root: &Path,
    record: &OnlineRecord,
    key: &str,
    mode: &str,
    base64: Option<&str>,
    mime: Option<&str>,
) -> Result<Option<String>, String> {
    match mode {
        "keep" => Ok(record.cover_path.clone().filter(|p| Path::new(p).exists())),
        "remove" => {
            if let Some(old) = &record.cover_path {
                let _ = std::fs::remove_file(old);
            }
            Ok(None)
        }
        _ => {
            let data = base64
                .and_then(decode_base64)
                .ok_or("coverMode=set 但缺少封面数据")?;
            let dir = root.join(COVER_DIR);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let ext = cover_ext(mime, base64);
            let next = dir.join(format!("cover-{}.{}", sha1(key), ext));
            let next_str = next.to_string_lossy().to_string();
            // 换过格式时删掉旧文件，避免 covers/ 里留垃圾
            if let Some(old) = &record.cover_path {
                if old != &next_str {
                    let _ = std::fs::remove_file(old);
                }
            }
            let mut tmp = next.as_os_str().to_os_string();
            tmp.push(".tmp");
            let tmp = PathBuf::from(tmp);
            std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &next).map_err(|e| e.to_string())?;
            Ok(Some(next_str))
        }
    }
}

/// 在线记录的原始标签（索引优先，兼容旧的 local-backup 备份文件）。
fn original_of(root: &Path, record: Option<&OnlineRecord>, key: &str) -> Option<MusicTagFields> {
    if let Some(original) = record.and_then(|r| r.original.clone()) {
        return Some(original);
    }
    read_backup(root, key)
}

/// 在线记录 → 返回给渲染进程的形状（去掉 original 内部字段）。
fn to_applied(record: &OnlineRecord) -> Value {
    json!({
        "key": record.key,
        "fields": record.fields,
        "coverPath": record.cover_path,
        "cachedAt": record.cached_at,
    })
}

fn normalize_fields(value: Option<&Value>) -> MusicTagFields {
    match value {
        Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
        None => MusicTagFields::default(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 本地文件标签读写（lofty）
// ---------------------------------------------------------------------------

/// 写本地文件标签。
///
/// 与 Electron 版（taglib）语义对齐：**空串即清空**该字段。
fn write_local_tags(
    path: &str,
    fields: &MusicTagFields,
    cover_mode: &str,
    cover_base64: Option<&str>,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::TaggedFileExt;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::{ItemKey, TagExt};
    use lofty::tag::{Accessor, Tag, TagType};

    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在：{path}"));
    }

    let tagged = lofty::read_from_path(file_path).map_err(|e| format!("读取标签失败：{e}"))?;
    let tag_type: TagType = tagged.primary_tag_type();
    let mut tag = tagged
        .primary_tag()
        .cloned()
        .unwrap_or_else(|| Tag::new(tag_type));

    // 基本字段：空串清空
    if fields.title.is_empty() {
        tag.remove_title();
    } else {
        tag.set_title(fields.title.clone());
    }
    if fields.artist.is_empty() {
        tag.remove_artist();
    } else {
        tag.set_artist(fields.artist.clone());
    }
    if fields.album.is_empty() {
        tag.remove_album();
    } else {
        tag.set_album(fields.album.clone());
    }
    if fields.genre.is_empty() {
        tag.remove_genre();
    } else {
        tag.set_genre(fields.genre.clone());
    }
    if fields.comment.is_empty() {
        tag.remove_comment();
    } else {
        tag.set_comment(fields.comment.clone());
    }

    // Accessor 未覆盖的组合字段走 ItemKey。
    //
    // 注意：`ItemKey::Year` 在 lofty 0.20 的 ID3v2 实现里没有映射，
    // `insert_text` / `get_string` 会静默丢失，因此年份走 Accessor。
    let extras: [(ItemKey, &str); 3] = [
        (ItemKey::AlbumArtist, fields.album_artist.as_str()),
        (ItemKey::TrackNumber, fields.track.as_str()),
        (ItemKey::Lyrics, fields.lyrics.as_str()),
    ];
    for (key, value) in extras {
        if value.is_empty() {
            tag.remove_key(&key);
        } else {
            tag.insert_text(key, value.to_string());
        }
    }

    // 年份：空串清空；非数字字符串无法写入 u32 年份，也按清空处理
    // （与旧 taglib 版 `setYear(unsigned)` 的语义一致）。
    if fields.year.is_empty() {
        tag.remove_year();
    } else if let Ok(y) = fields.year.trim().parse::<u32>() {
        tag.set_year(y);
    } else {
        tag.remove_year();
    }

    // 封面：remove 删掉 / set 覆写 / keep 不动
    if cover_mode == "remove" {
        tag.remove_picture_type(PictureType::CoverFront);
    } else if cover_mode == "set" {
        if let Some(data) = cover_base64.and_then(decode_base64) {
            tag.remove_picture_type(PictureType::CoverFront);
            tag.push_picture(Picture::new_unchecked(
                PictureType::CoverFront,
                Some(MimeType::Jpeg),
                None,
                data,
            ));
        }
    }

    tag.save_to_path(file_path, WriteOptions::new())
        .map_err(|e| format!("写入标签失败：{e}"))
}

/// 读本地文件标签。失败（文件不存在 / 解析不了）**回退空字段且不抛**。
fn read_local_tags(path: &str) -> Value {
    use lofty::file::TaggedFileExt;
    use lofty::prelude::ItemKey;
    use lofty::tag::Accessor;

    let mut fields = MusicTagFields::default();
    let mut has_cover = false;
    if let Ok(tagged) = lofty::read_from_path(path) {
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            fields.title = tag.title().unwrap_or_default().to_string();
            fields.artist = tag.artist().unwrap_or_default().to_string();
            fields.album = tag.album().unwrap_or_default().to_string();
            fields.genre = tag.genre().unwrap_or_default().to_string();
            fields.comment = tag.comment().unwrap_or_default().to_string();
            fields.album_artist = tag
                .get_string(&ItemKey::AlbumArtist)
                .unwrap_or_default()
                .to_string();
            fields.year = tag.year().map(|y| y.to_string()).unwrap_or_default();
            fields.track = tag
                .get_string(&ItemKey::TrackNumber)
                .unwrap_or_default()
                .to_string();
            fields.lyrics = tag
                .get_string(&ItemKey::Lyrics)
                .unwrap_or_default()
                .to_string();
            has_cover = !tag.pictures().is_empty();
        }
    }
    json!({ "fields": fields, "hasCover": has_cover })
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

/// 处理 `musicTags` 通道的全部 op（与 `capabilities.musicTagCall` 一一对应）。
///
/// payload 形状见契约 §4：op 与各自字段平铺在同一个对象里。
#[tauri::command]
pub fn music_tags_op(app: AppHandle, op: String, payload: Value) -> Result<Value, String> {
    let root = tags_root(&app)?;
    let obj = payload.as_object().cloned().unwrap_or_default();
    let str_of = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());

    match op.as_str() {
        // ------------------------------------------------------------ 本地
        "writeLocal" => {
            let path = str_of("path").ok_or("writeLocal 缺少 path")?;
            let fields = normalize_fields(obj.get("fields"));
            let cover_mode = str_of("coverMode").unwrap_or_else(|| "keep".into());
            let cover_base64 = str_of("coverBase64");
            write_local_tags(&path, &fields, &cover_mode, cover_base64.as_deref())?;
            Ok(Value::Null)
        }
        "readLocal" => {
            let path = str_of("path").ok_or("readLocal 缺少 path")?;
            Ok(read_local_tags(&path))
        }
        "backupLocal" => {
            let path = str_of("path").ok_or("backupLocal 缺少 path")?;
            let fields = serde_json::to_value(normalize_fields(obj.get("fields")))
                .map_err(|e| e.to_string())?;
            Ok(json!({ "created": create_backup_if_absent(&root, &path, &fields) }))
        }
        "readLocalBackup" => {
            let path = str_of("path").ok_or("readLocalBackup 缺少 path")?;
            Ok(serde_json::to_value(read_backup(&root, &path)).map_err(|e| e.to_string())?)
        }

        // ------------------------------------------------------------ 在线
        "cacheOnline" => {
            let key = str_of("key").ok_or("cacheOnline 缺少 key")?;
            let mut index = read_index(&root);
            let mut record = index
                .entries
                .get(&key)
                .cloned()
                .unwrap_or_else(|| OnlineRecord {
                    key: key.clone(),
                    fields: MusicTagFields::default(),
                    original: None,
                    cover_path: None,
                    cached_at: 0,
                });
            record.fields = normalize_fields(obj.get("fields"));
            let mode = str_of("coverMode").unwrap_or_else(|| "keep".into());
            let base64 = str_of("coverBase64");
            let mime = str_of("coverMime");
            record.cover_path = update_cover(
                &root,
                &record,
                &key,
                &mode,
                base64.as_deref(),
                mime.as_deref(),
            )?;
            record.cached_at = now_ms();
            index.entries.insert(key, record.clone());
            write_index(&root, &index)?;
            Ok(to_applied(&record))
        }
        "readOnline" => {
            let key = str_of("key").ok_or("readOnline 缺少 key")?;
            let index = read_index(&root);
            Ok(index
                .entries
                .get(&key)
                .map(to_applied)
                .unwrap_or(Value::Null))
        }
        "removeOnline" => {
            let key = str_of("key").ok_or("removeOnline 缺少 key")?;
            let mut index = read_index(&root);
            let Some(record) = index.entries.remove(&key) else {
                return Ok(json!({ "removed": false }));
            };
            if let Some(path) = record.cover_path {
                let _ = std::fs::remove_file(path);
            }
            write_index(&root, &index)?;
            Ok(json!({ "removed": true }))
        }
        "listOnline" => {
            let index = read_index(&root);
            Ok(Value::Array(
                index.entries.values().map(to_applied).collect(),
            ))
        }

        // ------------------------------------------- 在线：歌词 / 原始标签
        "readLyrics" => {
            let key = str_of("key").ok_or("readLyrics 缺少 key")?;
            let kind = str_of("kind").unwrap_or_else(|| "tag".into());
            if kind == "original" {
                let index = read_index(&root);
                let original = original_of(&root, index.entries.get(&key), &key);
                let lyrics = original.map(|f| f.lyrics).unwrap_or_default();
                return Ok(if lyrics.is_empty() {
                    Value::Null
                } else {
                    json!(lyrics)
                });
            }
            Ok(read_lyrics_sidecar(&root, &key)
                .map(|s| json!(s))
                .unwrap_or(Value::Null))
        }
        "writeLyrics" => {
            let key = str_of("key").ok_or("writeLyrics 缺少 key")?;
            let lyrics = str_of("lyrics").unwrap_or_default();
            write_lyrics_sidecar(&root, &key, &lyrics)?;
            Ok(json!({ "written": !lyrics.is_empty() }))
        }
        "readOriginal" => {
            let key = str_of("key").ok_or("readOriginal 缺少 key")?;
            let index = read_index(&root);
            Ok(
                serde_json::to_value(original_of(&root, index.entries.get(&key), &key))
                    .map_err(|e| e.to_string())?,
            )
        }
        "writeOriginal" => {
            let key = str_of("key").ok_or("writeOriginal 缺少 key")?;
            let mut index = read_index(&root);
            let existing = index.entries.get(&key).cloned();
            let mut record = existing.clone().unwrap_or_else(|| OnlineRecord {
                key: key.clone(),
                fields: MusicTagFields::default(),
                original: None,
                cover_path: None,
                cached_at: 0,
            });

            // 只合并 original，绝不动 fields
            let mut merged = record.original.clone().unwrap_or_default();
            if let Some(patch) = obj.get("fields").and_then(|v| v.as_object()) {
                let p = normalize_fields(obj.get("fields"));
                let apply = |name: &str, target: &mut String, value: &str| {
                    if patch.contains_key(name) {
                        *target = value.to_string();
                    }
                };
                apply("title", &mut merged.title, &p.title);
                apply("artist", &mut merged.artist, &p.artist);
                apply("album", &mut merged.album, &p.album);
                apply("albumArtist", &mut merged.album_artist, &p.album_artist);
                apply("year", &mut merged.year, &p.year);
                apply("track", &mut merged.track, &p.track);
                apply("genre", &mut merged.genre, &p.genre);
                apply("lyrics", &mut merged.lyrics, &p.lyrics);
                apply("comment", &mut merged.comment, &p.comment);
            }
            record.original = Some(merged.clone());
            if existing.is_none() {
                record.cached_at = now_ms();
            }
            index.entries.insert(key.clone(), record.clone());
            write_index(&root, &index)?;
            // 镜像到 local-backup：歌词回退链可以直接 readBackup（只在无备份时创建）
            let merged_value = serde_json::to_value(&merged).map_err(|e| e.to_string())?;
            create_backup_if_absent(&root, &key, &merged_value);
            Ok(to_applied(&record))
        }

        other => Err(format!("未知的音乐标签操作：{other}")),
    }
}

// ---------------------------------------------------------------------------
// 单元测试：本地标签读写（lofty 生产路径）
//
// 覆盖 doc/TAURI-MIGRATION.md「已知的验证覆盖缺口」第 1 条：
// 用 Rust 单测覆盖 write_local_tags / read_local_tags 的
// 「写标签 → 重新解析 → 断言」链路（旧验证脚本走的是 taglib-wasm，
// 不覆盖生产路径的 lofty）。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// 1x1 红色 JPEG（225 字节，ffmpeg 生成），用于封面 set/remove 测试。
    const TINY_JPEG: &[u8] = &[
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x10, 0x4c, 0x61, 0x76, 0x63, 0x36, 0x32,
        0x2e, 0x32, 0x38, 0x2e, 0x31, 0x30, 0x32, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x04,
        0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x06,
        0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x07,
        0x07, 0x07, 0x06, 0x06, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09, 0x09, 0x08, 0x08,
        0x08, 0x08, 0x09, 0x09, 0x0a, 0x0a, 0x0a, 0x0c, 0x0c, 0x0b, 0x0b, 0x0e, 0x0e, 0x0e, 0x11,
        0x11, 0x14, 0xff, 0xc4, 0x00, 0x4c, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x01, 0x01, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x07, 0x10,
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
        0x01, 0x22, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01,
        0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x8b, 0x00, 0x4d, 0x7f, 0x7f, 0xff, 0xd9,
    ];

    /// 用 ffmpeg 生成 2 秒静音 MP3 作为测试夹具。
    fn fixture_mp3(dir: &std::path::Path, name: &str) -> PathBuf {
        let out = dir.join(name);
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=stereo",
                "-t",
                "2",
                "-q:a",
                "9",
            ])
            .arg(&out)
            .status()
            .expect("测试需要 ffmpeg（PATH 里找不到）");
        assert!(status.success(), "ffmpeg 生成 MP3 夹具失败");
        assert!(out.exists(), "MP3 夹具未生成");
        out
    }

    fn full_fields() -> MusicTagFields {
        MusicTagFields {
            title: "测试标题 Title".to_string(),
            artist: "测试歌手 Artist".to_string(),
            album: "测试专辑 Album".to_string(),
            album_artist: "专辑歌手".to_string(),
            year: "2024".to_string(),
            track: "7".to_string(),
            genre: "Test Genre".to_string(),
            lyrics: "第一行歌词\n第二行歌词".to_string(),
            comment: "备注 comment".to_string(),
        }
    }

    fn assert_all_empty(f: &MusicTagFields) {
        assert!(f.title.is_empty(), "title");
        assert!(f.artist.is_empty(), "artist");
        assert!(f.album.is_empty(), "album");
        assert!(f.album_artist.is_empty(), "album_artist");
        assert!(f.year.is_empty(), "year");
        assert!(f.track.is_empty(), "track");
        assert!(f.genre.is_empty(), "genre");
        assert!(f.lyrics.is_empty(), "lyrics");
        assert!(f.comment.is_empty(), "comment");
    }

    /// 读回 (fields, has_cover)。
    fn read_back(path: &std::path::Path) -> (MusicTagFields, bool) {
        let v = read_local_tags(path.to_str().unwrap());
        let fields: MusicTagFields =
            serde_json::from_value(v["fields"].clone()).expect("fields 反序列化失败");
        let has_cover = v["hasCover"].as_bool().unwrap_or(false);
        (fields, has_cover)
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mp3 = fixture_mp3(dir.path(), "full.mp3");
        let p = mp3.to_str().unwrap();

        let want = full_fields();
        write_local_tags(p, &want, "keep", None).expect("写入标签失败");

        let (got, has_cover) = read_back(&mp3);
        assert!(!has_cover, "不应有封面");
        assert_eq!(got.title, want.title);
        assert_eq!(got.artist, want.artist);
        assert_eq!(got.album, want.album);
        assert_eq!(got.album_artist, want.album_artist);
        assert_eq!(got.year, want.year);
        assert_eq!(got.track, want.track);
        assert_eq!(got.genre, want.genre);
        assert_eq!(got.lyrics, want.lyrics);
        assert_eq!(got.comment, want.comment);
    }

    #[test]
    fn empty_string_clears_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mp3 = fixture_mp3(dir.path(), "clear.mp3");
        let p = mp3.to_str().unwrap();

        // 先写入有值字段
        write_local_tags(p, &full_fields(), "keep", None).expect("写入标签失败");
        let (got, _) = read_back(&mp3);
        assert_eq!(got.title, "测试标题 Title", "前置条件：字段应已写入");

        // 再写入空串：按契约应清空全部字段
        write_local_tags(p, &MusicTagFields::default(), "keep", None).expect("清空写入失败");
        let (got, _) = read_back(&mp3);
        assert_all_empty(&got);
    }

    #[test]
    fn year_non_numeric_is_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let mp3 = fixture_mp3(dir.path(), "year.mp3");
        let p = mp3.to_str().unwrap();

        // 非数字年份无法写入 u32，按清空处理（不残留旧值、不抛错）
        let mut f = full_fields();
        f.year = "not-a-year".to_string();
        write_local_tags(p, &f, "keep", None).expect("写入失败");
        let (got, _) = read_back(&mp3);
        assert!(
            got.year.is_empty(),
            "非数字年份应被清空，实际：{}",
            got.year
        );

        // 数字年份正常 round-trip
        let mut f = full_fields();
        f.year = "1999".to_string();
        write_local_tags(p, &f, "keep", None).expect("写入失败");
        let (got, _) = read_back(&mp3);
        assert_eq!(got.year, "1999");
    }

    #[test]
    fn read_missing_file_falls_back_to_empty() {
        // 读不存在的文件：不抛错，回退空字段
        let v = read_local_tags("/nonexistent-dir-xyz/nope.mp3");
        let fields: MusicTagFields =
            serde_json::from_value(v["fields"].clone()).expect("fields 反序列化失败");
        assert_all_empty(&fields);
        assert_eq!(v["hasCover"], false);

        // 写不存在的文件：应返回 Err 而不是 panic
        let err = write_local_tags(
            "/nonexistent-dir-xyz/nope.mp3",
            &full_fields(),
            "keep",
            None,
        )
        .expect_err("写不存在的文件应返回 Err");
        assert!(
            err.contains("文件不存在"),
            "错误信息应提示文件不存在，实际：{err}"
        );
    }

    #[test]
    fn cover_set_keep_remove() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let mp3 = fixture_mp3(dir.path(), "cover.mp3");
        let p = mp3.to_str().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(TINY_JPEG);

        // set：写入封面
        write_local_tags(p, &MusicTagFields::default(), "set", Some(&b64)).expect("封面写入失败");
        let (_, has_cover) = read_back(&mp3);
        assert!(has_cover, "set 后应有封面");

        // keep：封面不动（同时验证字段写入不影响封面）
        write_local_tags(p, &full_fields(), "keep", None).expect("keep 写入失败");
        let (got, has_cover) = read_back(&mp3);
        assert!(has_cover, "keep 后封面应保留");
        assert_eq!(got.title, "测试标题 Title");

        // remove：删掉封面
        write_local_tags(p, &full_fields(), "remove", None).expect("remove 写入失败");
        let (_, has_cover) = read_back(&mp3);
        assert!(!has_cover, "remove 后封面应消失");
    }
}
