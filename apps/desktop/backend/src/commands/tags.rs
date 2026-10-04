//! 本地音频标签读写（lofty）—— Win7 兼容版的标签实现。
//!
//! ## 为什么需要 Rust 侧实现
//!
//! 正式版（Electron 44）用 `taglib-wasm` 在 Electron 主进程里写标签。但 Win7
//! 兼容版必须停在 **Electron 22**（最后一个支持 Win7 的大版本），其 Node 为
//! **16.17.1**；而 `taglib-wasm` 要求 **Node >= 22.6**（1.x）或 **>= 24**（2.x）——
//! 实测在 Node 16 上初始化直接报：
//!
//! ``text
//! EnvironmentError: Environment 'Node.js' Node.js v22.6.0 or higher is required.
//! Older versions lack WASI and Wasm exception handling support.
//! Required feature: WASI support.
//! ```
//!
//! Node 16 连 `wasi` 模块都没有，且没有任何历史版本可用。因此 Win7 版把
//! 「读/写本地音频标签」下沉到后端 —— 这里本来就已经在用 `lofty` 读元数据
//! （见 `commands/metadata.rs`），写盘能力也已有先例（`osu.rs` 的 `write_tags`）。
//!
//! ## 字段语义（与前端 `MusicTagFields` 严格对齐）
//!
//! - 所有字段都是 `Option<String>`：`None` = **本次不改**，`Some("")` = **清空**；
//! - `year` / `trackNo` / `discNo` 保持**原始字符串**（"2005-10-31" / "3/12"），
//!   不做数值化 —— 数值型 setter 会把它们压平，这一点与 taglib 版一致。
//! - `cover`：`keep` 不动 / `set` 替换（带 base64）/ `remove` 删除。

use base64::Engine as _;
use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, ItemKey};
use lofty::tag::{Tag, TagExt, TagType};
use serde::{Deserialize, Serialize};

/// 封面处理方式，与前端 `MusicTagCoverMode` 对应。
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum CoverMode {
    #[default]
    Keep,
    Set,
    Remove,
}

/// 一次写标签的全部入参。
///
/// `Option<Option<String>>` 不必要：用 `Option<String>` 表达「改或清」，
/// `None` 表示该字段本次不参与。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WriteTagFields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    /// 原样字符串（"2005" / "2005-10-31"）
    pub year: Option<String>,
    /// 原样字符串（"3" / "3/12"）
    pub track_no: Option<String>,
    pub disc_no: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub lyrics: Option<String>,
}

/// 写标签的完整请求。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteLocalTagsArgs {
    pub path: String,
    #[serde(default)]
    pub fields: WriteTagFields,
    #[serde(default)]
    pub cover_mode: CoverMode,
    /// base64（可带 dataURL 前缀）—— 仅 `cover_mode = Set` 时有意义。
    pub cover_base64: Option<String>,
    pub cover_mime: Option<String>,
}

/// 读回的标签字段（与前端 `MusicTagFields` 一一对应，空串表示空）。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagFields {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub year: String,
    pub track_no: String,
    pub disc_no: String,
    pub genre: String,
    pub comment: String,
    pub lyrics: String,
}

/// 是否支持写入该文件的标签（lofty 能识别且有可写标签类型）。
fn primary_or_first_tag(tagged: &lofty::file::TaggedFile) -> Option<&Tag> {
    tagged.primary_tag().or_else(|| tagged.first_tag())
}

/// 读取本地音频标签。
///
/// 与 taglib 版的 `readLocal` 契约一致：**失败不抛**，返回空字段
/// （前端在「写标签」对话框里对读不到的文件仍允许手填）。
#[silvermoon_ipc::command]
pub fn tags_read_local(path: String) -> Result<LocalTagFields, String> {
    let Ok(tagged) = lofty::read_from_path(&path) else {
        return Ok(LocalTagFields::default());
    };
    let Some(tag) = primary_or_first_tag(&tagged) else {
        return Ok(LocalTagFields::default());
    };

    let s = |v: Option<std::borrow::Cow<'_, str>>| v.map(|x| x.to_string()).unwrap_or_default();
    let item = |k: ItemKey| {
        tag.get_string(&k)
            .map(|x| x.to_string())
            .unwrap_or_default()
    };

    // 年份 / 音轨 / 碟号优先取**原始字符串**（"2005-10-31" / "3/12"），
    // 取不到才退回 lofty 的数值型访问器 —— 数值型会把复合写法压平。
    let prefer_raw = |raw: String, fallback: Option<String>| {
        if raw.is_empty() {
            fallback.unwrap_or_default()
        } else {
            raw
        }
    };

    Ok(LocalTagFields {
        title: s(tag.title()),
        artist: s(tag.artist()),
        album: s(tag.album()),
        album_artist: item(ItemKey::AlbumArtist),
        year: prefer_raw(item(ItemKey::Year), tag.year().map(|y| y.to_string())),
        track_no: prefer_raw(
            item(ItemKey::TrackNumber),
            tag.track().map(|t| t.to_string()),
        ),
        disc_no: prefer_raw(item(ItemKey::DiscNumber), tag.disk().map(|d| d.to_string())),
        genre: s(tag.genre()),
        comment: item(ItemKey::Comment),
        lyrics: item(ItemKey::Lyrics),
    })
}

/// 选择一个可写的标签：优先沿用文件已有的，没有就按容器类型新建。
fn target_tag_type(tagged: &lofty::file::TaggedFile, path: &str) -> TagType {
    if let Some(tag) = primary_or_first_tag(tagged) {
        return tag.tag_type();
    }
    // 新建时按扩展名挑默认类型，避免给 FLAC 写 ID3v2 这类错配
    match std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("flac") | Some("ogg") | Some("opus") => TagType::VorbisComments,
        Some("m4a") | Some("mp4") | Some("aac") => TagType::Mp4Ilst,
        Some("wma") => TagType::Ape,
        _ => TagType::Id3v2,
    }
}

/// 空串 = 清空，非空 = 写入。用 `Option<String>` 区分「不改」与「清空」。
fn apply_fields(tag: &mut Tag, fields: &WriteTagFields) {
    if let Some(v) = &fields.title {
        tag.set_title(v.clone());
    }
    if let Some(v) = &fields.artist {
        tag.set_artist(v.clone());
    }
    if let Some(v) = &fields.album {
        tag.set_album(v.clone());
    }
    if let Some(v) = &fields.genre {
        tag.set_genre(v.clone());
    }
    if let Some(v) = &fields.comment {
        tag.set_comment(v.clone());
    }
    if let Some(v) = &fields.album_artist {
        set_or_remove(tag, ItemKey::AlbumArtist, v);
    }
    if let Some(v) = &fields.year {
        set_or_remove(tag, ItemKey::Year, v);
    }
    if let Some(v) = &fields.track_no {
        set_or_remove(tag, ItemKey::TrackNumber, v);
    }
    if let Some(v) = &fields.disc_no {
        set_or_remove(tag, ItemKey::DiscNumber, v);
    }
    if let Some(v) = &fields.lyrics {
        set_or_remove(tag, ItemKey::Lyrics, v);
    }
}

/// 取（或新建）指定类型的标签。
fn tag_type_owned(file: &lofty::file::TaggedFile, tag_type: TagType) -> Tag {
    file.tag(tag_type)
        .cloned()
        .unwrap_or_else(|| Tag::new(tag_type))
}

/// 空串 → 删除该键；非空 → 写入。
fn set_or_remove(tag: &mut Tag, key: ItemKey, value: &str) {
    if value.is_empty() {
        tag.remove_key(&key);
    } else {
        tag.insert_text(key, value.to_string());
    }
}

/// 写入本地音频标签。
///
/// 先备份原文件字节，写失败时回滚 —— 音频文件是用户的原始资产，
/// 任何情况下都不应因写标签失败而损坏。
#[silvermoon_ipc::command]
pub fn tags_write_local(args: WriteLocalTagsArgs) -> Result<(), String> {
    let path = std::path::Path::new(&args.path);
    if !path.is_file() {
        return Err(format!("文件不存在：{}", args.path));
    }

    // 备份：写失败能回滚（lofty 的 save 是原地重写整个文件）
    let backup = std::fs::read(path).map_err(|e| format!("读取原文件失败：{e}"))?;

    let result = write_inner(&args);
    if let Err(error) = result {
        // 回滚；回滚本身失败也不能掩盖原始错误，只记录
        if let Err(rollback) = std::fs::write(path, &backup) {
            eprintln!("[tags] 回滚失败（原错误：{error}）：{rollback}");
        }
        return Err(error);
    }
    Ok(())
}

fn write_inner(args: &WriteLocalTagsArgs) -> Result<(), String> {
    let path = std::path::Path::new(&args.path);
    let tagged = lofty::read_from_path(path).map_err(|e| format!("lofty 无法解析该文件：{e}"))?;

    let tag_type = target_tag_type(&tagged, &args.path);
    // 直接操作**拥有的** Tag，再用 TagExt::save_to_path 落盘。
    // 不走 TaggedFile::save_to_path：lofty 0.20 的 TaggedFile 没有这个方法
    // （它只能在读取时投影出标签），写盘入口在 Tag 上 —— osu.rs 的 write_tags 同款。
    let mut tag = tag_type_owned(&tagged, tag_type);

    apply_fields(&mut tag, &args.fields);

    // 封面
    match args.cover_mode {
        CoverMode::Keep => {}
        CoverMode::Remove => {
            tag.remove_picture_type(PictureType::CoverFront);
        }
        CoverMode::Set => {
            let raw = args
                .cover_base64
                .as_deref()
                .ok_or("coverMode=set 但缺少封面数据")?;
            let bytes = decode_base64(raw)?;
            if bytes.is_empty() {
                return Err("coverMode=set 但封面数据为空".into());
            }
            let mime = args
                .cover_mime
                .as_deref()
                .map(mime_from)
                .unwrap_or(MimeType::Jpeg);
            tag.remove_picture_type(PictureType::CoverFront);
            tag.push_picture(Picture::new_unchecked(
                PictureType::CoverFront,
                Some(mime),
                None,
                bytes,
            ));
        }
    }

    tag.save_to_path(path, WriteOptions::new())
        .map_err(|e| format!("写入标签失败：{e}"))
}

/// 解析 base64（容忍 `data:image/png;base64,` 前缀）。
fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let raw = if let Some(idx) = value.find(',') {
        if value.starts_with("data:") {
            &value[idx + 1..]
        } else {
            value
        }
    } else {
        value
    };
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("封面 base64 解码失败：{e}"))
}

/// MIME 字符串 → lofty 的 `MimeType`。
fn mime_from(value: &str) -> MimeType {
    let v = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match v.as_str() {
        "image/png" => MimeType::Png,
        "image/gif" => MimeType::Gif,
        "image/bmp" => MimeType::Bmp,
        "image/tiff" => MimeType::Tiff,
        _ => MimeType::Jpeg,
    }
}
