//! **depot 下载器**：把一份 manifest 落成磁盘上的真实文件。

use sha1::{Digest, Sha1};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
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
/// 文件 worker 将 chunk 按 manifest 偏移写入临时文件，进度由调用线程统一上报。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
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
                let outcome = process_chunk(&bytes, &task.depot_key, chunk.cb_original);
                if !outcome.is_ok() {
                    last_error = outcome
                        .error
                        .unwrap_or_else(|| "chunk 处理失败".to_string());
                } else if depot_adler_hash(&outcome.data) != chunk.crc {
                    last_error = "chunk Adler-32 校验失败".to_string();
                } else {
                    return Ok(outcome.data);
                }
            }
            Ok(_) => last_error = "chunk 为空".to_string(),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!("chunk {} 下载失败：{last_error}", hex(&chunk.sha)))
}

fn depot_adler_hash(data: &[u8]) -> u32 {
    const BLOCK: usize = 5552;
    let mut a = 0u32;
    let mut b = 0u32;
    for block in data.chunks(BLOCK) {
        for byte in block {
            a += *byte as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    a | (b << 16)
}

/// 并发抓取文件 chunk，按 manifest 的文件内偏移写入磁盘并及时释放内存。
fn download_file_chunks(
    task: &DepotTask,
    file: &crate::manifest::FileMapping,
    servers: &[CdnServer],
    cdn_token: &str,
    options: DownloadOptions,
    temp_path: &Path,
    on_chunk_progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    // Manifest offsets determine file placement; protobuf entries need not arrive in file order.
    if file.chunks.is_empty() && file.size != 0 {
        return Err(format!("文件 {} 没有 chunk 数据", file.filename));
    }
    let mut ranges = Vec::with_capacity(file.chunks.len());
    for chunk in &file.chunks {
        let end = chunk
            .offset
            .checked_add(u64::from(chunk.cb_original))
            .ok_or_else(|| format!("文件 {} 的 chunk 偏移溢出", file.filename))?;
        if end > file.size {
            return Err(format!(
                "文件 {} 的 chunk 超出文件范围（{} > {}）",
                file.filename, end, file.size
            ));
        }
        if chunk.cb_original > 0 {
            ranges.push((chunk.offset, end));
        }
    }
    ranges.sort_unstable();
    for pair in ranges.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(format!("文件 {} 的 chunk 范围重叠", file.filename));
        }
    }

    let mut output = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(temp_path)
        .map_err(|e| format!("创建 {} 失败：{e}", temp_path.display()))?;
    output
        .set_len(file.size)
        .map_err(|e| format!("设置临时文件长度失败：{e}"))?;

    if file.chunks.is_empty() {
        output.flush().map_err(|e| format!("flush 失败：{e}"))?;
        return Ok(());
    }

    let worker_count = options.chunk_workers.min(file.chunks.len()).max(1);
    let (tx, rx) = mpsc::channel::<(usize, Result<Vec<u8>, String>)>();

    let download_result = thread::scope(|scope| -> Result<(), String> {
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
                    let chunk = &file.chunks[index];
                    if data.len() != chunk.cb_original as usize {
                        first_error.get_or_insert_with(|| {
                            format!("文件 {} 的 chunk 长度不符", file.filename)
                        });
                        continue;
                    }
                    if let Err(error) = write_chunk_at(&mut output, chunk.offset, &data) {
                        first_error.get_or_insert_with(|| {
                            format!("写入文件 {} 的 chunk 失败：{error}", file.filename)
                        });
                        continue;
                    }
                    downloaded_file_bytes += data.len() as u64;
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
    });

    if let Err(error) = download_result {
        drop(output);
        let _ = fs::remove_file(temp_path);
        return Err(error);
    }
    output
        .flush()
        .map_err(|e| format!("flush {} 失败：{e}", temp_path.display()))?;
    Ok(())
}

enum FileWorkerMessage {
    Progress {
        position: usize,
        downloaded: u64,
    },
    Finished {
        position: usize,
        result: Result<(), String>,
    },
}

fn verify_file_content(path: &Path, file: &crate::manifest::FileMapping) -> Result<(), String> {
    if file.sha_content.is_empty() {
        return Ok(());
    }
    if file.sha_content.len() != 20 {
        return Err(format!("文件 {} 的 manifest SHA-1 长度无效", file.filename));
    }

    let mut input =
        fs::File::open(path).map_err(|e| format!("读取 {} 进行校验失败：{e}", path.display()))?;
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|e| format!("读取 {} 进行校验失败：{e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hasher.finalize();
    if actual.as_slice() != file.sha_content.as_slice() {
        return Err(format!(
            "文件 {} 的 SHA-1 校验失败，内容不完整或已损坏",
            file.filename
        ));
    }
    Ok(())
}

fn temp_file_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".sm-tmp");
    target.with_file_name(name)
}

fn replace_with_temp_file(temp: &Path, target: &Path) -> Result<(), String> {
    if target.is_dir() {
        fs::remove_dir(target)
            .map_err(|e| format!("目标 {} 是目录且无法清空：{e}", target.display()))?;
    }
    fs::rename(temp, target).map_err(|e| format!("重命名到 {} 失败：{e}", target.display()))
}

fn write_chunk_at(output: &mut fs::File, offset: u64, data: &[u8]) -> std::io::Result<()> {
    output.seek(SeekFrom::Start(offset))?;
    output.write_all(data)
}

fn is_existing_file_valid(target: &Path, file: &crate::manifest::FileMapping) -> bool {
    if file.sha_content.len() != 20 {
        return false;
    }
    fs::metadata(target).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
        && verify_file_content(target, file).is_ok()
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
        if is_existing_file_valid(&target, file) {
            result.files_skipped += 1;
            done_bytes += file.size;
            continue;
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
            let pending_ref = &pending;
            scope.spawn(move || {
                for position in (worker..pending_ref.len()).step_by(worker_count) {
                    let file = &pending_ref[position].0;
                    let target = &pending_ref[position].1;
                    let temp_path = temp_file_path(target);
                    let result = {
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
                            &temp_path,
                            &mut report_progress,
                        )
                    }
                    .and_then(|_| verify_file_content(&temp_path, file))
                    .and_then(|_| replace_with_temp_file(&temp_path, target));
                    if result.is_err() {
                        let _ = fs::remove_file(&temp_path);
                    }
                    if tx
                        .send(FileWorkerMessage::Finished { position, result })
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
        let mut first_error: Option<String> = None;
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
                FileWorkerMessage::Finished {
                    position,
                    result: file_result,
                } => {
                    let (file, _) = &pending[position];
                    in_flight_bytes[position] = 0;
                    completed_files += 1;
                    if let Err(error) = file_result {
                        first_error.get_or_insert(error);
                        continue;
                    }
                    result.files_written += 1;
                    result.bytes_written += file.size;
                    done_bytes += file.size;
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
        if let Some(error) = first_error {
            return Err(error);
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

    if !skipped.is_empty() {
        return Err(format!("下载未完整完成：{}", skipped.join("；")));
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
    fn download_options_deserialize_camel_case_and_defaults() {
        let options: DownloadOptions =
            serde_json::from_value(serde_json::json!({ "fileWorkers": 7, "maxRequests": 64 }))
                .expect("download options should deserialize");

        assert_eq!(options.file_workers, 7);
        assert_eq!(options.chunk_workers, 8);
        assert_eq!(options.max_requests, 64);
        assert_eq!(options.retries, 2);
        assert_eq!(options.cdn_servers, 10);
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
    fn chunks_are_written_at_manifest_offsets_even_when_received_out_of_order() {
        let path = std::env::temp_dir().join(format!("sm-offset-write-{}", std::process::id()));
        let mut output = fs::File::create(&path).unwrap();
        output.set_len(5).unwrap();
        write_chunk_at(&mut output, 3, b"lo").unwrap();
        write_chunk_at(&mut output, 0, b"hel").unwrap();
        output.flush().unwrap();
        drop(output);

        assert_eq!(fs::read(&path).unwrap(), b"hello");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn adler32_matches_known_vector() {
        assert_eq!(depot_adler_hash(b"Wikipedia"), 0x11e6_0398);
    }

    #[test]
    fn existing_file_is_skipped_only_when_manifest_sha1_matches() {
        let path = std::env::temp_dir().join(format!("sm-file-sha-{}", std::process::id()));
        let mut hasher = Sha1::new();
        hasher.update(b"hello");
        let file = crate::manifest::FileMapping {
            filename: "game.bin".into(),
            size: 5,
            sha_content: hasher.finalize().to_vec(),
            ..Default::default()
        };

        fs::write(&path, b"jello").unwrap();
        assert!(!is_existing_file_valid(&path, &file));
        fs::write(&path, b"hello").unwrap();
        assert!(is_existing_file_valid(&path, &file));
        let _ = fs::remove_file(path);
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
