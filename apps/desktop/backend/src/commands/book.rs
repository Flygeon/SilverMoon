//! 书籍阅读进度：读取 / 保存 `book_progress` 表。
//!
//! EPUB 用 CFI（location）定位精确位置；page 存章节/页码索引，percent 存百分比。
//! 每次翻页（relocated）保存，应用退出/关闭书籍时也会补一次。

use serde::{Deserialize, Serialize};
use silvermoon_ipc::HostApi;

use crate::commands::{now_secs, DbState};
use crate::media::{classify, ext_of, MediaKind};

/// 阅读进度（字段 camelCase，与前端 BookProgress 对应）
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookProgress {
    pub book_id: String,
    pub location: String,
    pub page: i64,
    pub percent: f64,
    pub updated_at: i64,
}

/// 读取某本书的阅读进度；无记录时返回 null
#[silvermoon_ipc::command]
pub fn get_book_progress(
    app: silvermoon_ipc::Host,
    file_id: String,
) -> Result<Option<BookProgress>, String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT book_id, location, page, percent, updated_at
         FROM book_progress WHERE book_id=?1",
        rusqlite::params![file_id],
        |row| {
            Ok(BookProgress {
                book_id: row.get(0)?,
                location: row.get(1)?,
                page: row.get(2)?,
                percent: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    );
    match result {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 保存 / 覆盖某本书的阅读进度
#[silvermoon_ipc::command]
pub fn save_book_progress(
    app: silvermoon_ipc::Host,
    book_id: String,
    location: String,
    page: i64,
    percent: f64,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO book_progress (book_id, location, page, percent, updated_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(book_id) DO UPDATE SET
           location=excluded.location, page=excluded.page,
           percent=excluded.percent, updated_at=excluded.updated_at",
        rusqlite::params![book_id, location, page, percent, now_secs()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
/// 手动导入书籍文件。
///
/// 书籍不再参与媒体扫描：扫描会软删除「本次没见到」的条目，用户自己挑的书
/// 不该被一次「重新扫描」清掉。这里往 `files` 表写一行 `imported = 1` 的记录，
/// 扫描的软删除 SQL 会跳过导入项；`list_files(type=book)` 也只返回导入项。
/// 升级时旧库里的书籍记录会回填为 imported=1（见 schema v6 迁移），不会突然消失。
///
/// 导入**不复制文件**：记录绝对路径，删除磁盘文件后由缩略图/阅读器自然报错。
/// 返回成功导入的条数；单个文件失败（不存在 / 扩展名不支持 / 非普通文件）直接跳过，
/// 不让一个坏路径毁掉整批导入。
#[silvermoon_ipc::command]
pub fn book_import(
    state: silvermoon_ipc::State<'_, DbState>,
    paths: Vec<String>,
) -> Result<usize, String> {
    let scanned_at = now_secs();
    let mut imported = 0usize;

    for raw in paths {
        let path = raw.trim();
        if path.is_empty() {
            continue;
        }
        let p = std::path::Path::new(path);
        let ext = ext_of(p);
        if classify(&ext) != Some(MediaKind::Book) {
            continue;
        }
        let Ok(md) = std::fs::metadata(p) else {
            continue;
        };
        if !md.is_file() {
            continue;
        }

        // id 与扫描一致：路径的 xxh3。这样「曾经扫描过、后来改为导入」的同一路径
        // 会命中同一条记录并升级为 imported=1，不会产生重复条目。
        let id = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(path.as_bytes()));
        let parent = p
            .parent()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = p
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = md.len() as i64;

        {
            let conn = state.0.lock().map_err(|_| "db lock".to_string())?;
            conn.execute(
                "INSERT INTO files
                   (id, path, parent, name, ext, type, size, mtime, scanned_at, parsed_at, deleted, imported)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'book', ?6, ?7, ?8, 0, 0, 1)
                 ON CONFLICT(id) DO UPDATE SET
                   path=excluded.path, parent=excluded.parent, name=excluded.name,
                   ext=excluded.ext, type=excluded.type, size=excluded.size,
                   mtime=excluded.mtime, scanned_at=excluded.scanned_at,
                   deleted=0, imported=1",
                rusqlite::params![id, path, parent, name, ext, size, mtime, scanned_at],
            )
            .map_err(|e| e.to_string())?;
        }

        // 元数据解析可能读 EPUB zip，放在数据库锁之外。
        let meta = crate::commands::metadata::extract(path, &id, "book");
        {
            let conn = state.0.lock().map_err(|_| "db lock".to_string())?;
            crate::commands::metadata::save(&conn, &meta).map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE files SET parsed_at=?1 WHERE id=?2",
                rusqlite::params![scanned_at, id],
            )
            .map_err(|e| e.to_string())?;
        }
        imported += 1;
    }

    Ok(imported)
}
