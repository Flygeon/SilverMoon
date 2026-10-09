//! 启动器 ↔ 主程序（Tauri 应用）的握手协议。
//!
//! 为什么用**命名管道**而不是别的：
//! - 应用是父进程、启动器是子进程，管道随父子生命周期联动；
//! - 不依赖应用已就绪（HTTP/端口都得等应用起来）；
//! - 一端退出管道即断开，另一端能立刻感知，不会傻等。
//!
//! 协议极简（一行一条，'\n' 结尾）：
//!
//!   应用 → 启动器:  READY          # 首屏已就绪，可以淡出了
//!   启动器 → 应用:  FADING:<ms>    # 我开始淡出，预计 ms 后消失
//!
//! 约定：应用收到 FADING 后再等 <ms> 才显示主窗口，
//! 让 splash 淡出与主窗口出现**有时间交叠**，视觉上不会「先黑一下再亮」。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PeekNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_WAIT,
};

/// 等待应用 READY 的上限。超时即如实放弃（应用异常 / 被杀）。
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// 「完全没有客户端连上」的兜底上限。
///
/// 为什么需要它（真实缺陷）：`ConnectNamedPipe` 会**无限期**阻塞直到有客户端连接。
/// 若应用根本没连上来（崩了/没起来），后台等待线程会永远卡在那里，
/// 主线程的消息循环便永远等不到 ready 标志 —— 用户会对着 splash 无限转圈、
/// 且无法进入应用。所以连接阶段也要有独立的硬上限。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 淡出时长（毫秒）。
///
/// **这个值同时决定应用等多久才显示主窗口** —— 两端共用它做交叠，
/// 所以改这里就等于同时改两端的行为。
pub const FADE_MS: u64 = 220;

/// 管道名：现在由**应用**生成，并以 --splash-pipe= 传给启动器。仍然带 pid 与时间戳，
///
/// 带 pid 与时间戳，避免多实例 / 快速重启时撞名。
pub fn pipe_name() -> String {
    let pid = std::process::id();
    let tick = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!(r"\\.\pipe\silvermoon-splash-{pid}-{tick}")
}

/// UTF-8 → NUL 结尾 UTF-16（Win32 W 系 API 用）
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 握手通道服务端（启动器持有）。
///
/// 只持有句柄：管道名由调用方（main.rs）从命令行拿到，
/// 这里再存一份会变成无人读取的冗余字段。
pub struct Handshake {
    handle: HANDLE,
}

impl Handshake {
    /// 创建命名管道并开始监听。
    pub fn listen(name: &str) -> std::io::Result<Self> {
        let wname = wide(name);
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wname.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1, // 单实例：只有我们自己的孩子会连
                512,
                512,
                0,
                None,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    /// 阻塞等待应用连上来并读到 READY。
    ///
    /// 调用方应在**后台线程**里跑它，主线程继续跑动画。
    /// 返回 true = 收到 READY；false = 超时或对端提前断开（应用崩了）。
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        // 连接阶段**不能**直接 ConnectNamedPipe 阻塞等待：它是无限期的，
        // 应用起不来时会把我们永久卡住（见 CONNECT_TIMEOUT 的说明）。
        // 做法：把连接放到独立线程，主逻辑用带超时的轮询观察 `connected` 标志。
        let connected = Arc::new(AtomicBool::new(false));
        let raw = self.handle.0 as usize; // 句柄值跨线程传递（HANDLE 本身就是裸指针包装）
        let connected_bg = Arc::clone(&connected);
        std::thread::spawn(move || {
            let handle = HANDLE(raw as *mut core::ffi::c_void);
            let _ = unsafe { ConnectNamedPipe(handle, None) };
            connected_bg.store(true, Ordering::SeqCst);
        });

        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return false; // 始终没连上：如实放弃
            }
            // 先 Peek：有数据才 Read，否则会被 ReadFile 阻塞住、无法超时
            let mut avail = 0u32;
            let peeked =
                unsafe { PeekNamedPipe(self.handle, None, 0, None, Some(&mut avail), None) };
            if peeked.is_err() {
                // Peek 失败有两种含义：还没连上（ERROR_PIPE_LISTENING）或已断开。
                // 只有「连接线程已确认连上」时才按断开处理，否则继续等。
                if connected.load(Ordering::SeqCst) {
                    return false;
                }
            } else if avail > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(16));
        }

        matches!(self.read_line(), Some(l) if l.trim() == "READY")
    }

    /// 从管道读一行（阻塞；None 表示对端断开且未读到内容）
    fn read_line(&self) -> Option<String> {
        let mut line = String::new();
        let mut byte = [0u8; 1];
        loop {
            let mut read = 0u32;
            let ok = unsafe { ReadFile(self.handle, Some(&mut byte), Some(&mut read), None) };
            if ok.is_err() || read == 0 {
                return if line.is_empty() { None } else { Some(line) };
            }
            match byte[0] {
                b'\n' => return Some(line),
                b'\r' => {}
                b => line.push(b as char),
            }
        }
    }

    /// 向应用发送一行命令。
    pub fn send(&self, msg: &str) -> std::io::Result<()> {
        let line = format!("{msg}\n");
        let mut written = 0u32;
        unsafe { WriteFile(self.handle, Some(line.as_bytes()), Some(&mut written), None) }
            .map_err(|e| std::io::Error::other(e.message().to_string()))
    }
}

// HANDLE 内部是裸指针（*mut c_void），默认 !Send。
// 这里显式声明可跨线程：句柄本身由 Windows 保证可跨线程使用，
// 且我们用 Mutex 串行化访问（见 main.rs 的 handshake_slot）。
unsafe impl Send for Handshake {}

impl Drop for Handshake {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}
