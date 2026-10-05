//! 启动轨迹（boot trace）：把启动器启动过程逐阶段落盘。
//!
//! ## 为什么启动器也需要它
//!
//! 实测在 Win7 上双击快捷方式时，启动器自己先崩：
//!
//! ```text
//! 问题事件名称: APPCRASH
//! 应用程序名: silvermoon-splash.exe
//! 异常代码: c0000005          （= STATUS_ACCESS_VIOLATION）
//! 异常偏移: 0000000000005da3
//! OS 版本: 6.1.7601
//! ```
//!
//! 整个事件报告里唯一有用的线索就是那个偏移量 —— 而没有符号表时它几乎没有意义。
//! 启动器是 `windows_subsystem = "windows"` 的 GUI 程序，**没有控制台**，
//! `eprintln!` 无处可看。
//!
//! 因此和 backend 一样，改成**主动打点**：每个阶段进入前先写一行并 flush。
//! 进程若在某步崩掉，日志最后一行就是崩溃区间下界。
//!
//! ## 与 backend 那份的关系
//!
//! 两个 crate 无法共享代码（backend 依赖一整棵 tokio/reqwest/rusqlite 树，
//! 启动器则刻意只依赖 `windows` + `serde_json`，体积 0.23MB —— 抽公共 crate
//! 会把这份克制毁掉）。所以这里是一份**刻意重复**的最简实现，只有几十行。
//! 改动其中一份时记得同步语义（文件名格式、flush 语义、开关名）。
//!
//! 日志落在 `<%TEMP%>/silvermoon-boot-splash.log`。

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static TRACE_PATH: OnceLock<Vec<PathBuf>> = OnceLock::new();
static T0: OnceLock<std::time::Instant> = OnceLock::new();

/// 是否启用（`SILVERMOON_BOOT_TRACE=0` 关闭）。
fn enabled() -> bool {
    !matches!(
        std::env::var("SILVERMOON_BOOT_TRACE").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    )
}

/// 初始化轨迹文件，返回其路径。
///
/// ## 位置的选择（这里踩过设计坑）
///
/// 第一版写 `%TEMP%` —— 但 `%TEMP%` 在 Windows 7 上是
/// `C:\Users\<用户>\AppData\Local\Temp`，**资源管理器默认不显示隐藏目录**，
/// 而用户遇到「双击快捷方式没反应」时最需要的就是快速找到这份日志。
///
/// 所以改成**优先写到安装目录旁**（启动器所在处，即
/// `<安装目录>\resources\` 或 `<安装目录>\`）：用户已经知道应用装在哪，
/// 一眼就能找到 `silvermoon-boot-splash.log`。
///
/// 但安装目录可能不可写（装到 `Program Files` 且非管理员运行时）。
/// 因此保留 `%TEMP%` 作为兜底，且**两个位置都尝试写**——多写一份的代价是
/// 几十字节，换来的是「无论权限如何，总有地方能找到日志」。
fn candidate_paths(tag: &str) -> Vec<PathBuf> {
    let name = format!("silvermoon-boot-{tag}.log");
    let mut out = Vec::new();
    // 1) 可执行文件旁边（最容易被用户找到）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(&name));
        }
    }
    // 2) 当前工作目录（开发态/手工运行）
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join(&name));
    }
    // 3) 系统临时目录（最后的兜底，一定有写权限）
    out.push(std::env::temp_dir().join(&name));
    out
}

/// 初始化轨迹文件，返回**实际可写**的路径列表。
///
/// 策略：**能写几个写几个**，全部保留。
///
/// 为什么不做「写成功一个就够」：两个位置各有各的失手方式 ——
/// 安装目录可能因权限不可写（装到 `Program Files` 且非管理员），
/// `%TEMP%` 可能被清理工具扫掉或用户根本找不到隐藏目录。
/// 多写一份的成本是每次启动几十字节，换来的是「总有一条线索在」。
///
/// 崩溃排查时**以用户找得到的那份为准**（安装目录旁那份优先展示）。
pub fn init(tag: &str) -> Vec<PathBuf> {
    let paths = TRACE_PATH.get_or_init(|| {
        if !enabled() {
            return Vec::new();
        }
        let candidates = candidate_paths(tag);
        let mut viable: Vec<PathBuf> = Vec::new();
        for p in &candidates {
            // 用「能否以追加方式打开」判定可写性；打不开就跳过。
            if std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .is_ok()
            {
                viable.push(p.clone());
            }
        }
        if viable.is_empty() {
            // 全都写不了（极端情形）：保留 temp 路径占位，
            // 让后续 trace() 静默失败而不是 panic —— 诊断设施绝不能拖垮主流程。
            if let Some(last) = candidates.last() {
                viable.push(last.clone());
            }
        }
        viable
    });
    let _ = T0.set(std::time::Instant::now());
    paths.clone()
}

fn since_start() -> u128 {
    T0.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis()
}

/// 写一行并 **flush**（崩溃时缓冲里的内容会丢，必须落盘）。
pub fn trace(msg: &str) {
    let Some(paths) = TRACE_PATH.get() else {
        return;
    };
    let line = format!("[+{:>6}ms] {}\n", since_start(), msg);
    for path in paths {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}

/// 写一条「本次启动开始」的分隔头。
///
/// 追加模式下必须要有它：否则连续两次启动的轨迹首尾相接，
/// 排查时容易把上一次的结尾误当成这一次的过程。
pub fn mark_session_start(tag: &str) {
    let paths = TRACE_PATH.get().cloned().unwrap_or_default();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!(
        "\n===== SilverMoon {tag} 启动会话 @ unix {ts}（pid {}）=====\n",
        std::process::id()
    );
    for path in &paths {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}

/// 进入某阶段（必须在被诊断代码**之前**调用）。
pub fn step(msg: &str) {
    trace(&format!("STEP   {msg}"));
}

/// 记录结果 / 状态。
pub fn info(msg: &str) {
    trace(&format!("INFO   {msg}"));
}

/// 记录警告。
pub fn warn(msg: &str) {
    trace(&format!("WARN   {msg}"));
}

/// 记录错误。
pub fn error(msg: &str) {
    trace(&format!("ERROR  {msg}"));
}

/// 环境自检：只读环境变量，不调用任何可能缺失的 API。
pub fn env_probe() {
    info(&format!(
        "可执行文件：{}",
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<未知>".into())
    ));
    info(&format!("当前目录：{:?}", std::env::current_dir().ok()));
    info(&format!("系统临时目录：{:?}", std::env::temp_dir()));
    info(&format!("进程 id：{}", std::process::id()));
    info(&format!("架构位数：{}", usize::BITS));
    info(&format!(
        "命令行参数：{:?}",
        std::env::args().collect::<Vec<_>>()
    ));
    if let Ok(p) = std::env::var("SILVERMOON_ELECTRON_BIN") {
        info(&format!("SILVERMOON_ELECTRON_BIN={p}"));
    }
    for key in [
        "SILVERMOON_DATA_DIR",
        "SILVERMOON_CACHE_DIR",
        "SILVERMOON_HOST_PORT",
        "SILVERMOON_SERVER_BIN",
    ] {
        if let Ok(v) = std::env::var(key) {
            info(&format!("{key}={v}"));
        }
    }
}

/// 阶段计时辅助。
pub struct Phase {
    label: &'static str,
    start: std::time::Instant,
}

impl Phase {
    pub fn begin(label: &'static str) -> Self {
        step(label);
        Self {
            label,
            start: std::time::Instant::now(),
        }
    }

    pub fn done(self) {
        info(&format!(
            "{} 完成（{}ms）",
            self.label,
            self.start.elapsed().as_millis()
        ));
    }
}
