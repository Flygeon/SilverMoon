//! 宿主侧启动打点。
//!
//! ## 为什么需要它
//!
//! 渲染侧的打点（`src/utils/bootTiming.ts`）以「入口 chunk 开始执行」为 t0，
//! 因此 **「进程启动 → bundle 开始执行」这一整段完全没有覆盖**：Rust 初始化、
//! 建窗口、WebView2 环境创建、导航、HTML 解析、bundle 下载。排查
//! 「双击图标到看见画面要好几秒」时，这一段恰恰是盲区。
//!
//! 本模块以**进程启动**为 t0，与渲染打点写进同一份 `main.log`，靠前缀区分：
//!
//! ```text
//! [启动][宿主] 进程启动: 0ms          ← 本模块（t0 = main() 进入时刻）
//! [启动][宿主] setup 开始: 412ms
//! [启动][宿主] 页面开始加载: 655ms
//! [启动][宿主] 主窗口已显示: 1180ms
//! [启动][渲染] 首帧内容绘制(FCP): 137ms   ← bootTiming.ts（t0 = chunk 开始执行）
//! ```
//!
//! ⚠️ **两套 t0 不同，不能直接相加**。对照方法：把宿主侧的「页面开始加载」
//! 近似看作渲染 t0，它之后的耗时看渲染打点，之前的看宿主打点。
//!
//! ⚠️ **打点记录的是「回调真正跑起来」的时刻，不是事件发生的时刻**。
//! setup() 是在主线程上同步执行的，期间事件循环不转，因此页面加载类回调会被
//! 推迟到 setup 结束后才执行——那时记下的毫秒数会偏大。
//! 这不是缺陷而是有用的信号：它正说明「主线程被占住了」。
//! 判断时以 `setup 结束` 与 `主窗口已显示` 两点为准。
//!
//! ## 实现约束
//!
//! 「进程启动」这一刻还没有 `AppHandle`，拿不到 `app_log_dir`。因此这里先攒在
//! 内存里，等 `attach()` 拿到路径后一次性补写，之后的打点直接追加。
//! 这样时间轴上不会缺头。

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

// `app.path()` 来自 Manager trait，必须显式引入，否则不解析
use tauri::Manager;

/// 进程启动时刻（`mark_start()` 只生效一次）。
static T0: OnceLock<Instant> = OnceLock::new();
/// 日志文件路径；`attach()` 之后才有值。
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
/// `attach()` 之前攒下的行（先于日志路径可用而发生的打点）。
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 记录进程启动时刻。必须在 `main()` 最早期调用一次，否则 t0 会偏晚。
pub fn mark_start() {
    let _ = T0.set(Instant::now());
}

/// 距进程启动的毫秒数（t0 未设置时返回 0）。
pub fn since_start_ms() -> u128 {
    T0.get().map(|t| t.elapsed().as_millis()).unwrap_or(0)
}

/// 绑定日志文件并补写此前攒下的打点。应在 `setup()` 一进来就调用。
pub fn attach(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = LOG_PATH.set(dir.join("main.log"));
    }
    flush_pending();
}

/// 写一条宿主侧启动打点。
///
/// 打点失败绝不影响启动（与 `bootTiming.ts` 的取舍一致）：所有 IO 错误都被吞掉。
pub fn record(label: &str) {
    let line = format!("[启动][宿主] {label}: {}ms\n", since_start_ms());
    if LOG_PATH.get().is_some() {
        write_line(&line);
    } else {
        // 还没 attach：先攒着，等知道路径再补写，避免丢掉最早的那几条
        if let Ok(mut buf) = PENDING.lock() {
            buf.push(line);
        }
    }
}

/// 把 attach 之前攒下的行按原顺序写出。
fn flush_pending() {
    let Ok(mut buf) = PENDING.lock() else { return };
    for line in buf.drain(..) {
        write_line(&line);
    }
}

fn write_line(line: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
}
