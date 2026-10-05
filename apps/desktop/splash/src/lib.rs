//! 库入口：**只为了能在宿主（Linux/CI）上跑纯逻辑单元测试**。
//!
//! 启动器本体是 `main.rs`（bin），但它依赖 Win32，宿主上编不过。
//! 把不依赖平台的部分（`pathfind` 路径解析、`prefs` 设置解析、`animation` 动画数学）
//! 在这里重新导出，`cargo test` 就能用宿主目标编译并运行它们 ——
//! 这正是「发布布局 / 主题解析」这类缺陷的回归防线。
//!
//! `theme` 与 `window` 依赖 GDI，只在 Windows 目标编译，因此不在此列。

pub mod animation;
pub mod boot_trace;
pub mod pathfind;
pub mod prefs;
