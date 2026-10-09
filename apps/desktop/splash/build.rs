//! 构建脚本：把应用图标与版本信息嵌进启动器 exe。
//!
//! **为什么必须内嵌图标**：安装后快捷方式指向 `silvermoon-splash.exe`，
//! 而 Windows 取的是**目标 exe 自己的图标资源**。不嵌的话桌面快捷方式就是个
//! 空白方块（实机反馈过）—— 之前只有 Electron 的 SilverMoon.exe 有图标。
//!
//! **两条工具链要分开处理**（都踩过）：
//!
//! * **MSVC**（CI 的 windows-latest 走这条，也就是真实发布路径）：
//!   直接交给 `WindowsResource::compile()`。它自己会在 Visual Studio / Windows SDK
//!   目录里解析 `rc.exe`（也认 `RC_PATH`），并且**已经**用 `rustc-link-arg`
//!   把产物交给链接器，因此 `.rsrc` 能进 exe。
//!
//!   > 曾经在这里自作聪明：自己 `Command::new("rc")` 调裸 `rc`。
//!   > 裸 `rc` **不在 PATH 上**，于是 CI 虽然绿、日志里却写着
//!   > 「资源编译失败，图标未嵌入」—— 发布版照样没图标。
//!   > 这个 bug 只在 MSVC 上出现，而本机只能用 GNU 验证，差点漏掉。
//!
//! * **GNU**（本机与 Linux 交叉编译验证走这条）：**不能**用它的自动链接。
//!   它的路径是「windres → resource.o → ar 打成 libresource.a →
//!   `cargo:rustc-link-lib=static:+whole-archive`」，实测 `.rsrc` 节没能进最终
//!   exe（objdump -h 查不到，而中间产物 resource.o 里明明有；strip / lto /
//!   --gc-sections 逐一排除过）。所以这里自己编成对象再 `rustc-link-arg`。
//!
//! 失败时不 panic：图标缺失只影响观感，不该让整个构建挂掉，
//! 但一定打印 cargo:warning，避免「静默没图标」直到用户装上才发现。

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");

    // 非 Windows 目标（宿主上跑纯逻辑测试）直接跳过，
    // 否则会因为没有资源编译器而报错。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let icon = manifest.join("../src-tauri/icons/icon.ico");
    if !icon.is_file() {
        require_icon(format!("找不到图标文件 {}", icon.display()));
        return;
    }

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());

    let mut res = winresource::WindowsResource::new();
    res.set_icon(icon.to_str().unwrap_or_default());
    res.set("ProductName", "SilverMoon");
    res.set("FileDescription", "SilverMoon 启动器");
    res.set("LegalCopyright", "Copyright © SilverMoon contributors");

    let is_msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");

    if is_msvc {
        // MSVC：交给 winresource 自己的解析 + link-arg（它已经做对了）
        //
        // 失败一律 panic，不降级成 warning：曾经这里只打 warning，于是 CI 全绿、
        // 发布版快捷方式却是空白图标，直到用户装上才发现。图标是发布必备项。
        // 需要临时跳过就显式设 SILVERMOON_ALLOW_MISSING_ICON=1。
        if let Err(e) = res.compile() {
            require_icon(format!("MSVC 资源编译失败：{e}"));
        }
        println!("cargo:warning=已嵌入图标资源（MSVC）：{}", icon.display());
        return;
    }

    // GNU：自己编成对象再直接把对象交给链接器
    let rc_file = out.join("silvermoon.rc");
    if let Err(e) = res.write_resource_file(&rc_file) {
        require_icon(format!("写资源脚本失败：{e}"));
        return;
    }

    match compile_gnu(&rc_file, &out) {
        Some(obj) => {
            println!("cargo:rustc-link-arg={}", obj.display());
            println!("cargo:warning=已嵌入图标资源（GNU）：{}", icon.display());
        }
        None => require_icon("GNU 资源编译失败（未找到可用的 windres？）".to_string()),
    }
}

/// 图标嵌入失败时的处置：默认让构建失败。
///
/// 为什么不用 `cargo:warning` 就算了：这个失败**没有任何下游信号** ——
/// 构建成功、CI 全绿、打包正常，只有用户装上后看到空白图标。
/// 实测就这样漏过一次（MSVC 下裸 `rc` 不在 PATH，资源根本没编出来）。
///
/// 需要临时跳过时显式设 `SILVERMOON_ALLOW_MISSING_ICON=1`，
/// 让「接受缺图标」成为一个有意为之的选择，而不是默认行为。
fn require_icon(reason: String) {
    if std::env::var("SILVERMOON_ALLOW_MISSING_ICON").as_deref() == Ok("1") {
        println!("cargo:warning=图标缺失但已显式允许：{reason}");
        return;
    }
    panic!("启动器图标嵌入失败：{reason}。快捷方式的图标取自目标 exe，缺图标会让桌面快捷方式变成空白方块。请修复资源编译器；若确实要跳过，设置 SILVERMOON_ALLOW_MISSING_ICON=1。");
}

/// GNU 路径：windres（可能带目标前缀）编成 COFF 对象，返回其路径。
///
/// 返回的对象由调用方通过 `cargo:rustc-link-arg` 直接交给链接器 ——
/// 这是 `.rsrc` 能进最终 exe 的关键（见文件头说明）。
fn compile_gnu(rc_file: &Path, out: &Path) -> Option<PathBuf> {
    let obj = out.join("silvermoon.res.o");
    for bin in ["windres", "x86_64-w64-mingw32-windres"] {
        let status = Command::new(bin)
            .arg("-I")
            .arg(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
            .arg("-i")
            .arg(rc_file)
            .arg("-o")
            .arg(&obj)
            .arg("-O")
            .arg("coff")
            .status();
        if matches!(status, Ok(s) if s.success()) {
            return Some(obj);
        }
    }
    println!("cargo:warning=未找到可用的 windres");
    None
}
