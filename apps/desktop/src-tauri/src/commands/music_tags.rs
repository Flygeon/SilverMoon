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

    // Accessor 未覆盖的组合字段走 ItemKey
    let extras: [(ItemKey, &str); 4] = [
        (ItemKey::AlbumArtist, fields.album_artist.as_str()),
        (ItemKey::Year, fields.year.as_str()),
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
            fields.year = tag
                .get_string(&ItemKey::Year)
                .unwrap_or_default()
                .to_string();
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
