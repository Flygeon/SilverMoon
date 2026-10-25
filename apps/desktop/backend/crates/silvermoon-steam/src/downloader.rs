//! **depot 下载器**：把一份 manifest 落成磁盘上的真实文件。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use crate::cdn::{
    chunk_url, describe_body_prefix, fetch_bytes, fetch_servers, manifest_url, CdnServer,
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
        match fetch_bytes(&url, 2) {
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
    let mut last_error = String::from("未知错误");

    for file in &manifest.files {
        if file.flags & FLAG_DIRECTORY == 0 {
            continue;
        }
        let Some(path) = safe_join(install_dir, &file.filename) else {
            return Err(format!("非法的目录路径：{}", file.filename));
        };
        fs::create_dir_all(&path).map_err(|e| format!("创建目录 {} 失败：{e}", path.display()))?;
    }

    for file in &manifest.files {
        if file.flags & FLAG_DIRECTORY != 0 {
            continue;
        }
        let Some(target) = safe_join(install_dir, &file.filename) else {
            return Err(format!("非法的文件路径：{}", file.filename));
        };
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }

        if let Ok(meta) = fs::metadata(&target) {
            if meta.is_file() && meta.len() == file.size {
                result.files_skipped += 1;
                done_bytes += file.size;
                continue;
            }
        }

        let mut file_bytes: Vec<u8> = Vec::with_capacity(file.size as usize);
        for chunk in &file.chunks {
            let mut chunk_data: Option<Vec<u8>> = None;
            for server in servers {
                let Some(url) = chunk_url(server, task.depot_id, &chunk.sha, cdn_token) else {
                    continue;
                };
                match fetch_bytes(&url, 2) {
                    Ok(bytes) if !bytes.is_empty() => {
                        match process_chunk(&bytes, &task.depot_key, chunk.cb_original) {
                            outcome if outcome.is_ok() => {
                                chunk_data = Some(outcome.data);
                                break;
                            }
                            outcome => {
                                if let Some(error) = outcome.error {
                                    last_error = error;
                                }
                            }
                        }
                    }
                    Ok(_) => last_error = "chunk 为空".to_string(),
                    Err(error) => last_error = format!("{error}"),
                }
            }
            let Some(data) = chunk_data else {
                return Err(format!(
                    "文件 {} 的 chunk {} 下载失败：{last_error}",
                    file.filename,
                    hex(&chunk.sha)
                ));
            };
            file_bytes.extend_from_slice(&data);

            if let Some(cb) = progress.as_deref_mut() {
                emit_progress(
                    cb,
                    &mut gate,
                    task.depot_id,
                    done_bytes + file_bytes.len() as u64,
                    depot_total,
                    &file.filename,
                );
            }
        }

        if file_bytes.len() as u64 != file.size {
            return Err(format!(
                "文件 {} 长度不符（{} != {}）",
                file.filename,
                file_bytes.len(),
                file.size
            ));
        }

        let tmp = target.with_extension("sm-tmp");
        {
            let mut handle =
                fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败：{e}", tmp.display()))?;
            handle
                .write_all(&file_bytes)
                .map_err(|e| format!("写入 {} 失败：{e}", tmp.display()))?;
            handle.flush().map_err(|e| format!("flush 失败：{e}"))?;
        }
        fs::rename(&tmp, &target)
            .map_err(|e| format!("重命名到 {} 失败：{e}", target.display()))?;

        result.files_written += 1;
        result.bytes_written += file.size;
        done_bytes += file.size;
        if let Some(cb) = progress.as_deref_mut() {
            emit_progress(
                cb,
                &mut gate,
                task.depot_id,
                done_bytes,
                depot_total,
                &file.filename,
            );
        }
    }

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

    let cell_id = session.cell_id();
    let servers = fetch_servers(cell_id, 10).map_err(|e| format!("{e}"))?;
    if servers.is_empty() {
        return Err("Steam 未返回任何 CDN 服务器".to_string());
    }

    fs::create_dir_all(install_dir)
        .map_err(|e| format!("创建安装目录 {} 失败：{e}", install_dir.display()))?;

    let mut overall = DownloadResult::default();
    let total = tasks.len() as u32;
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
