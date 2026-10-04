//! 构建脚本：把应用图标与版本信息嵌进启动器 exe。
//!
//! **为什么必须内嵌图标**：安装后快捷方式指向 `silvermoon-splash.exe`，
//! 而 Windows 取的是**目标 exe 自己的图标资源**。不嵌的话桌面快捷方式就是个
//! 空白方块（实机反馈过）—— 之前只有 Electron 的 SilverMoon.exe 有图标。
//!
//! **为什么不用 `winresource::compile()` 的自动链接**：
//! 它的 GNU 路径是「windres 编出 resource.o → ar 打成 libresource.a →
//! cargo:rustc-link-lib=static:+whole-archive=resource」。实测在这套工具链下
//! `.rsrc` 节**没能进最终 exe**：objdump -h 查不到该节，而中间产物 resource.o
//! 里明明有。排查过 strip / lto / --gc-sections 都不是原因；同一个对象文件用
//! gcc 直接链就能得到 .rsrc。与其继续和静态库成员提取周旋，不如**把目标文件
//! 直接交给链接器**（cargo:rustc-link-arg）—— 这也正是 winresource 自己在 MSVC
//! 路径上的做法，确定性更高。
//!
//! 分工：winresource 只负责**生成 .rc**（图标路径与版本号的拼接），
//! 编译成对象与链接由本脚本接管。
//!
//! 失败时不 panic：图标缺失只影响观感，不该让整个构建挂掉，
//! 但一定打印 cargo:warning，避免「静默没图标」直到用户装上才发现。

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../backend/icons/icon.ico");

    // 非 Windows 目标（宿主上跑纯逻辑测试）直接跳过，
    // 否则会因为没有资源编译器而报错。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let icon = manifest.join("../backend/icons/icon.ico");
    if !icon.is_file() {
        println!(
            "cargo:warning=找不到图标 {}，启动器将没有图标资源",
            icon.display()
        );
        return;
    }

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());

    // 1) 生成资源脚本（winresource 把图标路径与版本号写成 .rc）
    let mut res = winresource::WindowsResource::new();
    res.set_icon(icon.to_str().unwrap_or_default());
    res.set("ProductName", "SilverMoon");
    res.set("FileDescription", "SilverMoon 启动器");
    res.set("LegalCopyright", "Copyright © SilverMoon contributors");

    let rc_file = out.join("silvermoon.rc");
    if let Err(e) = res.write_resource_file(&rc_file) {
        println!("cargo:warning=写资源脚本失败（{e}）；启动器将没有图标资源");
        return;
    }

    // 2) 编成对象文件并直接交给链接器
    match compile_to_object(&rc_file, &out) {
        Some(obj) => {
            println!("cargo:rustc-link-arg={}", obj.display());
            println!("cargo:warning=已嵌入图标资源：{}", icon.display());
        }
        None => println!("cargo:warning=资源编译失败，图标未嵌入"),
    }
}

/// 把 `.rc` 编成可链接的对象文件。
///
/// MSVC 用 `rc /nologo /fo out.obj in.rc`；GNU 用 `windres -O coff`。
/// 按 `CARGO_CFG_TARGET_ENV` 分支，两条路都产出可直接 link 的 COFF 对象。
fn compile_to_object(rc_file: &Path, out: &Path) -> Option<PathBuf> {
    let is_msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");

    if is_msvc {
        let obj = out.join("silvermoon.res.obj");
        let status = Command::new("rc")
            .arg("/nologo")
            .arg("/fo")
            .arg(&obj)
            .arg(rc_file)
            .status();
        return match status {
            Ok(s) if s.success() => Some(obj),
            other => {
                println!("cargo:warning=rc 执行失败：{other:?}");
                None
            }
        };
    }

    // GNU：windres 有带目标前缀的变体，逐个试
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
