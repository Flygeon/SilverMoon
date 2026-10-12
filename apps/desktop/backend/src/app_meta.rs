//! 应用元信息与首个启动的旧数据迁移。
//!
//! 单一真源仍是 `silvermoon.config.json`（与 `tauri.conf.json`、`scripts/check-version.mjs`
//! 共用同一个 version 字段）。迁回 Tauri 后不再有 Node 侧的 `electron/config.ts`，
//! 原先由它负责的「把旧项目 LumiLuna 的数据目录整份复制过来」搬到这里，
//! 在 `setup` 阶段跑一次。

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// 应用元信息（`silvermoon.config.json` 的子集）。
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyMigration {
    /// 旧项目的数据目录名（LumiLuna 的 identifier）。
    #[serde(rename = "legacyIdentifier")]
    pub legacy_identifier: String,
}

/// 只解析迁移相关的字段；其余字段由 tauri.conf.json 负责。
#[derive(Debug, Clone, Deserialize)]
struct ConfigFile {
    migration: LegacyMigration,
}

fn read_config() -> Option<ConfigFile> {
    let raw = include_str!("../silvermoon.config.json");
    serde_json::from_str(raw).ok()
}

/// 一次性数据迁移：把旧项目 LumiLuna 的数据目录整份复制过来。
///
/// 只在「新目录还不存在」且「旧目录存在」时执行一次，**只读旧目录、绝不删改**。
/// 迁移内容包含 library.db、设置、皮肤、扩展、登录态等。
///
/// 返回是否真的执行了迁移。任何失败都不阻断启动——新目录照样会被创建，
/// 用户只是需要重新扫描媒体库。
pub fn migrate_legacy_data(app_data_dir: &Path) -> bool {
    let Some(config) = read_config() else {
        return false;
    };
    let Some(root) = app_data_dir.parent() else {
        return false;
    };
    let target = app_data_dir;
    let legacy = root.join(&config.migration.legacy_identifier);

    if target.exists() || !legacy.exists() {
        return false;
    }

    match copy_tree(&legacy, target) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[silvermoon] 旧数据迁移失败：{error}");
            false
        }
    }
}

/// 递归复制目录（保留子目录结构）。
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst: PathBuf = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}
