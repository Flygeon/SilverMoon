//! SilverMoon 的 B 站协议层（纯逻辑，无 IO）。
//!
//! ## 为什么单独一个 crate
//!
//! 原实现把 B 站客户端整个放在渲染进程的 TypeScript 里
//! （`apps/desktop/src/utils/bilibili.ts`，约 2400 行），而网易云 / 酷狗 / Pixiv /
//! 番剧 / 小说的同类客户端都在 Rust。这带来三个问题：
//!
//! 1. 签名、弹幕解析这类**纯计算**占用了渲染主线程与 JS 堆；
//! 2. 同一件事有两套写法，维护面翻倍；
//! 3. 协议逻辑无法单测（依赖网络与宿主桥）。
//!
//! 拆出这个 crate 后：纯逻辑进 Rust 且有单测，HTTP 编排留在 backend
//! （见 `backend/src/bilibili.rs`），前端只做展示。
//!
//! ## 模块
//!
//! - [`wbi`]：WBI 请求签名（mixin key 推导 + `w_rid` 计算）
//! - [`danmaku`]：弹幕 XML 解析与模式映射
//! - [`text`]：文本 / 数值归一化（去高亮标签、封面地址、时长、计数、画质标签）
//! - [`model`]：与前端 TS 接口同形的数据结构
//! - [`parse`]：上游 JSON → 模型
//!
//! ## 边界
//!
//! 这里**不做**两件事，且是有意的：
//! - **不发请求**：所有函数都是纯函数，网络由调用方负责；
//! - **不做本地化展示**（如「3 天前」）：那依赖本机时区，属于 UI 层，
//!   留在前端 `biliPubdate`，避免把时区语义塞进协议层。

pub mod danmaku;
pub mod model;
pub mod parse;
pub mod text;
pub mod wbi;

pub use danmaku::{map_mode, parse_danmaku_xml, Danmaku, MAX_DANMAKU};
pub use model::{BiliAccount, BiliDetail, BiliOwner, BiliPart, BiliStat, BiliVideo};
pub use parse::{video_from_feed, video_from_search};
pub use text::{
    clock_or_num, count, duration, image_url, media_url, num, parse_clock, quality_label, str_of,
    strip_html,
};
pub use wbi::{
    encode_value, file_name_of, mixin_key_from_nav, mixin_key_from_urls, signed_query,
    MIXIN_KEY_ENC_TAB,
};
