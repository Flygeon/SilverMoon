//! **depot 下载器**：把一份 manifest 落成磁盘上的真实文件。
//!
//! ## 流程
//!
//! ```text
//! 1. 取 CDN 服务器列表（HTTPS，免鉴权）
//! 2. 对每个 depot：
//!    a. CM: GetManifestRequestCode → request_code
//!    b. CM: GetCDNAuthToken(depot, host) → cdn token
//!    c. CDN: 拉 manifest 字节 → ContentManifest::parse
//!    d. depot_key 解密文件名
//!    e. 建目录树
//!    f. 逐文件：按 chunk 顺序拉取 → 解密 → 解压 → 校验 SHA-1 → 写入
//! ```
//!
//! ## 设计取舍
//!
//! - **串行下载**：chunk 之间没有依赖，并行能更快，但并行会把内存与带宽打满，
//!   且进度上报更复杂。先做串行、可中断、可重试；并行留作后续优化。
//! - **断点续传按文件粒度**：已存在且大小正确的文件直接跳过（内容完整性靠 manifest 的
//!   sha_content 可选校验）。chunk 级续传需要 journal，暂不实现。
//! - **失败即停**：任何一个文件写失败就中止并报错，避免留下「看起来装好了」的半成品。
//!
//! ## 安全边界
//!
//! 所有写入路径都经过 `safe_join` 校验：manifest 里的 `filename` 来自远端，
//! 若出现 `..` 或绝对路径，必须拒绝 —— 否则恶意 depot 能写到安装目录之外。
//!
//! ## ⚠️ 已知缺口：depot key 需要外部提供
//!
//! 解密文件名与 chunk 都需要 **32 字节 depot key**。获取它要调 CM 的老式消息
//! `CMsgClientGetDepotDecryptionKey`（`k_EMsgClientGetDepotDecryptionKey = 5438`）。
//!
//! 当前依赖的 `steam-vent 0.5` **没有为这条消息实现 `NetMessage`**
//! （该 trait 的 `EncodableMessage` 没有 blanket impl，外部也补不上），
//! 所以本项目**无法自动取 key**。剩下的路只有两条：
//!
//! 1. **已安装的 depot**：本机 Steam 客户端已把 key 存在 `config/config.vdf` 的
//!    `Depots` 段（以及 `steamapps` 的 manifest 里），可直接读 —— 这也是
//!    「补全/校验已装游戏」场景下真正需要的；
//! 2. **未安装的 depot**：需要换成支持该消息的协议库（例如 JavaSteam 的类似实现），
//!    或等上游补上。
//!
//! 因此 `DepotTask.depot_key` 由调用方填充；本模块只负责「有 key 之后怎么下」。
//! 这样职责清晰，也避免写一个永远调不通的接口冒充完成。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::cdn::{chunk_url, fetch_bytes, fetch_servers, manifest_url, CdnServer};
use crate::chunk::process_chunk;
use crate::cm::CmManager;
use crate::manifest::{ContentManifest, FLAG_DIRECTORY};

/// 一个 depot 的下载任务描述。
#[derive(Debug, Clone, Default)]
pub struct DepotTask {
    pub depot_id: u32,
    pub manifest_gid: u64,
    /// 32 字节的 depot key（从 Steam 的 app info 获取；未加密的 depot 可为空）
    pub depot_key: Vec<u8>,
    /// 归属的 app id（GetManifestRequestCode / GetCDNAuthToken 都要）
    pub app_id: u32,
}

/// 下载进度回调。
pub type ProgressFn<'a> = &'a mut dyn FnMut(DownloadProgress);

/// 上报给调用方（前端）的进度。
#[derive(Debug, Clone, Default)]
pub struct DownloadProgress {
    pub depot_id: u32,
    pub depot_done: u64,
    pub depot_total: u64,
    pub depots_done: u32,
    pub depots_total: u32,
    /// 当前文件名（用于界面显示「正在下载 xxx」）
    pub current_file: String,
}

/// 单个 depot 的下载结果。
#[derive(Debug, Clone, Default)]
pub struct DepotResult {
    pub depot_id: u32,
    pub bytes_written: u64,
    pub files_written: u32,
    pub files_skipped: u32,
}

/// 一次完整下载的结果。
#[derive(Debug, Default)]
pub struct DownloadResult {
    pub depots: Vec<DepotResult>,
    pub bytes_written: u64,
}

/// 把 manifest 里的相对路径安全地拼到安装目录下。
///
/// 拒绝：绝对路径、`..`、盘符前缀、以 `/` 开头的路径。
/// 这是**安全边界**：manifest 内容来自远端，必须当作不可信输入。
pub fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() {
        return None;
    }
    let candidate = Path::new(relative);
    // 逐段检查：只允许 Normal 段（拒绝 ParentDir / RootDir / Prefix）
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    let joined = root.join(candidate);
    // 双重保险：拼出来的路径必须仍在 root 之内
    let normalized_root = root.to_path_buf();
    if !joined.starts_with(&normalized_root) {
        return None;
    }
    Some(joined)
}

/// 下载一个 depot 的全部内容到 `install_dir`。
///
/// `cdn_token` 由调用方（`cm.rs`）提供 —— 它需要先连上 CM 并调用
/// `GetCDNAuthToken`。`request_code` 同理来自 `GetManifestRequestCode`。
pub fn download_depot(
    task: &DepotTask,
    install_dir: &Path,
    servers: &[CdnServer],
    request_code: u64,
    cdn_token: &str,
    mut progress: Option<ProgressFn<'_>>,
) -> Result<DepotResult, String> {
    if servers.is_empty() {
        return Err("没有可用的 CDN 服务器".to_string());
    }

    // ---- 拉 manifest：逐个节点尝试 ----
    let mut manifest_bytes: Option<Vec<u8>> = None;
    let mut last_error = String::from("未知错误");
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
        match fetch_bytes(&url, 2) {
            Ok(bytes) if !bytes.is_empty() => {
                manifest_bytes = Some(bytes);
                break;
            }
            Ok(_) => last_error = "manifest 为空".to_string(),
            Err(error) => last_error = error,
        }
    }
    let raw = manifest_bytes.ok_or_else(|| format!("拉取 manifest 失败：{last_error}"))?;
    let mut manifest =
        ContentManifest::parse(&raw).ok_or_else(|| "manifest 格式无法解析".to_string())?;

    // ---- 解密文件名 ----
    if manifest.metadata.filenames_encrypted {
        if task.depot_key.len() != 32 {
            return Err("manifest 的文件名加密，但 depot_key 无效".to_string());
        }
        if !manifest.decrypt_filenames(&task.depot_key) {
            return Err("解密文件名失败（depot_key 不对）".to_string());
        }
    } else {
        // 未加密也要归一化路径分隔符
        manifest.decrypt_filenames(&[]);
    }

    let depot_total = manifest.total_bytes();
    let mut result = DepotResult {
        depot_id: task.depot_id,
        ..Default::default()
    };
    let mut done_bytes = 0u64;

    // ---- 先建目录，再写文件（避免写文件时父目录不存在）----
    for file in &manifest.files {
        if file.flags & FLAG_DIRECTORY == 0 {
            continue;
        }
        let Some(path) = safe_join(install_dir, &file.filename) else {
            return Err(format!("非法的目录路径：{}", file.filename));
        };
        fs::create_dir_all(&path).map_err(|e| format!("创建目录 {} 失败：{e}", path.display()))?;
    }

    // ---- 逐文件下载 ----
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

        // 已存在且大小一致 → 跳过（断点续传的文件粒度）
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
                                last_error = outcome.error.unwrap_or_default();
                            }
                        }
                    }
                    Ok(_) => last_error = "chunk 为空".to_string(),
                    Err(error) => last_error = error,
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
        }

        if file_bytes.len() as u64 != file.size {
            return Err(format!(
                "文件 {} 长度不符（{} != {}）",
                file.filename,
                file_bytes.len(),
                file.size
            ));
        }

        // 原子写：临时文件 + rename，避免留下半截文件
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
            cb(DownloadProgress {
                depot_id: task.depot_id,
                depot_done: done_bytes,
                depot_total,
                depots_done: 0,
                depots_total: 1,
                current_file: file.filename.clone(),
            });
        }
    }

    Ok(result)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 完整下载流程：连 CM → 逐 depot 解析 → 下载。
///
/// 这是给上层命令调用的入口。任何一步失败都返回可读错误，不做部分成功。
///
/// ## 每个 depot 都要两次 CM 往返
///
/// 1. `GetManifestRequestCode`：部分 depot 的 manifest URL 需要它（否则 401）
/// 2. `GetCDNAuthToken(depot, host)`：CDN 拉取的鉴权票据
///
/// 这两步是本模块唯一依赖 CM 的地方 —— 也因此「没有 CM 就没有下载」。
pub fn download_app(
    // ⚠️ runtime 由调用方传入，且**必须与 CmManager 同生命周期**（进程级单例）。
    //
    // 这里曾经自己新建一个 current_thread runtime，用完随函数结束销毁 ——
    // 而 CmManager 是全局的，它缓存的 CmSession（含连接心跳、socket）
    // 绑定在**创建它的那个 runtime** 上。runtime 一销毁，心跳就死，
    // 下一次任何 CM 请求都会报：
    //   IO error: A Tokio 1.x context was found, but it is being shutdown.
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

    // 连 CM（长连接由 manager 持有）。拿不到就整体失败 —— 没有 CM 下不了。
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

    // 目标目录先建出来：调用方给的往往是「steamapps/common/<游戏名>」这种还不存在的路径。
    // 少了这一步，manifest 里若没有任何目录条目，首个文件写盘就会 ENOENT。
    fs::create_dir_all(install_dir)
        .map_err(|e| format!("创建安装目录 {} 失败：{e}", install_dir.display()))?;

    let mut overall = DownloadResult::default();
    let total = tasks.len() as u32;
    // 收集「被跳过的 depot」而不是让单个失败拖垮整次下载：
    // 含 DLC 的游戏里常有当前账号没授权的 depot（Steam 回 EResult != OK），
    // 那不是错误，跳过它继续下其余部分才是对的行为。
    let mut skipped: Vec<String> = Vec::new();
    for (index, task) in tasks.iter().enumerate() {
        // 0) depot key：调用方没给就现取（解密文件名与 chunk 都要它）
        //
        // 这条是**老式 CM 消息**（CMsgClientGetDepotDecryptionKey），
        // 已在 depot_key.rs 里自己实现 NetMessage 包装后发出。
        // 取不到时保留调用方传入的值（可能来自本地缓存），都没有就跳过这个 depot。
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

        // 1) manifest request code（拿不到就传 0，部分 depot 不需要）
        let request_code = runtime
            .block_on(fetch_manifest_request_code(
                session,
                task.app_id,
                task.depot_id,
                task.manifest_gid,
            ))
            .unwrap_or(0);

        // 2) CDN auth token：按节点逐个尝试，第一个成功的就用。
        //
        // 拿不到**不等于**下不了：免费 / 公开 depot 的 manifest 允许匿名拉取
        // （实测无鉴权 401 的那个例子是付费 depot）。所以这里只收集失败原因、
        // 不中断流程 —— 让 manifest 自己说话；真拉了 401，错误里带上这些原因。
        //
        // 早先的实现遇到失败就 continue 掉整个 depot，等于把「本来能下」也判死；
        // 而且通配分支把 Steam 的真实错误吞了，日志只剩一句「全部失败」。
        let mut cdn_token = String::new();
        let mut cdn_errors: Vec<String> = Vec::new();
        for server in &servers {
            let Some(base) = server.base_url() else {
                continue;
            };
            // GetCDNAuthToken 要的是 host（不带 scheme/port）
            let host = base
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split(':')
                .next()
                .unwrap_or_default()
                .to_string();
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
                Ok(_) => cdn_errors.push(format!("{host}: 返回空票据")),
                Err(error) => cdn_errors.push(format!("{host}: {error}")),
            }
        }

        on_progress(DownloadProgress {
            depot_id: task.depot_id,
            depots_done: index as u32,
            depots_total: total,
            ..Default::default()
        });

        match download_depot(
            task,
            install_dir,
            &servers,
            request_code,
            &cdn_token,
            Some(&mut |p| on_progress(p)),
        ) {
            Ok(result) => {
                overall.bytes_written += result.bytes_written;
                overall.depots.push(result);
            }
            // 单个 depot 失败也跳过：多 depot 游戏里一个坏块不该让其余部分全白下。
            // 但要把原因带出来，最后汇总。
            Err(error) => {
                // 把 CDN 票据的失败原因一并带出来：manifest 401 的最常见原因
                // 就是票据没取到，单看 "HTTP 401" 根本判断不了。
                let hint = if cdn_errors.is_empty() {
                    String::new()
                } else {
                    format!("（CDN 票据未取到：{}）", cdn_errors.join("；"))
                };
                skipped.push(format!("depot {}: {error}{hint}", task.depot_id));
            }
        }
    }

    // 一个都没成功才算是失败 —— 否则用户会看到「下载失败」但磁盘上其实有内容。
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
}
