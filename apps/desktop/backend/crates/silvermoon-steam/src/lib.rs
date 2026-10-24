//! # silvermoon-steam
//!
//! Steam **CM 连接层**与 depot 下载器。
//!
//! ## 它在链路里的位置
//!
//! 登录 / 游戏库 / 启动 / 详情都走纯 HTTPS WebAPI（见 `electron/steam/`），
//! 不需要本 crate。**只有下载**需要它：
//!
//! ```text
//! refresh_token ──CM 长连接──> GetManifestRequestCode / GetCDNAuthToken
//!                                        │
//!                                        v
//!                      CDN 拉 manifest + 分块 ——> 写入 steamapps
//! ```
//!
//! ## 为什么下载必须走 CM
//!
//! 那两个 service method 在 WebAPI 上**不存在**（实测 404），而没有它们，
//! 直接请求 CDN 的 manifest 会返回 **401**（实测）。所以没有 CM 就没有下载。
//!
//! ## 可降级
//!
//! 本 crate 的任何失败都不影响应用主流程：没有 CM 时「安装」按钮回退为
//! 唤起 Steam 官方客户端。

pub mod cm;

pub use cm::{CmError, CmManager, CmSession};
