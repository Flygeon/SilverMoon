//! 库入口：**只为了能在宿主（Linux/CI）上跑纯逻辑单元测试**。
//!
//! 歌词窗口本体是 `main.rs`（bin），它依赖 Win32 与 WebView2，宿主上编不过。
//! 把不依赖平台的部分在这里重新导出，`cargo test` 就能用宿主目标编译并运行。
//!
//! 这与 splash 的取舍一致（见 apps/desktop/splash/src/lib.rs）：**把容易算错的
//! 数学与协议解析抽成纯函数**，绘制与窗口层只负责调用。本机没有 MSVC，
//! `cargo build` 跑不了，所以「能在 CI 上真跑断言」的部分要尽量多。
//!
//! 收录范围：几何（anchor）、动画数学（animation）、协议（ipc）、
//! 逐字填充（karaoke）、路径解析（pathfind）、宿主消息转 JS（bridge）。
//! 不含：窗口创建、任务栏嵌入、WebView2（那些必须 Windows 目标）。

pub mod anchor;
pub mod animation;
pub mod bridge;
pub mod ipc;
pub mod karaoke;
pub mod pathfind;
