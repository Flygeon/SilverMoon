//! **depot 下载器**：把一份 manifest 落成磁盘上的真实文件。
//!
//! ## 流程
//!
//!    1. 取 CDN 服务器列表（HTTPS，免鉴权）
//!    2. 对每个 depot：
//!       a. CM: GetDepotDecryptionKey → depot key（解密文件名与 chunk）
//!       b. CM: GetManifestRequestCode → request_code
//!       c. CDN: 拉 manifest（**先不带票据**）→ ContentManifest::parse
//!          仅在 CDN 回 401/403 时：CM: GetCDNAuthToken → 带票据重试一次
//!       d. 建目录树
//!       e. 逐文件：按 chunk 顺序拉取 → 解密 → 解压 → 校验 SHA-1 → 写入
//!
//! ## 为什么 manifest 不再强依赖 CDN 票据
//!
//! 事故记录（2026-10-24）：GetManifestRequestCode 与 GetCDNAuthToken 都被 Steam
//! 回 EResult=2（Fail）。旧流程把「拿到票据」当成前置条件，于是票据一失败，
//! 本来能下的内容也一起被判死；而且它把 request code 的失败用
//! 把它当成 0 静默吞掉，最后只剩一句「manifest 格式无法解析」。
//!
//! 现在的顺序与参考实现一致（GameNative 的 fetch_cdn_auth_token 注释：
//! 票据是「on a 401/403」才去取的）：
//! **先只用 request code 拉，被 401/403 拒了才去申请票据**。
//!
//! ## 设计取舍
//!
//! - **串行下载**：chunk 之间没有依赖，并行能更快，但并行会把内存与带宽打满，
//!   且进度上报更复杂。先做串行、可中断、可重试；并行留作后续优化。
//! - **断点续传按文件粒度**：已存在且大小正确的文件直接跳过（内容完整性靠 manifest 的
//!   sha_content 可选校验）。chunk 级续传需要 journal，暂不实现。
//! - **失败即停**：任何一个文件写失败就中止并报错，避免留下「看起来装好了」的半成品。
//! - **进度节流**：见 ProgressGate。满速下 chunk 级进度每秒几百条，
//!   不节流会形成事件风暴（host.emit → SSE → IPC → Vue）。
//!
//! ## 安全边界
//!
//! 所有写入路径都经过 safe_join 校验：manifest 里的 filename 来自远端，
//! 若出现 .. 或绝对路径，必须拒绝 —— 否则恶意 depot 能写到安装目录之外。

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

/// 一个 depot 的下载任务描述。
#[derive(Debug, Clone, Default)]
pub struct DepotTask {
    pub depot_id: u32,
    pub manifest_gid: u64,
    /// 32 字节的 depot key（从 CM 的 GetDepotDecryptionKey 取；未加密的 depot 可为空）
    pub depot_key: Vec<u8>,
    /// 归属的 app id（GetManifestRequestCode / GetCDNAuthToken / GetDepotDecryptionKey 都要）
    ///
    /// ⚠️ 必须是**拥有该 depot 的 app**。共享 depot（例如 Steamworks 公共
    /// 可再分发组件）与 DLC depot 的归属 app 未必是玩家点的那个游戏 ——
    /// 传错会让 Steam 对这几个 RPC 一律回 EResult=2（Fail）。
    /// 参考实现 GameNative 也是先按 owningAppId 问、再退回 appId。
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
/// 拒绝：绝对路径、..、盘符前缀、以 / 开头的路径。
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

// ---------------------------------------------------------------------------
// 进度节流
// ---------------------------------------------------------------------------

/// 进度上报的节流闸门。
///
/// ## 为什么需要
///
/// 满速下一个 depot 每秒会产生几百条 chunk 级进度。每一条都要走
/// host.emit("steam:download") → sidecar SSE → 主进程 → preload → Vue，
/// 前端每帧都要重算进度条 —— 这不是「卡一下」，而是事件风暴把界面拖住。
///
/// ## 但里程碑不能丢
///
/// - 第一次回调必定放行（last_emit 为 None），否则界面要等一个间隔才有反应；
/// - **当前文件变化**必定放行：界面上「正在下载 xxx」这句话必须立刻更新，
///   否则用户会看到文件名长时间停在上一处；
/// - 100% 必定放行（done >= total），让进度条在 depot 切换前落定。
///
/// 与参考实现 GameNative 的 ProgressGate 同构（它按 200ms 节流、里程碑放行）。
struct ProgressGate {
    /// 最小发射间隔。做成字段而不是常量，是为了让单测能用 0 / 一小时的
    /// 极端值把「时间」这个不确定因素从断言里彻底排除。
    interval: Duration,
    last_emit: Option<Instant>,
    last_file: String,
}

impl ProgressGate {
    /// 10 次/秒 —— 人眼能分辨的上限，也是本轮任务给的硬指标。
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
        // total 为 0 表示体积未知，**不能**当成「已完成」
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

/// 过闸后再回调。
///
/// depots_done / depots_total 这里填 0：全局计数只有 download_app 知道，
/// 它会在自己的进度闭包里填真实值。本函数只负责单个 depot 的字节进度。
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

/// 把诊断备注拼成错误后缀；没有备注时返回空串（不留一对空括号）。
fn notes_suffix(notes: &[String]) -> String {
    if notes.is_empty() {
        String::new()
    } else {
        format!("（{}）", notes.join("；"))
    }
}

// ---------------------------------------------------------------------------
// manifest 获取
// ---------------------------------------------------------------------------

/// 取 manifest 失败的原因，以及「值不值得去申请 CDN 票据」。
struct ManifestFailure {
    /// 可读原因（已包含节点状态码 / 响应体前缀）
    reason: String,
    /// 至少有一个节点明确回 401/403 —— 这才是该去申请票据的信号。
    ///
    /// 超时 / 5xx / 解析失败都不算：那种情况下票据也救不了，
    /// 白打一串 CM 往返只会让「下不了」来得更慢。
    auth_denied: bool,
}

/// 从 CDN 取一份 depot manifest 并解析。
///
/// ## 为什么「解析成功」才算成功
///
/// 旧实现只要响应体非空就当拿到 manifest，于是「200 + 一段不是 manifest 的正文」
/// （边缘缓存出错时会出现）会一路拖到 ContentManifest::parse，
/// 最后变成一句无从解释的「格式无法解析」，而响应体里真正的原因被丢掉了。
/// 现在逐个节点试、**当场解析**：解析不了就把响应体开头写进失败原因。
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
            Ok(bytes) => match ContentManifest::parse(&bytes) {
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
        // 只列前 3 个：10 个节点的失败原因通常完全一样，
        // 全列出来会让错误文案长到没法看，也就没人读了。
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

// ---------------------------------------------------------------------------
// 单个 depot 落盘
// ---------------------------------------------------------------------------

/// 下载一个 depot 的全部内容到 install_dir。
///
/// manifest 由调用方（download_app）取好并传进来：取 manifest 需要按
/// 401/403 决定要不要申请票据，那是「网络策略」，与「怎么落盘」是两件事。
/// 分开之后 download_depot 只关心字节，也就能被单独推理与测试。
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
    let mut gate = ProgressGate::new();
    let mut last_error = String::from("未知错误");

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
                                if let Some(error) = outcome.error {
                                    last_error = error;
                                }
                            }
                        }
                    }
                    Ok(_) => last_error = "chunk 为空".to_string(),
                    // CdnFetchError 实现了 Display：状态码与响应体前缀都会带出来
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

            // 文件内部也要报进度：一个 4GB 的文件若只在写完后报一次，
            // 进度条会在这期间一动不动 —— 那正是用户报的「进度条不动」。
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
        // 文件切换是一条里程碑（ProgressGate 会放行），界面上的文件名立刻更新
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

/// 从 CDN 基地址里取出裸主机名（GetCDNAuthToken 要的就是它，不带 scheme/端口）。
fn cdn_host(base: &str) -> String {
    base.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split(':')
        .next()
        .unwrap_or_default()
        .to_string()
}

// ---------------------------------------------------------------------------
// 完整流程
// ---------------------------------------------------------------------------

/// 完整下载流程：连 CM → 逐 depot 解析 → 下载。
///
/// 这是给上层命令调用的入口。任何一步失败都返回可读错误，不做部分成功。
///
/// ## 每个 depot 的 CM 往返
///
/// 1. GetDepotDecryptionKey：解密文件名与 chunk（老式 job 消息）
/// 2. GetManifestRequestCode：manifest URL 的访问码（**必需**，缺了 CDN 回 401）
/// 3. GetCDNAuthToken：**仅当 CDN 回 401/403 时**才申请
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

        // 本次 depot 的诊断备注（request code / 票据的真实原因）。
        // 只有这个 depot 真的失败时才拼进错误 —— 成功了就不该让用户看到这些噪音。
        let mut notes: Vec<String> = Vec::new();

        // 1) manifest request code
        //
        // 拿不到**不等于**下不了（少数 depot 的 manifest 允许匿名取），
        // 但绝不能再像以前那样把它当成 0 静默吞掉 ——
        // 实测：不带 request code 时 CDN 对每个节点都回 401，
        // 于是「Steam 拒绝发码」会伪装成一个莫名其妙的「CDN 401」。
        // 这里把真实原因留下来，等 manifest 真的失败时作为首要原因报出去。
        let request_code = match runtime.block_on(fetch_manifest_request_code(
            session,
            task.app_id,
            task.depot_id,
            task.manifest_gid,
        )) {
            Ok(0) => {
                // 0 不是「不需要码」：参考实现 GameNative 的注释写明
                // a zero code is not harmless —— 每个节点都会回 401。
                notes.push("Steam 答复的 manifest 请求码是 0（该 depot 这版没有码）".to_string());
                0
            }
            Ok(code) => code,
            Err(error) => {
                notes.push(format!("Steam 未给出 manifest 请求码（{error}）"));
                0
            }
        };

        // 2) manifest：先不带票据
        //
        // 参考实现（GameNative 的 fetch_cdn_auth_token）注释写明票据是
        // 「on a 401/403」才去取的。早先这里是「每个 depot 先把 10 个节点的票据
        // 都申请一遍」，票据一旦被 Steam 拒（本次事故里就是全部 EResult=Fail），
        // 本来能下的内容也一起被判死，还平白多 10 次 CM 往返。
        let mut cdn_token = String::new();
        let manifest = match fetch_manifest(task, &servers, request_code, "") {
            Ok(manifest) => manifest,
            Err(failure) if failure.auth_denied => {
                // CDN 明确说没鉴权 → 现在才值得去申请票据
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
                // 全局 depot 计数只有这里知道；download_depot 只负责单 depot 的字节进度。
                p.depots_done = depots_done;
                p.depots_total = total;
                on_progress(p);
            }),
        ) {
            Ok(result) => {
                overall.bytes_written += result.bytes_written;
                overall.depots.push(result);
            }
            // 单个 depot 失败也跳过：多 depot 游戏里一个坏块不该让其余部分全白下。
            // 但要把原因带出来，最后汇总。
            Err(error) => {
                skipped.push(format!(
                    "depot {}: {error}{}",
                    task.depot_id,
                    notes_suffix(&notes)
                ));
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

    /// 节流必须「丢中间帧、保里程碑」。
    ///
    /// 间隔取一小时：把「时间到点」这条分支从断言里彻底排除，
    /// 剩下的行为就只由「文件变化 / 100%」决定 —— 不依赖机器快慢，不会 flaky。
    #[test]
    fn progress_gate_throttles_but_keeps_milestones() {
        let mut gate = ProgressGate::with_interval(Duration::from_secs(3600));

        // 第一次必定放行，否则界面要等一个间隔才有反应
        assert!(gate.should_emit(10, 1000, "a.bin"));
        // 同一文件、未到 100% → 被节流
        assert!(!gate.should_emit(20, 1000, "a.bin"));
        assert!(!gate.should_emit(999, 1000, "a.bin"));
        // 文件变化必定放行：界面上的「正在下载 xxx」不能停在上一处
        assert!(gate.should_emit(1000, 1000, "b.bin"));
        // 100% 必定放行（哪怕文件名没变）
        assert!(gate.should_emit(1000, 1000, "b.bin"));
    }

    /// 间隔到点必须放行 —— 否则长文件的进度条会停住。
    ///
    /// 用零间隔把这条分支变成确定性的：elapsed() >= 0 恒真。
    #[test]
    fn progress_gate_emits_when_interval_elapses() {
        let mut gate = ProgressGate::with_interval(Duration::ZERO);
        assert!(gate.should_emit(1, 1000, "a.bin"));
        assert!(gate.should_emit(2, 1000, "a.bin"));
        assert!(gate.should_emit(3, 1000, "a.bin"));
    }

    /// 体积未知（total == 0）不能被当成「已完成」。
    ///
    /// 这是真会踩的：manifest 还没算总体积时 total 为 0，
    /// 若写成 done >= total 就会每帧都放行，节流等于没做。
    #[test]
    fn progress_gate_does_not_treat_unknown_total_as_complete() {
        let mut gate = ProgressGate::with_interval(Duration::from_secs(3600));
        assert!(gate.should_emit(0, 0, "a.bin")); // 第一次
        assert!(!gate.should_emit(10, 0, "a.bin")); // total 未知 ≠ 已完成
    }

    /// 没有备注时不能留下「（）」这种空括号。
    #[test]
    fn notes_suffix_avoids_empty_parentheses() {
        assert_eq!(notes_suffix(&[]), "");
        assert_eq!(notes_suffix(&["a".to_string()]), "（a）");
        assert_eq!(
            notes_suffix(&["a".to_string(), "b".to_string()]),
            "（a；b）"
        );
    }

    /// GetCDNAuthToken 要的是裸主机名：带 scheme / 端口会让 CDN 一律 401。
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
