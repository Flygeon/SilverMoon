//! 主题偏好的解析（**纯逻辑，无 Win32 依赖**）。
//!
//! 为什么单独成模块：启动器要在 Electron 起来**之前**决定 splash 的亮/暗，
//! 因此必须自己去读应用设置。而「读设置」这件事有两个真实的坑：
//!
//! 1. 设置文件是嵌套 JSON，`settings.theme` 与 `settings.readerTheme` 同时存在 ——
//!    用子串/正则去捞 `"theme"` 会命中 `readerTheme`（本仓实测有这两个键）；
//! 2. 取值 "system" 时要有系统亮暗兜底。
//!
//! 把解析写成纯函数后，就能在 Linux 上直接跑单元测试（见文件末尾），
//! 不用依赖 Windows 环境 —— 与 `pathfind.rs` 同一思路。

use serde_json::Value;

/// 亮/暗模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
}

impl Mode {
    /// 是否深色（画图时用得上）
    pub fn is_dark(self) -> bool {
        matches!(self, Mode::Dark)
    }
}

/// 从 `settings.json` 全文里解出「用户选的主题」。
///
/// 结构是 `{ "settings": { "theme": "dark", ... }, ... }`，
/// 键路径固定为 `settings.theme`。取值语义与 `src/stores/settings.ts` 的
/// `ThemeMode = "system" | "light" | "dark"` 一致。
///
/// 任何异常（文件为空、JSON 坏、键缺失、值不认识）都返回 `None`，
/// 由调用方回退到系统亮暗 —— **绝不猜**。
pub fn theme_from_settings(json: &str) -> Option<&'static str> {
    let root: Value = serde_json::from_str(json).ok()?;
    let value = root.get("settings")?.get("theme")?.as_str()?;
    match value {
        "light" => Some("light"),
        "dark" => Some("dark"),
        "system" => Some("system"),
        _ => None,
    }
}

/// 解析最终模式。
///
/// `pref` = `settings.theme` 的值（可能为 `None`）；
/// `system_dark` = 系统亮暗（Windows 上取自注册表 AppsUseLightTheme）。
///
/// 规则：
/// - `Some("dark")` / `Some("light")` → 用户显式选择优先；
/// - `Some("system")` 或 `None` → 跟随系统。
pub fn resolve(pref: Option<&'static str>, system_dark: bool) -> Mode {
    match pref {
        Some("dark") => Mode::Dark,
        Some("light") => Mode::Light,
        // "system" 与任何未知值都跟随系统
        _ => {
            if system_dark {
                Mode::Dark
            } else {
                Mode::Light
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_explicit_dark_and_light() {
        assert_eq!(
            theme_from_settings(r#"{"settings":{"theme":"dark"}}"#),
            Some("dark")
        );
        assert_eq!(
            theme_from_settings(r#"{"settings":{"theme":"light"}}"#),
            Some("light")
        );
        assert_eq!(
            theme_from_settings(r#"{"settings":{"theme":"system"}}"#),
            Some("system")
        );
    }

    /// 真实设置文件里 `theme` 与 `readerTheme` 并存；
    /// 这也是不能用「搜 '"theme"' 子串」那种取巧写法的原因。
    #[test]
    fn does_not_confuse_reader_theme() {
        let json = r#"{"settings":{"readerTheme":"dark","theme":"light"}}"#;
        assert_eq!(theme_from_settings(json), Some("light"));
    }

    #[test]
    fn reader_theme_before_theme_is_ignored() {
        let json = r#"{"settings":{"readerTheme":"light","theme":"dark","readerFont":"x"}}"#;
        assert_eq!(theme_from_settings(json), Some("dark"));
    }

    /// 顶层也有个 theme、且值不同：必须取 settings 里面那个
    #[test]
    fn ignores_top_level_theme() {
        let json = r#"{"theme":"dark","settings":{"theme":"light"}}"#;
        assert_eq!(theme_from_settings(json), Some("light"));
    }

    #[test]
    fn bad_input_returns_none() {
        assert_eq!(theme_from_settings(""), None);
        assert_eq!(theme_from_settings("not json"), None);
        assert_eq!(theme_from_settings("{}"), None);
        assert_eq!(theme_from_settings(r#"{"settings":{}}"#), None);
        assert_eq!(theme_from_settings(r#"{"settings":{"theme":null}}"#), None);
        assert_eq!(theme_from_settings(r#"{"settings":{"theme":42}}"#), None);
        // 未知取值也不猜
        assert_eq!(
            theme_from_settings(r#"{"settings":{"theme":"sepia"}}"#),
            None
        );
    }

    #[test]
    fn resolve_prefers_explicit_choice_over_system() {
        // 用户显式选了 dark，而系统是亮色 → 仍然暗
        assert_eq!(resolve(Some("dark"), false), Mode::Dark);
        assert_eq!(resolve(Some("light"), true), Mode::Light);
    }

    #[test]
    fn resolve_follows_system_when_system_or_unknown() {
        assert_eq!(resolve(Some("system"), true), Mode::Dark);
        assert_eq!(resolve(Some("system"), false), Mode::Light);
        assert_eq!(resolve(None, true), Mode::Dark);
        assert_eq!(resolve(None, false), Mode::Light);
    }
}
