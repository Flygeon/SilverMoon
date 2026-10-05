#![allow(non_snake_case)]

//! Manual bindings to the win32 API to avoid dependencies on windows-sys or winapi
//! as these bindings will **never** change and `parking_lot_core` is a foundational
//! dependency for the Rust ecosystem, so the dependencies used by it have an
//! outsize affect

pub const INFINITE: u32 = 4294967295;
pub const ERROR_TIMEOUT: u32 = 1460;
pub const GENERIC_READ: u32 = 2147483648;
pub const GENERIC_WRITE: u32 = 1073741824;
pub const STATUS_SUCCESS: i32 = 0;
pub const STATUS_TIMEOUT: i32 = 258;

pub type HANDLE = isize;
pub type HINSTANCE = isize;
pub type BOOL = i32;
pub type BOOLEAN = u8;
pub type NTSTATUS = i32;
pub type FARPROC = Option<unsafe extern "system" fn() -> isize>;
pub type WaitOnAddress = unsafe extern "system" fn(
    Address: *const std::ffi::c_void,
    CompareAddress: *const std::ffi::c_void,
    AddressSize: usize,
    dwMilliseconds: u32,
) -> BOOL;
pub type WakeByAddressSingle = unsafe extern "system" fn(Address: *const std::ffi::c_void);

windows_link::link!("kernel32.dll" "system" fn GetLastError() -> u32);
windows_link::link!("kernel32.dll" "system" fn CloseHandle(hObject: HANDLE) -> BOOL);
windows_link::link!("kernel32.dll" "system" fn GetModuleHandleA(lpModuleName: *const u8) -> HINSTANCE);
windows_link::link!("kernel32.dll" "system" fn GetProcAddress(hModule: HINSTANCE, lpProcName: *const u8) -> FARPROC);
windows_link::link!("kernel32.dll" "system" fn Sleep(dwMilliseconds: u32) -> ());

// -----------------------------------------------------------------------------
// SilverMoon 补丁新增：操作系统版本探测
// -----------------------------------------------------------------------------
//
// 目的：在 Win7 上跳过 `WaitAddress::create()` 里的 apiset 探测（见
// `waitaddress.rs` 顶部的详细说明）。
//
// 为什么用 `RtlGetVersion` 而不是 `GetVersionEx` / `GetVersion`：
//
//   * `GetVersion` / `GetVersionEx` 会**谎报版本** —— 从 Win8.1 起，
//     没有 manifest 声明支持新系统的进程会拿到 6.2 这种兼容值。
//     用它们判断「是不是 Win7」不可靠。
//   * `RtlGetVersion` 直接读 PEBB 里的真实版本号，**不撒谎**，
//     从 XP 一直可用到现在。这里正是需要「真实」版本。
//
// 结构体布局（RTL_OSVERSIONINFOW，20 字节 + 固定 128 字节的 szCSDVersion）：
//
//     DWORD dwOSVersionInfoSize;     // 必须自己填 sizeof
//     DWORD dwMajorVersion;
//     DWORD dwMinorVersion;
//     DWORD dwBuildNumber;
//     DWORD dwPlatformId;
//     WCHAR szCSDVersion[128];
//
// 这里故意**不用** `#[repr(C)] struct` + `MaybeUninit` 那套完整做法，
// 而是用一个足够大的 `[u32; 40]` 缓冲区：只要前 5 个 u32 的偏移正确即可，
// 代码更短、且不需要引入 `MaybeUninit` 的 unsafe 样板。
// 布局在 x86 / x64 上都是 4 字节对齐的，不会因位数变化。

windows_link::link!("ntdll.dll" "system" fn RtlGetVersion(
    lpVersionInformation: *mut RtlOsVersionInfo
) -> NTSTATUS);

/// `RTL_OSVERSIONINFOW` 的最小可用前缀。
///
/// 只声明到 `dwPlatformId`，因为本补丁只读 major/minor；
/// 后面还有 128 个 WCHAR 的 `szCSDVersion`，但我们不关心，
/// 用一个超出实际需要的缓冲区兜住即可（见 [`os_version`]）。
#[repr(C)]
#[allow(non_snake_case)]
pub struct RtlOsVersionInfo {
    pub dwOSVersionInfoSize: u32,
    pub dwMajorVersion: u32,
    pub dwMinorVersion: u32,
    pub dwBuildNumber: u32,
    pub dwPlatformId: u32,
}

/// 返回真实的 `(major, minor)` 系统版本；读取失败时返回 `None`。
///
/// Win7 = `(6, 1)`，Win8 = `(6, 2)`，Win8.1 = `(6, 3)`，Win10/11 = `(10, *)`。
#[allow(dead_code)]
pub fn os_version() -> Option<(u32, u32)> {
    // 缓冲区刻意开大：前 20 字节是上面 5 个 u32，其余空间留给
    // `RTL_OSVERSIONINFOW` 尾部那 128 个 WCHAR 的 `szCSDVersion`。
    // `RtlGetVersion` 会按 `dwOSVersionInfoSize` 写入，若 size 给小于
    // 真实结构体需要的量，API 可能返回 STATUS_BUFFER_TOO_SMALL 或越界写。
    #[repr(C, align(4))]
    struct Buf {
        v: RtlOsVersionInfo,
        _csd: [u16; 128],
    }

    let mut buf = Buf {
        v: RtlOsVersionInfo {
            dwOSVersionInfoSize: core::mem::size_of::<Buf>() as u32,
            dwMajorVersion: 0,
            dwMinorVersion: 0,
            dwBuildNumber: 0,
            dwPlatformId: 0,
        },
        _csd: [0u16; 128],
    };

    let status = unsafe { RtlGetVersion(&mut buf.v) };
    // NTSTATUS == 0 即 STATUS_SUCCESS
    if status == STATUS_SUCCESS {
        Some((buf.v.dwMajorVersion, buf.v.dwMinorVersion))
    } else {
        None
    }
}
