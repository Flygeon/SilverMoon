//! Steam **CM 能力**的命令层。
//!
//! 只暴露下载所必需的能力，并且**全部可降级**。
//!
//! ## 为什么这里只有连接管理
//!
//! 登录 / 游戏库 / 启动 / 详情都在 Electron 侧走纯 HTTPS（见 `electron/steam/`），
//! 不经过 sidecar。真正需要 CM 的只有「自己下载」：
//! `GetManifestRequestCode` 与 `GetCDNAuthToken` 在 WebAPI 上**不存在**（实测 404），
//! 而没有它们，CDN 的 manifest 请求会返回 **401**（实测）。
//!
//! 所以本模块先把「连接」这条地基做出来并验证：连不上，后面一切都是死代码。
//!
//! ## 凭据
//!
//! refresh_token 由 Electron 侧加密保存（`steam-session.json`），调用时传入。
//! 本进程**不落盘任何凭据**。

use std::sync::OnceLock;

use serde::Serialize;
use tokio::runtime::Runtime;

// EventEmitter 提供 Host::emit —— 它是 **trait 方法**，不 import 就调不到
// （osu.rs 同样是 use silvermoon_ipc::{EventEmitter, HostApi}）。
use silvermoon_ipc::EventEmitter;
use silvermoon_steam::CmManager;

/// 全局 CM 管理器（懒建立）。
fn manager() -> &'static CmManager {
    static MANAGER: OnceLock<CmManager> = OnceLock::new();
    MANAGER.get_or_init(CmManager::new)
}

/// 后台 tokio 运行时。
///
/// 不能借用命令级的 runtime：CM 连接是**长生命周期**的，读写循环要一直跑；
/// 命令返回后 runtime 被回收，连接随即失效。这里持有一个独立 runtime，
/// 让 CM 会话有稳定的执行环境。
fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("steam-cm")
            .build()
            .expect("无法创建 Steam CM 运行时")
    })
}

/// CM 连接状态。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CmStatus {
    /// 是否已连接
    pub connected: bool,
    /// 最近一次错误（连接失败时给用户看）
    pub error: Option<String>,
}

/// 查询 CM 是否已连接。
#[silvermoon_ipc::command]
pub async fn steam_cm_status() -> Result<CmStatus, String> {
    let connected = runtime().block_on(manager().is_connected());
    Ok(CmStatus {
        connected,
        error: None,
    })
}

/// 用 **access_token（JWT）** 建立 CM 会话。
///
/// 注意参数不是 refresh_token：`Connection::access` 会把 token 当 JWT 解出 steamid，
/// 而 refresh_token 是不透明字符串。调用方（Electron 侧）应先用 refresh_token
/// 换取 access_token 再传进来。
///
/// 失败时把可读原因回给前端（而不是抛裸错误）——「连不上 CM」是**预期内**的网络状况，
/// 不该让界面崩，只需降级成「唤起 Steam 客户端下载」。
#[silvermoon_ipc::command]
pub async fn steam_cm_connect(
    account_name: String,
    access_token: String,
) -> Result<CmStatus, String> {
    let result = runtime().block_on(async {
        manager()
            .get_or_connect(&account_name, &access_token)
            .await
            .map(|guard| guard.is_some())
    });
    Ok(match result {
        Ok(connected) => CmStatus {
            connected,
            error: None,
        },
        Err(error) => CmStatus {
            connected: false,
            error: Some(error.to_string()),
        },
    })
}

/// 断开 CM 会话（登出 / 切换账号）。
#[silvermoon_ipc::command]
pub async fn steam_cm_disconnect() -> Result<CmStatus, String> {
    runtime().block_on(manager().disconnect());
    Ok(CmStatus {
        connected: false,
        error: None,
    })
}

/// 下载任务描述（前端传进来）。
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DepotTaskInput {
    pub depot_id: u32,
    pub manifest_gid: String,
    /// 32 字节 depot key 的 hex；未加密 depot 可传空
    #[serde(default)]
    pub depot_key: String,
    pub app_id: u32,
}

/// 下载结果（回给前端）。
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub ok: bool,
    pub bytes_written: u64,
    pub depots: u32,
    pub error: Option<String>,
}

/// 下载某个 app 的若干 depot 到 `install_dir`。
///
/// **前置条件**：必须先 `steam_cm_connect` 成功。没有 CM 就没有 manifest
/// request code 与 CDN token，CDN 会一律 401。
///
/// 进度经 `steam:download` 事件回推（见 emit 调用）。
#[silvermoon_ipc::command]
pub async fn steam_download(
    app: silvermoon_ipc::Host,
    account_name: String,
    access_token: String,
    install_dir: String,
    depots: Vec<DepotTaskInput>,
) -> Result<DownloadOutcome, String> {
    use silvermoon_steam::{download_app, DepotTask};

    if depots.is_empty() {
        return Ok(DownloadOutcome {
            ok: false,
            error: Some("没有要下载的 depot".into()),
            ..Default::default()
        });
    }
    let target = std::path::PathBuf::from(&install_dir);
    if install_dir.trim().is_empty() {
        return Ok(DownloadOutcome {
            ok: false,
            error: Some("安装目录为空".into()),
            ..Default::default()
        });
    }

    // depot key 是 hex，解析成 32 字节
    let mut tasks = Vec::with_capacity(depots.len());
    for input in depots {
        let key = if input.depot_key.trim().is_empty() {
            Vec::new()
        } else {
            match hex_to_bytes(&input.depot_key) {
                Some(bytes) if bytes.len() == 32 => bytes,
                _ => {
                    return Ok(DownloadOutcome {
                        ok: false,
                        error: Some(format!("depot {} 的 key 不是 32 字节 hex", input.depot_id)),
                        ..Default::default()
                    })
                }
            }
        };
        let manifest_gid = input
            .manifest_gid
            .trim()
            .parse::<u64>()
            .map_err(|_| format!("depot {} 的 manifestGid 不是合法数字", input.depot_id))?;
        tasks.push(DepotTask {
            depot_id: input.depot_id,
            manifest_gid,
            depot_key: key,
            app_id: input.app_id,
        });
    }

    let host = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        download_app(
            manager(),
            &account_name,
            &access_token,
            &tasks,
            &target,
            |progress| {
                // 进度事件名必须与前端 listen 一致（改名不报错、只静默失效）
                let _ = host.emit(
                    "steam:download",
                    serde_json::json!({
                        "depotId": progress.depot_id,
                        "depotDone": progress.depot_done,
                        "depotTotal": progress.depot_total,
                        "depotsDone": progress.depots_done,
                        "depotsTotal": progress.depots_total,
                        "currentFile": progress.current_file,
                    }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("下载任务崩溃：{e}"))?;

    Ok(match result {
        Ok(done) => DownloadOutcome {
            ok: true,
            bytes_written: done.bytes_written,
            depots: done.depots.len() as u32,
            error: None,
        },
        Err(error) => DownloadOutcome {
            ok: false,
            error: Some(error),
            ..Default::default()
        },
    })
}

/// hex 字符串 → 字节（大小写不敏感）。非法字符返回 None。
fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    let text = hex.trim();
    if text.is_empty() || text.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let high = hex_value(bytes[index])?;
        let low = hex_value(bytes[index + 1])?;
        out.push((high << 4) | low);
        index += 2;
    }
    Some(out)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
