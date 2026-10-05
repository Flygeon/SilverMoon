// SilverMoon Win7 崩溃最小复现程序（Rust 版）
// ---------------------------------------------------------------------------
// 与 repro.c 的关系：
//   repro.c   —— C 版，隔离「OS 的 GetModuleHandleA 对 apiset 名是否安全」
//   本文件    —— Rust 版，隔离「parking_lot 的探测路径是否就是崩溃点」
//
// 为什么两个都要：
//   如果只有 C 版崩，说明是 OS 层面的事；
//   如果只有 Rust 版崩，说明是 parking_lot / Rust std 的事；
//   如果两个都崩，就是 GetModuleHandleA 本身。
//
// 本文件的探测序列**照抄** parking_lot_core 0.9.12：
//   src/thread_parker/windows/waitaddress.rs:22-38
//
//     pub fn create() -> Option<WaitAddress> {
//         let synch_dll = GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll\0".as_ptr());
//         if synch_dll == 0 { return None; }
//         let WaitOnAddress = GetProcAddress(synch_dll, b"WaitOnAddress\0".as_ptr())?;
//         let WakeByAddressSingle = GetProcAddress(synch_dll, b"WakeByAddressSingle\0".as_ptr())?;
//         Some(WaitAddress { ... })
//     }
//
// 编译（必须用 win7 target，因为要复现的就是那个构建的产物）：
//   cargo +nightly build --release -Z build-std=std,panic_abort \
//       --target x86_64-win7-windows-gnu
// 也接受稳定版交叉编译（行为等价，便于快速验证）：
//   cargo build --release --target x86_64-pc-windows-gnu
//
// 注意：本程序**故意**用 `#![windows_subsystem = "windows"]` 保持一致 ——
// 但为了能看到输出，下面显式 AttachConsole + 重定向，
// 同时把全部轨迹写文件（和原程序同款做法）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Win32 声明（自备，避免引入 windows-sys 依赖 —— 复现程序要尽可能少依赖）
// ---------------------------------------------------------------------------
type HMODULE = *mut core::ffi::c_void;
type FARPROC = *mut core::ffi::c_void;
type BOOL = i32;
type DWORD = u32;
type HANDLE = *mut core::ffi::c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleA(lpModuleName: *const u8) -> HMODULE;
    fn GetProcAddress(hModule: HMODULE, lpProcName: *const u8) -> FARPROC;
    fn LoadLibraryA(lpLibFileName: *const u8) -> HMODULE;
    fn GetLastError() -> DWORD;
    fn GetVersion() -> DWORD;
    fn GetTempPathA(nBufferLength: DWORD, lpBuffer: *mut u8) -> DWORD;
    fn GetStdHandle(nStdHandle: DWORD) -> HANDLE;
}

const STD_OUTPUT_HANDLE: DWORD = 0xFFFF_FFF5u32;

// ---------------------------------------------------------------------------
// 多路日志（思路与 SilverMoon 的 boot_trace 一致）
// ---------------------------------------------------------------------------
static LOGS: OnceLock<Vec<PathBuf>> = OnceLock::new();
static T0: OnceLock<Instant> = OnceLock::new();

fn init_logs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("repro-rs-trace.log"));
        }
    }
    // %TEMP%
    let mut buf = [0u8; 260];
    unsafe {
        let n = GetTempPathA(260, buf.as_mut_ptr());
        if n > 0 && (n as usize) < 260 {
            let tmp = String::from_utf8_lossy(&buf[..n as usize]).to_string();
            out.push(PathBuf::from(tmp).join("repro-rs-trace.log"));
        }
    }
    out
}

fn log(msg: &str) {
    let t0 = T0.get_or_init(Instant::now);
    let line = format!("[+{:>6}ms] {}\r\n", t0.elapsed().as_millis(), msg);

    // 控制台（若从 cmd 启动）
    unsafe {
        let con = GetStdHandle(STD_OUTPUT_HANDLE);
        if !con.is_null() && con as isize != -1 {
            // 直接写文件句柄
            #[link(name = "kernel32")]
            extern "system" {
                fn WriteFile(
                    hFile: HANDLE,
                    lpBuffer: *const u8,
                    nNumberOfBytesToWrite: DWORD,
                    lpNumberOfBytesWritten: *mut DWORD,
                    lpOverlapped: *mut core::ffi::c_void,
                ) -> BOOL;
            }
            let mut w: DWORD = 0;
            WriteFile(con, line.as_ptr(), line.len() as DWORD, &mut w, core::ptr::null_mut());
        }
    }

    if let Some(paths) = LOGS.get() {
        for p in paths {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
                let _ = f.write_all(line.as_bytes());
                let _ = f.flush();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 探测：**逐字照抄** parking_lot 的逻辑
// ---------------------------------------------------------------------------
fn parking_lot_style_probe() -> bool {
    log("STEP  进入 parking_lot 式探测：GetModuleHandleA(\"api-ms-win-core-synch-l1-2-0.dll\")");

    let name = CString::new("api-ms-win-core-synch-l1-2-0.dll").unwrap();
    let h = unsafe { GetModuleHandleA(name.as_ptr() as *const u8) };
    log(&format!(
        "  GetModuleHandleA -> 0x{:p}  (GetLastError={})",
        h,
        unsafe { GetLastError() }
    ));

    if h.is_null() {
        log("  -> 返回 NULL：会安全回退到 KeyedEvent（XP+ 可用），**这是预期行为**");
        return false;
    }

    log("  -> 非 NULL（Win8+ 才会这样），继续取函数地址");
    let wa = CString::new("WaitOnAddress").unwrap();
    let p = unsafe { GetProcAddress(h, wa.as_ptr() as *const u8) };
    log(&format!(
        "  GetProcAddress(\"WaitOnAddress\") -> 0x{:p}  (GetLastError={})",
        p,
        unsafe { GetLastError() }
    ));
    true
}

fn main() {
    let logs = init_logs();
    let _ = LOGS.set(logs.clone());
    T0.get_or_init(Instant::now);

    log("===== SilverMoon Win7 复现程序（Rust）=====");
    let v = unsafe { GetVersion() };
    log(&format!(
        "GetVersion：{}.{}.{}  (build {})",
        v & 0xFF,
        (v >> 8) & 0xFF,
        (v >> 16) & 0xFFFF,
        if v >> 31 == 0 { "NT" } else { "9x" }
    ));

    log("");
    log("### 1) 复现 parking_lot 的探测路径");
    let got = parking_lot_style_probe();

    log("");
    log("### 2) LoadLibraryA 对照");
    {
        let n = CString::new("api-ms-win-core-synch-l1-2-0.dll").unwrap();
        let h = unsafe { LoadLibraryA(n.as_ptr() as *const u8) };
        log(&format!(
            "  LoadLibraryA -> 0x{:p}  (GetLastError={})",
            h,
            unsafe { GetLastError() }
        ));
    }

    log("");
    log("### 3) 触发 parking_lot 真实初始化（Mutex 用法）");
    log("STEP  即将创建 std::sync::Mutex —— Rust std 在 Windows 上会走到 Lazy 后端初始化");
    {
        use std::sync::Mutex;
        let m = Mutex::new(0u64);
        if let Ok(mut g) = m.lock() {
            *g = 42;
        }
        log(&format!("  Mutex 可用，值为 {}", *m.lock().unwrap()));
    }

    log("");
    log("### 4) 触发 std 的线程 park（Condvar）");
    log("STEP  即将用 Condvar 做一次 park/unpark");
    {
        use std::sync::{Arc, Condvar, Mutex};
        let pair = Arc::new((Mutex::new(false), Condvar::new()));
        let p2 = Arc::clone(&pair);
        let handle = std::thread::spawn(move || {
            let (l, c) = &*p2;
            let mut started = l.lock().unwrap();
            while !*started {
                started = c.wait(started).unwrap();
            }
            log("  子线程被唤醒");
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        {
            let (l, c) = &*pair;
            let mut started = l.lock().unwrap();
            *started = true;
            c.notify_one();
        }
        let _ = handle.join();
        log("  Condvar park/unpark 正常");
    }

    log("");
    if got {
        log("===== 全部完成：探测返回了非 NULL，未崩溃 =====");
    } else {
        log("===== 全部完成：探测安全返回 NULL，未崩溃 =====");
        log("结论：如果本程序在 Win7 上能正常跑完，说明 parking_lot 的探测逻辑");
        log("      本身不是崩溃点 —— SilverMoon 的问题在别处。");
    }

    // 停下来让人看窗口（GUI 模式下控制台不可见，靠文件）
    std::thread::sleep(std::time::Duration::from_millis(300));

    let msg = format!(
        "复现程序执行完毕，未崩溃。\r\n\r\n轨迹文件：\r\n{}\r\n\r\n请把 repro-rs-trace.log 发回。",
        logs.iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\r\n")
    );
    show_msgbox("SilverMoon Win7 复现（Rust）—— 未崩溃", &msg);
}

// MessageBoxA 声明（避免引入 windows crate）
#[link(name = "user32")]
extern "system" {
    fn MessageBoxA(hWnd: *mut core::ffi::c_void, lpText: *const u8, lpCaption: *const u8, uType: u32) -> i32;
}

fn show_msgbox(title: &str, text: &str) {
    let t = CString::new(text.replace('\r', "").replace('\n', "\r\n")).unwrap();
    let c = CString::new(title).unwrap();
    unsafe {
        MessageBoxA(core::ptr::null_mut(), t.as_ptr() as *const u8, c.as_ptr() as *const u8, 0x40);
    }
}
