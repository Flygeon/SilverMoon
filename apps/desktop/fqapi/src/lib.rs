// silvermoon-fqapi —— 番茄内容源核心（独立 sidecar）。
//
// 裁剪自 fqapp 的 rust/src（GPL-3.0）。与原项目的差异：
//   * 删除了 `api/`（flutter_rust_bridge 桥）与 `server.rs`（loopback HTTP 适配器）；
//   * 删除了 `static_files.rs` 与 `endpoints/webui.rs` / `endpoints/pages.rs`；
//   * `dispatch.rs` 保留为纯函数式分发器（无 HTTP 概念），由 main.rs 的 stdio 协议驱动。
//
// 分层：
//   dispatch  - 唯一请求分发器（进程内调用）
//   endpoints - 路由表与业务处理器
//   upstream  - 带签名的 HTTP 访问、设备轮换、DH/CM 密钥交换
//   device    - 持久化设备池 + 注册
//   sign      - 请求签名原语

pub mod chapter;
pub mod config;
pub mod crypto;
pub mod device;
pub mod dispatch;
pub mod endpoints;
pub mod error;
pub mod filter;
pub mod json;
pub mod sign;
pub mod timeutil;
pub mod upstream;
