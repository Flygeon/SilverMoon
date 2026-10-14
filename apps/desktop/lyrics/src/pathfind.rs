//! 纯路径解析（**不依赖任何 Win32 API**）。
//!
//! 与 splash 的 pathfind.rs 同一思路：发布布局与直觉不同，而这类缺陷
//! **只在安装后暴露**，本地开发永远碰不到。把它抽成无平台依赖的纯函数后，
//! 就能在 Linux/CI 上用 `cargo test` 真跑断言（而不是靠人眼审阅）。
//!
//! 本进程需要定位两样东西：
//! 1. **歌词页资源**（`lyrics-web/` 目录）—— 由 WebView2 加载；
//! 2. **宿主 Electron**（`SilverMoon.exe`）—— 仅用于日志定位，找不到也不致命。
//!
//! electron-builder 的 `extraResources` 把文件放进 `<安装目录>\resources\`，
//! 所以本进程的可执行文件与歌词页资源**同级**，而与 Electron 主程序**不同级**。

use std::path::{Path, PathBuf};

/// 歌词页资源的目录名（打包后与可执行文件同级）。
pub const WEB_DIR: &str = "lyrics-web";

/// 歌词页入口文件名。
pub const WEB_ENTRY: &str = "index.html";

/// Electron 主程序文件名（与 electron-builder 的 productName 一致）。
pub const ELECTRON_EXE: &str = "SilverMoon.exe";

/// 按优先级列出歌词页资源的候选目录。
///
/// 顺序即语义：
/// 1. **可执行文件同目录下的 lyrics-web/** —— 发布布局（extraResources 落地处）；
/// 2. **上一级目录下的 lyrics-web/** —— 开发态（target/release/ 之上是 crate 根）。
pub fn web_dir_candidates(here: &Path) -> Vec<PathBuf> {
    let mut out = vec![here.join(WEB_DIR)];
    if let Some(parent) = here.parent() {
        out.push(parent.join(WEB_DIR));
    }
    out
}

/// 从候选里挑出第一个真实存在的歌词页目录（以入口文件为准）。
pub fn pick_web_dir(here: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    web_dir_candidates(here)
        .into_iter()
        .find(|dir| exists(&dir.join(WEB_ENTRY)))
}

/// 按优先级列出 Electron 的候选路径（与 splash 一致：同目录 → 上一级）。
pub fn electron_candidates(here: &Path) -> Vec<PathBuf> {
    let mut out = vec![here.join(ELECTRON_EXE)];
    if let Some(parent) = here.parent() {
        out.push(parent.join(ELECTRON_EXE));
    }
    out
}

pub fn pick_electron(here: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    electron_candidates(here).into_iter().find(|p| exists(p))
}

/// 把本地文件路径转成 WebView2 能加载的 `file://` URL。
///
/// 为什么不用 `app://`：那是 Electron 注册的私有协议，WebView2 不认。
/// 而 `file://` 有它自己的坑：
/// - Windows 路径用反斜杠，URL 必须用正斜杠；
/// - 盘符路径要写成 `file:///C:/...`（三条斜杠），两条会被当成主机名；
/// - 路径里的空格与中文必须百分号编码，否则 WebView2 加载失败。
pub fn file_url(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if !s.starts_with('/') {
        // Windows 盘符路径：C:/x → /C:/x，拼上 file:// 后就是 file:///C:/x
        s = format!("/{s}");
    }
    format!("file://{}", encode_url_path(&s))
}

/// 对 URL 路径做百分号编码。
///
/// 只编码「路径里非法但文件系统里合法」的字符。**不能**直接编码整个字符串：
/// `/` 是路径分隔符必须保留，`:` 在盘符里也要保留（否则 file:///C:/ 变
/// file:///C%3A/ 会加载失败）。
fn encode_url_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | '/' | ':' => out.push(ch),
            _ => {
                // UTF-8 逐字节编码（一个中文字符会变成 3 组 %XX）
                let mut buf = [0u8; 4];
                for byte in ch.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn exists_only<'a>(paths: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        let set: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |p: &Path| set.contains(p)
    }

    #[test]
    fn web_dir_candidates_same_dir_then_parent() {
        let here = Path::new("/app/resources");
        let c = web_dir_candidates(here);
        assert_eq!(c[0], PathBuf::from("/app/resources/lyrics-web"));
        assert_eq!(c[1], PathBuf::from("/app/lyrics-web"));
    }

    #[test]
    fn published_layout_found_in_same_dir() {
        // 发布布局：extraResources 把 lyrics-web 放在可执行文件旁边
        let here = Path::new("/app/resources");
        let hit = pick_web_dir(here, exists_only(&["/app/resources/lyrics-web/index.html"]));
        assert_eq!(hit, Some(PathBuf::from("/app/resources/lyrics-web")));
    }

    #[test]
    fn dev_layout_found_via_parent() {
        // 开发态：target/release/ 之上是 crate 根，lyrics-web 在 crate 根
        let here = Path::new("/crate/target/release");
        let hit = pick_web_dir(here, exists_only(&["/crate/lyrics-web/index.html"]));
        assert_eq!(hit, Some(PathBuf::from("/crate/lyrics-web")));
    }

    #[test]
    fn missing_web_dir_returns_none() {
        let here = Path::new("/app/resources");
        assert_eq!(pick_web_dir(here, |_| false), None);
    }

    #[test]
    fn electron_candidates_match_splash_convention() {
        let here = Path::new("/app/resources");
        let c = electron_candidates(here);
        assert_eq!(c[0], PathBuf::from("/app/resources/SilverMoon.exe"));
        assert_eq!(c[1], PathBuf::from("/app/SilverMoon.exe"));
    }

    #[test]
    fn file_url_uses_three_slashes_for_drive_paths() {
        // 两条斜杠会被解析成主机名 "C"，WebView2 加载失败
        let url = file_url(Path::new("C:\\app\\resources\\lyrics-web\\index.html"));
        assert_eq!(url, "file:///C:/app/resources/lyrics-web/index.html");
    }

    #[test]
    fn file_url_encodes_spaces_and_cjk() {
        let url = file_url(Path::new("C:\\Program Files\\银月\\index.html"));
        assert!(url.starts_with("file:///C:/Program%20Files/"));
        // 中文必须编码，且是 UTF-8 逐字节
        assert!(url.contains("%E9%93%B6%E6%9C%88"));
        assert!(url.ends_with("/index.html"));
    }

    #[test]
    fn file_url_keeps_separators_and_colon() {
        let url = file_url(Path::new("C:\\a\\b.html"));
        // 分隔符与盘符冒号不能被编码，否则路径失效
        assert!(url.contains("C:/a/b.html"));
        assert!(!url.contains("%2F"));
        assert!(!url.contains("%3A"));
    }

    #[test]
    fn file_url_handles_unc_style_path() {
        // 已经是正斜杠的路径不应被重复处理
        let url = file_url(Path::new("//server/share/index.html"));
        assert!(url.starts_with("file:////server/share/"));
    }
}
