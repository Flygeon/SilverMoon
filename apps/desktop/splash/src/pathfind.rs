//! 纯路径解析逻辑（**不依赖任何 Win32 API**）。
//!
//! 为什么单独成模块：启动器整体是 Windows 程序（user32/gdi32），在 Linux 或本地
//! 跑不起来；而「安装后启动器与 Electron 的相对位置」这个缺陷**只在发布版暴露** ——
//! 曾经因为假设两者同级，导致装出来的应用直接打不开。
//!
//! 把这段判断抽成无平台依赖的纯函数后，就能在 Linux 上用 `rustc --test src/pathfind.rs`
//! **直接执行真实代码**（而不是靠人眼审阅或另写一份复刻逻辑 —— 复刻只能证明
//! 「我以为的逻辑对」）。CI 与本机都跑 `npm run verify:splash-paths`。

use std::path::{Path, PathBuf};

/// Electron 主程序文件名（与 electron-builder 的 productName 一致）。
pub const ELECTRON_EXE: &str = "SilverMoon.exe";

/// 按优先级列出 Electron 的候选路径。
///
/// 顺序即语义：
///
/// 1. **启动器同目录** —— 开发态 / 手工摆放；
/// 2. **上一级目录** —— 发布布局。electron-builder 的 `win.extraResources` 把文件
///    放进 `<安装目录>\resources\`，而 `SilverMoon.exe` 在 `<安装目录>` 根下，
///    所以发布版里启动器**不在** Electron 旁边。
pub fn electron_candidates(here: &Path) -> Vec<PathBuf> {
    let mut out = vec![here.join(ELECTRON_EXE)];
    if let Some(parent) = here.parent() {
        out.push(parent.join(ELECTRON_EXE));
    }
    out
}

/// 从候选里挑出第一个真实存在的 Electron。
///
/// `exists` 注入进来是为了可测：单元测试可以模拟任意布局，无需真的建文件。
pub fn pick_electron(here: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    electron_candidates(here).into_iter().find(|p| exists(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 造一个「只有列出的路径存在」的判定器
    fn exists_only<'a>(paths: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        let set: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |p: &Path| set.contains(p)
    }

    #[test]
    fn candidates_put_same_dir_first_then_parent() {
        let here = Path::new("/app/resources");
        let c = electron_candidates(here);
        assert_eq!(c[0], PathBuf::from("/app/resources/SilverMoon.exe"));
        assert_eq!(c[1], PathBuf::from("/app/SilverMoon.exe"));
    }

    #[test]
    fn published_layout_is_found_via_parent() {
        // 真实发布布局：启动器在 resources/，Electron 在上一级
        let here = Path::new("/app/resources");
        let found = pick_electron(here, exists_only(&["/app/SilverMoon.exe"]));
        assert_eq!(found, Some(PathBuf::from("/app/SilverMoon.exe")));
    }

    #[test]
    fn dev_layout_is_found_via_same_dir() {
        let here = Path::new("/dev/out");
        let found = pick_electron(here, exists_only(&["/dev/out/SilverMoon.exe"]));
        assert_eq!(found, Some(PathBuf::from("/dev/out/SilverMoon.exe")));
    }

    #[test]
    fn same_dir_wins_when_both_exist() {
        // 两者都在时优先同目录（开发态更贴近直觉）
        let here = Path::new("/app/resources");
        let found = pick_electron(
            here,
            exists_only(&["/app/resources/SilverMoon.exe", "/app/SilverMoon.exe"]),
        );
        assert_eq!(found, Some(PathBuf::from("/app/resources/SilverMoon.exe")));
    }

    #[test]
    fn returns_none_when_nothing_exists() {
        let here = Path::new("/app/resources");
        assert_eq!(pick_electron(here, exists_only(&[])), None);
    }

    #[test]
    fn root_dir_does_not_panic_on_missing_parent() {
        // 极端输入：`/` 没有父目录。只要不 panic 即可 ——
        // 此时候选只剩同目录一项（这是正确行为，不该硬凑出第二个）。
        let here = Path::new("/");
        let _ = pick_electron(here, exists_only(&[]));
        assert_eq!(electron_candidates(here).len(), 1);
    }
}
