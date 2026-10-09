//! 启动动画（splash）的宿主侧：spawn + 命名管道握手。
//!
//! ## 为什么由宿主 spawn 启动器，而不是反过来
//!
//! 旧版（Electron 时代）是**启动器当父进程**：快捷方式指向启动器，它再拉起应用。
//! 那样必须改 NSIS 的快捷方式指向与安装布局 —— 是「发布版才暴露」的那类坑
//! （归档里的 pathfind.rs 就是为它写的）。
//!
//! 现在反过来：快捷方式仍然指向主程序，主程序在 run() 一开始就把启动器 spawn 出去。
//! 好处是**开发态与发布态行为一致**，且启动器缺失/启动失败时应用完全不受影响
//! （无非是没有那几秒的动画）。
//!
//! ## 握手协议（对端实现见 splash/src/handshake.rs）
//!
//!   应用 → 启动器:  READY          # 首屏已就绪，可以淡出了
//!   启动器 → 应用:  FADING:<ms>    # 我开始淡出，预计 ms 后消失
//!
//! 应用收到 FADING 后再等 <ms> 才显示主窗口，两端视觉交叠；
//! 没有启动器时就直接显示，不引入任何延迟。
//!
//! ## 为什么用 std 而不是 windows crate
//!
//! Windows 上命名管道可以用 OpenOptions::open(r"\\.\pipe\name") 当普通文件打开，
//! 读写走 Read/Write。这样宿主侧**零新增依赖**。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 首屏就绪后最多等启动器多久（毫秒）。超过就自己显示窗口，不等了。
const HANDSHAKE_TIMEOUT_MS: u64 = 3000;
/// 启动器可执行文件名。
const SPLASH_EXE: &str = "silvermoon-splash.exe";

/// 主窗口句柄（setup 时登记），供后台线程回到主线程显示窗口用。
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// 按优先级列出启动器的候选路径（**纯函数，无平台依赖，因此可单测**）。
///
/// 顺序即语义，且是**实测出来的**：
///
/// 1. exe 同目录 —— Tauri 的 NSIS 把主程序放安装根目录；若 resource 也被放到
///    这里（Windows 上 `resource_dir` 就是 exe 所在目录），启动器就在旁边；
/// 2. `resources/` 子目录 —— 部分布局下 resource 会落在子目录里；
/// 3. 开发态：`<repo>/apps/desktop/src-tauri/target/debug/silvermoon.exe`
///    → `<repo>/apps/desktop/splash/target/{release,debug}/silvermoon-splash.exe`。
///    （`cargo tauri dev` 不会跑 CI 的拷贝步骤，所以开发态必须靠这条。）
///
/// ⚠️ 这段之所以单独成函数并带单测：归档里的 `pathfind.rs` 就是为同一类缺陷写的
/// —— **打包后的相对位置与开发态不同，且只在发布版暴露**。当时靠人眼审阅漏掉了，
/// 装出来的应用直接打不开。
pub fn splash_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![
        exe_dir.join(SPLASH_EXE),
        exe_dir.join("resources").join(SPLASH_EXE),
    ];
    for up in [2usize, 3] {
        let mut base = exe_dir.to_path_buf();
        for _ in 0..up {
            match base.parent() {
                Some(p) => base = p.to_path_buf(),
                None => return out,
            }
        }
        for profile in ["release", "debug"] {
            out.push(
                base.join("splash")
                    .join("target")
                    .join(profile)
                    .join(SPLASH_EXE),
            );
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc::{channel, Sender};
    use std::time::{Duration, Instant};

    struct Link {
        /// 通知后台线程「可以报 READY 了」。
        tx: Sender<()>,
        /// 子进程句柄：只用于持有（不 kill —— 启动器淡出后自己退出）。
        _child: Child,
    }

    static LINK: Mutex<Option<Link>> = Mutex::new(None);

    /// 生成管道名（带 pid 与时间戳，避免多实例/快速重启撞名）。
    fn pipe_name() -> String {
        let pid = std::process::id();
        let tick = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!(r"\\.\pipe\silvermoon-splash-{pid}-{tick}")
    }

    /// 找启动器（候选顺序见顶层 splash_candidates 的说明）。
    fn find_splash() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        super::splash_candidates(exe.parent()?)
            .into_iter()
            .find(|p| p.is_file())
    }

    /// spawn 启动器并起后台线程连接管道。失败一律返回 false（不影响应用启动）。
    pub fn spawn() -> bool {
        let Some(splash) = find_splash() else {
            // 没装/没编启动器：完全正常的情形（干净的开发态、非 Windows 安装包）
            return false;
        };
        let name = pipe_name();
        let child = match Command::new(&splash)
            .arg(format!("--splash-pipe={name}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[splash] 拉起启动器失败：{e}");
                return false;
            }
        };

        let (tx, rx) = channel::<()>();
        *LINK.lock().unwrap() = Some(Link { tx, _child: child });

        // 后台线程：等「可以报 READY」的通知 → 连管道 → READY → 读 FADING → 等淡出 → 显示窗口。
        // 全程不碰主线程，只有最后 show 那一下通过 run_on_main_thread 回到主线程。
        std::thread::spawn(move || {
            // 等到宿主说「首屏好了」为止；宿主一直没说的话线程就自然结束
            if rx.recv().is_err() {
                return;
            }
            let fade_ms = handshake(&name).unwrap_or(0);
            if fade_ms > 0 {
                std::thread::sleep(Duration::from_millis(fade_ms));
            }
            super::reveal();
        });
        true
    }

    /// 连管道、报 READY、读回 FADING:<ms>。返回淡出时长（毫秒）。
    ///
    /// 任何一步失败都返回 None —— 调用方会把窗口直接显示出来，
    /// 用户最多是「没有交叠动画」，不会卡在看不见的状态。
    fn handshake(name: &str) -> Option<u64> {
        // 启动器要先 CreateNamedPipe 我们才连得上，给它一点时间；重试到超时为止。
        let deadline = Instant::now() + Duration::from_millis(HANDSHAKE_TIMEOUT_MS);
        let mut stream = loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(name)
            {
                Ok(s) => break s,
                Err(e) => {
                    if Instant::now() >= deadline {
                        eprintln!("[splash] 连接启动器管道失败：{e}");
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        };

        stream.write_all(b"READY\n").ok()?;
        let _ = stream.flush();

        // 读回 FADING:<ms>；启动器可能因超时已退出（无 FADING），按 0 处理。
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        line.trim().strip_prefix("FADING:")?.parse::<u64>().ok()
    }

    /// 通知后台线程可以报 READY 了。返回 false = 没有启动器在跑。
    pub fn notify_ready() -> bool {
        let guard = LINK.lock().unwrap();
        match guard.as_ref() {
            Some(link) => link.tx.send(()).is_ok(),
            None => false,
        }
    }
}

/// 登记主窗口句柄（在 Tauri setup 里调用一次）。
pub fn set_app(app: AppHandle) {
    *APP.lock().unwrap() = Some(app);
}

/// 在主线程显示主窗口（幂等）。
///
/// 这是**唯一**的显示入口：无论走「启动器淡出后」还是「没有启动器直接显示」，
/// 最后都落到这里，因此不会出现两条路径互相打架。
pub fn reveal() {
    let app = match APP.lock().unwrap().clone() {
        Some(a) => a,
        None => return,
    };
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = inner.get_webview_window("main") {
            if !win.is_visible().unwrap_or(false) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    });
}

/// 前台报「首屏就绪」。
///
/// 有启动器 → 交给它做交叠淡出；没有 → 直接显示窗口。
pub fn on_app_ready() {
    #[cfg(windows)]
    {
        if imp::notify_ready() {
            return;
        }
    }
    reveal();
}

/// 尝试拉起启动器（在 run() 最开始调用）。返回是否成功。
///
/// 注意这里**必须**拆成两个 cfg 限定的函数，不能写成
/// `#[cfg(windows)] { imp::spawn() }` 这样的块 —— 块作为语句时值会被丢弃，
/// 剥离 cfg 后函数体就没有尾表达式了，返回类型对不上（编译不过）。
#[cfg(windows)]
pub fn spawn() -> bool {
    imp::spawn()
}

/// 非 Windows 没有启动器（它是 Win32 + GDI 程序），恒为 false。
#[cfg(not(windows))]
pub fn spawn() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 发布布局：resource 与主程序同级 → 第一条候选就该命中。
    #[test]
    fn published_layout_finds_sibling_splash() {
        let dir = Path::new("/app");
        let c = splash_candidates(dir);
        assert_eq!(c[0], PathBuf::from("/app/silvermoon-splash.exe"));
    }

    /// 另一种发布布局：resource 落在 resources/ 子目录。
    #[test]
    fn resources_subdir_is_also_covered() {
        let dir = Path::new("/app");
        let c = splash_candidates(dir);
        assert!(c.contains(&PathBuf::from("/app/resources/silvermoon-splash.exe")));
    }

    /// 开发态：exe 在 src-tauri/target/debug，启动器在 splash/target/release。
    /// 向上 2 级到 apps/desktop，再拼 splash/target/*/silvermoon-splash.exe。
    #[test]
    fn dev_layout_reaches_cargo_output() {
        let dir = Path::new("/repo/apps/desktop/src-tauri/target/debug");
        let c = splash_candidates(dir);
        assert!(c.contains(&PathBuf::from(
            "/repo/apps/desktop/splash/target/release/silvermoon-splash.exe"
        )));
        assert!(c.contains(&PathBuf::from(
            "/repo/apps/desktop/splash/target/debug/silvermoon-splash.exe"
        )));
    }

    /// 根目录输入不能 panic（parent() 为 None 时要提前收手）。
    #[test]
    fn root_dir_does_not_panic() {
        let c = splash_candidates(Path::new("/"));
        assert!(!c.is_empty());
    }
}
