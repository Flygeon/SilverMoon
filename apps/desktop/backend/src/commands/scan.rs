//! 文件扫描：枚举 → 差分 → 入库 → 后台解析元数据。
//!
//! 设计要点：
//! - 枚举与解析分离，枚举阶段只做 stat，保证大目录也能秒级出列表。
//! - 差分入库：mtime/size 未变的文件跳过重新解析；本次未见到的文件标记 deleted=1。
//! - 取消通过 AtomicBool 传播，扫描循环在每个文件边界检查。
//! - 进度既写入 JobState（供轮询）也 emit 事件（供实时订阅）。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use silvermoon_ipc::{EventEmitter, HostApi, State};
use walkdir::WalkDir;

use crate::commands::{init_db, now_secs, DbState, JobState, ScanJob, ScanJobInfo};
use crate::media::{classify, ext_of};

/// 扫描范围模式。
///
/// 界面上的语义（设置 → 扫描与索引）：
/// - **白名单**：只扫描 `dirs` 里的目录。
/// - **黑名单**：扫描**所有固定驱动器**，但排除 `dirs` 里的目录（及其子树）。
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScanMode {
    /// 只扫 `dirs`（默认，与历史行为一致）
    #[default]
    Whitelist,
    /// 扫全局（所有固定驱动器），排除 `dirs`
    Blacklist,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanConfig {
    /// 含义随 `mode` 变化：白名单 = 要扫描的目录；黑名单 = 要**排除**的目录。
    pub dirs: Vec<String>,
    #[serde(default)]
    pub mode: ScanMode,
    #[serde(default)]
    pub max_depth: Option<usize>,
    /// 是否跟随符号链接（默认否，避免成环）
    #[serde(default)]
    pub follow_links: bool,
    /// 强制重新解析所有文件的元数据，忽略 mtime 差分
    #[serde(default)]
    pub force_reparse: bool,
}

/// 枚举「全局扫描」的根目录：所有固定驱动器。
///
/// 刻意**不引入新依赖**（不拉 windows-sys / sysinfo），而是直接探测盘符 ——
/// `std::fs::metadata` 底层是 `GetFileAttributesW`，对空光驱 / 未就绪的可移动盘
/// 会立即返回错误，不会像 `SetCurrentDirectory` 那类旧 API 一样弹「请插入磁盘」。
///
/// ⚠️ **已知局限**：`metadata` 没有超时。如果机器上有「已连接但不可达」的
/// 网络驱动器（映射盘掉线），这一句可能阻塞几十秒，而且它在取消检查之前 ——
/// 用户点取消也打断不了。断开的映射通常会立刻返回错误，真正会挂的是
/// 「连着但对面没响应」。真遇到这种情况，正解是换成 `GetDriveTypeW` 只取
/// `DRIVE_FIXED`（需要引入 windows-sys）。
#[cfg(windows)]
fn enumerate_fixed_roots() -> Vec<String> {
    let mut roots = Vec::new();
    for c in b'A'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if std::fs::metadata(&root).is_ok() {
            roots.push(root);
        }
    }
    roots
}

/// 非 Windows：以文件系统根为全局范围。
#[cfg(not(windows))]
fn enumerate_fixed_roots() -> Vec<String> {
    vec!["/".to_string()]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStartResult {
    pub job_id: String,
}

/// 扫描时**始终**跳过的目录名（按名字匹配，任意层级生效）。
///
/// 黑名单模式会从盘符根开始遍历，必须把系统目录挡在外面 —— 否则光 C:\Windows
/// 就有几十万文件，枚举阶段会被拖到不可接受。这些名字在任何模式下跳过都不会
/// 误伤真实媒体（没人把媒体库叫 WinSxS）。
const SKIP_DIRS: &[&str] = &[
    // Windows 系统 / 回收站 / 应用数据
    "$RECYCLE.BIN",
    "System Volume Information",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "PerfLogs",
    "Recovery",
    "$WinREAgent",
    "MSOCache",
    "Config.Msi",
    "WinSxS",
    "System32",
    "SysWOW64",
    "OneDriveTemp",
    "AppData",
    // Unix 系统目录
    "proc",
    "sys",
    "dev",
    "run",
    "boot",
    "lost+found",
    "snap",
    // 版本控制 / 依赖 / 构建产物
    "node_modules",
    ".git",
    ".svn",
    "__pycache__",
    "target",
];

/// 该目录名是否应当跳过（隐藏目录 / 系统目录 / 依赖目录）。
///
/// 单独抽出来是为了让 `filter_entry` 里的条件保持短行 —— 长条件在 rustfmt 下
/// 的折行位置很微妙，短条件没有歧义。
fn is_skipped_dir_name(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

/// 路径是否落在任一排除目录内（**含其自身**）。
///
/// 用 `Path::starts_with`（按路径分量比较）而不是字符串前缀 ——
/// 后者会让 `/media/music2` 被 `/media/music` 误伤。
fn is_excluded(path: &std::path::Path, excludes: &[std::path::PathBuf]) -> bool {
    excludes
        .iter()
        .any(|ex| path == ex.as_path() || path.starts_with(ex))
}

/// 按模式算出「实际要遍历的根」与「要排除的目录」。
fn resolve_scope(config: &ScanConfig) -> (Vec<String>, Vec<std::path::PathBuf>) {
    match config.mode {
        ScanMode::Whitelist => (config.dirs.clone(), Vec::new()),
        ScanMode::Blacklist => (
            enumerate_fixed_roots(),
            config.dirs.iter().map(std::path::PathBuf::from).collect(),
        ),
    }
}

fn xxh3_hex(s: &str) -> String {
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(s.as_bytes()))
}

fn uuid4() -> String {
    let mut buf = [0u8; 16];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 枚举阶段产出的一条候选记录
struct Candidate {
    id: String,
    path: String,
    parent: String,
    name: String,
    ext: String,
    kind: &'static str,
    size: i64,
    mtime: i64,
}

/// 启动异步扫描任务，立即返回 jobId
#[silvermoon_ipc::command]
pub fn scan_start(
    app: silvermoon_ipc::Host,
    state: State<'_, JobState>,
    config: ScanConfig,
) -> Result<ScanStartResult, String> {
    // 白名单模式必须有目录；黑名单模式的 dirs 是「排除项」，可以为空
    // （= 全局扫描且不排除任何目录）。
    if config.mode == ScanMode::Whitelist && config.dirs.is_empty() {
        return Err("白名单模式下至少要选择一个扫描目录".into());
    }

    let job_id = format!("scan-{}", uuid4());
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.0.lock().map_err(|e| e.to_string())?;
        jobs.insert(
            job_id.clone(),
            ScanJob {
                info: ScanJobInfo::new(job_id.clone()),
                cancel: cancel.clone(),
            },
        );
    }

    let job_id_ret = job_id.clone();
    silvermoon_ipc::rt::spawn_blocking(move || {
        if let Err(e) = run_scan(&app, &job_id, config, &cancel) {
            fail_job(&app, &job_id, &e);
        }
    });

    Ok(ScanStartResult { job_id: job_id_ret })
}

fn run_scan(
    app: &silvermoon_ipc::Host,
    job_id: &str,
    config: ScanConfig,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    // ---- 阶段 1：枚举 ----
    set_stage(app, job_id, "enumerate", 0, 0, "");

    let max_depth = config.max_depth.unwrap_or(usize::MAX);
    // 按模式解析真实范围：白名单 = dirs；黑名单 = 所有固定驱动器 − dirs
    let (roots, excludes) = resolve_scope(&config);
    if roots.is_empty() {
        return Err("没有可扫描的目录（未找到任何固定驱动器）".into());
    }
    if config.mode == ScanMode::Blacklist {
        let msg = format!(
            "全局扫描 {} 个驱动器根，排除 {} 个目录",
            roots.len(),
            excludes.len()
        );
        set_stage(app, job_id, "enumerate", 0, 0, &msg);
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for dir in &roots {
        let walker = WalkDir::new(dir)
            .max_depth(max_depth)
            .follow_links(config.follow_links)
            .into_iter()
            .filter_entry(|e| {
                if !e.file_type().is_dir() {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                // 跳过隐藏目录与已知的系统/依赖目录
                if is_skipped_dir_name(&name) {
                    return false;
                }
                // 黑名单模式：跳过用户排除的目录及其整棵子树
                !is_excluded(e.path(), &excludes)
            });

        for entry in walker {
            if cancel.load(Ordering::Relaxed) {
                return finish_cancelled(app, job_id);
            }
            // 单个目录不可读（权限等）不应中断整次扫描
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = ext_of(path);
            let Some(kind) = classify(&ext) else { continue };

            // 一次 stat 拿到 size 与 mtime，避免旧实现的两次系统调用
            let Ok(md) = entry.metadata() else { continue };
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let path_str = path.to_string_lossy().to_string();
            // 多个扫描目录互相嵌套时会重复枚举同一文件
            if !seen_paths.insert(path_str.clone()) {
                continue;
            }

            candidates.push(Candidate {
                id: xxh3_hex(&path_str),
                parent: path
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: path_str,
                ext,
                kind: kind.as_str(),
                size: md.len() as i64,
                mtime,
            });

            if candidates.len() % 200 == 0 {
                let n = candidates.len();
                let last = candidates[n - 1].path.clone();
                set_stage(app, job_id, "enumerate", n, 0, &last);
            }
        }
    }

    let total = candidates.len();
    set_stage(app, job_id, "store", 0, total, "");

    // ---- 阶段 2：差分入库 ----
    let scanned_at = now_secs();
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut dirty: Vec<(String, String, &'static str)> = Vec::new();
    let removed: usize;

    {
        let db = app.state::<DbState>();
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        init_db(&conn).map_err(|e| e.to_string())?;

        // 载入已知条目用于差分：path -> (mtime, size)
        let existing: std::collections::HashMap<String, (i64, i64)> = {
            let mut stmt = conn
                .prepare("SELECT path, mtime, size FROM files")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO files (id, path, parent, name, ext, type, size, mtime, scanned_at, parsed_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0)
                     ON CONFLICT(id) DO UPDATE SET
                       path=excluded.path, parent=excluded.parent, name=excluded.name,
                       ext=excluded.ext, type=excluded.type, size=excluded.size,
                       mtime=excluded.mtime, scanned_at=excluded.scanned_at, deleted=0",
                )
                .map_err(|e| e.to_string())?;

            for (i, c) in candidates.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    return finish_cancelled(app, job_id);
                }

                let changed = match existing.get(&c.path) {
                    None => {
                        added += 1;
                        true
                    }
                    Some((old_mtime, old_size)) => {
                        let ch = *old_mtime != c.mtime || *old_size != c.size;
                        if ch {
                            updated += 1;
                        }
                        ch
                    }
                };

                insert
                    .execute(rusqlite::params![
                        c.id, c.path, c.parent, c.name, c.ext, c.kind, c.size, c.mtime, scanned_at
                    ])
                    .map_err(|e| e.to_string())?;

                if changed || config.force_reparse {
                    dirty.push((c.id.clone(), c.path.clone(), c.kind));
                }

                if i % 500 == 0 {
                    let p = c.path.clone();
                    set_stage(app, job_id, "store", i, total, &p);
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        // ---- 阶段 3：软删除本次未见到的条目 ----
        removed = conn
            .execute(
                "UPDATE files SET deleted=1 WHERE deleted=0 AND scanned_at < ?1",
                rusqlite::params![scanned_at],
            )
            .map_err(|e| e.to_string())?;
    }

    // ---- 阶段 4：并行解析元数据 ----
    let dirty_total = dirty.len();
    set_stage(app, job_id, "parse", 0, dirty_total, "");

    let done = AtomicUsize::new(0);
    let parsed: Vec<crate::MediaMetadata> = dirty
        .par_iter()
        .filter_map(|(id, path, kind)| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let meta = crate::commands::metadata::extract(path, id, kind);
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 25 == 0 || n == dirty_total {
                set_stage(app, job_id, "parse", n, dirty_total, path);
            }
            Some(meta)
        })
        .collect();

    if cancel.load(Ordering::Relaxed) {
        return finish_cancelled(app, job_id);
    }

    // 解析结果批量落库
    {
        let db = app.state::<DbState>();
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for m in &parsed {
            let _ = crate::commands::metadata::save(&tx, m);
            let _ = tx.execute(
                "UPDATE files SET parsed_at=?1 WHERE id=?2",
                rusqlite::params![scanned_at, m.file_id],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // ---- 完成 ----
    let final_info = with_job(app, job_id, |j| {
        j.info.stage = "done".into();
        j.info.done = total;
        j.info.total = total;
        j.info.percent = 100.0;
        j.info.current_path = String::new();
        j.info.added = added;
        j.info.updated = updated;
        j.info.removed = removed;
        j.info.clone()
    });
    if let Some(info) = final_info {
        let _ = app.emit("scan:progress", info);
    }
    Ok(())
}

fn finish_cancelled(app: &silvermoon_ipc::Host, job_id: &str) -> Result<(), String> {
    let info = with_job(app, job_id, |j| {
        j.info.stage = "cancelled".into();
        j.info.clone()
    });
    if let Some(info) = info {
        let _ = app.emit("scan:progress", info);
    }
    Ok(())
}

fn fail_job(app: &silvermoon_ipc::Host, job_id: &str, err: &str) {
    let info = with_job(app, job_id, |j| {
        j.info.stage = "error".into();
        j.info.error = Some(err.to_string());
        j.info.clone()
    });
    if let Some(info) = info {
        let _ = app.emit("scan:progress", info);
    }
}

/// 在锁内修改任务并返回快照；任务已被移除时返回 None。
fn with_job<T>(
    app: &silvermoon_ipc::Host,
    job_id: &str,
    f: impl FnOnce(&mut ScanJob) -> T,
) -> Option<T> {
    let state = app.state::<JobState>();
    let mut jobs = state.0.lock().ok()?;
    jobs.get_mut(job_id).map(f)
}

fn set_stage(
    app: &silvermoon_ipc::Host,
    job_id: &str,
    stage: &str,
    done: usize,
    total: usize,
    path: &str,
) {
    let info = with_job(app, job_id, |j| {
        j.info.stage = stage.to_string();
        j.info.done = done;
        j.info.total = total;
        j.info.percent = if total > 0 {
            (done as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        j.info.current_path = path.to_string();
        j.info.clone()
    });
    if let Some(info) = info {
        let _ = app.emit("scan:progress", info);
    }
}

/// 取消扫描：置位取消标志，由扫描循环在下一个文件边界响应。
#[silvermoon_ipc::command]
pub fn scan_cancel(state: State<'_, JobState>, job_id: String) {
    if let Ok(jobs) = state.0.lock() {
        if let Some(job) = jobs.get(&job_id) {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// 查询扫描状态
#[silvermoon_ipc::command]
pub fn scan_status(state: State<'_, JobState>, job_id: String) -> Option<ScanJobInfo> {
    let jobs = state.0.lock().ok()?;
    jobs.get(&job_id).map(|j| j.info.clone())
}

// ---- 查询 ----

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub search: Option<String>,
    /// name | mtime | size | title | taken_at
    pub sort_by: Option<String>,
    pub desc: Option<bool>,
    /// 最小文件体积（字节）；小于此值的文件不出现在列表中
    pub min_size: Option<i64>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// 列表 / 计数共用的 WHERE 子句与参数。
///
/// 两者**必须完全一致**，否则分页的"总数"与实际能翻到的条数对不上。
/// 参数顺序即 SQL 里 `?` 的绑定顺序。
fn list_filter(q: &ListQuery) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut where_sql = String::from(" WHERE f.deleted = 0");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(t) = q.kind.as_deref().filter(|t| !t.is_empty()) {
        where_sql.push_str(" AND f.type = ?");
        params.push(Box::new(t.to_string()));
    }
    if let Some(min) = q.min_size.filter(|m| *m > 0) {
        where_sql.push_str(" AND f.size >= ?");
        params.push(Box::new(min));
    }
    if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        where_sql.push_str(
            " AND (f.name LIKE ? OR m.title LIKE ? OR m.artist LIKE ? OR m.album LIKE ?)",
        );
        let like = format!("%{s}%");
        for _ in 0..4 {
            params.push(Box::new(like.clone()));
        }
    }

    (where_sql, params)
}

/// 查询文件列表（含元数据），支持类型过滤、搜索、排序、分页。
/// 一次 JOIN 取回元数据，替代旧实现的 N 次 get_metadata IPC。
#[silvermoon_ipc::command]
pub fn list_files(
    app: silvermoon_ipc::Host,
    query: Option<ListQuery>,
) -> Result<Vec<crate::MediaEntry>, String> {
    let q = query.unwrap_or_default();
    // 缩略图缓存索引要在拿数据库锁**之前**建好：它只读一次目录，
    // 既不该占着数据库锁，也不该在锁内做文件系统调用。
    let thumb_index = crate::commands::thumbnail::cached_thumb_index(&app);
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let (where_sql, mut params) = list_filter(&q);
    let mut sql = String::from(
        "SELECT f.id, f.path, f.parent, f.name, f.ext, f.type, f.size, f.mtime, f.scanned_at, f.deleted,
                m.title, m.artist, m.album, m.duration_ms, m.width, m.height, m.codec, m.fps,
                m.taken_at, m.has_cover,
                EXISTS(SELECT 1 FROM favorites v WHERE v.file_id = f.id) AS favorite
         FROM files f LEFT JOIN media_metadata m ON m.file_id = f.id",
    );
    sql.push_str(&where_sql);

    // 白名单排序列，杜绝拼接注入
    let order_col = match q.sort_by.as_deref() {
        Some("mtime") => "f.mtime",
        Some("size") => "f.size",
        Some("title") => "COALESCE(m.title, f.name)",
        Some("taken_at") => "COALESCE(m.taken_at, f.mtime)",
        _ => "f.name",
    };
    sql.push_str(" ORDER BY ");
    sql.push_str(order_col);
    sql.push_str(if q.desc.unwrap_or(false) {
        " DESC"
    } else {
        " ASC"
    });

    if let Some(limit) = q.limit {
        sql.push_str(" LIMIT ?");
        params.push(Box::new(limit));
        if let Some(offset) = q.offset {
            sql.push_str(" OFFSET ?");
            params.push(Box::new(offset));
        }
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let mut entry = crate::MediaEntry {
                id: row.get(0)?,
                path: row.get(1)?,
                parent: row.get(2)?,
                name: row.get(3)?,
                ext: row.get(4)?,
                r#type: row.get(5)?,
                size: row.get(6)?,
                mtime: row.get(7)?,
                scanned_at: row.get(8)?,
                deleted: row.get(9)?,
                title: row.get(10)?,
                artist: row.get(11)?,
                album: row.get(12)?,
                duration_ms: row.get(13)?,
                width: row.get(14)?,
                height: row.get(15)?,
                codec: row.get(16)?,
                fps: row.get(17)?,
                taken_at: row.get(18)?,
                has_cover: row.get::<_, Option<i64>>(19)?.unwrap_or(0) != 0,
                favorite: row.get::<_, i64>(20)? != 0,
                thumb_path: None,
            };
            // 已生成过缩略图的条目直接带上缓存路径：前端拼 asset:// 即可，零命令
            entry.thumb_path = crate::commands::thumbnail::cached_thumb_path(
                &thumb_index,
                &entry.id,
                entry.mtime,
                entry.size,
                crate::commands::thumbnail::LIST_THUMB_SIZE,
            );
            Ok(entry)
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 当前过滤条件下的条目总数（分页用）。
/// 过滤条件与 `list_files` 共用 `list_filter`，保证"总数"与能翻到的条数一致。
#[silvermoon_ipc::command]
pub fn count_files(app: silvermoon_ipc::Host, query: Option<ListQuery>) -> Result<i64, String> {
    let q = query.unwrap_or_default();
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let (where_sql, params) = list_filter(&q);
    let sql = format!(
        "SELECT COUNT(*) FROM files f LEFT JOIN media_metadata m ON m.file_id = f.id{where_sql}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    stmt.query_row(param_refs.as_slice(), |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

/// 各类型数量统计（导航栏角标）。与列表使用同一体积过滤，避免角标数与实际条数对不上。
#[silvermoon_ipc::command]
pub fn library_counts(
    app: silvermoon_ipc::Host,
    min_size: Option<i64>,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT type, COUNT(*) FROM files WHERE deleted=0 AND size >= ?1 GROUP BY type")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![min_size.unwrap_or(0).max(0)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn ex(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn is_excluded_matches_self_and_descendants() {
        let excludes = ex(&["/media/games"]);
        assert!(is_excluded(Path::new("/media/games"), &excludes));
        assert!(is_excluded(Path::new("/media/games/x.mp4"), &excludes));
        assert!(is_excluded(Path::new("/media/games/sub/y.mp4"), &excludes));
    }

    #[test]
    fn is_excluded_is_component_wise_not_string_prefix() {
        // 关键：/media/games2 不能被 /media/games 误伤（字符串前缀判断会错）
        let excludes = ex(&["/media/games"]);
        assert!(!is_excluded(Path::new("/media/games2"), &excludes));
        assert!(!is_excluded(Path::new("/media/games2/x.mp4"), &excludes));
    }

    #[test]
    fn is_excluded_false_when_list_empty() {
        assert!(!is_excluded(Path::new("/media/anything"), &[]));
    }

    #[test]
    fn whitelist_scope_uses_dirs_and_excludes_nothing() {
        let cfg = ScanConfig {
            dirs: vec!["/media/music".into()],
            mode: ScanMode::Whitelist,
            max_depth: None,
            follow_links: false,
            force_reparse: false,
        };
        let (roots, excludes) = resolve_scope(&cfg);
        assert_eq!(roots, vec!["/media/music".to_string()]);
        assert!(excludes.is_empty());
    }

    #[test]
    fn blacklist_scope_uses_dirs_as_exclusions() {
        let cfg = ScanConfig {
            dirs: vec!["/media/games".into()],
            mode: ScanMode::Blacklist,
            max_depth: None,
            follow_links: false,
            force_reparse: false,
        };
        let (roots, excludes) = resolve_scope(&cfg);
        // 根来自驱动器枚举（CI 上是 "/"），排除项来自 dirs
        assert!(!roots.is_empty(), "全局模式必须能解析出根目录");
        assert_eq!(excludes, ex(&["/media/games"]));
    }

    #[test]
    fn default_mode_is_whitelist() {
        // 缺省必须是白名单：老前端不传 mode 时行为与历史一致（零回归）
        let cfg: ScanConfig = serde_json::from_str(r#"{"dirs":["/media"]}"#).unwrap();
        assert_eq!(cfg.mode, ScanMode::Whitelist);
    }

    #[test]
    fn mode_parses_lowercase_from_json() {
        let cfg: ScanConfig = serde_json::from_str(r#"{"dirs":[],"mode":"blacklist"}"#).unwrap();
        assert_eq!(cfg.mode, ScanMode::Blacklist);
    }

    #[test]
    fn is_skipped_dir_name_covers_hidden_system_and_deps() {
        assert!(is_skipped_dir_name(".git"));
        assert!(is_skipped_dir_name(".hidden"));
        assert!(is_skipped_dir_name("node_modules"));
        assert!(is_skipped_dir_name("Windows"));
        assert!(is_skipped_dir_name("windows"), "匹配应忽略大小写");
        assert!(!is_skipped_dir_name("Music"));
        assert!(!is_skipped_dir_name("我的视频"));
    }

    #[test]
    fn skip_dirs_covers_system_directories() {
        // 黑名单模式从盘符根遍历，这些必须被挡住，否则枚举量会失控
        for name in [
            "Windows",
            "Program Files",
            "ProgramData",
            "WinSxS",
            "System32",
        ] {
            assert!(
                SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name)),
                "{name} 必须在 SKIP_DIRS 里"
            );
        }
    }
}
