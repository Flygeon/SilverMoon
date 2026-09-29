# 银月（SilverMoon）后端语言迁移 · 粗略方案

> 目标：把"可迭代的业务逻辑"从 Rust 后端进程逐步迁出到更易本地开发/编译的语言，
> 仅保留 Rust 做不可替代的原生 / vendored 部分。本文是路线图，不是最终设计。

---

## 1. 背景与痛点

当前后端是一个 Rust sidecar（见 `backend/`），由 Electron 主进程以子进程方式拉起，
通过本地 HTTP 暴露 ~150 个命令。实际痛点：

- **本机无 Rust 工具链**，所有编译只能走 CI，改一行等几分钟反馈。
- Rust 编译（即便 thin LTO）在 CI 上仍偏慢，迭代成本高。
- 协议/解析类业务占了绝大多数，这部分用 Rust 写收益有限、维护成本高。

迁移目标：**业务层用更高生产力、可本地秒级编译的语言重写；Rust 退居"原生壳"**。

---

## 2. 后端业务盘点结论（来自代码盘点）

| 类别 | 代表模块 | 耦合性质 | 迁移属性 |
|---|---|---|---|
| 本地媒体库 | `scan` / `metadata` / `thumbnail` / `song` / `stats` / `book` / `skin` / `media` / DB schema | 纯文件+SQLite，跨平台 | **易** |
| 在线音乐-网易云 | `netease.rs`（1990 行，weapi/eapi/xeapi 签名） | 纯逻辑+网络，跨平台 | **易（量大）** |
| 在线图片 | `pixiv.rs`（1444 行，PKCE+代理） | 纯逻辑+网络 | **易（量大）** |
| 在线小说 | `novel.rs` / `novel_bqg.rs` / `novel_auth.rs` | 纯 HTML 解析+DB；`novel_auth` 走宿主 WebView 取 cookie | **易 / 中** |
| WebDAV / ffmpeg | `webdav.rs` / `ffmpeg.rs` | 纯逻辑+外部二进制，跨平台 | **易** |
| 在线动漫 | `anime.rs`（1549 行，规则抓取+隐藏 WebView 取流） | 抓取纯逻辑；`anime_webview_resolve` 依赖宿主 WebView | **中（宿主耦合）** |
| 扩展框架 | `extension.rs`（912 行，拉起引擎子进程+宿主代注册窗口/热键/托盘） | 宿主耦合 + 子进程管理 | **中** |
| 系统媒体控制 | `smtc.rs` | **强 Windows 原生**（smtc-tokio / WinRT） | **难，建议保留原生层** |
| 酷狗服务端 | `kugou_server/`（13.4k 行，AGPL-3.0 vendored） | 完整 Rust 协议实现，被 `bridge::call` 进程内直调 | **难，建议保留 Rust** |
| IPC 契约层 | `silvermoon-ipc` + `-macros` | sidecar 与 Electron 的进程边界 | **不可破坏，须复刻或保留** |

**核心结论**：全仓库 `#[cfg(windows)]` 几乎都是 `.exe` 后缀 / 隐藏控制台窗口这类轻量差异；
唯一硬 Windows 原生只有 `smtc.rs`。因此"迁语言"在技术上是**可行且低风险的**，只要处理好三块壁垒。

---

## 3. 目标语言选型

| 语言 | 适配度 | 优点 | 风险 / 代价 |
|---|---|---|---|
| **Go（推荐主体）** | ★★★★★ | 单静态二进制=直接替换 Rust sidecar；本地秒级编译；stdlib 覆盖 HTTP/SSE/SQLite/crypto/并发；150 命令易 1:1 移植 | 需把 TS 解析逻辑重写一遍；无泛型历史包袱小 |
| **TypeScript / Node（备选）** | ★★★★☆ | 与前端同语言，可复用 `src/utils/kugou.ts` 等归一逻辑，零语言切换 | 需随包分发 Node 运行时（或 bun build/pkg 打包）；原生互操作弱于 Go |
| **C++** | ★★☆☆☆ | 适合 SMTC/WinRT 原生部分 | 业务层用 C++ 成本最高、收益最低，重新引入内存安全负担；**不建议做主体** |
| **C#** | ★★★☆☆ | Windows SMTC 原生友好 | 跨平台（Linux 用户）支持弱，与现有 Electron 分发不搭 |

**推荐组合**：**Go 作为新业务后端主体 + Rust 保留为"原生壳"**（kugou_server 独立 sidecar 或 cdylib；SMTC 留 Rust 或用 WinRT）。
若你更看重"复用前端 TS 代码、零语言切换"，则改用 **TypeScript/Node** 作为主体（代价是分发体积与运行时）。

---

## 4. 分层策略（关键）

```
Electron 主进程 ──POST /cmd + SSE /events──> 新后端(Go/TS)  ← 复刻同一套 HTTP 契约
        ^                                         │
        └──────── host POST /_host ───────────────┘   (窗口/托盘/热键/WebView 反向 RPC)
```

- **进程模型完全不变**：新后端仍监听 `127.0.0.1` 随机端口、读 `SILVERMOON_TOKEN`、stdin 关闭即退出、
  启动打 `SILVERMOON_READY {"port":N}`。Electron 主进程**一行不改**。
- **命令契约必须逐条对齐**：`{cmd, args}` → `camelCase` 形参解包 + `Host`/`State` 注入约定
  （`silvermoon-ipc-macros` 的语义）。新语言要有等价的路由注册 + 参数反序列化。
- **Rust 保留层**：
  - `kugou_server`：作为独立 Rust sidecar 暴露 HTTP，新后端经网络调用；或编成 cdylib 供新语言 FFI。
  - `smtc.rs`：留 Rust 实现，新后端通过内部 HTTP/FFI 调用；或以后用 WinRT(C++/C#) 重写。
  - `silvermoon-ipc` 契约：原样保留作薄壳，或新语言精确复刻（优先级最高，是接口轴心）。

---

## 5. 迁移路线图（分阶段、可灰度）

- **阶段 0 · 契约基线**：录制现有 ~150 命令的请求/响应样本，建回放测试，作为回归基准。
- **阶段 1 · 新骨架**：用新语言复刻 HTTP 契约（/cmd、/events、/_host、token、stdin 看门狗），
  先跑通 1–2 个纯逻辑命令（如 `media` 分类、`song` 详情），验证 Electron 无感切换。
- **阶段 2 · 本地库**：迁 `scan`/`metadata`/`thumbnail`/`song`/`stats`/`book`/`skin`/DB schema。
  纯文件+SQLite，风险最低，先建立信心。
- **阶段 3 · 在线协议**：迁 `netease`/`pixiv`/`novel`/`novel_bqg`/`webdav`。
  纯逻辑但体量大，**加密签名（weapi/eapi/xeapi、X25519+AES-GCM+HMAC）必须单测回归**。
- **阶段 4 · 宿主耦合**：迁 `anime`/`novel_auth`/`extension` 的"走 `/_host`"部分，
  继续由 Electron 拉起、继续 fulfill 宿主协议；`anime_webview_resolve` 保持经宿主 WebView。
- **阶段 5 · 原生壁垒（可选）**：SMTC 留 Rust 或 WinRT 重写；kugou_server 保持 Rust sidecar / cdylib FFI。
- **灰度方式**：每个 Rust 命令被新后端覆盖并验证后，从 `generate_handler!` 移除，逐步切换；
  过渡期可新旧并存、按命令路由。

---

## 6. 可下沉到后端、且有收益的前端业务

当前前端承担了一部分"数据归一/路由"，与后端重复且难单测，建议下沉：

- **`src/utils/kugou.ts`**：`mergeNested` 浅展开、时长单位判定（>10000 视为毫秒）、
  封面 URL 模板（`{size}`→400、`c1.kgimg.com`→`imge.kugou.com`/`stdmusic` 二次尝试）。
  → 下沉后前端只渲染，真源统一、可单测。
- **`src/utils/onlineCache.ts`**：host 白名单 + 按 host 路由到后端代理（如 `kugou_cover`）。
  → 路由/白名单规则下沉，前端只调统一入口。
- 封面/媒体 URL 构造中散落的 host 改写逻辑。
- **收益**：前端瘦身、前后端不再双份归一、统一真源、后端可做缓存与鉴权、CLI 易验证。

---

## 7. 风险与注意

1. **命令签名对齐**：camelCase 形参、`Host`/`State` 注入约定必须逐命令对齐，否则前端协议不兼容。
2. **kugou_server 无法轻松迁**：它是 AGPL-3.0 vendored 的完整 Rust 实现，重写成本=从零造酷狗客户端。
   **Rust 必须继续在场**（sidecar 或 cdylib）。
3. **SMTC 是硬 Windows 原生**：依赖 smtc-tokio 的 STA/WinRT 桥接，迁 C++ 需 Windows.Media 原生重写。
4. **加密协议精度**：网易云签名/xeapi 是风控关键，移植须单测回归，避免被封。
5. **进程契约不可破坏**：token、stdin-EOF 退出、`SILVERMOON_READY` 输出格式。
6. **许可证**：整体 GPL-3.0；kugou_server AGPL-3.0。若未来重写酷狗协议，须 AGPL 兼容。
7. **本地验证**：本机仍无 Rust 工具链，Rust 保留层改动继续交 CI；新语言层可本地秒级编译+单测。

---

## 8. 待你确认的三个决策

1. **主体语言**：Go（推荐，单二进制）/ TypeScript-Node（复用前端代码）/ C++（仅建议做原生部分）？
2. **kugou_server 处理**：保留为独立 Rust sidecar（推荐）/ 编 cdylib 供 FFI / 彻底重写（不推荐）？
3. **SMTC 处理**：留 Rust 原生层（推荐）/ WinRT C++ 重写 / C# 重写？

确认后我可以把"阶段 1 骨架"落地成一个最小可运行的新后端（复刻 HTTP 契约 + 1–2 个命令），
并配套回放测试基线，作为第一步 PoC。
