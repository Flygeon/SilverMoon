//! 桌面环境集成：壁纸 / 常亮锁（防休眠）/ 系统通知 / 系统强调色。
//!
//! 经 **UDA（UniDesktop API）v0.2.0** 实现。之所以不直接调各平台 API：这四项
//! 能力在 Linux 上按桌面环境分裂成 gsettings / plasmashell / hyprpaper / swww /
//! feh，Windows 上又是另一套 Win32 / WinRT，且各自的失败模式不同；UDA 用一套
//! 能力驱动的 Rust trait 统一，并给出能力位让前端**在出错之前**分流。
//!
//! # 平台覆盖
//!
//! UDA 只做 Linux 与 Windows。macOS 走下面的 `unsupported` 分支：命令照常存在、
//! 返回明确错误，而不是编译失败或静默空操作——这样前端 `safeInvoke` 的降级链
//! 与浏览器预览模式的行为一致。
//!
//! # 常亮锁为什么用「理由集合」而不是多个句柄
//!
//! Windows 侧 `SetThreadExecutionState` 是**进程级**状态、每次调用覆盖前值，
//! UDA 因此同时只暴露一把锁；Linux 侧每把锁都是一个 D-Bus cookie。若允许多个
//! 句柄并存，Windows 上后申请的会静默顶掉先申请的，Linux 上则会堆积 cookie。
//! 因此本模块只持有**一把**锁，由「活跃理由集合」是否为空决定取/放，
//! 与 UDA 文档的建议一致（不要在回调里反复申请而不释放）。
//!
//! 另注：锁由本 sidecar 进程持有，进程退出即释放。

use std::sync::Mutex;

use serde::Serialize;

/// 通知里显示的应用名。
const APP_NAME: &str = "SilverMoon";

/// 壁纸填充模式（前端传字符串，先在这里收敛成枚举，避免拼错直达后端）。
enum FillModeArg {
    Crop,
    Fill,
    Fit,
    Stretch,
}

impl FillModeArg {
    fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("fill").trim().to_ascii_lowercase().as_str() {
            "crop" => Self::Crop,
            "fit" => Self::Fit,
            "stretch" => Self::Stretch,
            _ => Self::Fill,
        }
    }
}

/// 通知紧急程度。
enum UrgencyArg {
    Low,
    Normal,
    Critical,
}

impl UrgencyArg {
    fn parse(value: Option<u8>) -> Self {
        match value.unwrap_or(1) {
            0 => Self::Low,
            2 => Self::Critical,
            _ => Self::Normal,
        }
    }
}

/// 常亮锁类型。
#[derive(Clone, Copy, PartialEq, Eq)]
enum WakeLockKind {
    /// 只阻止熄屏，系统仍可空闲挂起。
    Display,
    /// 同时阻止系统空闲判定与自动挂起。
    System,
}

impl WakeLockKind {
    fn parse(value: Option<&str>) -> Self {
        match value
            .unwrap_or("system")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "display" => Self::Display,
            _ => Self::System,
        }
    }
}

/// 当前平台的桌面集成能力。启动时拉一次，用于决定入口显隐。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    /// linux / windows / unsupported
    pub platform: String,
    /// 该平台是否有 UDA 后端
    pub supported: bool,
    pub set_wallpaper: bool,
    pub get_wallpaper: bool,
    pub send_notification: bool,
    pub wake_lock: bool,
    pub read_accent_color: bool,
}

// ---------------------------------------------------------------------------
// 平台实现
//
// 三个分支导出同一组函数签名，命令层因此不含任何 `#[cfg]`。
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod imp {
    use uda_core::capability::{Capability, CapabilityMatrix, RgbaColor};
    use uda_core::error::UdaError;
    use uda_core::notification::{Notification, NotificationManager, Urgency};
    use uda_core::wakelock::WakeLockType;
    use uda_core::wallpaper::{FillMode, WallpaperManager, WallpaperOptions};
    use uda_core::{appearance::AppearanceManager, wakelock::WakeLockManager};
    use uda_platform_linux::appearance::LinuxAppearanceManager;
    use uda_platform_linux::notification::LinuxNotificationManager;
    use uda_platform_linux::wakelock::LinuxWakeLockManager;
    use uda_platform_linux::wallpaper::LinuxWallpaperManager;

    use super::{Caps, FillModeArg, UrgencyArg, WakeLockKind, APP_NAME};

    pub const WAKE_LOCK_AVAILABLE: bool = true;

    fn has(caps: &Result<Capability, UdaError>, bit: u32) -> bool {
        caps.as_ref()
            .map(|c| c.contains(Capability::from_bits_truncate(bit)))
            .unwrap_or(false)
    }

    fn fill_mode(mode: FillModeArg) -> FillMode {
        match mode {
            FillModeArg::Crop => FillMode::Crop,
            FillModeArg::Fill => FillMode::Fill,
            FillModeArg::Fit => FillMode::Fit,
            FillModeArg::Stretch => FillMode::Stretch,
        }
    }

    pub async fn capabilities() -> Caps {
        let wallpaper = LinuxWallpaperManager.capabilities();
        let accent = LinuxAppearanceManager.capabilities();
        // Linux 的通知能力取决于通知守护进程是否在跑：连不上会话总线或
        // 没有守护进程时按不可用上报，让前端隐藏入口而不是点了没反应。
        let notify = LinuxNotificationManager::new().await;

        Caps {
            platform: "linux".into(),
            supported: true,
            set_wallpaper: has(&wallpaper, CapabilityMatrix::SET_WALLPAPER),
            get_wallpaper: has(&wallpaper, CapabilityMatrix::GET_WALLPAPER),
            send_notification: match &notify {
                Ok(manager) => has(&manager.capabilities(), CapabilityMatrix::SEND_NOTIFICATION),
                Err(_) => false,
            },
            // WakeLockManager 没有 capabilities()；Wayland 平铺 WM 上
            // ScreenSaver 服务可能缺失，那时取锁才会失败。
            wake_lock: WAKE_LOCK_AVAILABLE,
            read_accent_color: has(&accent, CapabilityMatrix::READ_ACCENT_COLOR),
        }
    }

    pub fn set_wallpaper(path: &str, mode: FillModeArg, dark: bool) -> Result<(), String> {
        let options = WallpaperOptions {
            fill_mode: fill_mode(mode),
            monitor_index: None,
            dark_mode: dark,
        };
        LinuxWallpaperManager
            .set_wallpaper(path, &options)
            .map_err(|e| e.to_string())
    }

    pub fn get_wallpaper() -> Result<Option<String>, String> {
        LinuxWallpaperManager
            .get_wallpaper()
            .map_err(|e| e.to_string())
    }

    pub fn accent_color() -> Result<Option<[u8; 4]>, String> {
        // 平台没有系统强调色是**正常状态**（KDE / XFCE / 平铺 WM 常见），
        // 返回 None 由前端回落到固定种子色，而不是抛错。
        match LinuxAppearanceManager.get_accent_color() {
            Ok(RgbaColor { r, g, b, a }) => Ok(Some([r, g, b, a])),
            Err(_) => Ok(None),
        }
    }

    pub async fn acquire_wakelock(
        kind: WakeLockKind,
        reason: &str,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        let manager = LinuxWakeLockManager::new()
            .await
            .map_err(|e| format!("无法连接会话总线（常亮锁不可用）：{e}"))?;
        let lock_type = match kind {
            WakeLockKind::Display => WakeLockType::PreventDisplaySleep,
            WakeLockKind::System => WakeLockType::PreventSystemIdle,
        };
        let guard = manager
            .acquire(lock_type, reason)
            .await
            .map_err(|e| format!("申请常亮锁失败：{e}"))?;
        // WakeLockGuard 消费自身释放；装箱成统一的可调用对象，
        // 让平台间的类型差异不泄漏到命令层。
        Ok(Box::new(move || guard.release()))
    }

    pub async fn send_notification(
        title: &str,
        body: &str,
        icon: &str,
        urgency: UrgencyArg,
    ) -> Result<u32, String> {
        let manager = LinuxNotificationManager::new()
            .await
            .map_err(|e| format!("通知守护进程不可用：{e}"))?;
        let mut notification = Notification {
            app_name: APP_NAME.into(),
            summary: title.into(),
            body: body.into(),
            app_icon: icon.into(),
            ..Default::default()
        };
        notification.urgency = match urgency {
            UrgencyArg::Low => Urgency::Low,
            UrgencyArg::Normal => Urgency::Normal,
            UrgencyArg::Critical => Urgency::Critical,
        };
        manager
            .send(&notification)
            .await
            .map_err(|e| format!("发送通知失败：{e}"))
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use uda_core::capability::{Capability, CapabilityMatrix, RgbaColor};
    use uda_core::error::UdaError;
    use uda_core::notification::{Notification, NotificationManager, Urgency};
    use uda_core::wakelock::WakeLockType;
    use uda_core::wallpaper::{FillMode, WallpaperManager, WallpaperOptions};
    use uda_core::{appearance::AppearanceManager, wakelock::WakeLockManager};
    use uda_platform_windows::appearance::WindowsAppearanceManager;
    use uda_platform_windows::notification::WindowsNotificationManager;
    use uda_platform_windows::wakelock::WindowsWakeLockManager;
    use uda_platform_windows::wallpaper::WindowsWallpaperManager;

    use super::{Caps, FillModeArg, UrgencyArg, WakeLockKind, APP_NAME};

    pub const WAKE_LOCK_AVAILABLE: bool = true;

    fn has(caps: &Result<Capability, UdaError>, bit: u32) -> bool {
        caps.as_ref()
            .map(|c| c.contains(Capability::from_bits_truncate(bit)))
            .unwrap_or(false)
    }

    fn fill_mode(mode: FillModeArg) -> FillMode {
        match mode {
            FillModeArg::Crop => FillMode::Crop,
            FillModeArg::Fill => FillMode::Fill,
            FillModeArg::Fit => FillMode::Fit,
            FillModeArg::Stretch => FillMode::Stretch,
        }
    }

    pub async fn capabilities() -> Caps {
        let wallpaper = WindowsWallpaperManager::new().capabilities();
        let accent = WindowsAppearanceManager::new().capabilities();
        let notify = WindowsNotificationManager::new().capabilities();

        Caps {
            platform: "windows".into(),
            supported: true,
            set_wallpaper: has(&wallpaper, CapabilityMatrix::SET_WALLPAPER),
            get_wallpaper: has(&wallpaper, CapabilityMatrix::GET_WALLPAPER),
            send_notification: has(&notify, CapabilityMatrix::SEND_NOTIFICATION),
            wake_lock: WAKE_LOCK_AVAILABLE,
            read_accent_color: has(&accent, CapabilityMatrix::READ_ACCENT_COLOR),
        }
    }

    pub fn set_wallpaper(path: &str, mode: FillModeArg, dark: bool) -> Result<(), String> {
        let options = WallpaperOptions {
            fill_mode: fill_mode(mode),
            monitor_index: None,
            dark_mode: dark,
        };
        WindowsWallpaperManager::new()
            .set_wallpaper(path, &options)
            .map_err(|e| e.to_string())
    }

    pub fn get_wallpaper() -> Result<Option<String>, String> {
        WindowsWallpaperManager::new()
            .get_wallpaper()
            .map_err(|e| e.to_string())
    }

    pub fn accent_color() -> Result<Option<[u8; 4]>, String> {
        match WindowsAppearanceManager::new().get_accent_color() {
            Ok(RgbaColor { r, g, b, a }) => Ok(Some([r, g, b, a])),
            Err(_) => Ok(None),
        }
    }

    pub async fn acquire_wakelock(
        kind: WakeLockKind,
        reason: &str,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        let lock_type = match kind {
            WakeLockKind::Display => WakeLockType::PreventDisplaySleep,
            WakeLockKind::System => WakeLockType::PreventSystemIdle,
        };
        let guard = WindowsWakeLockManager::new()
            .acquire(lock_type, reason)
            .await
            .map_err(|e| format!("申请常亮锁失败：{e}"))?;
        Ok(Box::new(move || guard.release()))
    }

    pub async fn send_notification(
        title: &str,
        body: &str,
        icon: &str,
        urgency: UrgencyArg,
    ) -> Result<u32, String> {
        let manager = WindowsNotificationManager::new();
        let mut notification = Notification {
            app_name: APP_NAME.into(),
            summary: title.into(),
            body: body.into(),
            app_icon: icon.into(),
            ..Default::default()
        };
        notification.urgency = match urgency {
            UrgencyArg::Low => Urgency::Low,
            UrgencyArg::Normal => Urgency::Normal,
            UrgencyArg::Critical => Urgency::Critical,
        };
        manager
            .send(&notification)
            .await
            .map_err(|e| format!("发送通知失败：{e}"))
    }
}

/// macOS 等未被 UDA 覆盖的平台：命令仍在，返回明确错误。
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod imp {
    use super::{Caps, FillModeArg, UrgencyArg, WakeLockKind};

    pub const WAKE_LOCK_AVAILABLE: bool = false;

    const UNSUPPORTED: &str = "当前平台没有 UDA 后端（仅支持 Linux / Windows）";

    pub async fn capabilities() -> Caps {
        Caps {
            platform: "unsupported".into(),
            supported: false,
            set_wallpaper: false,
            get_wallpaper: false,
            send_notification: false,
            wake_lock: false,
            read_accent_color: false,
        }
    }

    pub fn set_wallpaper(_path: &str, _mode: FillModeArg, _dark: bool) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn get_wallpaper() -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn accent_color() -> Result<Option<[u8; 4]>, String> {
        Ok(None)
    }

    pub async fn acquire_wakelock(
        _kind: WakeLockKind,
        _reason: &str,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        Err(UNSUPPORTED.into())
    }

    pub async fn send_notification(
        _title: &str,
        _body: &str,
        _icon: &str,
        _urgency: UrgencyArg,
    ) -> Result<u32, String> {
        Err(UNSUPPORTED.into())
    }
}

// ---------------------------------------------------------------------------
// 命令层
// ---------------------------------------------------------------------------

/// 当前持有的常亮锁：类型 + 活跃理由 + 释放动作。
struct WakeState {
    kind: WakeLockKind,
    reasons: Vec<String>,
    release: Option<Box<dyn FnOnce() + Send>>,
}

static WAKE: Mutex<Option<WakeState>> = Mutex::new(None);

type WakeGuard = std::sync::MutexGuard<'static, Option<WakeState>>;

fn lock_wake() -> Result<WakeGuard, String> {
    // 上一次持锁的线程 panic 会让 Mutex 中毒；常亮锁不是关键状态，
    // 清掉毒继续用，避免一次 panic 让后续所有取锁都失败。
    match WAKE.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => Ok(poisoned.into_inner()),
    }
}

/// 查询桌面集成能力。前端据此隐藏 / 置灰不支持的入口。
#[silvermoon_ipc::command]
pub async fn desktop_capabilities() -> Caps {
    imp::capabilities().await
}

/// 设置系统壁纸。
///
/// `path` 必须是**绝对路径**：UDA 不负责把相对路径解析到某个基准目录，
/// 进程工作目录一变，同一份代码的行为就会不同，所以这里先 canonicalize。
#[silvermoon_ipc::command]
pub async fn desktop_set_wallpaper(
    path: String,
    mode: Option<String>,
    dark: Option<bool>,
) -> Result<(), String> {
    let abs = std::fs::canonicalize(&path)
        .map_err(|e| format!("壁纸文件不可读：{e}"))?
        .to_string_lossy()
        .into_owned();
    let mode = FillModeArg::parse(mode.as_deref());
    let dark = dark.unwrap_or(false);
    // 壁纸后端会拉起 gsettings / hyprpaper / swww / feh 等外部命令，
    // 属于阻塞操作，放进 blocking 池避免占住异步线程。
    silvermoon_ipc::rt::spawn_blocking(move || imp::set_wallpaper(&abs, mode, dark))
        .await
        .map_err(|e| format!("设置壁纸失败：{e}"))
        .and_then(|r| r)
}

/// 读取当前系统壁纸路径（平台不支持读取时返回 null）。
#[silvermoon_ipc::command]
pub async fn desktop_get_wallpaper() -> Result<Option<String>, String> {
    silvermoon_ipc::rt::spawn_blocking(imp::get_wallpaper)
        .await
        .map_err(|e| format!("读取壁纸失败：{e}"))
        .and_then(|r| r)
}

/// 读取系统强调色 `[r, g, b, a]`，无系统强调色时返回 null。
///
/// 供动态配色的「跟随系统」种子源使用；平台没有强调色是正常状态，按 null 处理。
#[silvermoon_ipc::command]
pub async fn desktop_accent_color() -> Result<Option<[u8; 4]>, String> {
    silvermoon_ipc::rt::spawn_blocking(imp::accent_color)
        .await
        .map_err(|e| format!("读取强调色失败：{e}"))
        .and_then(|r| r)
}

/// 发送系统通知，返回平台分配的通知 id。
#[silvermoon_ipc::command]
pub async fn desktop_notify(
    title: String,
    body: Option<String>,
    icon: Option<String>,
    urgency: Option<u8>,
) -> Result<u32, String> {
    let body = body.unwrap_or_default();
    let icon = icon.unwrap_or_default();
    let urgency = UrgencyArg::parse(urgency);
    imp::send_notification(&title, &body, &icon, urgency).await
}

/// 登记一个「需要保持唤醒」的理由。
///
/// 同一理由重复登记是幂等的。锁类型从 display 切到 system（或反向）时会
/// 先释放旧锁再申请新锁。返回当前是否持有锁。
#[silvermoon_ipc::command]
pub async fn desktop_wakelock_acquire(
    reason: String,
    kind: Option<String>,
) -> Result<bool, String> {
    let kind = WakeLockKind::parse(kind.as_deref());
    if reason.trim().is_empty() {
        return Err("常亮锁需要一个 reason（会显示在系统的电源请求列表里）".into());
    }
    if !imp::WAKE_LOCK_AVAILABLE {
        return Ok(false);
    }

    // 1) 只读判断是否已有同类型的锁。
    //    注意不能跨 await 持有 std MutexGuard —— 它不是 Send，
    //    会让整个 Future 失去 Send。
    let already_held = {
        let state = lock_wake()?;
        matches!(state.as_ref(), Some(s) if s.kind == kind)
    };
    if already_held {
        let mut state = lock_wake()?;
        if let Some(s) = state.as_mut() {
            if !s.reasons.contains(&reason) {
                s.reasons.push(reason);
            }
        }
        return Ok(true);
    }

    // 2) 释放旧锁（类型不同）或确认未持锁
    {
        let mut state = lock_wake()?;
        if let Some(mut old) = state.take() {
            if let Some(release) = old.release.take() {
                release();
            }
        }
    }

    // 3) 申请新锁。失败时保持「未持锁」状态，由调用方决定是否提示。
    let release = imp::acquire_wakelock(kind, &reason).await?;

    let mut state = lock_wake()?;
    *state = Some(WakeState {
        kind,
        reasons: vec![reason],
        release: Some(release),
    });
    Ok(true)
}

/// 撤销一个「需要保持唤醒」的理由。理由集合清空时真正释放锁。
///
/// 传 `reason` 只撤销该理由；不传则**直接释放整把锁**。
/// 返回释放后是否仍持有锁。
#[silvermoon_ipc::command]
pub fn desktop_wakelock_release(reason: Option<String>) -> Result<bool, String> {
    let mut state = lock_wake()?;
    let should_release = match (&reason, state.as_mut()) {
        // 未指定理由：无条件释放
        (None, _) => true,
        // 指定理由：移除后看集合是否为空
        (Some(r), Some(s)) => {
            s.reasons.retain(|x| x != r);
            s.reasons.is_empty()
        }
        // 指定理由但当前没锁
        (Some(_), None) => false,
    };
    if should_release {
        if let Some(mut old) = state.take() {
            if let Some(release) = old.release.take() {
                release();
            }
        }
    }
    Ok(state.is_some())
}

/// 当前是否持有常亮锁，以及活跃理由（调试 / UI 状态展示用）。
#[silvermoon_ipc::command]
pub fn desktop_wakelock_status() -> Result<WakeStatus, String> {
    let state = lock_wake()?;
    Ok(match state.as_ref() {
        Some(s) => WakeStatus {
            held: true,
            kind: match s.kind {
                WakeLockKind::Display => "display".into(),
                WakeLockKind::System => "system".into(),
            },
            reasons: s.reasons.clone(),
        },
        None => WakeStatus {
            held: false,
            kind: String::new(),
            reasons: Vec::new(),
        },
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatus {
    pub held: bool,
    pub kind: String,
    pub reasons: Vec<String>,
}
