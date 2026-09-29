//! 缩略图：按媒体类型分派，结果落磁盘缓存。
//!
//! - image：image crate 解码 + Lanczos3 缩放，按 EXIF orientation 摆正
//! - audio：取内嵌封面图；没有则回退同目录 cover.jpg/folder.jpg
//! - video：ffmpeg 抽帧（不可用时返回 None，前端显示占位）
//! - book ：epub 取封面图片项
//!
//! 缓存键 = xxh3(file_id + mtime + size)，文件内容变化后自动失效。

use std::io::Read;
use std::path::PathBuf;

use silvermoon_ipc::HostApi;

use crate::commands::DbState;
use crate::media::{ext_of, DECODABLE_IMAGE_EXTS};

/// 缓存目录：<app_cache_dir>/thumbs
fn cache_dir(app: &silvermoon_ipc::Host) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn cache_key(file_id: &str, mtime: i64, size: i64, target: u32) -> String {
    let raw = format!("{file_id}:{mtime}:{size}:{target}");
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(raw.as_bytes()))
}

/// 列表接口使用的缩略图尺寸。
///
/// **必须**与前端按需请求的尺寸一致（`capabilities.getThumbnail(id, 320)`），
/// 否则列表带出的路径与前端请求的路径落在不同缓存键上，等于白带。
pub const LIST_THUMB_SIZE: u32 = 320;

/// 缩略图缓存文件名（不含目录）。
pub fn thumb_cache_name(file_id: &str, mtime: i64, size: i64, target: u32) -> String {
    format!("{}.jpg", cache_key(file_id, mtime, size, target))
}

/// 缩略图缓存目录的索引：目录 + 已存在的文件名集合。
pub type ThumbIndex = Option<(PathBuf, std::collections::HashSet<String>)>;

/// 一次性列出缩略图缓存目录里的文件名。
///
/// 列表接口要为**每一行**判断"缩略图是否已生成"。逐行 `Path::is_file()` 在
/// 上万行时会退化成上万次系统调用；这里只读一次目录建成 HashSet，之后每行 O(1) 查表。
pub fn cached_thumb_index(app: &silvermoon_ipc::Host) -> ThumbIndex {
    let dir = cache_dir(app)?;
    let names = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    Some((dir, names))
}

/// 若缩略图已在磁盘缓存中则返回其路径；**不触发生成**。
pub fn cached_thumb_path(
    index: &ThumbIndex,
    file_id: &str,
    mtime: i64,
    size: i64,
    target: u32,
) -> Option<String> {
    let (dir, names) = index.as_ref()?;
    let name = thumb_cache_name(file_id, mtime, size, target);
    names
        .contains(&name)
        .then(|| dir.join(&name).to_string_lossy().into_owned())
}

/// 把任意已解码图像缩放并编码为 JPEG 字节
fn to_jpeg(img: image::DynamicImage, target: u32, orientation: Option<i64>) -> Option<Vec<u8>> {
    let img = apply_orientation(img, orientation);
    // thumbnail 内部用 Lanczos3，保持长宽比
    let thumb = img.thumbnail(target, target);
    // JPEG 编码器不接受 alpha 通道
    let rgb = image::DynamicImage::ImageRgb8(thumb.to_rgb8());
    let mut buf = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut buf, image::ImageFormat::Jpeg).ok()?;
    Some(buf.into_inner())
}

/// 按 EXIF orientation（1..8）摆正图像
fn apply_orientation(img: image::DynamicImage, orientation: Option<i64>) -> image::DynamicImage {
    match orientation.unwrap_or(1) {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// 同目录下常见的封面文件名
const COVER_NAMES: &[&str] = &[
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "folder.jpg",
    "folder.png",
    "front.jpg",
    "album.jpg",
];

/// 同目录封面（SMTC 也用它给系统浮层配图）
pub(crate) fn sidecar_cover(path: &str) -> Option<Vec<u8>> {
    let dir = std::path::Path::new(path).parent()?;
    for name in COVER_NAMES {
        let candidate = dir.join(name);
        if candidate.is_file() {
            if let Ok(bytes) = std::fs::read(&candidate) {
                return Some(bytes);
            }
        }
    }
    None
}

/// 从音频标签中取内嵌封面原始字节
pub fn embedded_cover(path: &str) -> Option<Vec<u8>> {
    use lofty::file::TaggedFileExt;
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    Some(pic.data().to_vec())
}

/// 从 epub 中取封面图片
fn epub_cover(path: &str) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).ok()?;

    // 找名字里含 cover 的图片项；找不到就用第一张图片
    let mut cover_name: Option<String> = None;
    let mut first_image: Option<String> = None;
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        let name = entry.name().to_string();
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".webp"))
        {
            continue;
        }
        if first_image.is_none() {
            first_image = Some(name.clone());
        }
        if lower.contains("cover") {
            cover_name = Some(name);
            break;
        }
    }

    let target = cover_name.or(first_image)?;
    let mut entry = zip.by_name(&target).ok()?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 解码图片。
///
/// image 0.25 未暴露 JPEG 的 DCT 降采样接口，只能整幅解码；
/// 因此这里限制解码时的内存上限，避免个别超大图（或损坏文件谎报尺寸）
/// 一次性吃掉几个 GB 把进程拖垮——缩略图场景宁可跳过也不该卡死。
fn decode_scaled(path: &str, _target: u32) -> Option<image::DynamicImage> {
    use image::ImageReader;

    let file = std::fs::File::open(path).ok()?;
    let mut reader = ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .ok()?;

    let mut limits = image::Limits::default();
    // 单张图解码上限 512MB，足够 8K RGBA，又能挡住异常大图
    limits.max_alloc = Some(512 * 1024 * 1024);
    limits.max_image_width = Some(30_000);
    limits.max_image_height = Some(30_000);
    reader.limits(limits);

    reader.decode().ok()
}

/// 生成缩略图，返回**磁盘缓存文件路径**（前端用 toAssetUrl 引用）。
///
/// 早期版本返回 base64 data URL，导致每张图在 JS 堆里常驻一份字符串，
/// 上万张图片时渲染进程内存暴涨、页面严重卡顿。改为返回路径后由
/// webview 直接流式读取，内存由浏览器按需回收。
#[silvermoon_ipc::command]
pub fn get_thumbnail(
    app: silvermoon_ipc::Host,
    file_id: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    let target = size.unwrap_or(320).clamp(64, 1024);
    thumbnail_for(&app, &file_id, target)
}

/// 批量取缩略图：一次往返处理整个可视区的 id，返回值与 `file_ids` 按下标一一对应。
///
/// 单张版 `get_thumbnail` 在网格滚动时会变成 N 次进程往返（30 张卡片 = 30 次
/// IPC + HTTP + JSON 信封），这是列表滚动卡顿的主要来源之一。批量通道把它压成一次。
#[silvermoon_ipc::command]
pub fn get_thumbnails(
    app: silvermoon_ipc::Host,
    file_ids: Vec<String>,
    size: Option<u32>,
) -> Result<Vec<Option<String>>, String> {
    let target = size.unwrap_or(320).clamp(64, 1024);
    // 单张失败降级为 null，不拖垮整批（前端按 null 显示占位图）
    Ok(file_ids
        .iter()
        .map(|id| thumbnail_for(&app, id.as_str(), target).unwrap_or(None))
        .collect())
}

/// 生成/取用单张缩略图（单张命令与批量命令共用），返回磁盘缓存路径。
///
/// 保持 `Result` 语义与重构前一致：文件不存在等错误仍然向上抛，
/// 只有"确实没有封面"才是 `Ok(None)`。
fn thumbnail_for(
    app: &silvermoon_ipc::Host,
    file_id: &str,
    target: u32,
) -> Result<Option<String>, String> {
    // 取文件信息（尽早释放数据库锁，解码可能耗时）
    let (path, kind, mtime, fsize, orientation, duration) = {
        let state = app.state::<DbState>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT f.path, f.type, f.mtime, f.size, m.orientation, m.duration_ms
             FROM files f LEFT JOIN media_metadata m ON m.file_id = f.id
             WHERE f.id = ?1",
            rusqlite::params![file_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .map_err(|_| format!("文件不存在: {file_id}"))?
    };

    let Some(dir) = cache_dir(app) else {
        return Ok(None);
    };
    let cache_file = dir.join(thumb_cache_name(file_id, mtime, fsize, target));

    // ---- 磁盘缓存命中 ----
    if cache_file.is_file() {
        return Ok(Some(cache_file.to_string_lossy().into_owned()));
    }

    // ---- 按类型生成 ----
    let jpeg: Option<Vec<u8>> = match kind.as_str() {
        "image" => {
            let ext = ext_of(std::path::Path::new(&path));
            if DECODABLE_IMAGE_EXTS.contains(&ext.as_str()) {
                decode_scaled(&path, target).and_then(|img| to_jpeg(img, target, orientation))
            } else {
                None
            }
        }
        "audio" => embedded_cover(&path)
            .or_else(|| sidecar_cover(&path))
            .and_then(|bytes| image::load_from_memory(&bytes).ok())
            .and_then(|img| to_jpeg(img, target, None)),
        "video" => crate::commands::ffmpeg::extract_frame(&path, target, duration),
        // PDF 首页封面需要栅格化 PDF，纯 Rust 方案体积过大；
        // 改由前端 pdf.js 渲染后回传（generate_pdf_cover），这里只处理 EPUB。
        "book" => epub_cover(&path)
            .and_then(|bytes| image::load_from_memory(&bytes).ok())
            .and_then(|img| to_jpeg(img, target, None)),
        _ => None,
    };

    let Some(jpeg) = jpeg else { return Ok(None) };

    std::fs::write(&cache_file, &jpeg).map_err(|e| e.to_string())?;
    Ok(Some(cache_file.to_string_lossy().into_owned()))
}

/// 查询某文件的缩略图缓存路径；未生成时返回 None。
/// 前端据此判断是否需要用 pdf.js 渲染 PDF 首页封面。
#[silvermoon_ipc::command]
pub fn thumbnail_cache_path(
    app: silvermoon_ipc::Host,
    file_id: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    let target = size.unwrap_or(320).clamp(64, 1024);
    let (mtime, fsize) = {
        let state = app.state::<DbState>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT mtime, size FROM files WHERE id=?1",
            rusqlite::params![file_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|_| format!("文件不存在: {file_id}"))?
    };
    let Some(dir) = cache_dir(&app) else {
        return Ok(None);
    };
    let path = dir.join(format!("{}.jpg", cache_key(&file_id, mtime, fsize, target)));
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

/// 保存前端渲染出的封面（PDF 首页）到缩略图磁盘缓存，返回缓存路径。
#[silvermoon_ipc::command]
pub fn save_thumbnail(
    app: silvermoon_ipc::Host,
    file_id: String,
    size: Option<u32>,
    jpeg: Vec<u8>,
) -> Result<Option<String>, String> {
    if jpeg.is_empty() {
        return Ok(None);
    }
    let target = size.unwrap_or(320).clamp(64, 1024);
    let (mtime, fsize) = {
        let state = app.state::<DbState>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT mtime, size FROM files WHERE id=?1",
            rusqlite::params![file_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|_| format!("文件不存在: {file_id}"))?
    };
    let Some(dir) = cache_dir(&app) else {
        return Ok(None);
    };
    let path = dir.join(format!("{}.jpg", cache_key(&file_id, mtime, fsize, target)));
    std::fs::write(&path, &jpeg).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 清空缩略图磁盘缓存，返回释放的字节数
#[silvermoon_ipc::command]
pub fn clear_thumbnail_cache(app: silvermoon_ipc::Host) -> Result<u64, String> {
    let Some(dir) = cache_dir(&app) else {
        return Ok(0);
    };
    let mut freed = 0u64;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if let Ok(md) = entry.metadata() {
            if md.is_file() && std::fs::remove_file(entry.path()).is_ok() {
                freed += md.len();
            }
        }
    }
    Ok(freed)
}
