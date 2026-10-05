//! 启动轨迹（boot trace）：把进程启动过程**逐阶段落盘**，用于定位「一启动就崩」。
//!
//! ## 为什么需要它（真实背景）
//!
//! Win7 兼容版实测出现两类崩溃，且**都没有可用信息**：
//!
//! - 启动器 `silvermoon-splash.exe`：`APPCRASH / 异常代码 c0000005`（访问违例），
//!   偏移 `0x5da3`，除故障模块名外什么也没有；
//! - 后端 `silvermoon-server.exe`：Electron 侧只看到
//!   `侧车退出：code=3221225477`（= `0xC0000005`），进程**静默消失**。
//!
//! 两者都是 `#![windows_subsystem = "windows"]` 的 GUI 进程 —— **没有控制台**，
//! `eprintln!` 与 panic hook 的输出在打包后的 Win7 上根本无处可看。而崩溃发生在
//! Rust 运行时的早期阶段时，连 panic hook 都还没装上，任何「崩溃后写日志」的方案
//! 都不成立。
//!
//! 因此这里换一个方向：**不依赖崩溃处理器，改成主动打点**。
//! 每个阶段**进入前**先写一行并 flush 到磁盘；进程若在下一步死掉，
//! 日志最后一行就是「最后成功进入的阶段」——直接圈定崩溃区间。
//!
//! ## 文件位置
//!
//! 写到 `<系统临时目录>/silvermoon-boot-<进程名>.log`（`%TEMP%` 在 Win7 上
//! 通常可写，不需要管理员权限）。刻意与 `lumiluna_login_debug.log` 分开：
//! 那个文件是**业务**日志（登录、panic），这个是**启动**日志，混在一起会
//! 让「启动到哪一步了」这个唯一关心的问题被噪声淹没。
//!
//! `SILVERMOON_BOOT_TRACE=0` 可彻底关掉（用于正式版不需要诊断时）。

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// 诊断文件路径（空 = 未初始化 / 已关闭）。
static TRACE_PATH: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// 进程启动的单调起点，用于给每一行附上「距进程启动多少毫秒」。
///
/// 用 `OnceLock` 而不是每行现取 `Instant::now()`：我们需要的是**相对起点**的
/// 时间，起点必须是进程里第一次调用本模块的时刻（早于任何打点）。
static T0: OnceLock<std::time::Instant> = OnceLock::new();

/// 打点标签（`"backend"` / `"splash"`），用于把两个进程的日志分开。
pub const TAG_BACKEND: &str = "backend";
pub const TAG_SPLASH: &str = "splash";

/// 是否启用。`SILVERMOON_BOOT_TRACE=0` 显式关闭；其余情况一律启用
/// （诊断设施的开销是「每次启动写十几行」，可以忽略，不该让用户去开开关）。
fn enabled() -> bool {
    !matches!(
        std::env::var("SILVERMOON_BOOT_TRACE").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    )
}

/// 候选路径：可执行文件旁 → 数据目录 → 系统临时目录。
///
/// 多写几份的理由同 splash 侧：`%TEMP%` 是隐藏目录、用户找不到；而安装目录
/// 又可能因权限不可写。两侧的策略保持一致，排查时不会因为「后端日志在 A、
/// 启动器日志在 B」而漏看一份。
///
/// 后端额外把 `<SILVERMOON_DATA_DIR>\logs\` 加进来 —— 那是应用**面向用户的
/// 日志目录**（Electron 的 main.log 就在那儿），用户最可能已经知道它。
fn candidate_paths(tag: &str) -> Vec<PathBuf> {
    let name = format!("silvermoon-boot-{tag}.log");
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(&name));
        }
    }
    if let Ok(data) = std::env::var("SILVERMOON_DATA_DIR") {
        out.push(PathBuf::from(data).join("logs").join(&name));
    }
    out.push(std::env::temp_dir().join(&name));
    out
}

/// 初始化并返回**实际可写**的路径列表。
///
/// `tag` 决定文件名，两个进程各写各的，互不覆盖。
pub fn init(tag: &str) -> Vec<PathBuf> {
    let paths = TRACE_PATH.get_or_init(|| {
        if !enabled() {
            return Vec::new();
        }
        let candidates = candidate_paths(tag);
        let mut viable: Vec<PathBuf> = Vec::new();
        for p in &candidates {
            // 数据目录的 logs/ 可能还不存在，先补建（失败就跳过这一项）
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
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
            if let Some(last) = candidates.last() {
                viable.push(last.clone());
            }
        }
        viable
    });
    // 起点只记一次；重复调用不影响已记录的起点。
    let _ = T0.set(std::time::Instant::now());
    paths.clone()
}

/// 距离进程启动（本模块首次调用）的毫秒数。
fn since_start() -> u128 {
    T0.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis()
}

/// 写一行轨迹（并立即 flush —— 崩溃时缓冲内容会丢，必须落盘）。
///
/// 文件用**追加**模式：上一次启动的内容保留着，两次崩溃可以对照。
/// 每次 `init` 会写一条醒目的分隔头，避免把两次启动的行读串。
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
            // flush 是**语义必需**：本文件存在的唯一目的就是在进程突然消失时留下痕迹，
            // 走 BufWriter 会让最后几行随进程一起蒸发。
            let _ = f.flush();
        }
    }
}

/// 写一条「本次启动开始」的分隔头。
///
/// 追加模式下必须要有它：否则连续两次启动的轨迹首尾相接，
/// 人眼（以及 `collectBootDiagnostics` 的尾部截断）都可能把上一次的结尾
/// 误当成这一次的过程。
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

/// 进入某阶段：**先**写一行，再执行后续代码。
///
/// 语义是「已到达这里」，所以调用点必须放在被诊断代码的**前面** ——
/// 放在后面就变成「成功后才记录」，崩溃时反而什么都看不到。
pub fn step(msg: &str) {
    trace(&format!("STEP   {msg}"));
}

/// 记录一条结果（成功 / 失败 / 统计信息）。
pub fn info(msg: &str) {
    trace(&format!("INFO   {msg}"));
}

/// 记录一个警告：不致命，但可能解释后续异常。
pub fn warn(msg: &str) {
    trace(&format!("WARN   {msg}"));
}

/// 记录错误：明确的失败点。
pub fn error(msg: &str) {
    trace(&format!("ERROR  {msg}"));
}

/// 记录「该阶段预计会加载/依赖的东西」，用于静态环境自检。
pub fn env(msg: &str) {
    trace(&format!("ENV    {msg}"));
}

/// 一组阶段计时的辅助：`Phase` 在构造时打点，`done()` 时补上耗时。
///
/// 只用于**值得计时**的长阶段（建库、扫描扩展、起 HTTP 服务），
/// 普通阶段直接用 `step()` 即可。
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

    /// 结束该阶段，记录耗时。
    pub fn done(self) {
        info(&format!(
            "{} 完成（{}ms）",
            self.label,
            self.start.elapsed().as_millis()
        ));
    }
}

/// 把一段 `Result` 记进轨迹（成功/失败都记），原样返回。
///
/// 用于 `?` 传播之前 —— 失败时日志里就有确切原因，而不是只看到进程消失。
pub fn note_result<T, E: std::fmt::Display>(label: &str, r: Result<T, E>) -> Result<T, E> {
    match &r {
        Ok(_) => info(&format!("{label} 成功")),
        Err(e) => error(&format!("{label} 失败：{e}")),
    }
    r
}

/// 环境自检：把「当前进程可见的关键运行时信息」写进轨迹。
///
/// 不调用任何 Win8+ API（那正是要诊断的东西），只用最基础的
/// `GetVersionExW` 路径之外的信息：环境变量、模块路径、命令行。
/// 这样即使在 Win7 上也能安全执行。
pub fn env_probe(argv0_hint: &str) {
    env(&format!("可执行文件：{}", argv0_hint));
    env(&format!("当前目录：{:?}", std::env::current_dir().ok()));
    env(&format!("系统临时目录：{:?}", std::env::temp_dir()));
    env(&format!("进程 id：{}", std::process::id()));
    env(&format!("架构位数：{}", usize::BITS));
    if let Ok(mode) = std::env::var("SILVERMOON_BOOT_TRACE") {
        env(&format!("SILVERMOON_BOOT_TRACE={mode}"));
    }
    // 这两个变量由 Electron 主进程注入，能确认侧车是被**宿主**拉起的
    // （而不是用户手工双击），避免把两种情形混为一谈。
    if let Ok(dir) = std::env::var("SILVERMOON_DATA_DIR") {
        env(&format!("SILVERMOON_DATA_DIR={dir}"));
    }
    if let Ok(port) = std::env::var("SILVERMOON_HOST_PORT") {
        env(&format!("SILVERMOON_HOST_PORT={port}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 关掉开关时不应产生任何文件（正式版可用它彻底静默）
    #[test]
    fn disabled_flag_is_recognised() {
        for v in ["0", "false", "off"] {
            std::env::set_var("SILVERMOON_BOOT_TRACE", v);
            assert!(!enabled(), "{v} 应关闭轨迹");
        }
        std::env::set_var("SILVERMOON_BOOT_TRACE", "1");
        assert!(enabled());
        std::env::remove_var("SILVERMOON_BOOT_TRACE");
        assert!(enabled(), "未设置时应默认启用");
    }

    /// 未初始化时打点必须安全（不能 panic）—— 它在启动最早期就会被调用
    #[test]
    fn trace_before_init_is_noop() {
        // 这个测试进程里可能已被别的用例 init 过，所以只断言「不 panic」
        step("未初始化前的打点");
        info("同上");
    }
}
