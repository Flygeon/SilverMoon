//! **depot 下载器**：把一份 manifest 落成磁盘上的真实文件。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::cdn::{
    cdn_client, chunk_url, describe_body_prefix, fetch_bytes_with_client, fetch_servers,
    manifest_url, CdnServer,
};
use crate::chunk::process_chunk;
use crate::cm::CmManager;
use crate::manifest::{ContentManifest, FLAG_DIRECTORY};

#[derive(Debug, Clone, Default)]
pub struct DepotTask {
    pub depot_id: u32,
    pub manifest_gid: u64,
    pub depot_key: Vec<u8>,
    pub app_id: u32,
}

pub type ProgressFn<'a> = &'a mut dyn FnMut(DownloadProgress);

#[derive(Debug, Clone, Default)]
pub struct DownloadProgress {
    pub depot_id: u32,
    pub depot_done: u64,
    pub depot_total: u64,
    pub depots_done: u32,
    pub depots_total: u32,
    pub current_file: String,
}

#[derive(Debug, Clone, Default)]
pub struct DepotResult {
    pub depot_id: u32,
    pub bytes_written: u64,
    pub files_written: u32,
    pub files_skipped: u32,
}

#[derive(Debug, Default)]
pub struct DownloadResult {
    pub depots: Vec<DepotResult>,
    pub bytes_written: u64,
}

/// 同时下载文件数、单文件 chunk 并发与整个 depot 的总请求上限。
///
/// `max_requests` 约束嵌套的文件 / chunk worker，避免两个设置相乘后启动数百个请求。
/// 文件完成后由主线程落盘，下载中的分块进度也由该线程统一上报。
#[derive(Debug, Clone, Copy)]
pub struct DownloadOptions {
    pub file_workers: usize,
    pub chunk_workers: usize,
    pub max_requests: usize,
    pub retries: u32,
    pub cdn_servers: u32,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            file_workers: 3,
            chunk_workers: 8,
            max_requests: 32,
            retries: 2,
            cdn_servers: 10,
        }
    }
}

fn effective_workers(options: DownloadOptions, pending_files: usize) -> (usize, usize) {
    if pending_files == 0 {
        return (0, 0);
    }
    let request_budget = options.max_requests.clamp(1, 128);
    let file_workers = options
        .file_workers
        .clamp(1, 16)
        .min(pending_files)
        .min(request_budget);
    let chunk_workers = options
        .chunk_workers
        .clamp(1, 32)
        .min(request_budget / file_workers)
        .max(1);
    (file_workers, chunk_workers)
}

/// 建目录，并处理「同名文件已存在」的冲突。
///
/// ## 为什么要单独包一层（线上事故 2026-10-25）
///
/// 用户把安装目录选在 `Steam/steamapps/common/Aniya`，该目录里已有
/// 上一轮留下的零字节 `Aliya_Data` **文件**，而 manifest 里 `Aliya_Data` 是**目录**。
/// `fs::create_dir_all` 遇到同名文件会返回 Windows 的 `ERROR_ALREADY_EXISTS`
/// （`os error 183`），整个 depot 因此失败、进度条停在 0%。
///
/// 这在真实环境很常见：断点续传的半截文件、用户手建的空文件、上一版残留。
/// **manifest 是权威**，所以按「目录优先」处理：路径上是普通文件就先删掉再建目录。
///
/// 范围约束：只作用于 `safe_join` 校验过的安装目录内路径，且只删单个文件（不递归）。
fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    // 存在但不是目录（普通文件 / 符号链接）：manifest 说它是目录，删掉让位
    if path.symlink_metadata().is_ok() {
        fs::remove_file(path)?;
    }
    fs::create_dir_all(path)
}

pub fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() {
        return None;
    }
    let candidate = Path::new(relative);
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    let joined = root.join(candidate);
    let normalized_root = root.to_path_buf();
    if !joined.starts_with(&normalized_root) {
        return None;
    }
    Some(joined)
}

struct ProgressGate {
    interval: Duration,
    last_emit: Option<Instant>,
    last_file: String,
}

impl ProgressGate {
    const DEFAULT_INTERVAL: Duration = Duration::from_millis(100);

    fn new() -> Self {
        Self::with_interval(Self::DEFAULT_INTERVAL)
    }

    fn with_interval(interval: Duration) -> Self {
        Self {
            interval,
            last_emit: None,
            last_file: String::new(),
        }
    }

    fn should_emit(&mut self, done: u64, total: u64, current_file: &str) -> bool {
        let complete = total > 0 && done >= total;
        let file_changed = current_file != self.last_file;
        let due = match self.last_emit {
            None => true,
            Some(last) => last.elapsed() >= self.interval,
        };

        if complete || file_changed || due {
            self.last_emit = Some(Instant::now());
            self.last_file = current_file.to_string();
            true
        } else {
            false
        }
    }
}

fn emit_progress(
    cb: &mut dyn FnMut(DownloadProgress),
    gate: &mut ProgressGate,
    depot_id: u32,
    done: u64,
    total: u64,
    current_file: &str,
) {
    if !gate.should_emit(done, total, current_file) {
        return;
    }
    cb(DownloadProgress {
        depot_id,
        depot_done: done,
        depot_total: total,
        depots_done: 0,
        depots_total: 0,
        current_file: current_file.to_string(),
    });
}

fn fetch_chunk(
    client: &reqwest::blocking::Client,
    task: &DepotTask,
    servers: &[CdnServer],
    chunk: &crate::manifest::Chunk,
    cdn_token: &str,
    retries: u32,
) -> Result<Vec<u8>, String> {
    let mut last_error = String::from("未知错误");
    for server in servers {
        let Some(url) = chunk_url(server, task.depot_id, &chunk.sha, cdn_token) else {
            continue;
        };
        match fetch_bytes_with_client(client, &url, retries) {
            Ok(bytes) if !bytes.is_empty() => {
                match process_chunk(&bytes, &task.depot_key, chunk.cb_original) {
                    outcome if outcome.is_ok() => return Ok(outcome.data),
                    outcome => {
                        if let Some(error) = outcome.error {
                            last_error = error;
                        }
                    }
                }
            }
            Ok(_) => last_error = "chunk 为空".to_string(),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!("chunk {} 下载失败：{last_error}", hex(&chunk.sha)))
}

/// 并发抓取一个文件的所有 chunk，并在收到结果时按完成顺序上报进度。
///
/// 返回值仍按 manifest 中的 chunk 顺序排列；网络完成顺序不会影响文件内容。
fn download_file_chunks(
    task: &DepotTask,
    file: &crate::manifest::FileMapping,
    servers: &[CdnServer],
    cdn_token: &str,
    options: DownloadOptions,
    on_chunk_progress: &mut dyn FnMut(u64),
) -> Result<Vec<u8>, String> {
    if file.chunks.is_empty() {
        return Ok(Vec::new());
    }

    let worker_count = options.chunk_workers.min(file.chunks.len()).max(1);
    let (tx, rx) = mpsc::channel::<(usize, Result<Vec<u8>, String>)>();
    let mut ordered: Vec<Option<Vec<u8>>> = vec![None; file.chunks.len()];

    thread::scope(|scope| {
        for worker in 0..worker_count {
            let tx = tx.clone();
            scope.spawn(move || {
                let client = match cdn_client() {
                    Ok(client) => client,
                    Err(error) => {
                        for index in (worker..file.chunks.len()).step_by(worker_count) {
                            let _ = tx.send((index, Err(error.to_string())));
                        }
                        return;
                    }
                };
                for index in (worker..file.chunks.len()).step_by(worker_count) {
                    let result = fetch_chunk(
                        &client,
                        task,
                        servers,
                        &file.chunks[index],
                        cdn_token,
                        options.retries,
                    );
                    if tx.send((index, result)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(tx);

        let mut received = 0usize;
        let mut downloaded_file_bytes = 0u64;
        let mut first_error: Option<String> = None;
        while received < file.chunks.len() {
            let (index, result) = rx
                .recv()
                .map_err(|_| "chunk 工作线程意外退出".to_string())?;
            received += 1;
            match result {
                Ok(data) => {
                    downloaded_file_bytes += data.len() as u64;
                    ordered[index] = Some(data);
                    on_chunk_progress(downloaded_file_bytes);
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }

        if let Some(error) = first_error {
            return Err(format!("文件 {} 的 {error}", file.filename));
        }
        Ok(())
    })?;

    assemble_chunks(file, ordered)
}

enum FileWorkerMessage {
    Progress {
        position: usize,
        downloaded: u64,
    },
    Finished {
        position: usize,
        bytes: Result<Vec<u8>, String>,
    },
}

fn assemble_chunks(
    file: &crate::manifest::FileMapping,
    ordered: Vec<Option<Vec<u8>>>,
) -> Result<Vec<u8>, String> {
    let mut file_bytes = Vec::with_capacity(file.size as usize);
    for data in ordered {
        let Some(data) = data else {
            return Err(format!("文件 {} 缺少 chunk 数据", file.filename));
        };
        file_bytes.extend_from_slice(&data);
    }
    Ok(file_bytes)
}

fn write_file_atomically(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension("sm-tmp");
    {
        let mut handle =
            fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败：{e}", tmp.display()))?;
        handle
            .write_all(bytes)
            .map_err(|e| format!("写入 {} 失败：{e}", tmp.display()))?;
        handle.flush().map_err(|e| format!("flush 失败：{e}"))?;
    }
    if target.is_dir() {
        fs::remove_dir(target)
            .map_err(|e| format!("目标 {} 是目录且无法清空：{e}", target.display()))?;
    }
    fs::rename(&tmp, target).map_err(|e| format!("重命名到 {} 失败：{e}", target.display()))
}

fn notes_suffix(notes: &[String]) -> String {
    if notes.is_empty() {
        String::new()
    } else {
        format!("（{}）", notes.join("；"))
    }
}

struct ManifestFailure {
    reason: String,
    auth_denied: bool,
}

fn fetch_manifest(
    task: &DepotTask,
    servers: &[CdnServer],
    request_code: u64,
    cdn_token: &str,
) -> Result<ContentManifest, ManifestFailure> {
    let client = match cdn_client() {
        Ok(client) => client,
        Err(error) => {
            return Err(ManifestFailure {
                reason: error.to_string(),
                auth_denied: false,
            })
        }
    };
    let mut failures: Vec<String> = Vec::new();
    let mut auth_denied = false;
    let mut tried = 0usize;

    for server in servers {
        let Some(url) = manifest_url(
            server,
            task.depot_id,
            task.manifest_gid,
            request_code,
            cdn_token,
        ) else {
            continue;
        };
        tried += 1;
        match fetch_bytes_with_client(&client, &url, 2) {
            Ok(bytes) if bytes.is_empty() => {
                failures.push(format!("{}: 响应体为空", server.host));
            }
            Ok(bytes) => match ContentManifest::parse_response(&bytes) {
                Some(manifest) => return Ok(manifest),
                None => failures.push(format!(
                    "{}: 响应不是 manifest（{}）",
                    server.host,
                    describe_body_prefix(&bytes, 96)
                )),
            },
            Err(error) => {
                if error.is_auth_denied() {
                    auth_denied = true;
                }
                failures.push(format!("{}: {error}", server.host));
            }
        }
    }

    let reason = if tried == 0 {
        "没有可用的 CDN 节点（host 为空）".to_string()
    } else if failures.is_empty() {
        "所有 CDN 节点都没有给出响应".to_string()
    } else {
        let shown = failures
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("；");
        if failures.len() > 3 {
            format!("{shown}；其余 {} 个节点同样失败", failures.len() - 3)
        } else {
            shown
        }
    };

    Err(ManifestFailure {
        reason,
        auth_denied,
    })
}

pub fn download_depot(
    task: &DepotTask,
    install_dir: &Path,
    servers: &[CdnServer],
    mut manifest: ContentManifest,
    cdn_token: &str,
    mut progress: Option<ProgressFn<'_>>,
    options: DownloadOptions,
) -> Result<DepotResult, String> {
    if servers.is_empty() {
        return Err("没有可用的 CDN 服务器".to_string());
    }

    if manifest.metadata.filenames_encrypted {
        if task.depot_key.len() != 32 {
            return Err("manifest 的文件名加密，但 depot_key 无效".to_string());
        }
        if !manifest.decrypt_filenames(&task.depot_key) {
            return Err("解密文件名失败（depot_key 不对）".to_string());
        }
    } else {
        manifest.decrypt_filenames(&[]);
    }

    let depot_total = manifest.total_bytes();
    let mut result = DepotResult {
        depot_id: task.depot_id,
        ..Default::default()
    };
    let mut done_bytes = 0u64;
    let mut gate = ProgressGate::new();
    for file in &manifest.files {
        if file.flags & FLAG_DIRECTORY == 0 {
            continue;
        }
        let Some(path) = safe_join(install_dir, &file.filename) else {
            return Err(format!("非法的目录路径：{}", file.filename));
        };
        ensure_dir(&path).map_err(|e| format!("创建目录 {} 失败：{e}", path.display()))?;
    }

    let mut pending: Vec<(crate::manifest::FileMapping, PathBuf)> = Vec::new();
    for file in &manifest.files {
        if file.flags & FLAG_DIRECTORY != 0 {
            continue;
        }
        let Some(target) = safe_join(install_dir, &file.filename) else {
            return Err(format!("非法的文件路径：{}", file.filename));
        };
        if let Some(parent) = target.parent() {
            ensure_dir(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        if let Ok(meta) = fs::metadata(&target) {
            if meta.is_file() && meta.len() == file.size {
                result.files_skipped += 1;
                done_bytes += file.size;
                continue;
            }
        }
        pending.push((file.clone(), target));
    }

    if pending.is_empty() {
        if let Some(cb) = progress.as_deref_mut() {
            emit_progress(cb, &mut gate, task.depot_id, depot_total, depot_total, "");
        }
        return Ok(result);
    }

    let (worker_count, chunk_workers) = effective_workers(options, pending.len());
    let (tx, rx) = mpsc::sync_channel::<FileWorkerMessage>(worker_count.max(1));
    let worker_options = DownloadOptions {
        chunk_workers,
        ..options
    };
    thread::scope(|scope| {
        for worker in 0..worker_count {
            let tx = tx.clone();
            scope.spawn(move || {
                for position in (worker..pending.len()).step_by(worker_count) {
                    let file = &pending[position].0;
                    let bytes = {
                        let mut report_progress = |downloaded| {
                            let _ = tx.send(FileWorkerMessage::Progress {
                                position,
                                downloaded,
                            });
                        };
                        download_file_chunks(
                            task,
                            file,
                            servers,
                            cdn_token,
                            worker_options,
                            &mut report_progress,
                        )
                    }
                    .and_then(|bytes| {
                        if bytes.len() as u64 != file.size {
                            Err(format!(
                                "文件 {} 长度不符（{} != {}）",
                                file.filename,
                                bytes.len(),
                                file.size
                            ))
                        } else {
                            Ok(bytes)
                        }
                    });
                    if tx
                        .send(FileWorkerMessage::Finished { position, bytes })
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
        drop(tx);

        let mut completed_files = 0;
        let mut in_flight_bytes = vec![0u64; pending.len()];
        while completed_files < pending.len() {
            match rx
                .recv()
                .map_err(|_| "文件下载 worker 意外退出".to_string())?
            {
                FileWorkerMessage::Progress {
                    position,
                    downloaded,
                } => {
                    in_flight_bytes[position] = downloaded;
                    if let Some(cb) = progress.as_deref_mut() {
                        let active_bytes = in_flight_bytes.iter().sum::<u64>();
                        emit_progress(
                            cb,
                            &mut gate,
                            task.depot_id,
                            done_bytes + active_bytes,
                            depot_total,
                            &pending[position].0.filename,
                        );
                    }
                }
                FileWorkerMessage::Finished { position, bytes } => {
                    let (file, target) = &pending[position];
                    let file_bytes = bytes?;
                    write_file_atomically(target, &file_bytes)?;
                    in_flight_bytes[position] = 0;
                    result.files_written += 1;
                    result.bytes_written += file_bytes.len() as u64;
                    done_bytes += file_bytes.len() as u64;
                    completed_files += 1;
                    if let Some(cb) = progress.as_deref_mut() {
                        let active_bytes = in_flight_bytes.iter().sum::<u64>();
                        emit_progress(
                            cb,
                            &mut gate,
                            task.depot_id,
                            done_bytes + active_bytes,
                            depot_total,
                            &file.filename,
                        );
                    }
                }
            }
        }
        Ok::<(), String>(())
    })?;

    Ok(result)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn cdn_host(base: &str) -> String {
    base.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split(':')
        .next()
        .unwrap_or_default()
        .to_string()
}

pub fn download_app(
    runtime: &tokio::runtime::Runtime,
    manager: &CmManager,
    account_name: &str,
    access_token: &str,
    tasks: &[DepotTask],
    install_dir: &Path,
    options: DownloadOptions,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<DownloadResult, String> {
    use crate::cm_requests::{fetch_cdn_auth_token, fetch_manifest_request_code};
    use crate::depot_key::fetch_depot_key;

    let mut guard = runtime
        .block_on(manager.get_or_connect(account_name, access_token))
        .map_err(|e| e.to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("CM 会话不可用".to_string());
    };

    let total = tasks.len() as u32;
    on_progress(DownloadProgress {
        depots_total: total,
        current_file: "准备连接 Steam CDN".to_string(),
        ..Default::default()
    });

    let cell_id = session.cell_id();
    let servers = fetch_servers(cell_id, options.cdn_servers).map_err(|e| format!("{e}"))?;
    if servers.is_empty() {
        return Err("Steam 未返回任何 CDN 服务器".to_string());
    }

    fs::create_dir_all(install_dir)
        .map_err(|e| format!("创建安装目录 {} 失败：{e}", install_dir.display()))?;

    let mut overall = DownloadResult::default();
    let mut skipped: Vec<String> = Vec::new();

    for (index, task) in tasks.iter().enumerate() {
        let mut task_owned = task.clone();
        if task_owned.depot_key.is_empty() {
            match runtime.block_on(fetch_depot_key(session, task.app_id, task.depot_id)) {
                Ok(key) => task_owned.depot_key = key,
                Err(error) => {
                    skipped.push(format!("depot {}: {error}", task.depot_id));
                    continue;
                }
            }
        }
        let task = &task_owned;

        let mut notes: Vec<String> = Vec::new();

        let request_code = match runtime.block_on(fetch_manifest_request_code(
            session,
            task.app_id,
            task.depot_id,
            task.manifest_gid,
        )) {
            Ok(0) => {
                notes.push("Steam 答复的 manifest 请求码是 0（该 depot 这版没有码）".to_string());
                0
            }
            Ok(code) => code,
            Err(error) => {
                notes.push(format!("Steam 未给出 manifest 请求码（{error}）"));
                0
            }
        };

        let mut cdn_token = String::new();
        let manifest = match fetch_manifest(task, &servers, request_code, "") {
            Ok(manifest) => manifest,
            Err(failure) if failure.auth_denied => {
                let mut token_errors: Vec<String> = Vec::new();
                for server in &servers {
                    let Some(base) = server.base_url() else {
                        continue;
                    };
                    let host = cdn_host(&base);
                    match runtime.block_on(fetch_cdn_auth_token(
                        session,
                        task.app_id,
                        task.depot_id,
                        &host,
                    )) {
                        Ok(token) if !token.is_empty() => {
                            cdn_token = token;
                            break;
                        }
                        Ok(_) => token_errors.push(format!("{host}: 返回空票据")),
                        Err(error) => token_errors.push(format!("{host}: {error}")),
                    }
                }

                if cdn_token.is_empty() {
                    notes.push(format!(
                        "CDN 票据申请失败（{}）",
                        if token_errors.is_empty() {
                            "没有可用的 CDN 节点".to_string()
                        } else {
                            token_errors.join("；")
                        }
                    ));
                    skipped.push(format!(
                        "depot {}: {}{}",
                        task.depot_id,
                        failure.reason,
                        notes_suffix(&notes)
                    ));
                    continue;
                }

                match fetch_manifest(task, &servers, request_code, &cdn_token) {
                    Ok(manifest) => manifest,
                    Err(again) => {
                        notes.push(format!("带票据重试仍失败：{}", again.reason));
                        skipped.push(format!(
                            "depot {}: {}{}",
                            task.depot_id,
                            again.reason,
                            notes_suffix(&notes)
                        ));
                        continue;
                    }
                }
            }
            Err(failure) => {
                skipped.push(format!(
                    "depot {}: {}{}",
                    task.depot_id,
                    failure.reason,
                    notes_suffix(&notes)
                ));
                continue;
            }
        };

        on_progress(DownloadProgress {
            depot_id: task.depot_id,
            depots_done: index as u32,
            depots_total: total,
            ..Default::default()
        });

        let depots_done = index as u32;
        match download_depot(
            task,
            install_dir,
            &servers,
            manifest,
            &cdn_token,
            Some(&mut |mut p: DownloadProgress| {
                p.depots_done = depots_done;
                p.depots_total = total;
                on_progress(p);
            }),
            options,
        ) {
            Ok(result) => {
                overall.bytes_written += result.bytes_written;
                overall.depots.push(result);
            }
            Err(error) => {
                skipped.push(format!(
                    "depot {}: {error}{}",
                    task.depot_id,
                    notes_suffix(&notes)
                ));
            }
        }
    }

    if overall.depots.is_empty() {
        return Err(format!(
            "没有可下载的内容。{}",
            if skipped.is_empty() {
                "Steam 未返回任何 depot".to_string()
            } else {
                skipped.join("；")
            }
        ));
    }
    Ok(overall)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_workers_respects_total_request_budget() {
        let options = DownloadOptions {
            file_workers: 16,
            chunk_workers: 32,
            max_requests: 10,
            ..Default::default()
        };
        let (files, chunks) = effective_workers(options, 20);
        assert_eq!((files, chunks), (10, 1));
        assert!(files * chunks <= options.max_requests);
    }

    #[test]
    fn effective_workers_keeps_configured_parallelism_when_budget_allows() {
        let options = DownloadOptions::default();
        assert_eq!(effective_workers(options, 20), (3, 8));
        assert_eq!(effective_workers(options, 0), (0, 0));
    }

    #[test]
    fn safe_join_accepts_normal_relative_paths() {
        let root = Path::new("/install");
        assert_eq!(
            safe_join(root, "bin/game.exe"),
            Some(PathBuf::from("/install/bin/game.exe"))
        );
        assert_eq!(
            safe_join(root, "a/b/c.txt"),
            Some(PathBuf::from("/install/a/b/c.txt"))
        );
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = Path::new("/install");
        assert!(safe_join(root, "../etc/passwd").is_none());
        assert!(safe_join(root, "a/../../b").is_none());
        assert!(safe_join(root, "..").is_none());
    }

    #[test]
    fn safe_join_rejects_absolute_and_empty() {
        let root = Path::new("/install");
        assert!(safe_join(root, "/etc/passwd").is_none());
        assert!(safe_join(root, "").is_none());
    }

    #[test]
    fn assemble_chunks_preserves_manifest_order() {
        let file = crate::manifest::FileMapping {
            filename: "game.bin".into(),
            size: 5,
            ..Default::default()
        };
        let bytes = assemble_chunks(&file, vec![Some(b"hel".to_vec()), Some(b"lo".to_vec())])
            .expect("chunks should assemble");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn assemble_chunks_rejects_missing_result() {
        let file = crate::manifest::FileMapping {
            filename: "game.bin".into(),
            size: 5,
            ..Default::default()
        };
        let error = assemble_chunks(&file, vec![Some(b"hel".to_vec()), None])
            .expect_err("missing chunk must fail");
        assert!(error.contains("game.bin"));
    }

    /// 线上事故（2026-10-25）：安装目录里已有一个同名的**文件**，
    /// manifest 说该路径是**目录**，`create_dir_all` 直接 `os error 183` 失败。
    /// 这类残留很常见（断点续传半截文件、上一版安装残留），必须能自愈。
    #[test]
    fn ensure_dir_replaces_conflicting_file() {
        let base = std::env::temp_dir().join(format!("sm-ensure-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let target = base.join("Aliya_Data");

        // 先造一个同名普通文件（0 字节，正是线上那种残留）
        fs::write(&target, b"").unwrap();
        assert!(target.is_file(), "前置条件：应是文件");

        // 首次调用前 create_dir_all 会失败，ensure_dir 必须能把它变成目录
        ensure_dir(&target).expect("应能把同名文件换成目录");
        assert!(target.is_dir(), "调用后应是目录");

        // 幂等：已是目录时再调一次不能报错
        ensure_dir(&target).expect("已是目录时应成功");

        let _ = fs::remove_dir_all(&base);
    }

    /// `ensure_dir` 只删**单个文件**，不能递归删掉已有目录里的内容。
    #[test]
    fn ensure_dir_keeps_existing_directory_contents() {
        let base = std::env::temp_dir().join(format!("sm-ensure-keep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let inner = base.join("data");
        fs::create_dir_all(&inner).unwrap();
        let keep = inner.join("keep.bin");
        fs::write(&keep, b"payload").unwrap();

        ensure_dir(&inner).expect("已有目录应直接成功");
        assert!(keep.is_file(), "不能删除目录里已有的文件");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn hex_lowercases() {
        assert_eq!(hex(&[0xAB, 0x01]), "ab01");
    }

    #[test]
    fn progress_gate_throttles_but_keeps_milestones() {
        let mut gate = ProgressGate::with_interval(Duration::from_secs(3600));

        assert!(gate.should_emit(10, 1000, "a.bin"));
        assert!(!gate.should_emit(20, 1000, "a.bin"));
        assert!(!gate.should_emit(999, 1000, "a.bin"));
        assert!(gate.should_emit(1000, 1000, "b.bin"));
        assert!(gate.should_emit(1000, 1000, "b.bin"));
    }

    #[test]
    fn progress_gate_emits_when_interval_elapses() {
        let mut gate = ProgressGate::with_interval(Duration::ZERO);
        assert!(gate.should_emit(1, 1000, "a.bin"));
        assert!(gate.should_emit(2, 1000, "a.bin"));
        assert!(gate.should_emit(3, 1000, "a.bin"));
    }

    #[test]
    fn progress_gate_does_not_treat_unknown_total_as_complete() {
        let mut gate = ProgressGate::with_interval(Duration::from_secs(3600));
        assert!(gate.should_emit(0, 0, "a.bin")); // 第一次
        assert!(!gate.should_emit(10, 0, "a.bin")); // total 未知 ≠ 已完成
    }

    #[test]
    fn notes_suffix_avoids_empty_parentheses() {
        assert_eq!(notes_suffix(&[]), "");
        assert_eq!(notes_suffix(&["a".to_string()]), "（a）");
        assert_eq!(
            notes_suffix(&["a".to_string(), "b".to_string()]),
            "（a；b）"
        );
    }

    #[test]
    fn cdn_host_strips_scheme_and_port() {
        assert_eq!(
            cdn_host("https://cache5-lax2.steamcontent.com:443"),
            "cache5-lax2.steamcontent.com"
        );
        assert_eq!(
            cdn_host("http://cache2-hkg1.steamcontent.com:80"),
            "cache2-hkg1.steamcontent.com"
        );
        assert_eq!(cdn_host("https://host"), "host");
    }
}
