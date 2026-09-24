//! 图标句柄。
//!
//! 业务代码只在托盘里用到图标（`app.default_window_icon()` → `TrayIconBuilder::icon()`），
//! 而真正的图标资源由宿主（Electron）持有。因此这里只保留一个路径句柄，
//! 用于让 `tray.rs` 的 `ok_or_else(|| AssetNotFound)` 分支保持可达。

use std::path::PathBuf;
use std::sync::OnceLock;

/// 等价 `silvermoon_ipc::image::Image`（仅保留路径这一必要信息）。
#[derive(Debug, Clone)]
pub struct Image {
    /// 图标文件路径。宿主会优先使用自己的图标，这里主要供调试与降级使用。
    pub path: PathBuf,
}

/// 应用图标。路径来源优先级：`SILVERMOON_ICON_PATH` → 可执行文件同目录的 `icon.png`。
pub fn app_icon() -> Option<&'static Image> {
    static ICON: OnceLock<Option<Image>> = OnceLock::new();
    ICON.get_or_init(|| {
        let path = std::env::var_os("SILVERMOON_ICON_PATH")
            .map(PathBuf::from)
            .or_else(|| {
                let exe = std::env::current_exe().ok()?;
                Some(exe.parent()?.join("icon.png"))
            })?;
        Some(Image { path })
    })
    .as_ref()
}
