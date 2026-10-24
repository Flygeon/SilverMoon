//! 从**本地 Steam 缓存**读取 manifest。
//!
//! ## 为什么这条路很重要
//!
//! 获取 depot key 需要 CM 的老式消息 `CMsgClientGetDepotDecryptionKey`，
//! 而当前 `steam-vent 0.5` 没有为它实现 `NetMessage`（见 `downloader.rs` 的说明），
//! 所以**未安装**的 depot 我们解不开。
//!
//! 但**已安装**的游戏不需要走那条路：Steam 客户端早就在本地缓存了 manifest 明文。
//!
//! ```text
//! <Steam>/depotcache/<depot_id>_<manifest_gid>.manifest
//! ```
//!
//! 实测（本机 Stardew Valley 的 depot 1463922）：
//! - 首 4 字节 `0x71f617d0` = PAYLOAD_MAGIC
//! - 次 4 字节 = section 长度
//! - 随后 `0x1f4812be` = METADATA_MAGIC
//! - metadata 里 `depot_id=1463922`、`gid` 与文件名一致、`filenames_encrypted=false`
//!
//! 也就是说：**已装游戏的 manifest 是明文、文件名未加密**，本模块能直接解析出
//! 完整文件清单 —— 这正是「校验/补全已安装游戏」真正需要的能力。
//!
//! ## 用途
//!
//! - 校验已安装文件的完整性（按 manifest 的 size/chunk 比对）
//! - 显示某款已装游戏的真实文件数 / 总体积
//! - 将来做「修复缺失文件」时，知道缺哪些 chunk

use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest::ContentManifest;

/// 一个本地缓存的 manifest 条目。
#[derive(Debug, Clone)]
pub struct CachedManifest {
    pub depot_id: u32,
    pub manifest_gid: u64,
    pub path: PathBuf,
}

/// 扫描 `<steam_root>/depotcache`，列出所有已缓存的 manifest。
///
/// 文件名格式固定为 `<depot_id>_<gid>.manifest`；不符合的直接跳过
/// （该目录偶尔会有 `.tmp` 之类残留）。
pub fn list_cached_manifests(steam_root: &Path) -> Vec<CachedManifest> {
    let dir = steam_root.join("depotcache");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".manifest") else {
            continue;
        };
        let Some((depot_text, gid_text)) = stem.split_once('_') else {
            continue;
        };
        let (Ok(depot_id), Ok(manifest_gid)) = (depot_text.parse::<u32>(), gid_text.parse::<u64>())
        else {
            continue;
        };
        out.push(CachedManifest {
            depot_id,
            manifest_gid,
            path,
        });
    }
    // 按 depot 排序，输出稳定
    out.sort_by_key(|m| (m.depot_id, m.manifest_gid));
    out
}

/// 找某个 depot 的缓存 manifest（取 gid 最大的那份 = 最新）。
pub fn find_cached_manifest(steam_root: &Path, depot_id: u32) -> Option<CachedManifest> {
    list_cached_manifests(steam_root)
        .into_iter()
        .filter(|m| m.depot_id == depot_id)
        .max_by_key(|m| m.manifest_gid)
}

/// 读取并解析一份缓存 manifest。
pub fn load_cached_manifest(entry: &CachedManifest) -> Result<ContentManifest, String> {
    let raw =
        fs::read(&entry.path).map_err(|e| format!("读取 {} 失败：{e}", entry.path.display()))?;
    let mut manifest = ContentManifest::parse(&raw)
        .ok_or_else(|| format!("解析 {} 失败", entry.path.display()))?;
    // 缓存里的 manifest 通常未加密文件名；有加密标记时无法解密（缺 depot key），
    // 这时返回可读错误而不是静默给出错的路径。
    if manifest.metadata.filenames_encrypted {
        return Err(format!(
            "depot {} 的 manifest 文件名是加密的，缺少 depot key 无法解析",
            entry.depot_id
        ));
    }
    manifest.decrypt_filenames(&[]);
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_manifest_filename() {
        let dir = std::env::temp_dir().join(format!("sm-depotcache-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        // 造两个文件名，验证解析与排序
        fs::write(dir.join("1463922_5952929429667574849.manifest"), b"x").unwrap();
        fs::write(dir.join("1463922_1.manifest"), b"x").unwrap();
        fs::write(dir.join("not-a-manifest.txt"), b"x").unwrap();
        fs::write(dir.join("228980_42.manifest"), b"x").unwrap();

        let list = list_cached_manifests(&dir);
        assert_eq!(list.len(), 3, "非 .manifest 文件应被忽略");
        // 取 gid 最大的
        let newest = find_cached_manifest(&dir, 1463922).expect("应找到");
        assert_eq!(newest.manifest_gid, 5952929429667574849);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_yields_empty() {
        let list = list_cached_manifests(Path::new("/definitely/not/here"));
        assert!(list.is_empty());
        assert!(find_cached_manifest(Path::new("/definitely/not/here"), 1).is_none());
    }
}
