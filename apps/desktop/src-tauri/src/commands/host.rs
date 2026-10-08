//! 宿主命令：Electron 版由主进程 Node 侧实现的「非业务」能力。
//!
//! 迁回 Tauri 后，对话框 / 文件读写 / 网络 / 系统默认程序都交给官方插件
//! （渲染进程直接调 `@tauri-apps/plugin-*`，不经过本模块）。**本模块只保留
//! 插件覆盖不到、或必须与 Rust 侧的目录口径保持一致的那几项**：
//!
//! | 命令 | 用途 | 前端调用点 |
//! |---|---|---|
//! | `host_path` | 应用目录 + 路径运算 | `src/ipc/paths.ts` |
//! | `host_version` / `host_app_exit` | 宿主版本 / 退出 | `src/ipc/app.ts` |
//! | `host_clear_cover_cache` | 清空封面缓存 | `src/ipc/app.ts` |
//! | `host_updater` | 自动更新（只提示，不自动重启） | `capabilities.updater*` |
//!
//! ## 为什么 `host_path` 不直接用插件的 `path` API
//!
//! 扩展的 `web/<dist>/index.html` 需要前端拼出与 Rust 侧 `app_data_dir()`
//! **完全一致**的路径。两侧各算一次必然漂移，因此这里把权威口径放在 Rust，
//! 前端只做转发。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 路径能力统一入口（`op` 分支）。
#[tauri::command]
pub fn host_path(
    app: AppHandle,
    op: String,
    path: Option<String>,
    paths: Option<Vec<String>>,
    ext: Option<String>,
) -> Result<Value, String> {
    let resolver = app.path();
    let to_value =
        |p: PathBuf| -> Result<Value, String> { Ok(json!(p.to_string_lossy().to_string())) };

    match op.as_str() {
        "appDataDir" => resolver
            .app_data_dir()
            .map_err(|e| e.to_string())
            .and_then(to_value),
        "appCacheDir" => resolver
            .app_cache_dir()
            .map_err(|e| e.to_string())
            .and_then(to_value),
        "appConfigDir" => resolver
            .app_config_dir()
            .map_err(|e| e.to_string())
            .and_then(to_value),
        "appLogDir" => resolver
            .app_log_dir()
            .map_err(|e| e.to_string())
            .and_then(to_value),
        "homeDir" => resolver
            .home_dir()
            .map_err(|e| e.to_string())
            .and_then(to_value),
        "tempDir" => resolver
            .temp_dir()
            .map_err(|e| e.to_string())
            .and_then(to_value),
        // 路径拼接：语义与 Node 的 path.join 一致（逐段追加，不解析 ..）
        "join" => {
            let mut acc = PathBuf::new();
            for segment in paths.unwrap_or_default() {
                acc.push(segment);
            }
            Ok(json!(acc.to_string_lossy().to_string()))
        }
        "normalize" => {
            let raw = path.ok_or_else(|| "normalize 缺少 path".to_string())?;
            Ok(json!(normalize_str(&raw)))
        }
        "dirname" => {
            let raw = path.ok_or_else(|| "dirname 缺少 path".to_string())?;
            let p = Path::new(&raw);
            Ok(json!(p
                .parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default()))
        }
        "basename" => {
            let raw = path.ok_or_else(|| "basename 缺少 path".to_string())?;
            let p = Path::new(&raw);
            let mut name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            // 与 Node 的 path.basename(path, ext) 一致：剥掉匹配的后缀
            if let Some(ext) = ext.filter(|e| !e.is_empty()) {
                if let Some(stripped) = name.strip_suffix(&ext) {
                    name = stripped.to_string();
                }
            }
            Ok(json!(name))
        }
        "extname" => {
            let raw = path.ok_or_else(|| "extname 缺少 path".to_string())?;
            let ext = Path::new(&raw)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            Ok(json!(ext))
        }
        other => Err(format!("未知的 host_path op：{other}")),
    }
}

/// 规范化路径：统一分隔符、折叠 `.`，但**不**解析符号链接 / 不要求路径存在
/// （Node 的 `path.normalize` 同样不碰文件系统）。
fn normalize_str(raw: &str) -> String {
    let unified = raw.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for segment in unified.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    // 保留 Windows 盘符 / UNC 前缀与 POSIX 根
    if unified.starts_with('/') || unified.starts_with("//") {
        format!("/{joined}")
    } else {
        joined
    }
}

/// 宿主版本号（诊断上报用）。
#[tauri::command]
pub fn host_version() -> String {
    tauri::VERSION.to_string()
}

/// 退出应用。
#[tauri::command]
pub fn host_app_exit(app: AppHandle, _code: Option<i32>) {
    app.exit(0);
}

/// 清空封面磁盘缓存，返回释放的字节数。
#[tauri::command]
pub fn host_clear_cover_cache(app: AppHandle) -> u64 {
    crate::cover::clear(&app)
}

/// 首个启动的旧数据迁移检查（供前端设置页展示）。
#[tauri::command]
pub fn host_legacy_migrated(app: AppHandle) -> bool {
    // 迁移在 setup 阶段已完成；这里只回报「数据目录里还有没有旧目录残留」
    let Ok(dir) = app.path().app_data_dir() else {
        return false;
    };
    let Some(root) = dir.parent() else {
        return false;
    };
    !root.join("cn.cool.lumiluna").exists()
}

/// 自动更新：检查是否有新版本。**只提示、不自动安装**（与 Electron 版产品行为一致）。
///
/// ⚠️ 未配置更新源时**必须返回 idle 而不是报错**：`tauri-plugin-updater` 在
/// `endpoints` 为空时 `updater()` 直接返回 `Error::EmptyEndpoints`。
/// 本仓库当前没填 endpoints（发版签名方案未定，见 README 的发布约定），
/// 若把该错误抛给前端，设置页的「检查更新」会弹一条无意义的报错。
/// 因此这里把「未配置」与「已是最新」都归为 idle。
#[tauri::command]
pub async fn host_updater_check(app: AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let Ok(updater) = app.updater() else {
        // 未配置 endpoints（或当前架构不支持）→ 视为「没有可用更新」
        return Ok(json!({ "status": "idle" }));
    };
    match updater.check().await {
        Ok(Some(update)) => Ok(json!({
            "status": "available",
            "info": { "version": update.version, "notes": update.body },
        })),
        Ok(None) => Ok(json!({ "status": "idle" })),
        // 网络失败也不该让 UI 报错：更新检查是尽力而为的旁路
        Err(e) => {
            eprintln!("[updater] 检查更新失败：{e}");
            Ok(json!({ "status": "idle" }))
        }
    }
}

/// 自动更新：下载并安装（由用户显式点击触发）。
#[tauri::command]
pub async fn host_updater_install(app: AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let Ok(updater) = app.updater() else {
        return Ok(json!({ "status": "idle" }));
    };
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(json!({ "status": "idle" }));
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "status": "installed" }))
}

// ---------------------------------------------------------------------------
// app 通道：启动打点 / 内存诊断 / 内存基准 / 自动更新
//
// Electron 版这些指标来自 Node 的 `app.getAppMetrics()`（按 Chromium 进程）。
// Tauri 是「单进程 + 系统 WebView」结构，**没有等价的进程列表**：
// WebView 由系统托管（WebView2 / WKWebView / WebKitGTK），其内存不暴露给宿主。
// 因此这里只回报本进程的 RSS，并把「渲染进程」合并进同一行——口径变化在返回值
// 里显式标注（`note`），避免把不可比的数字伪装成同一指标。
// ---------------------------------------------------------------------------

/// 读取本进程常驻内存（字节）。Windows 走 Win32 API，其它平台读 `/proc` / `ps`。
fn process_rss_bytes() -> u64 {
    #[cfg(windows)]
    {
        // 不引入 windows crate：`tasklist` 足够，且这是纯诊断路径。
        let pid = std::process::id();
        if let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            // CSV: "name","pid","session","sess#","mem usage"  —— 形如 "1,234 K"
            for field in text.split(',').rev() {
                let cleaned = field.trim().trim_matches('"').replace([',', 'K', 'k'], "");
                if cleaned.chars().all(|c| c.is_ascii_digit()) && !cleaned.is_empty() {
                    if let Ok(kb) = cleaned.parse::<u64>() {
                        return kb * 1024;
                    }
                }
            }
        }
        0
    }
    #[cfg(not(windows))]
    {
        // /proc/self/statm 的第 2 个字段是 RSS（页数）；macOS 上没有 /proc，退化为 0。
        let Ok(text) = std::fs::read_to_string("/proc/self/statm") else {
            return 0;
        };
        let pages = text
            .split_whitespace()
            .nth(1)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        pages * 4096
    }
}

/// 内存快照（口径见上方模块注释）。
fn memory_metrics(app: &AppHandle) -> Value {
    let rss = process_rss_bytes();
    let total_mb = rss as f64 / 1024.0 / 1024.0;
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    json!({
        "totalMB": total_mb,
        "processes": [{
            "pid": std::process::id(),
            "type": "Main",
            "name": "SilverMoon",
            "workingSetMB": total_mb,
            "peakMB": total_mb,
            "cpu": 0.0,
        }],
        "labels": labels,
        "note": "Tauri 单进程口径：系统 WebView 的内存不在本进程 RSS 内",
    })
}

/// `app` 通道（op + payload）。
#[tauri::command]
pub fn host_app(app: AppHandle, op: String, payload: Value) -> Result<Value, String> {
    match op.as_str() {
        // 启动打点：写进数据目录的 main.log，便于对齐启动耗时
        "logBoot" => {
            let mark = payload.get("mark").and_then(|v| v.as_str()).unwrap_or("");
            let since = payload.get("since").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let line = format!("[启动][渲染] {mark}: {since:.0}ms\n");
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("main.log"))
                    .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
            }
            Ok(Value::Null)
        }
        "metrics" => Ok(memory_metrics(&app)),
        // 内存基准：Tauri 侧没有 Chromium 的多进程快照可采，只回报当前 RSS 基线，
        // 保证前端 UI 不炸；详细口径见 memory_metrics 的 note。
        _ if op == "bench" => {
            let action = payload
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("status");
            let rss = process_rss_bytes() as f64 / 1024.0 / 1024.0;
            match action {
                "status" | "start" | "stop" | "clear" => Ok(json!({
                    "running": false,
                    "samples": 0,
                    "marks": [],
                    "startedAt": null,
                })),
                "mark" => Ok(json!({ "t": 0, "label": payload.get("label"), "totalMB": rss })),
                "report" => Ok(json!({ "summary": empty_bench_summary(rss) })),
                "export" => Ok(json!({ "path": "", "summary": empty_bench_summary(rss) })),
                other => Err(format!("未知的 bench action：{other}")),
            }
        }
        other => Err(format!("未知的 app op：{other}")),
    }
}

fn empty_bench_summary(rss: f64) -> Value {
    json!({
        "totalMB": rss,
        "marks": [],
        "processPeaks": [],
        "processDeltas": [],
    })
}

/// `updater` 通道（op + payload）。
///
/// 声明为 `async` 而不是「同步命令 + `block_on`」：同步命令跑在主线程上，
/// `block_on` 会在检查更新（含网络往返）期间把 UI 冻住；`async` 命令由 async
/// 运行时驱动，直接 `await` 即可，也不会因为「主线程等待运行时」而自锁。
#[tauri::command]
pub async fn host_updater(app: AppHandle, op: String, _payload: Value) -> Result<Value, String> {
    match op.as_str() {
        "state" => Ok(json!({ "status": "idle" })),
        "check" => host_updater_check(app).await,
        "install" => host_updater_install(app).await,
        other => Err(format!("未知的 updater op：{other}")),
    }
}
