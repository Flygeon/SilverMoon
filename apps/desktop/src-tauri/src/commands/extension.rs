//! 扩展框架（host 侧）。
//!
//! 设计目标：主项目零体积增加，把「锦上添花」的功能（如 MiaoHui 离线内容检索）
//! 作为独立扩展包分发。扩展包放在 `app_data_dir/extensions/<id>/`，含：
//! - `manifest.json`：元数据 + 引擎入口 + 贡献点（窗口/热键/托盘/设置）
//! - `engine/`：扩展私有引擎（MiaoHui 的 Python sidecar）
//! - `web/dist/`：扩展预构建前端（可选，Phase 5 起由前端 ExtensionHost 加载）
//! - `data/`：扩展私有数据（引擎写）
//!
//! 主机只暴露一组**通用桥接命令**（`ext_list`/`ext_install`/`ext_uninstall`/
//! `ext_set_enabled`/`ext_invoke`），把调用路由到扩展引擎的 localhost HTTP。
//! 引擎以 `std::process::Command` 拉起（复用 ffmpeg.rs 的 CREATE_NO_WINDOW），
//! 端口经 stdout 的 `READY <port>` 行握手（复用 webdav.rs 的随机端口思路）。
//!
//! 高权限动作（打开文件/跳秒）由主机代执行，扩展经 `ext_invoke` 请求，
//! 避免扩展直接持有关键权限。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// ---- Manifest 结构（camelCase 过桥）----

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub min_host_version: Option<String>,
    #[serde(default)]
    pub engines: Option<ExtEngine>,
    #[serde(default)]
    pub web: Option<ExtWeb>,
    #[serde(default)]
    pub contributes: Option<ExtContributes>,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
    /// 激活时机：`"onStartup"` | `"onHotkey"` | `"onTray"` | `"onInvoke"`。
    ///
    /// 省略 = 等同 `["onStartup"]`（旧包行为，启动即拉起引擎）。
    /// 声明了但**不含 onStartup** 的扩展，启动时不拉起引擎，改为首次被
    /// 热键/托盘/调用触达时才懒启动 —— 与 VS Code 的 activationEvents 同一思路，
    /// 避免每个装了的扩展都在开机时吃一份内存。
    #[serde(default)]
    pub activation_events: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtEngine {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub support_env: Option<String>,
    #[serde(default)]
    pub ready_line: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtWeb {
    #[serde(default)]
    pub dist: Option<String>,
    #[serde(default)]
    pub default_route: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtContributes {
    #[serde(default)]
    pub windows: Vec<ExtWindowContrib>,
    #[serde(default)]
    pub hotkeys: Vec<ExtHotkey>,
    #[serde(default)]
    pub tray: Vec<ExtTrayItem>,
    #[serde(default)]
    pub settings: Option<ExtSettings>,
    /// 扩展自带的皮肤。
    ///
    /// 皮肤功能已**不再由设置页管理**：用户想装皮肤就装一个封装了皮肤的扩展，
    /// 由扩展声明并自带 skin.json。宿主只负责读取与校验（复用既有 skinSchema）。
    #[serde(default)]
    pub themes: Vec<ExtTheme>,
}

/// 扩展声明的一款皮肤（对应 `contributes.themes[]`）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtTheme {
    pub id: String,
    pub name: String,
    /// 扩展目录内 skin.json 的**相对路径**（防穿越校验见 `read_theme`）
    pub path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtWindowContrib {
    pub route: String,
    pub title: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub decorations: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtHotkey {
    pub accelerator: String,
    #[serde(default)]
    pub route: String,
    #[serde(default = "default_action")]
    pub action: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtTrayItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub action: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtSettings {
    #[serde(default)]
    pub schema: Vec<Value>,
}

fn default_action() -> String {
    "toggle".to_string()
}

// ---- 扩展 API 版本与权限 ----
//
// `minHostVersion` 比较的是**扩展框架 API 版本**，不是应用版本号
// （`silvermoon.config.json` 的 0.1.0 是产品版本，两者语义不同）。
// 这与 VS Code 的 `engines.vscode` 是同一套思路：宿主契约独立版本化，
// 契约发生不兼容变更时才 +1 major。
//
// 当前值 2.0.0 与已在用的参考扩展 miaohui 的声明一致。
pub const EXT_API_VERSION: &str = "2.0.0";

/// 调用扩展引擎任意方法所需权限（legacy 包未声明权限时放行）
pub const PERM_INVOKE: &str = "ext:invoke";
/// 由宿主代执行"打开 / 定位文件"所需权限
pub const PERM_OPEN: &str = "opener:open-path";

/// 校验 manifest.minHostVersion 是否被当前扩展 API 满足。
/// 缺省 = 不限；显式写 `*` 视为无效（照 VS Code 的做法，逼作者给真实区间）。
fn check_host_version(req: &Option<String>) -> Result<(), String> {
    let Some(req) = req.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    if req == "*" {
        return Err("minHostVersion 不允许写 \"*\"，请给出真实版本区间".into());
    }
    let want =
        VersionReq::parse(req).map_err(|e| format!("minHostVersion 不是合法版本区间：{e}"))?;
    let host = Version::parse(EXT_API_VERSION).unwrap_or(Version::new(0, 0, 0));
    if want.matches(&host) {
        Ok(())
    } else {
        Err(format!("需要扩展 API {req}，当前 {host}"))
    }
}

/// 权限判定。manifest **完全没有** `permissions` 字段时返回 true ——
/// 迁移期兼容已发出的旧扩展包（它们先于权限模型），由 UI 提示用户；
/// 一旦声明了数组，就逐项严格校验。
fn permitted(manifest: &ExtManifest, perm: &str) -> bool {
    match manifest.permissions.as_deref() {
        None => true,
        Some(list) => list.iter().any(|p| p == perm),
    }
}

/// 启动时是否就该拉起引擎。
///
/// 未声明 `activationEvents` = 旧包，保持"启动即拉起"的老行为；
/// 声明了就只认显式的 `onStartup`。
fn wants_startup(activation_events: &[String]) -> bool {
    if activation_events.is_empty() {
        return true;
    }
    activation_events
        .iter()
        .any(|e| e.eq_ignore_ascii_case("onStartup"))
}

/// 取扩展为指定 route 声明的窗口偏好（无匹配则退到第一个窗口贡献）。
fn window_pref(manifest: &ExtManifest, route: &str) -> Option<ExtWindowContrib> {
    let wins = &manifest.contributes.as_ref()?.windows;
    wins.iter()
        .find(|w| w.route == route)
        .or_else(|| wins.first())
        .cloned()
}

/// 安装来源（前端传）
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtSource {
    pub kind: String, // "folder" | "zip" | "url"
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// 已安装扩展摘要（前端列表用）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub has_engine: bool,
    pub engine_ready: bool,
    /// 宿主扩展 API 版本是否满足 manifest 的 minHostVersion
    pub compatible: bool,
    /// 不兼容原因（compatible = false 时给出，供 UI 直接展示）
    pub incompatible_reason: Option<String>,
    /// 声明的权限清单；空数组 = 未声明（legacy 包，宿主放行但 UI 会提示）
    pub permissions: Vec<String>,
    /// 扩展声明的默认路由（manifest.web.defaultRoute）
    pub default_route: Option<String>,
    /// 最近一次引擎启动失败的原因；None = 引擎正常或该扩展没有引擎。
    /// 此前失败只 `eprintln!`，UI 仍显示"已启用"，用户无从得知。
    pub engine_error: Option<String>,
    /// 是否声明了窗口贡献点（扩展管理页据此决定要不要给「打开」按钮）
    pub has_window: bool,
}

// ---- 运行时状态 ----

struct ExtEntry {
    manifest: ExtManifest,
    dir: PathBuf,
    enabled: bool,
    port: Option<u16>,
    child: Option<Child>,
    /// minHostVersion 不满足时的原因；None = 兼容
    incompatible: Option<String>,
    /// 最近一次引擎启动失败的原因（成功则清空）
    engine_error: Option<String>,
}

impl ExtEntry {
    /// 摘要（`ext_list` 与 `ext_install` 共用，避免两处字段拷贝漂移）
    fn info(&self) -> ExtInfo {
        ExtInfo {
            id: self.manifest.id.clone(),
            name: self.manifest.name.clone(),
            version: self.manifest.version.clone().unwrap_or_default(),
            enabled: self.enabled,
            has_engine: self.manifest.engines.is_some(),
            engine_ready: self.port.is_some(),
            compatible: self.incompatible.is_none(),
            incompatible_reason: self.incompatible.clone(),
            permissions: self.manifest.permissions.clone().unwrap_or_default(),
            default_route: self
                .manifest
                .web
                .as_ref()
                .and_then(|w| w.default_route.clone()),
            engine_error: self.engine_error.clone(),
            has_window: self
                .manifest
                .contributes
                .as_ref()
                .map(|c| !c.windows.is_empty())
                .unwrap_or(false),
        }
    }
}

/// 打开某个扩展的窗口（扩展管理页的「打开」按钮）。
///
/// 路由优先取 manifest 的 `web.defaultRoute`，否则退到第一个窗口贡献点。
/// 存在的意义：不必先知道扩展声明了什么热键，也能确定性地把它打开来验证。
#[tauri::command]
pub async fn ext_open_window(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let route = {
            let state = app.state::<ExtState>();
            let map = state.map.lock().unwrap();
            let ext = map.get(&id).ok_or_else(|| format!("扩展不存在：{id}"))?;
            let c = ext.manifest.contributes.as_ref();
            if c.map(|c| c.windows.is_empty()).unwrap_or(true) {
                return Err(format!("扩展 {id} 没有声明窗口贡献点"));
            }
            ext.manifest
                .web
                .as_ref()
                .and_then(|w| w.default_route.clone())
                .or_else(|| c.and_then(|c| c.windows.first().map(|w| w.route.clone())))
                .unwrap_or_default()
        };
        open_extension_window(&app, &id, &route).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("打开扩展窗口失败：{e}"))
    .and_then(|r| r)
}

#[derive(Default)]
struct ExtState {
    map: Mutex<HashMap<String, ExtEntry>>,
    /// 最近一次的扩展导航目标 `(ext_id, route)`。
    ///
    /// ## 为什么要有它
    ///
    /// 新建扩展窗口时，`WebviewWindowBuilder::build()` 一返回就 `emit`，
    /// 而窗口里的前端**还没来得及 `listen`** —— Tauri 的事件不缓存，直接就丢了。
    /// 表现就是：窗口打开了，却停在「等待导航事件」的空白页，再按一次热键才好
    /// （第二次走的是「窗口已存在」分支，那时前端早就挂载完了）。
    ///
    /// 所以把目标记在这里，前端挂载时**主动拉一次**（`ext_current_nav`），
    /// 不再依赖「推的时机刚好赶得上」。
    last_nav: Mutex<Option<(String, String)>>,
}

// ---- 路径工具 ----

fn ext_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app data 目录：{e}"))?;
    Ok(dir.join("extensions"))
}

fn enabled_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app data 目录：{e}"))?;
    Ok(dir.join("extensions_state.json"))
}

fn load_enabled_state(app: &tauri::AppHandle) -> HashMap<String, bool> {
    let p = match enabled_state_path(app) {
        Ok(p) => p,
        Err(_) => return HashMap::new(),
    };
    if !p.is_file() {
        return HashMap::new();
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_enabled_state(app: &tauri::AppHandle, map: &HashMap<String, bool>) -> Result<(), String> {
    let p = enabled_state_path(app)?;
    let text = serde_json::to_string(map).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| e.to_string())
}

/// 在 Windows 上隐藏子进程控制台窗口（同 ffmpeg.rs）
fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// ---- 发现与启动 ----

/// 扫描 extensions/ 目录，填充状态，并（异步）拉起已启用扩展的引擎。
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.manage(ExtState::default());
    if let Err(e) = load_extensions(app) {
        eprintln!("[ext] 加载扩展失败：{e}");
    }
    register_hotkeys(app);
    Ok(())
}

fn load_extensions(app: &tauri::AppHandle) -> Result<(), String> {
    let base = ext_base_dir(app)?;
    let _ = std::fs::create_dir_all(&base);
    let enabled = load_enabled_state(app);

    let mut map: HashMap<String, ExtEntry> = HashMap::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let manifest_path = p.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let text = match std::fs::read_to_string(&manifest_path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let manifest: ExtManifest = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[ext] 跳过 {}：manifest 解析失败（{e}）", p.display());
                continue;
            }
        };
        if manifest.id.is_empty() {
            continue;
        }
        let is_enabled = enabled.get(&manifest.id).copied().unwrap_or(true);
        let incompatible = check_host_version(&manifest.min_host_version).err();
        if let Some(reason) = &incompatible {
            eprintln!(
                "[ext] {} 与当前扩展 API 不兼容，已跳过：{reason}",
                manifest.id
            );
        }
        map.insert(
            manifest.id.clone(),
            ExtEntry {
                enabled: is_enabled,
                dir: p,
                manifest,
                port: None,
                child: None,
                incompatible,
                engine_error: None,
            },
        );
    }

    let state = app.state::<ExtState>();
    *state.map.lock().unwrap() = map;

    // 异步拉起已启用扩展的引擎，避免阻塞启动
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<String> = app2
            .state::<ExtState>()
            .map
            .lock()
            .unwrap()
            .values()
            .filter(|e| {
                e.enabled
                    && e.incompatible.is_none()
                    && wants_startup(&e.manifest.activation_events)
            })
            .map(|e| e.manifest.id.clone())
            .collect();
        for id in ids {
            if let Err(e) = spawn_engine(&app2, &id) {
                eprintln!("[ext] 启动引擎 {id} 失败：{e}");
            }
        }
    });
    Ok(())
}

/// 拉起扩展引擎，读取 stdout `READY <port>` 行，存入端口。
///
/// 外面这层负责把成功/失败**写回 ExtEntry**，让 `ext_list` 能把真实的启动失败
/// 原因带回 UI——再往里才是真正的启动逻辑。
fn spawn_engine(app: &tauri::AppHandle, id: &str) -> Result<u16, String> {
    let result = spawn_engine_inner(app, id);
    {
        let state = app.state::<ExtState>();
        // guard 必须先绑到局部变量：写成 `if let Some(..) = state.map.lock()...`
        // 时那个 MutexGuard 临时量会活到 if-let 结束，比 `state` 更晚 drop（E0597）。
        let mut map = state.map.lock().unwrap();
        if let Some(ext) = map.get_mut(id) {
            ext.engine_error = result.as_ref().err().cloned();
        }
    }
    result
}

fn spawn_engine_inner(app: &tauri::AppHandle, id: &str) -> Result<u16, String> {
    let (dir, cmd, args, support_env, ready_line) = {
        let state = app.state::<ExtState>();
        let map = state.map.lock().unwrap();
        let ext = map.get(id).ok_or_else(|| format!("扩展不存在：{id}"))?;
        let eng = ext
            .manifest
            .engines
            .as_ref()
            .ok_or_else(|| format!("扩展 {id} 没有引擎声明"))?;
        (
            ext.dir.clone(),
            eng.cmd.clone(),
            eng.args.clone(),
            eng.support_env.clone(),
            eng.ready_line.clone(),
        )
    };

    let mut exe = cmd;
    // 源码模式（cmd 以 .py 结尾）用系统 Python 解释器拉起；冻结模式直接执行。
    let is_py = exe.to_ascii_lowercase().ends_with(".py");
    if !is_py && cfg!(windows) && !exe.to_ascii_lowercase().ends_with(".exe") {
        exe.push_str(".exe");
    }
    let program = dir.join(&exe);
    if !program.is_file() {
        return Err(format!("引擎可执行文件未找到：{}", program.display()));
    }
    let py = if is_py { resolve_python() } else { None };
    if is_py && py.is_none() {
        return Err("未找到可用的 Python 解释器（python/python3/py）".into());
    }
    let data_dir = dir.join("data");
    let _ = std::fs::create_dir_all(&data_dir);

    let mut c = match &py {
        Some(interpreter) => {
            let mut cmd = command(Path::new(interpreter));
            cmd.arg(&program);
            cmd
        }
        None => command(&program),
    };
    c.args(&args)
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(env) = &support_env {
        c.env(env, &data_dir);
    }
    let mut child = c.spawn().map_err(|e| format!("启动扩展引擎失败：{e}"))?;

    let port = read_ready_port(child.stdout.take(), Duration::from_secs(20), ready_line)?;

    let state = app.state::<ExtState>();
    let mut map = state.map.lock().unwrap();
    if let Some(ext) = map.get_mut(id) {
        ext.child = Some(child);
        ext.port = Some(port);
    }
    Ok(port)
}

/// 在 PATH 中探测可用的 Python 解释器（源码模式引擎用）。
fn resolve_python() -> Option<String> {
    for p in ["python", "python3", "py"] {
        let ok = command(Path::new(p))
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(p.to_string());
        }
    }
    None
}

/// 按 manifest 声明的 `readyLine` 匹配引擎 stdout 的一行，取出端口。
///
/// 默认模式是 `"READY <port>"`。此前 `readyLine` 是**声明了但没人读**的装饰字段，
/// 现在真的生效：模式按空白切段，`<port>` 那段解析为 u16。
/// 这让引擎可以用任意就绪行（如 `"listening on <port>"`），
/// 也让 miaohui 那种与默认一致的声明变成**显式契约**而不是巧合。
pub fn parse_ready_line(line: &str, pattern: Option<&str>) -> Option<u16> {
    let pattern = pattern.unwrap_or("READY <port>");
    let pat: Vec<&str> = pattern.split_whitespace().collect();
    let parts: Vec<&str> = line.split_whitespace().collect();
    if pat.is_empty() || pat.len() != parts.len() {
        return None;
    }
    let mut port = None;
    for (p, v) in pat.iter().zip(parts.iter()) {
        if *p == "<port>" {
            port = v.parse::<u16>().ok();
        } else if p != v {
            return None;
        }
    }
    port
}

/// 扫描引擎 stdout，返回首个匹配 `readyLine` 的端口（超时则失败，不阻塞启动）。
///
/// 注意是**扫描**而不是只读第一行：引擎完全可能在就绪前先打印日志。
fn read_ready_port(
    stdout: Option<impl std::io::Read + Send + 'static>,
    timeout: Duration,
    pattern: Option<String>,
) -> Result<u16, String> {
    let stdout = stdout.ok_or_else(|| "引擎 stdout 未捕获".to_string())?;
    let (tx, rx) = mpsc::channel::<u16>();
    std::thread::spawn(move || {
        let mut line = String::new();
        let mut reader = BufReader::new(stdout);
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            if let Some(port) = parse_ready_line(line.trim(), pattern.as_deref()) {
                let _ = tx.send(port);
                break;
            }
        }
    });
    rx.recv_timeout(timeout)
        .map_err(|_| "等待扩展引擎就绪超时".to_string())
}

fn stop_engine(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<ExtState>();
    let mut map = state.map.lock().unwrap();
    if let Some(ext) = map.get_mut(id) {
        if let Some(mut child) = ext.child.take() {
            let _ = child.kill();
        }
        ext.port = None;
    }
}

// ---- 命令 ----

/// 列出已安装扩展
#[tauri::command]
pub fn ext_list(app: tauri::AppHandle) -> Vec<ExtInfo> {
    let state = app.state::<ExtState>();
    let map = state.map.lock().unwrap();
    map.values().map(ExtEntry::info).collect()
}

/// 最近一次的扩展导航目标（扩展窗口前端**挂载时主动拉取**）。
///
/// 见 `ExtState::last_nav` 的注释：新建窗口时 `emit` 早于前端 `listen`，
/// 事件会丢；靠这一拉把「窗口已打开但停空白页」这个竞态彻底消掉。
#[tauri::command]
pub fn ext_current_nav(app: tauri::AppHandle) -> Option<Value> {
    let state = app.state::<ExtState>();
    let nav = state.last_nav.lock().unwrap().clone();
    nav.map(|(ext, route)| json!({ "ext": ext, "route": route }))
}

/// 读取某个扩展的完整 manifest。
/// 前端用它取 `web.defaultRoute`（默认路由）、`permissions`（权限展示）、
/// `contributes.settings.schema`（设置面板），不必把这些再复制进 ExtInfo。
#[tauri::command]
pub fn ext_get(app: tauri::AppHandle, id: String) -> Option<ExtManifest> {
    let state = app.state::<ExtState>();
    let map = state.map.lock().unwrap();
    map.get(&id).map(|e| e.manifest.clone())
}

/// 安装扩展（folder / zip / url）。校验 manifest 后置入 extensions/<id>/。
#[tauri::command]
pub async fn ext_install(app: tauri::AppHandle, source: ExtSource) -> Result<ExtInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = ext_base_dir(&app)?;
        let _ = std::fs::create_dir_all(&base);
        let staging = base.join("__staging");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

        match source.kind.as_str() {
            "folder" => {
                let p = source.path.ok_or("缺少路径")?;
                copy_dir(Path::new(&p), &staging)?;
            }
            "zip" => {
                let p = source.path.ok_or("缺少路径")?;
                unzip_to(Path::new(&p), &staging)?;
            }
            "url" => {
                let u = source.url.ok_or("缺少 URL")?;
                let tmp = base.join("__download.zip");
                let _ = std::fs::remove_file(&tmp);
                let resp = reqwest::blocking::Client::new()
                    .get(&u)
                    .timeout(Duration::from_secs(120))
                    .send()
                    .map_err(|e| e.to_string())?;
                let bytes = resp.bytes().map_err(|e| e.to_string())?;
                std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
                unzip_to(&tmp, &staging)?;
                let _ = std::fs::remove_file(&tmp);
            }
            _ => return Err("不支持的安装来源".into()),
        }

        // 校验 manifest
        let manifest_path = staging.join("manifest.json");
        if !manifest_path.is_file() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("扩展包缺少 manifest.json".into());
        }
        let text = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let manifest: ExtManifest =
            serde_json::from_str(&text).map_err(|e| format!("manifest 解析失败：{e}"))?;
        if manifest.id.is_empty() {
            return Err("manifest 缺少 id".into());
        }
        // 版本校验放在**落盘之前**：装了也跑不起来的包，不如当场拒绝。
        if let Err(reason) = check_host_version(&manifest.min_host_version) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("扩展要求更高的扩展 API 版本：{reason}"));
        }

        // ---- 事务化换入 ----
        //
        // 旧实现是「先删旧目录再 rename」，rename 失败或新包有问题就直接丢数据。
        // 这里改成三步：旧目录先改名让位 → 新目录就位 → 才真正删掉旧的。
        // 与 skin.rs 的 stage → commit → abort 是同一套思路。
        let dest = base.join(&manifest.id);
        let backup = base.join(format!("__backup_{}", manifest.id));
        let _ = std::fs::remove_dir_all(&backup);
        if dest.exists() {
            std::fs::rename(&dest, &backup).map_err(|e| format!("暂存旧版本失败：{e}"))?;
        }
        if let Err(e) = std::fs::rename(&staging, &dest) {
            // 换入失败：把旧版本放回去，别把用户装好的扩展弄丢
            if backup.exists() {
                let _ = std::fs::rename(&backup, &dest);
            }
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("换入扩展目录失败：{e}"));
        }
        let _ = std::fs::remove_dir_all(&backup);

        load_extensions(&app)?;

        let state = app.state::<ExtState>();
        let map = state.map.lock().unwrap();
        let ext = map.get(&manifest.id).ok_or("安装后未找到扩展")?;
        Ok(ext.info())
    })
    .await
    .map_err(|e| format!("安装扩展失败：{e}"))
    .and_then(|r| r)
}

/// 卸载扩展：停引擎 + 删目录
#[tauri::command]
pub async fn ext_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_engine(&app, &id);
        let base = ext_base_dir(&app)?;
        let dir = base.join(&id);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        let state = app.state::<ExtState>();
        state.map.lock().unwrap().remove(&id);
        Ok(())
    })
    .await
    .map_err(|e| format!("卸载扩展失败：{e}"))
    .and_then(|r| r)
}

/// 启用 / 禁用扩展（持久化），并相应拉起 / 停止引擎
#[tauri::command]
pub async fn ext_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        {
            let state = app.state::<ExtState>();
            let mut map = state.map.lock().unwrap();
            let ext = map.get_mut(&id).ok_or("扩展不存在")?;
            ext.enabled = enabled;
        }
        let mut en = load_enabled_state(&app);
        en.insert(id.clone(), enabled);
        save_enabled_state(&app, &en)?;
        if enabled {
            if let Err(e) = spawn_engine(&app, &id) {
                eprintln!("[ext] 启动引擎失败：{e}");
            }
        } else {
            stop_engine(&app, &id);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("设置扩展启用状态失败：{e}"))
    .and_then(|r| r)
}

/// 通用路由：把调用转发到扩展引擎的 localhost HTTP。
#[tauri::command]
pub async fn ext_invoke(
    app: tauri::AppHandle,
    id: String,
    method: String,
    payload: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 权限门：manifest 里声明的权限在这里**真的生效**（不再是装饰字段）。
        let (manifest, port) = {
            let state = app.state::<ExtState>();
            let map = state.map.lock().unwrap();
            let ext = map.get(&id).ok_or_else(|| format!("扩展不存在：{id}"))?;
            (ext.manifest.clone(), ext.port)
        };
        if !permitted(&manifest, PERM_INVOKE) {
            return Err(format!(
                "扩展 {id} 未声明 {PERM_INVOKE} 权限，拒绝 {method}"
            ));
        }
        // 高权限动作由主机代执行（方案书 §1.4）：open/reveal 不转发给引擎
        if method == "open" || method == "reveal" {
            if !permitted(&manifest, PERM_OPEN) {
                return Err(format!("扩展 {id} 未声明 {PERM_OPEN} 权限，拒绝 {method}"));
            }
            let path = payload
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let ts = payload.get("ts").and_then(|v| v.as_f64());
            let reveal = method == "reveal"
                || payload
                    .get("reveal")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            return ext_open_impl(&app, &path, ts, reveal).map(|_| json!({ "ok": true }));
        }
        let port = match port {
            Some(p) => p,
            None => spawn_engine(&app, &id).map_err(|e| format!("扩展引擎未就绪：{e}"))?,
        };
        let url = format!("http://127.0.0.1:{port}/{method}");
        let client = reqwest::blocking::Client::new();
        let resp = client
            .post(&url)
            .json(&payload)
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(|e| format!("调用扩展引擎失败：{e}"))?;
        resp.json::<Value>()
            .map_err(|e| format!("扩展引擎返回非 JSON：{e}"))
    })
    .await
    .map_err(|e| format!("扩展调用异常：{e}"))
    .and_then(|r| r)
}

// ---- 窗口 / 热键 / 托盘（主机代注册）----

/// 打开（或聚焦）扩展窗口。扩展窗口为单一共享窗口 label="extension"，
/// 由前端 ExtensionHost 监听 `ext:navigate` 事件按 ext/route 渲染。
/// 注意：窗口创建必须经 spawn_blocking 脱离主线程，否则与 novel_auth.rs
/// 同款主线程嵌套死锁。
pub fn open_extension_window(
    app: &tauri::AppHandle,
    ext_id: &str,
    route: &str,
) -> tauri::Result<()> {
    // 先把导航目标记下来，再动窗口。
    // 顺序很重要：必须早于 emit，否则前端拉到的还是上一次的目标。
    {
        let state = app.state::<ExtState>();
        *state.last_nav.lock().unwrap() = Some((ext_id.to_string(), route.to_string()));
    }

    // 这里**刻意不预热引擎**。原先调过 `ensure_engine`，两个问题：
    //   1) 它要等 `READY <port>` 握手（最长 20 秒），按热键到窗口出现会卡住十几秒；
    //   2) 它与前端挂载后的首次 `ext_invoke` 并发，两者都会看到 `port == None`
    //      而各拉起一个引擎 —— 后一个 `Child` 覆盖前一个，前一个**不会被 kill**，泄漏进程。
    // 懒启动交给唯一一条路径：`ext_invoke` 发现没有端口就先 `spawn_engine` 再转发。

    // 先取 manifest 快照再动窗口：持锁做窗口操作极易与主线程互等（见文件头注释）。
    let (pref, ext_name) = {
        let state = app.state::<ExtState>();
        let map = state.map.lock().unwrap();
        match map.get(ext_id) {
            Some(e) => (window_pref(&e.manifest, route), e.manifest.name.clone()),
            None => (None, ext_id.to_string()),
        }
    };
    let product = app.package_info().name.clone();
    let title = match &pref {
        Some(p) if !p.title.is_empty() => format!("{product} · {}", p.title),
        _ => format!("{product} · {ext_name}"),
    };

    if let Some(win) = app.get_webview_window("extension") {
        let _ = win.show();
        let _ = win.unminimize();
        // 共享窗口：每次导航都把「可运行时修改」的偏好重新套用一遍
        let _ = win.set_title(title.as_str());
        if let Some(p) = &pref {
            if let (Some(w), Some(h)) = (p.width, p.height) {
                let _ = win.set_size(LogicalSize::new(w as f64, h as f64));
            }
            let _ = win.set_always_on_top(p.always_on_top);
        }
        let _ = win.set_focus();
        let _ = app.emit_to(
            "extension",
            "ext:navigate",
            json!({ "ext": ext_id, "route": route }),
        );
        return Ok(());
    }

    // 窗口共享且只创建一次：`decorations` 这类只能在创建时定的参数，
    // 取**本次导航**那个扩展的声明（缺省回落到内置默认值）。
    let (width, height, decorations, always_on_top) = match &pref {
        Some(p) => (
            p.width.unwrap_or(760) as f64,
            p.height.unwrap_or(520) as f64,
            p.decorations,
            p.always_on_top,
        ),
        None => (760.0, 520.0, false, true),
    };
    let _win = WebviewWindowBuilder::new(
        app,
        "extension",
        WebviewUrl::App(PathBuf::from("/index.html")),
    )
    .title(title)
    .inner_size(width, height)
    .minimizable(false)
    .resizable(true)
    .decorations(decorations)
    .always_on_top(always_on_top)
    .build()?;
    let _ = app.emit_to(
        "extension",
        "ext:navigate",
        json!({ "ext": ext_id, "route": route }),
    );
    Ok(())
}

/// 切换扩展窗口（已可见则关闭）
pub fn toggle_extension_window(
    app: &tauri::AppHandle,
    ext_id: &str,
    route: &str,
) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("extension") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.close();
            return Ok(());
        }
    }
    open_extension_window(app, ext_id, route)
}

/// 注册所有已启用扩展声明的热键（主机代注册，扩展不直接拿权限）
fn register_hotkeys(app: &tauri::AppHandle) {
    let mut regs: Vec<(String, String, String)> = Vec::new(); // (ext_id, route, accelerator)
    {
        let state = app.state::<ExtState>();
        let map = state.map.lock().unwrap();
        for e in map.values() {
            if !e.enabled {
                continue;
            }
            if let Some(c) = &e.manifest.contributes {
                for h in &c.hotkeys {
                    regs.push((
                        e.manifest.id.clone(),
                        h.route.clone(),
                        h.accelerator.clone(),
                    ));
                }
            }
        }
    }
    for (ext_id, route, accel) in regs {
        let shortcut: Shortcut = match accel.parse() {
            Ok(s) => s,
            Err(_) => {
                eprintln!("[ext] 热键解析失败，跳过：{accel}");
                continue;
            }
        };
        if let Err(err) = app
            .global_shortcut()
            .on_shortcut(shortcut, move |a, _sc, ev| {
                if ev.state == ShortcutState::Pressed {
                    let app3 = a.clone();
                    let ext = ext_id.clone();
                    let rt = route.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let _ = toggle_extension_window(&app3, &ext, &rt);
                    });
                }
            })
        {
            eprintln!("[ext] 注册热键失败 {accel}：{err}");
        }
    }
}

/// 收集托盘菜单项：(menu_id, title)，menu_id 形如 `ext:<ext_id>:<item_id>`
pub fn tray_menu_items(app: &tauri::AppHandle) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let state = app.state::<ExtState>();
    let map = state.map.lock().unwrap();
    for e in map.values() {
        if !e.enabled {
            continue;
        }
        if let Some(c) = &e.manifest.contributes {
            for t in &c.tray {
                out.push((format!("ext:{}:{}", e.manifest.id, t.id), t.title.clone()));
            }
        }
    }
    out
}

/// 处理托盘菜单事件（解析 `ext:<ext_id>:<item_id>`）
pub fn handle_tray_event(app: &tauri::AppHandle, id: &str) {
    let Some(rest) = id.strip_prefix("ext:") else {
        return;
    };
    let Some((ext_id, item_id)) = rest.split_once(':') else {
        return;
    };
    let action = {
        let state = app.state::<ExtState>();
        let map = state.map.lock().unwrap();
        map.get(ext_id)
            .and_then(|e| e.manifest.contributes.as_ref())
            .and_then(|c| c.tray.iter().find(|t| t.id == item_id))
            .map(|t| t.action.clone())
    };
    if let Some(action) = action {
        if let Some(route) = action.strip_prefix("open:") {
            let app2 = app.clone();
            let ext = ext_id.to_string();
            let rt = route.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = open_extension_window(&app2, &ext, &rt);
            });
        } else if let Some(method) = action.strip_prefix("invoke:") {
            let app2 = app.clone();
            let ext = ext_id.to_string();
            let m = method.to_string();
            tauri::async_runtime::spawn(async move {
                let _ = ext_invoke(app2, ext, m, Value::Null).await;
            });
        }
    }
}

// ---- 扩展提供的皮肤 ----

/// 查一个扩展声明的一款皮肤，返回 `(扩展目录, 主题声明)`。
fn find_theme(
    app: &tauri::AppHandle,
    ext_id: &str,
    theme_id: &str,
) -> Result<(PathBuf, ExtTheme), String> {
    let state = app.state::<ExtState>();
    let map = state.map.lock().unwrap();
    let ext = map
        .get(ext_id)
        .ok_or_else(|| format!("扩展不存在：{ext_id}"))?;
    let theme = ext
        .manifest
        .contributes
        .as_ref()
        .and_then(|c| c.themes.iter().find(|t| t.id == theme_id))
        .cloned()
        .ok_or_else(|| format!("扩展 {ext_id} 未声明皮肤 {theme_id}"))?;
    Ok((ext.dir.clone(), theme))
}

/// 列出所有**已启用**扩展声明为皮肤的条目。
///
/// 皮肤功能已改由扩展承载（设置页不再管理皮肤库），所以这里是前端拿皮肤的
/// 唯一入口。
#[tauri::command]
pub fn ext_themes(app: tauri::AppHandle) -> Vec<Value> {
    let state = app.state::<ExtState>();
    let map = state.map.lock().unwrap();
    let mut out = Vec::new();
    for e in map.values() {
        if !e.enabled || e.incompatible.is_some() {
            continue;
        }
        let Some(c) = &e.manifest.contributes else {
            continue;
        };
        for t in &c.themes {
            // dir = skin.json 所在目录（素材引用以它为基准）
            let dir = Path::new(&t.path)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            // absDir 由**宿主**算出来。不把 app_data 目录布局算两遍是仓库既有约定
            // （见 commands/host.rs 关于 host_path 的说明：两侧各算一次必然漂移）。
            let abs_dir = e.dir.join(&dir);
            out.push(json!({
                "extId": e.manifest.id,
                "id": t.id,
                "name": t.name,
                "path": t.path,
                "dir": dir,
                "absDir": abs_dir.to_string_lossy(),
            }));
        }
    }
    out
}

/// 读取某款扩展皮肤：skin.json 原文 + 该主题目录下的文件清单。
///
/// 返回的 `dir` / `files` 都是**扩展根目录相对路径**，前端据此拼出
/// `ext:` 协议的取图地址（基准是主题目录本身）。
/// 校验交给前端既有的 `skinSchema.ts`，这里只做可信 IO —— 与 `skin.rs` 分工一致。
#[tauri::command]
pub fn ext_theme_load(
    app: tauri::AppHandle,
    ext_id: String,
    theme_id: String,
) -> Result<Value, String> {
    let (ext_dir, theme) = find_theme(&app, &ext_id, &theme_id)?;

    // 防穿越：path 必须是**扩展根内的相对路径**。扩展包是用户自己装的，
    // 但一个手滑写成 "../../.." 的 manifest 不该能读到扩展目录之外。
    let rel = Path::new(&theme.path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("皮肤路径不合法：{}", theme.path));
    }
    let skin_path = ext_dir.join(rel);
    if !skin_path.is_file() {
        return Ok(json!({ "json": Value::Null, "dir": Value::Null, "files": [] }));
    }

    let json_text = std::fs::read_to_string(&skin_path).map_err(|e| e.to_string())?;
    let theme_dir = skin_path.parent().unwrap_or(&ext_dir);

    // ⚠️ files 的基准必须是**主题目录本身**，不是扩展根目录。
    //
    // 前端既有的校验器（src/utils/skinSchema.ts）拿 skin.json 里的相对引用
    // （如 "assets/bg.png"）**直接与 files 逐条比对**，它假定基准 = skin.json
    // 所在目录 —— 这正是 skin.rs 的 `skin_load` 的口径（list_files_recursively
    // 以皮肤目录为 base）。
    //
    // 曾经这里传的是扩展根目录，得到 "themes/sakura/assets/bg.png"，
    // 与 "assets/bg.png" 字符串对不上，导致 **v2 皮肤全部校验失败**。
    // 同一份文件两套基准是这里唯一的坑，改这个参数前先看一眼上面这段。
    let mut files = Vec::new();
    collect_files(theme_dir, theme_dir, &mut files);

    let dir_rel = theme_dir
        .strip_prefix(&ext_dir)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    // absDir 是皮肤引擎的**基准目录**：skin.json 里对素材的引用（如 assets/bg.png）
    // 都是相对它解析的。由宿主给出，前端不自行拼接应用数据目录。
    Ok(json!({
        "json": json_text,
        "dir": dir_rel,
        "absDir": theme_dir.to_string_lossy(),
        "files": files,
    }))
}

/// 递归收集 `cur` 下的文件，路径相对 `base`（斜杠统一，跳过隐藏项）。
///
/// 隐藏文件不列入 —— 与 `skin.rs` 的 `list_files_recursively` 保持一致
/// （那里跳过 `.staging` 之类的隐藏目录，避免把非资产文件算进皮肤包）。
fn collect_files(base: &Path, cur: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(cur) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        if p.is_dir() {
            collect_files(base, &p, out);
        } else if p.is_file() {
            if let Ok(rel) = p.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

// ---- 打开 / 视频跳秒（主机代执行，扩展不直接持有权限）----

const VIDEO_EXTS: &[&str] = &[
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".flv", ".wmv", ".3gp", ".mpg", ".mpeg", ".ts",
];

#[cfg(windows)]
fn player_candidates() -> Vec<PathBuf> {
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    [
        format!(r"{pf}\mpv\mpv.exe"),
        format!(r"{pf86}\mpv\mpv.exe"),
        format!(r"{local}\Programs\mpv\mpv.exe"),
        r"C:\PotPlayer\PotPlayerMini64.exe".to_string(),
        format!(r"{pf}\PotPlayer\PotPlayerMini64.exe"),
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(not(windows))]
fn player_candidates() -> Vec<PathBuf> {
    // macOS/Linux 常见安装路径
    [
        "/Applications/mpv.app/Contents/MacOS/mpv",
        "/usr/bin/mpv",
        "/usr/local/bin/mpv",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

fn is_video(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    VIDEO_EXTS.iter().any(|e| lower.ends_with(e))
}

/// 打开文件；视频带 ts 时优先 mpv `--start=` / PotPlayer `/seek=`（精确跳秒），
/// 找不到外置播放器则交给系统默认程序。reveal=true 在文件管理器中定位。
fn ext_open_impl(
    app: &tauri::AppHandle,
    path: &str,
    ts: Option<f64>,
    reveal: bool,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("缺少 path".into());
    }
    use tauri_plugin_opener::OpenerExt;
    let opener = app.opener();
    if reveal {
        return opener
            .reveal_item_in_dir(path)
            .map_err(|e| format!("定位文件失败：{e}"));
    }
    if is_video(path) {
        if let Some(ts) = ts {
            for cand in player_candidates() {
                if !cand.is_file() {
                    continue;
                }
                let name = cand.to_string_lossy().to_ascii_lowercase();
                // mpv: --start=<秒> <file>；PotPlayer: <file> /seek=<hhmmss>
                let seek_args: Vec<String> = if name.contains("mpv") {
                    vec![format!("--start={}", ts as i64), path.to_string()]
                } else if name.contains("potplayer") {
                    vec![path.to_string(), format!("/seek={:06}", ts as i64)]
                } else {
                    continue;
                };
                // 播放器需要弹出可见窗口，绝不能带 CREATE_NO_WINDOW
                #[cfg(windows)]
                let mut c = Command::new(&cand);
                #[cfg(not(windows))]
                let mut c = command(&cand);
                c.args(&seek_args);
                if c.spawn().is_ok() {
                    return Ok(());
                }
            }
        }
    }
    opener
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开文件失败：{e}"))
}

/// 供扩展前端直接调用（也可经 ext_invoke("open") 走主机代执行）。
#[tauri::command]
pub async fn ext_open(
    app: tauri::AppHandle,
    path: String,
    ts: Option<f64>,
    reveal: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ext_open_impl(&app, &path, ts, reveal.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("打开文件异常：{e}"))
    .and_then(|r| r)
}

// ---- 文件工具 ----

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let ft = e.file_type().map_err(|e| e.to_string())?;
        let sp = e.path();
        let dp = dst.join(e.file_name());
        if ft.is_dir() {
            copy_dir(&sp, &dp)?;
        } else if ft.is_file() {
            std::fs::copy(&sp, &dp).map_err(|e| e.to_string())?;
        }
        // 符号链接跳过
    }
    Ok(())
}

// ---- 解包与拷贝的防护参数 ----
//
// 照 skin.rs 的口径（条目 ≤ 200 / 总量 ≤ 50MB）。扩展包要带引擎，
// 所以总量放宽到 1GB，但**条目数与单文件仍然设限**——否则一个 zip bomb
// 就能把用户磁盘写满。
const ZIP_MAX_ENTRIES: usize = 5000;
const ZIP_MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const ZIP_MAX_FILE: u64 = 256 * 1024 * 1024;

fn unzip_to(src: &Path, dst: &Path) -> Result<(), String> {
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(format!(
            "扩展包条目过多（{} > {ZIP_MAX_ENTRIES}）",
            archive.len()
        ));
    }

    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // `enclosed_name` 已屏蔽 `..` 与绝对路径（防 zip-slip）
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("扩展包含非法路径：{}", entry.name()));
        };
        let size = entry.size();
        if size > ZIP_MAX_FILE {
            return Err(format!("扩展包内单文件过大：{}", rel.display()));
        }
        total = total.saturating_add(size);
        if total > ZIP_MAX_TOTAL {
            return Err("扩展包解压后总量超出上限".into());
        }

        let out = dst.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
    }
    Ok(())
}
