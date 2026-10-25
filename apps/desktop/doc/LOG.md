# LOG — 银月（SilverMoon）施工记录

> **本文件回答「项目是怎么一步步变成现在这样的」。** 记录每轮施工做了什么、
> **为什么这么做**、以及**验证到什么程度**。
>
> - 现状与操作手册 → [`AGENTS.md`](AGENTS.md)
> - 设计边界与验收标准 → [`SPEC.md`](SPEC.md)
> - 对外可见的版本变化 → [`../CHANGELOG.md`](../CHANGELOG.md)
>
> ### 三层分工（2026-10-17 定稿）
>
> | 层 | 记什么 | 粒度 |
> |---|---|---|
> | commit message | 只写定位所需要点 | 原子步 |
> | **LOG（本文件）** | 施工记录 + **决策原因** | 主题线 |
> | CHANGELOG | 对外可见的功能变化 | 版本 |
>
> **不做 LOG-INDEX**：检索直接 `git log --grep="关键词"` 或按下方日期定位。
> 本文件按**倒序**追加，最新在最上面。
>
> ### 条目格式
>
> ```
> ## YYYY-MM-DD · <主题>
> - **commit**: `hash`（+ 关联 hash）
> - **status**: 已人眼验证 / CI 绿未人验 / 未验证
> - **做了什么**: …
> - **为什么**: …（决策原因，本文件存在的意义）
> - **教训**: …（踩过的坑，供下一个 AI 避雷）
> ```

## 2026-10-25（四）· Steam 下载：安装目录里的同名残留文件会让建目录失败

- **commit**: 见本轮提交
- **status**: Rust 只能由 CI 编译；本地 rustfmt + 逐行走查。新增 2 条单测**未执行**。
- **现象**：上一轮修完 LZMA 后，manifest / chunk 下载 / 解密 / 解压全通了，
  进度走到写盘阶段，报 `depot 2704111: 创建目录失败：当文件已存在时，无法创建该文件。
  （os error 183）`。用户选的安装目录是 `C:\Program Files (x86)\Steam\steamapps\common\Aniya`。
- **根因**：该目录里已有一个 **0 字节的 `Aliya_Data` 文件**（上一轮失败留下的），
  而 manifest 说 `Aliya_Data` 是**目录**。`fs::create_dir_all` 遇到同名文件返回
  Windows `ERROR_ALREADY_EXISTS`（os error 183），整个 depot 直接失败。
  实测确认：`Aliya.exe` 672256 字节已正常写入，`Aliya_Data` 是 0 字节文件。
- **改动**：`downloader.rs` 新增 `ensure_dir()` 替代直接调 `create_dir_all`：
  已是目录直接返回；路径上是普通文件/符号链接则先删掉再建目录（**manifest 是权威**）。
  范围约束：只作用于 `safe_join` 校验过的安装目录内路径，只删单个文件、不递归。
  同时给「写文件」那条路加防护：目标若是**空目录**先 `remove_dir`（非空则如实报错），
  避免 `fs::rename` 在 Windows 上因同名目录失败。
- **为什么值得自愈而不是报错让用户手动删**：这类残留极常见（断点续传半截文件、
  上一版安装残留、用户手建的空文件），而断点续传本身就是本模块的既有能力 ——
  要求用户先去资源管理器删文件，等于把这个能力废掉。
- **新增测试**：
  - `ensure_dir_replaces_conflicting_file`：先造同名 0 字节文件，断言能变成目录，且二次调用幂等。
  - `ensure_dir_keeps_existing_directory_contents`：已有目录时不能删掉里面的文件。
- **教训**：断点续传/增量安装必须假设「磁盘上的状态是脏的」。
  只处理「文件已存在且大小一致就跳过」不够 —— 还要处理**类型冲突**（文件 vs 目录）。

## 2026-10-25（三）· Steam 下载：VZa 的 LZMA 参数必须从封头读

- **commit**: 见本轮提交
- **status**: Rust 只能由 CI 编译；本地做过 rustfmt 与逐行走查。新增 2 条 LZMA 单测**未执行**。
- **现象**：上一轮修完传输层解压后，chunk 已能下载并成功 AES 解密（说明 depot key 正确），
  但卡在 LZMA：`vza: LZMA 解压失败：lzma error: LZ distance 52259912 is beyond
  dictionary size 1048576`。
- **根因**：`VZa` 块里**自带** LZMA 参数，而代码把它写死了。
  正确的封头布局（照 GameNative `depot_chunk.rs::decompress_vzip`）：
  ```text
  [3B "VZa"][4B 版本][5B LZMA props][压缩数据][10B footer，末两字节 "zv"]
  ```
  `props[0]` 是 lc/lp/pb 的打包值（`lc + 9*(lp + 5*pb)`），`props[1..5]` 是小端 dict_size。
  旧代码跳过 8 字节（错误偏移）且固定 `lc=3/lp=0/pb=2` + `dict=1MiB`，
  真实字典远大于 1MiB，任何回溯距离都越界 —— 报错里的 52259912 就是证据。
- **改动**：`chunk.rs` 按上述布局解析 props，字典与 lc/lp/pb 全部来自数据；
  校验 footer 的 `zv` 标记；删掉不再使用的 `LZMA_DICT_SIZE` 常量。
- **新增测试**：
  - `lzma_uses_dict_size_from_chunk_header`：用 `lzma_compress` 造真实 .lzma 流拼成 VZa，
    断言能解出原文。**这条能抓住回归**：`lzma_compress` 默认用 8MiB 字典，
    写死 1MiB 就会解不出来。
  - `lzma_rejects_missing_footer`：footer 的 `zv` 被破坏时必须报错而非输出半截数据。
- **教训**：容器格式里的「固定参数」要当作可疑项。写死 LZMA 参数看起来能跑通小样本，
  但真实数据一旦用到更大字典就炸，而且错误信息（distance vs dictionary size）
  指向的是数据本身，很容易误判成「chunk 损坏」。

## 2026-10-25（二）· Steam 下载：关掉 CDN 请求的自动解压（chunk 是密文）

- **commit**: 见本轮提交
- **status**: Rust 只能由 CI 编译；本地做过 rustfmt 与逐行走查。
- **现象**：上一轮修完 zip 后 manifest 已能解析（报错里出现了文件名 `Aliya.exe` 与
  某个 chunk 的 SHA），但紧接着下载 chunk 报
  `网络错误：读取响应失败：error decoding response body`，进度条停在 0%。
- **根因**：`reqwest` 开了 `gzip` feature，会发 `Accept-Encoding` 并按响应的
  `Content-Encoding` 自动解压。Steam CDN 的 chunk 是 **AES 密文**，
  但某些边缘节点仍给它带上 `Content-Encoding: gzip`（缓存层行为），
  于是 reqwest 拿密文当 gzip 流解，报 `error decoding response body`。
  manifest 之所以没事：它本身就是 zip 包，走的是另一条判断路径。
- **改动**：`cdn.rs` 抽出 `cdn_client()`，对 CDN 拉字节的请求关闭
  `no_gzip / no_brotli / no_deflate / no_zstd`，拿原始字节；
  解密与解压全部交给 `process_chunk` 按自己的魔数判断，不与传输层假设耦合。
  `fetch_servers`（WebAPI 的 JSON）**保持**自动解压 —— 那是正常需要 gzip 的接口。
- **为什么不在拿到字节后再兜底**：reqwest 的解压在 `.bytes()` 内部完成，
  失败时原始字节已经丢了，拿不到可以自己解的东西。必须在 client 层关。
- **教训**：判断「响应体解析失败」时先问「这是传输层在解压，还是我们在解析」。
  这次是前者，而 `error decoding response body` 正是 reqwest 的原文措辞。

## 2026-10-25（一）· Steam 下载续修：CDN 的 manifest 是 zip 包 + 移除游戏 hero 动画

- **commit**: 见本轮提交
- **status**: 前端已本地验证（typecheck / eslint / 单测）；Rust 仍只能由 CI 编译。

### 1. 下载：manifest 响应要先解封装

- **现象**：上一轮修完 error 透传后，报错变成
  `depot 2704111: cache5-hkg1.steamcontent.com: 响应不是 manifest（二进制 0x504b0304...（共 76641 字节））`。
- **根因**：`50 4b 03 04` 是 ZIP 魔数。CDN 对
  `/depot/<id>/manifest/<gid>/5/<code>` 返回的是**装了 manifest 的单条目 zip**，
  而代码把响应体直接交给 `ContentManifest::parse`（它只认 Valve 的分节容器）。
  上一轮新加的错误文案刚好把魔数打了出来，这一轮才能一眼定位。
- **改动**：
  - `manifest.rs` 新增 `ContentManifest::parse_response()`：先试明文，失败再按魔数
    解封装（`PK\x03\x04` → zip 首条目；`1f 8b` → gzip），然后再解析。
  - `downloader.rs` 改调 `parse_response`。
  - 新增 4 条单测：zip 封装能解、gzip 封装能解、明文照常走通、
    垃圾输入返回 None（并断言「裸 parse 对 zip 必须失败」，钉住这个 bug）。
- **为什么用 zip 而不是自己解 inflate**：`zip` crate 已是本 crate 依赖（chunk 的
  `PK` 分支在用），复用比再引一个 inflate 实现省事，也不增加依赖面。
- **未验证**：Rust 未编译；「真实 CDN 响应能否解出可见文件清单」要等装包后实测。

### 2. 移除游戏模块的 hero 动画

- **原因**：用户明确要求「效果不好，全去掉」。前几轮反复调整（同步导航、DOM 直挂过渡名、
  返回时复用元素引用、诊断日志）都没达到可接受手感，继续投入的收益低于成本。
- **改动**：
  - `utils/gameHeroTransition.ts` 收缩为「记住封面 URL」的十几行：`rememberCover` /
    `clearCover` / `clearCoverUrl` + 三个状态。**删掉** `beginCoverFlight` /
    `runViewTransition` / `findCardCover` / `GAME_HERO_VT_NAME` / 诊断日志。
  - `GamesView` / `GameDetailView`：点击与返回改成普通 `router.push` / `router.back`；
    移除两个页面的 `view-transition-name`、根节点的 `--lm-game-hero-vt*` 内联变量。
  - `App.vue`：删掉整段 91 行的 `::view-transition-*` 全局样式（含 reduced-motion 兜底）。
  - 测试改为覆盖新的最小契约（4 条），不再断言 CSS 里存在过渡名。
- **保留**：`activeCoverUrl` 仍把卡片封面传给详情页做**首帧占位** —— 这与动画无关，
  是「点进去立刻有图，而不是先灰块再出图」，去掉反而会退步。
- **教训**：动画参数化到第 4 轮仍不满意时，应该先问「要不要这个动画」，
  而不是继续调参数。这次是用户先提出的。

## 2026-10-24（八）· 修 Steam 应用内下载：manifest 不再强依赖 CDN 票据 + 错误不再静默

- **commit**: 见本轮提交
- **status**: **未验证**（本机无 MSVC 链接器，Rust 只能由 CI 编译）。本地做到的是：
  rustfmt 干净、语法可解析、CDN 行为实测、manifest 解析器用真实数据实测。
- **现象**：详情页点「安装」立刻失败，进度条一帧都没动：
  「没有可下载的内容。depot 2704111: manifest 格式无法解析（CDN 票据未收到：
  cache2-hkg1...：Steam CM 请求失败：Remote returned an error code: Fail; …）」
- **根因（两段，缺一不可）**：
  1. **Steam 拒绝了两条内容 RPC**。那句 Remote returned an error code: Fail 来自 steam-vent 的
     RawNetMessage::into_header_and_message（net.rs:355-358）—— 它检查的是**响应头里的 eresult**，
     而且发生在解析响应体**之前**。所以这是服务端拒绝，不是网络/编码/解析问题。
     方法名与字段名都核对过（ContentServerDirectory.GetManifestRequestCode#1 /
     GetCDNAuthToken#1，字段 app_id / depot_id / manifest_id / host_name 全部对得上），没写错。
  2. **我们把拒绝变成了 0，又把 0 变成了一句没法排查的话**。fetch_manifest_request_code 用
     unwrap_or(0) 吞掉错误 → manifest URL 既无 code 也无 ticket → CDN 回错误页 →
     最终报「manifest 格式无法解析」，而响应体里真正的内容被丢掉了。
- **本轮实测证据（可复现）**：
  - 不带 request code 请求 /depot/<id>/manifest/<gid>/5：lax2 / hkg1 / sha1 / sgp1 四个 cell
    **每个节点都回 401 + 98 字节 HTML**；chunk 路径回 404。
    所以「没有 request code 就下不了」是硬事实，不是可省掉的优化。
  - ContentManifest::parse **不是**根因：把解析器逐行移植到 Node，跑本机 Steam depotcache 里
    12 份真实 manifest，**12/12 全部解析成功**。
- **改了什么**：
  1. cdn.rs：fetch_bytes 改为返回结构化 CdnFetchError（HTTP 状态 + 响应体前缀 + 传输层原因），
     新增 is_auth_denied()（只认 401/403）与 describe_body_prefix()。
  2. cm_requests.rs：新增 ServiceMethodCall / ServiceMethodResponseBody（自己实现
     EncodableMessage / NetMessage，用 k_EMsgServiceMethodCallFromClientNonAuthed）。
     两个 RPC 都先走已登录路径、失败再走 NonAuthed 回退；两条都失败时**把两边的原因都带上**。
  3. downloader.rs：manifest 先不带票据拉，只有 CDN 明确 401/403 才去逐个节点申请票据；
     manifest 改成「逐个节点试 + 当场解析」，解析不了就把响应体开头写进错误；
     request code 拿不到 / 为 0 都进诊断备注，不再静默。
  4. 进度节流 ProgressGate（≤10 次/秒；首次、当前文件变化、100% 必定放行），并且
     **文件内部也报进度** —— 原来只在文件写完后报一次，大文件下载期间进度条完全不动。
- **为什么这样能修好**：
  - 票据从「硬前置」降级为「401/403 才要」，Steam 拒发票据不再连累本来能下的 depot
    （参考实现 GameNative 的 fetch_cdn_auth_token 注释就是 on a 401/403）；
  - 真有 Steam 侧拒绝时，错误里会直接带上 app / depot / manifest 三个 id 与两条路径的 EResult，
    一眼能区分「账号没授权」和「app_id 与 depot 不匹配」；
  - 大文件下载期间进度条会动，不再是「一帧都不动」。
- **仍然没定位的（下一轮第一件事）**：Steam 为什么回 Fail。
  已排除共同原因是 app_branch —— GetCDNAuthToken 根本没有 branch 字段却也失败。
  也**基本排除**「app_id 不是该 depot 的归属 app」：本次失败的是 app 2704110
  （Aliya: Timelink）的 depot 2704111，是同一 app 的直属 depot（depot id 与 app id
  相邻，不是共享组件 / DLC 的形态）。这条只作为「将来遇到共享 depot、DLC depot 时」
  的通用注意事项保留，**不要再用它解释本次现象**。
  下一步看**新错误文案**：它会带 app / depot / manifest 三个 id、两条路径各自的 EResult，
  以及（拿到 code 之后）CDN 的 HTTP 状态与响应体开头。
  若仍是 Fail，重点转向「CM 会话本身缺了什么」—— 同一会话上 GetOwnedGames / PICS /
  GetDepotDecryptionKey 都正常，只有 ContentServerDirectory 这两个方法被拒。
- **教训**：
  1. **协议层的 unwrap_or(0) 等于销毁证据**。默认值可以继续用，但原因必须留下来。
  2. 判断「两条 RPC 同时失败」的共同原因时，**看它们的入参交集**：都吃 app_id + depot_id，
     而 GetCDNAuthToken 没有 branch —— 这一步就把分支假设排掉了，省掉一次无效改动。
  3. **「上游返回 2xx」不等于「拿到了想要的东西」**。非空就收下，等于把错误页当数据用，
     错误会一路漂到很远的地方才炸，且炸出来的话毫无信息量。

## 2026-10-24（七）· 统一到 CM 登录（一次扫码）+ 游戏库搬 CM

- **commit**: 见本轮提交
- **架构修正（用户提出，他是对的）**：原设计是两套登录 ——
  网页扫码（游戏库/WebAPI）+ CM 扫码（下载），用户要扫两次码。这是实现不当。
  确认 CM 本身就提供 `IPlayerService/GetOwnedGames`（proto 里
  `CPlayer_GetOwnedGames_Request` 字段齐全），于是：
  **登录只走 CM，游戏库也走 CM**，一次扫码两用。
- **为什么之前分两套**：当初先在 Node 侧做 WebAPI，因为那条能立即验证；
  CM 当时还没打通。等 CM 通了却没有回头收敛，留下了"两次登录"这个产品缺陷。
- **详情 / 成就保持不动**：商店 API 与社区 XML 本来就**不需要登录**，没有理由搬。
- **踩到的两个坑**：
  1. `electron/ipc.ts` 漏了 `steamOwnedGames` 转发分支 —— 后端命令注册了但宿主没转发，
     桌面端抛「未知的 steam 操作」，前端只能退回旧 WebAPI，统一登录等于白做。
     **新增后端命令必须同时补 IPC 分支**，否则前端拿不到。
  2. `CmError` 相关：`steam.rs` 里重复定义 `hex_value` 触发 E0428 —— 追加命令时
     复用了已有辅助函数的名字。**加命令前先 grep 一遍同名函数**。
- **教训**：能用同一套凭据覆盖两种能力时，不要因为"先做了哪条"就保留两套。
  多一套登录的代价最终由用户承担（多扫一次码），而且两套凭据失效时机不同，排查成本翻倍。

## 2026-10-24（六）· B 站回归修复 + hero 落地 + CM 凭据真因

- **commit**: 见本轮提交
- **B 站（已修好，用户确认）**：日志里 `https://api.bilibili.com/x/player/playurl` 报
  `ERR_BLOCKED_BY_CLIENT`，是 **https** —— 说明上一条「http 放行」没修到触发点。
  真因：`Referer` 是 Chromium 的 **forbidden request header**。
  - 旧版 filter 含 `*.bilibili.com` → 拦截器删掉 Referer 再重设（特权操作，允许）
  - 我为「收窄打击面」去掉它 → 请求带着 net.fetch 传入的 Referer 出发 → 直接 BLOCKED
  - 修法：恢复 filter + 在 http 通道先摘掉 B 站的 Referer，两条路径不打架。
- **hero**：前端日志抓到 `heroEl=null`，导航后元素根本不在 DOM。
  原因：详情页是懒加载组件 + 路由过渡 `mode="out-in"`，固定帧数等不到。
  修法：改成「命中即返回」的短轮询（≤12 帧 ≈200ms）。
  与上一版轮询的区别：上一版等的是**网络数据**（gameDetail），慢网必久等；
  这次等的是「组件挂载 + 一个 DOM 节点」，与网络无关。
- **CM invalid credentials 的真因（我的 bug）**：
  诊断日志打出两个 token 的真实 iss 后一切清楚：
  | token | iss | 用途 |
  |---|---|---|
  | access_token | `r:0016_29018D4C_D5D87` | WebAPI |
  | refresh_token（原始） | `steam` | **CM logon 唯一凭据** |
  而 `ensureAccessToken` 里有一行把 `GenerateAccessTokenForApp` 返回的 **rotated**
  refresh_token 覆盖到了会话上 —— 等于把可用于 CM 的凭据换成不能用的那个。
  GameNative 的 `SteamService.kt` 也是 `accessToken = refreshToken`，印证 refresh_token 才对。
- **教训**：
  1. 「更安全的做法」（总是用最新 token）在这里恰好是错的：**token 用途不同，不能互换**。
  2. 错误文案必须指向下一步动作。`invalid credentials` 让人无从下手，补上
     「请退出登录后重新扫码」才有用。
  3. **加渲染进程日志通道**是这几轮最大的效率提升：没有它，纯前端问题只能靠猜改，
     一轮 CI 二十分钟。hero 这次就是靠 `heroEl=null` 一行定位的。

## 2026-10-24（五）· 修 CM 登录被拒 + hero 动画不生效

- **commit**: 见本轮提交
- **status**: hero 单测 7 项绿、steam 成就 8 项绿；vue-tsc / tsc exit 0；eslint 0 error。
- **问题一：下载报「无法连接 Steam CM（登录被拒）」**
  - 根因 A：`exportCmCredentials` 直接把 `access_token` 丢给 sidecar，**没有校验它是否满足
    `Connection::access` 的硬要求**（必须是三段式 JWT 且 `iss === "steam"`）。
    早期版本落盘的 access_token 可能是坏的，于是 CM 在 JWT 解析阶段就拒绝。
  - 根因 B（我的措辞错误）：`describe_connection_error` 把 `AccessToken(_)` 一律说成
    「refresh_token 已失效」。传进去的明明是 access_token，且 AccessTokenError 有 5 种
    不同原因（Malformed / InvalidIssuer / Expired / Base64 / Json）。这句话把人往错方向带。
  - 修法：新增 `isSteamCmToken()` 在**本地**判定，不合格就不发请求；两个候选
    （access_token 优先 —— `CMsgClientLogon.access_token` 字段语义就是它；refresh_token 兜底）
    都试一遍。错误里带上每个候选的 iss 实际值，一次就能定位。
- **问题二：hero 动画完全不生效（上一轮修卡死时改过头）**
  - 上一轮为了消除 500ms 卡顿，把回调写成 `const r = handlers.navigate(); void r;` ——
    **不等导航完成**。浏览器于是立刻拍新快照，而新路由组件还没挂载，快照里根本没有
    hero 元素，补间无从发生，只剩淡入。
  - 正确做法：`await navigate()` + `nextTick()` + **固定两帧**。
    两帧 ≈ 33ms 用户无感，且**不轮询** —— 轮询才是卡顿根源，等待本身不是。
- **教训**：
  1. 「消除卡顿」不等于「删掉所有等待」。要删的是**不确定时长**的轮询，不是必要的时序等待。
  2. 传凭据给下层库之前，先按它的**接受条件**本地校验；否则错误从深处冒出来只剩一句含糊拒绝。
  3. 错误文案必须与事实一致（access_token ≠ refresh_token），否则等于给排查埋雷。

## 2026-10-24（四）· 修 hero 动画卡死 + 统一 hero 图 + depot key / PICS 打通

- **commit**: 见本轮提交
- **status**: hero 动画相关单测 7 项绿；vue-tsc / tsc exit 0；PICS 的 VDF 解析在 Node 侧等价验证通过。Rust 编译仍需 CI。
- **做了什么**：
  1. **修「点卡片/点返回会卡死半秒」**：删掉过渡回调里的 `waitForSelector` 轮询。
  2. **hero 图改成卡片同款**：优先级改为 商店 headerImage → 网格传入的 headerUrl → backgroundImage。
  3. **depot key 打通**：自实现 `NetMessage` 包装 `CMsgClientGetDepotDecryptionKey`。
  4. **PICS appinfo**：新增 `pics.rs`，查 app 的 depot 列表与 public gid。
  5. 新命令 `steam_app_depots`；IPC 新增 `appDepots` / `download`（凭据只在主进程内流转）。
- **为什么（卡死）**：
  `document.startViewTransition` 的回调**同步阻塞快照与渲染** —— 回调不 resolve，
  页面就不更新。旧实现为了「等 hero 元素出现」在回调里轮询最多 30 帧（≈500ms），
  于是点击后整个界面卡住半秒才切页。现在回调只做同步导航；代价是慢网首帧 hero 可能还空，
  但那是**瞬时**的，而为了动画完整去等 500ms 是实打实的卡死。
- **为什么（图不对）**：
  卡片用 `header.jpg`，详情页 hero 原本用商店的 `backgroundImage`（1920×620 大背景），
  两张图**内容不同**，补间时出现明显「换图」跳变。现改为两端用同一张 header 图，
  并新增 `activeCoverUrl` 把网格那张图交给详情页，首帧就有图可补。
- **为什么（depot key 曾经说拿不到）**：
  上一轮我判断「`steam-vent` 没为 `CMsgClientGetDepotDecryptionKey` 实现 `NetMessage`，所以拿不到」，
  **这是错的**：`NetMessage: EncodableMessage` 是公开 trait、方法全有默认实现，外部 crate 可以自己实现。
  GameNative 正是用 JavaSteam 的同名方法（`steamApps.getDepotDecryptionKey`）拿到 key 的。
  把「上游没实现」当成「做不到」，是少走了一步追问。
- **教训**：
  1. **View Transition 回调里绝不能 await 网络/数据**。要等的东西应在导航**前**准备好。
  2. **`git add backend` 会连 `target/` 一起提交** —— `.gitignore` 里只写了 splash/fqapi 的 target，
     漏了 backend 的。已补规则并从索引移除（教训：只 add 明确路径，不要 add 目录）。
  3. 共享元素过渡的「两端图不同」比「没有动画」更难看：宁可先用低分辨率同一张图，
     也不要在补间途中换图。

## 2026-10-24（三）· depot 下载器（manifest 解析 / chunk 解密 / CDN / 缓存读取）

- **commit**: 见本轮提交
- **status**: `verify:steam-manifest` **5 项全绿（真解析本机 97 份 Valve manifest，73069 个文件条目）**；`verify:steam-cm` 4 项绿；前端 lint 0 error、双层 typecheck exit 0。Rust 侧**仅语法/格式校验**，编译需 CI（本机无链接器）。
- **做了什么**：
  1. `backend/crates/silvermoon-steam` 新增 5 个模块：`crypto`（AES-256 ECB/CBC）、`manifest`（容器 + protobuf wire 解析）、`chunk`（解密 + LZMA/zstd/zip 解压）、`cdn`（服务器列表 / manifest / chunk 拉取）、`downloader`（落盘）、`cache`（读本地 depotcache）、`cm_requests`（两个 CM service method）。
  2. 新增命令 `steam_download`，进度经 `steam:download` 事件回推。
  3. 新增 `scripts/verify-steam-manifest.mjs`：对真实 Valve manifest 验证解析器。
- **为什么（能验证到什么程度）**：
  - 下载链路的前置——`GetManifestRequestCode` 与 `GetCDNAuthToken`——只在 CM 上（WebAPI 实测 404），CM 已打通（`verify:steam-cm`）。
  - **manifest 解析器能在本机真验证**：Steam 客户端把已装游戏的 manifest 明文缓存在
    `<Steam>/depotcache/<depot>_<gid>.manifest`。实测本机 97 份，逐份解析全部成功，
    metadata 的 depot_id/gid 与文件名 100% 吻合。这比「靠自己造样例」可信得多。
  - CDN 的分块地址、AES 解密、VZ 压缩魔数（`VZa/VSZa/zip）都按 Valve 的公开格式实现，
    并与 `GameNative-master`（`store_dl/steam/`）对照过。
- **一个必须说清的缺口：depot key**：
  - 解密文件名/chunk 需要 32 字节 depot key，获取它要发 CM 老式消息
    `CMsgClientGetDepotDecryptionKey`（`k_EMsgClientGetDepotDecryptionKey = 5438`）。
  - 而 `steam-vent 0.5` **没有为这条消息实现 `NetMessage`**（`EncodableMessage` 无 blanket impl，
    外部也补不上），所以**未安装** depot 的 key 拿不到。
  - 因此 `DepotTask.depot_key` 由调用方填充；**已安装**的游戏不受影响——它们的 manifest
    在本地且文件名未加密（实测 0 份加密），`cache.rs` 可直接解析，用于校验/补全。
- **教训**：
  1. **`aes::Block` 是非泛型别名**（`GenericArray<u8, U16>`），写 `aes::Block<Aes256>` 编译不过。
  2. **`steam_vent::serverlist`/`service_method` 是私有模块**，必须从 crate 根导入；
     `service_method` 还需 `use ConnectionTrait`（它是 trait 方法，不是固有方法）。
  3. **CDN token 自带 `ticket=` 前缀**，URL 里直接接 `?` 后即可；再拼一次会变成
     `ticket=ticket=...`，CDN 一律 401。
  4. **`lzma-rs` 的 raw 解码需要 `raw_decoder` feature**，且 Valve 的 `VZa` 流没有属性头，
     必须用 `LzmaParams::new(properties, dict_size, unpacked_size)` 显式传参（lc=3/lp=0/pb=2）。

## 2026-10-24（二）· 修「重启后会话过期」+ CM 连接层 + 详情页 UI 迭代

- **commit**: 见本轮提交
- **status**: `verify:steam-cm` 4 项全绿（**真连 CM 成功**）；steam 单测 71 项绿；双层 typecheck exit 0。Rust 侧 CM 层仅做语法校验，**编译需 CI**。
- **做了什么**：
  1. **修「扫码登录成功、下次打开却提示会话过期」**：access_token 与会话一起持久化（含 JWT `exp` 过期时间），重启先用它、真过期了才换。见下。
  2. **新增 CM 连接层** `backend/crates/silvermoon-steam`（复用 `steam-vent`），并接出 `steam_cm_status` / `steam_cm_connect` / `steam_cm_disconnect` 三个命令。
  3. 新增 `scripts/verify-steam-cm.mjs`：真连 CM 端点，把「网络不通」与「代码有问题」区分开。
- **为什么（会话掉的根因）**：
  - 上一版登录时只落盘 `refresh_token`，**从未验证过它可用**；重启后第一次用到它就换 access_token，那次一旦失败（限流 / 失效 / 抖动）用户就被踢到未登录。表现正是「手机里明明记住了账号，下次打开还是过期」。
  - 修法是把 access_token 一并加密落盘：重启先用它（24h 有效），失败面收窄成「真的过期」。JWT 的 `exp` 直接解出来，留 5 分钟余量避免边界抖动。
- **为什么（CM 层）**：
  - 下载的前置条件有两个，都**只能**通过 CM 拿：`GetManifestRequestCode` 与 `GetCDNAuthToken`。它们在 WebAPI 上**不存在**（实测 404）；而没有它们，CDN 的 manifest 请求返回 **401**（实测，已写进验证脚本）。所以「自己下载」的唯一通路是 CM。
  - 不自己造 CM 协议：含 RSA 密钥交换、protobuf 编解码、心跳、重连，上万行且本机无法编译验证。复用 `steam-vent`（与 `Aurelia参考` 同源）更可靠。
  - **实测 CM 是可连的**：`GetCMListForConnect` 拿到的端点里 `cmp1-lax1.steamserver.net:443` 建立 WebSocket 成功。之前第一轮失败是因为试了旧端点（`cm0.steamserver.net`）被重置。
- **教训**：
  1. **`Connection::access` 的参数是 `(server_list, account, token)`**，不是 steamid。照记忆写会编译失败 —— 这次是先读签名再写，并且 `ConnectionError` 的真实变体是 `AccessToken/Network/LoginError/Aborted/UnsupportedConfirmationAction`，不是 `Login`。
  2. **`libraryfolders.vdf` 里列出的库目录可能不存在**（移动硬盘没插）。扫描必须逐库校验目录，否则会把离线库算进来。
  3. 测试确实能抓到实现疏漏：本轮 `loadSession` 重建对象时漏搬 `accessToken`，是回归测试直接抓出来的 —— 没有那条测试，落盘的 token 等于白存。

## 2026-10-24 · Steam 详情页整页化 + 本地库检测 / 启动 / 成就

- **commit**: 见本轮提交
- **status**: 后端 **真读本机 Steam 验证**（`npm run verify:steam-local` 14 项全绿，扫到 7 款已装游戏）；单测 70 项绿；双层 typecheck exit 0；ESLint 0 error。**未做 GUI 人眼验收**（本机无 Electron 二进制）。
- **做了什么**：
  1. 「游戏」页点击卡片从 `m3e-dialog` 浮窗改为**独立详情页** `/games/:appId`（hero 大图 + 左侧主栏 + 右侧信息栏，窄屏单栏）。
  2. `electron/steam/local.ts`：VDF 解析 + `libraryfolders.vdf`（两代格式）+ `appmanifest_*.acf` 扫描，发现已安装游戏。
  3. `electron/steam/launch.ts`：`steam://rungameid/<id>` 启动、`steam://install/<id>` 唤起安装。
  4. `electron/steam/settings.ts`：Steam 目录设置（自动识别 + 手动添加，去重/原子写/坏文件降级）。
  5. 成就走**社区公开 XML** 而非 `ISteamUserStats`。
- **为什么**：
  - **不自己实现下载**。`DroidDeck参考` 能让 Steam 下载，是因为它跑的是**官方 Steam 客户端**（proot + Proton），下载由 Valve 自己的代码完成。自行实现 depot 协议要 CM 长连接 + manifest + 分块 CDN + AES 解密，而**实测本机 CM WebSocket 被重置**（`ECONNRESET`），那条链路跑不通；且实现量极大、本机无法验证。因此「安装」按钮的行为是**唤起官方客户端**，与用户确认的取舍一致。
  - **启动必须过 Steam，不能直接跑 exe**。直接 spawn 会绕过 Steamworks：成就/云存档不记录、需要 Steam 在线的游戏直接闪退。`steam://rungameid/` 让 Steam 负责启动，overlay 与成就才能正常工作。
  - **成就必须走社区 XML**。实测 `ISteamUserStats/GetPlayerAchievements` **只认 WebAPI key**：传 `access_token` 直接 400 `Required parameter 'key' is missing`（注意是 400 不是 401，和 `GetOwnedGames` 的行为不同）。本应用不该要求用户去申请 key，所以用免鉴权的 `/profiles/<id>/stats/<appid>/achievements/?xml=1`。
- **教训**：
  1. **`StateFlags & 4` 才是「已完整安装」**（4 = StateFullyInstalled）。不判这一位会把「正在下载」的游戏当已安装，点启动必然失败。
  2. **同一接口族对 token/key 的接受度不一致**：`IPlayerService` 接受 `access_token`，`ISteamUserStats` 只认 `key`。别按「Steam WebAPI 都能用 token」的直觉写。
  3. **隐私设为 friendsonly/private 时 XML 只回 `privacyState`、没有成就块**，必须降级成 `available:false` 并说明原因，否则界面会显示「0/0 没有成就」这种误导性结论。
  4. 移动硬盘不在线时，`libraryfolders.vdf` 里仍会列出该库路径，但 `steamapps` 不存在 —— 扫描时逐库校验目录存在，才不会把离线库算进来。

## 2026-10-24 · Steam 登录（全方式）+ 游戏库：新增「游戏」选项卡

- **commit**: 见本轮提交
- **status**: 协议层**已真打 Steam 接口验证**（`npm run verify:steam` 15 项全绿）；单测 21 项绿；electron 侧 typecheck / ESLint 干净。**未做人眼 GUI 验证**（本机没装 Electron 二进制，`node_modules/electron/dist` 为空）。
- **做了什么**：
  1. 左侧导航栏「百宝箱」之上新增「游戏」选项卡（`navItems` 里排在 `books` 与 `treasure` 之间），路由 `/games`。
  2. 新增 `electron/steam/protocol.ts`：纯 HTTPS 的 Steam 协议实现 —— 二维码登录、账号密码 + Steam Guard（邮箱码 / 手机令牌 / App 确认）、会话恢复、游戏库（`IPlayerService/GetOwnedGames`）、商店详情（`appdetails`，10 分钟缓存）、账号资料（`GetPlayerSummaries` + 社区 XML 回退）。
  3. `electron/steam/index.ts` 接到宿主：网络注入 Electron `net.fetch`（走 Chromium 网络栈 → 遵守「设置 → 网络」的代理），存储注入 `secure-store`（`safeStorage`：DPAPI / Keychain / libsecret）。
  4. `electron/ipc.ts` 新增 `steam` 通道（op 分发）+ `steam:auth` 跨窗口广播。
  5. 验证：`scripts/verify-steam-protocol.mjs`（真打网络，15 项）、`electron/__tests__/steamProtocol.test.ts`（纯逻辑，21 项）。
- **为什么**：
  - **协议放在 Node 侧而不是 Rust 后端**。参考实现（`Aurelia参考/`）用 `steam-vent` 走 CM 的 WebSocket 长连接，但本机实测 **CM 的 WebSocket 会被网络重置**（`ECONNRESET`/`ETIMEDOUT`，三次重试全失败），而 Steam 的 **纯 HTTPS WebAPI 完全可用**（扫码、轮询、RSA 公钥、商店接口全部 200）。两条路在本机能拿到的能力集合相同，但本机**没有 MSVC 链接器**，Rust 后端连 `cargo check` 都跑不了（连 build script 都要链接，AGENTS.md 已记录只能走 CI，约 20 分钟一轮）。把协议写在 Node 侧，才能用 `npm run verify:steam` **当场真打 Steam 接口**。
  - **不引第三方 Steam 库**（`steam-user` / `steam-session`）：它们同样走 CM WebSocket，在本机不可用；而 HTTPS 这套只需要内置的 `fetch` + `node:crypto`（RSA 用 JWK 拼公钥，密码 PKCS#1 v1.5 加密，明文不上传）。
  - **凭据走 safeStorage**：refresh_token 等同密码，不能明文落盘；项目已有 `secure-store`，复用即可。密码**从不落盘**。
  - **代理必须走 `net.fetch`**：Node 全局 `fetch`（undici）不读系统代理、也不吃 `session.setProxy`，项目里已有多处因此改为 `net.fetch`（见 `electron/net-proxy.ts` 文件头）。Steam 服务器在国内常需代理，踩这个坑表现为「登录一直超时」。
- **教训**：
  1. **Steam 的账号密码接口对错误账号返回 `200 + {"response":{}}`**，既没有 EResult 也没有错误文案。必须自己判空并给可读提示（否则界面表现为「一直等待确认」）。`verify:steam` 里专门有一条断言守这个行为。
  2. **`rtime_last_played` 是秒，其它时间字段是毫秒**：协议层已统一转成毫秒再交给前端，前后端类型注释里都写明了。
  3. **换账号必须清库缓存**：`steam-library.json` 独立于会话文件（为了未登录也能秒开首屏），所以 `logout()` 要同时删两者，否则换号后看到的是上一个账号的游戏。
  4. 本轮中途跑过 `cargo check`，它**改写了 `backend/Cargo.lock`**（重新解析依赖，删掉 4138 行）。已 `git checkout` 还原 —— 本机无链接器时不要为了「试试看」去跑 cargo，它会动锁文件。

## 2026-10-20 · 修 schema 版本碰撞（no such column: source）+ 书架合并本地导入

- **commit**: 见本轮提交（基线 `15b4e24`）
- **status**: 迁移逻辑已在用户库副本上用等价 SQL 验证（`user_version=6`、缺列 → 补列并回填成功）；typecheck / lint / prettier 全过；书架页 Chromium 预览通过；**Rust 需 CI 编译验证**
- **做了什么**：
  1. schema 升至 7：新增 `ensure_added_columns()` —— 每次启动用 `PRAGMA table_info` 幂等检查 `files.imported` 与 `novel_shelf.source`，缺列就补并回填旧书架来源；v6→v7 分支显式修复「版本号已到 6、但列不存在」的库。
  2. 书籍页删除「本地」下拉项与独立页面：本地导入书与三源书架书统一显示在「书架」，导入按钮移到书架页标题右侧；本地书首屏只渲染 48 本，按「加载更多」增量渲染，缩略图也只请求可见项。
  3. 恢复 `LibraryToolbar` 的扫描按钮（书籍不再使用它的导入模式）。
- **为什么**：
  - 用户实测报错 `no such column: source in SELECT ... at offset 44`。检查其 `library.db` 发现 `user_version=6`，但 `files.imported` / `novel_shelf.source` 都不存在 —— 只按 `user_version` 判断迁移，会让这类库永远缺列。列的存在性必须由列本身判断，而且要在每次启动时自愈。
  - 用户要求删掉本地选项卡、直接在书架导入本地书；本地书作为书架里的一个分组，符合「书架 = 我的全部书」的心智。911 本全量渲染会同时挂几百张卡片并请求几百张缩略图，所以做了增量渲染。
- **教训**：
  1. **`user_version` 只代表「某个迁移跑过」，不代表「当前分支期望的列都在」**：多分支 / 多构建共用同一份用户数据时，它可能被别的分支推到同一个数字。后加列要做幂等探测（SQLite 用 `PRAGMA table_info`），并放在每次启动的路径上。
  2. 大库不能一次性渲染 + 一次性拉缩略图；首屏要有硬上限，其余增量加载。
  3. 删除一个页面入口时，原页面的能力（导入）要迁到新入口，而不是一起删掉。

---

## 2026-10-19 · 书籍/图片/视频一级导航收进标题下拉 + 书籍改导入制 + 共享书架

- **commit**: 见本轮提交（基线 `10cd9fd`）
- **status**: 前端已用 Chromium 预览逐页点测（标题下拉开合 / 切页、导入按钮与空态、无残留分段条）；typecheck / eslint / prettier / verify-docs / icon-font 全过；vitest 除 `electron/__tests__/splashContract.test.ts` 的 Windows 命名管道 EACCES（环境限制，与本轮无关）外全过；**Rust 需 CI 编译验证**
- **做了什么**：
  1. `PageHeader` 支持 `menu-items` / `menu-value`：标题变成下拉触发器（`m3e-menu-trigger` + `m3e-menu`），书籍 / 图片 / 视频的一级选项全部收进这里；`SegmentedTabs` 新增 `hide-tabs`，只保留方向感知的内容切换过渡。
  2. 书籍页新增 `NovelShelfView`：共享书架按 `source` 分组展示三个源的书；点击后切到对应源并打开详情。三个源自己的页面移除书架区（番茄的「我的书架」tab、文库8 顶部书架），笔趣阁详情补「加入书架」。
  3. 书籍「本地」改为手动导入：`book_import` 写入 `files(imported=1)`，`LibraryToolbar` 支持导入按钮；扫描跳过 book、软删除跳过 imported=1；列表与导航计数只统计导入书籍。
  4. 后端 schema v6：新增 `files.imported`、`novel_shelf.source`；老书架按 aid 长度回填来源（番茄长 id → `fqapi`，其余 → `wenku8`）。
- **为什么**：
  - 用户明确要求把红色分段组（本地 / 在线 / 创作）收进黄色标题「书籍」的下拉，图片 / 视频照做。分段组占横向空间，且与标题表达的是同一层信息。
  - 「书架」必须是三个源共享的：数据本来就在同一张 `novel_shelf` 表里，但过去每个源各自渲染，从番茄页点文库8 的书会打开错误详情。补 `source` 后共享书架才能正确路由。
  - 本地书籍改导入制：扫描按「本次未见即软删除」工作，手动挑的书会被下一次扫描清掉；把书籍排除出扫描、用 `imported` 标记并在软删除时跳过，才能同时满足「不再纳入扫描」与「导入的书不会丢」。
- **教训**：
  1. **跨源共享的数据表必须带来源列**，否则展示层只能猜；`aid` 在不同源之间不保证全局唯一。
  2. 扫描的软删除是「全表 `scanned_at < 本次`」，新增任何「不参与扫描」的条目都必须同步给它一个豁免条件，否则第一次扫描就会误删。
  3. 给「不可扫描」的条目做 UI 时，空态要直接引导到新入口（导入），不能继续提示「去设置里加扫描目录」。

---

## 2026-10-19 · 返回列表闪回顶部 + 迷你条 hero 首帧直角 / 顿挫

- **commit**: 见本轮提交（基线 `825744e`）
- **status**: 已用 Chromium + CDP 复现与回归（滚动：内容插回的第一帧 `scrollTop` 即为 600；飞行层：动画首帧圆角 8px，起飞延迟约 13ms）；typecheck / eslint / prettier / heroTransition 单测 9 项全过；**真实窗口观感需人眼**
- **做了什么**：
  1. **`App.vue`：滚动恢复从 `setTimeout(260ms)` 改为路由 transition 的 `@enter` 钩子** ——
     该钩子在「新页面 DOM 已插入、这一帧尚未绘制」时同步执行；同步写 `scrollTop`，
     用户从第一帧看到的就是原位置。另保留逐帧兜底（最多 30 帧），只服务「数据异步到达、
     高度晚一截」的页面，命中即停。
  2. **`heroTransition.ts`：起飞瞬间快照源封面的 `border-radius` / `box-shadow`**，
     `land()` 不再回头读源元素；`landHeroFlight()` 改为先**同步**试一次降落，
     不再固定等一帧 rAF。
  3. **`MiniPlayer.vue`：挂载 400ms 后预热 `PlayerView` chunk**，避免首次展开播放器时
     飞行层在迷你条原位等动态 import。
- **为什么**：
  - 返回列表闪回顶部：旧实现等 260ms 才写回 `scrollTop`。实测（CDP 采样）：歌单内容在
    `t=1016ms` 已经插回，`scrollTop=0`；直到 `t=1198ms` 才跳到 600 —— 中间约 11 帧停在顶部，
    正是用户截图里的一瞬。改为 `@enter` 后，内容插回的那一帧 `scrollTop` 已经是 600。
  - 迷你条封面变直角：`land()` 里的 `radiusOf(srcEl)` 在**降落时**才执行，而进播放页两帧后
    `shellChromeVisible` 已把迷你条 `v-if` 卸载。对脱离文档的元素调用 `getComputedStyle()`
    得到的是空值声明，`parseFloat("")` → `NaN` → 圆角 0；WAAPI 首帧 `borderRadius: 0px`
    覆盖了克隆层已经固化的 8px。实测动画开始那一帧圆角由 8px 突变为 0px。
  - 「顿一下」：克隆层 `t=6ms` 出现、动画 `t=66ms` 才开始，期间静止在迷你条原位（等路由挂载 +
    一帧 rAF）。同步降落 + chunk 预热后，动画在 `t≈20ms` 就已起跑。
- **教训**：
  1. **飞行层的起点视觉参数必须在起飞瞬间快照**（此时源元素必然还在文档里），
     不能等降落时回头读 —— 跨路由动画的源随时可能被 `v-if` 卸载。
  2. **`getComputedStyle()` 对脱离文档的元素返回空值，且失败是静默的**：
     `parseFloat("")` 得到 `NaN`，再被 `Number.isFinite` 兜成 0。这类「看起来有兜底」的代码
     最容易把错误藏起来，量不到值时应显式回退到目标值，而不是 0。
  3. **滚动恢复只能发生在「新 DOM 已插入、绘制之前」**：Vue 的 transition `before-enter`
     是插入**之前**，`enter` 才是插入之后（且在 post-render 队列里，仍早于绘制）。
     用 `setTimeout` 猜时长必然闪一帧甚至多帧。

---
## 2026-10-18 · hero 飞行层样式失效（卡片入口）+ 进播放器重排

- **commit**: 见本轮提交（基线 `0cffbd9`）
- **status**: 未实机验证（typecheck / eslint / prettier / heroTransition 单测 9 项全过；**观感需人眼**）
- **做了什么**：
  1. **`heroTransition.ts`：新增 `freezeCloneStyles()`** —— 克隆飞行层时，逐层把源元素整棵子树的
     `getComputedStyle` 固化到内联样式（尺寸 / `aspect-ratio` / `overflow` / `border-radius` /
     `object-fit` / 背景 / 阴影 / 字体），并给 `<img>` 强制 `width:100%;height:100%;object-fit:cover`。
  2. **移除写死的 `box-shadow: var(--md-elevation-3)`**，阴影改为跟随源元素；
     `land()` 的 WAAPI 补间加入 `boxShadow`，终点取目标元素计算值。
  3. **`App.vue`：新增 `shellChromeVisible`** —— 进播放页时延后两帧再收导航栏 / 标题栏 / 迷你条，
     离开时立刻恢复；`has-player` padding 同步改用该标志。
- **为什么**：
  - 用户回「**B，飞行动画不对**」——封面确实在飞，但姿态不对，排除「没飞」与「落点偏」。
    从构建产物 `dist/assets/MusicView-*.css` 反查：卡片封面样式全是**后代选择器**
    ``.song-card .thumb[data-v-x]{width:100%;aspect-ratio:1;overflow:hidden}`` 与
    ``.song-card .thumb img[data-v-x]{object-fit:cover}``。飞行层是 `cloneNode` 后挂到 `<body>`，
    **祖先链断开 → 两条规则一条都不匹配**，于是 `.thumb` 失去尺寸与 `overflow:hidden`、
    `<img>` 失去 `object-fit` → 图片按原始分辨率铺开，正是用户截图里那块盖住半屏的大白图。
    对照迷你条 `.cover`、列表 `.o-thumb`、网格 `.thumb` 都是单选择器，所以历史上**只有卡片入口坏**，
    与「从卡片样式进入 hero 不对」精确吻合。
  - 重排的根因：`isPlayerPage` 在路由变化那一 tick 就翻转 → 导航栏（88px）被 `v-if` 立刻卸载，
    而 `<transition mode="out-in">` 还要等旧页离场、新页挂载 —— 中间一两帧内容区**向左展开 88px**。
    播放页是 `position:fixed; inset:0` 不透明遮住的，所以**延后收外壳**零观感成本。
- **教训**：
  1. **给 hero 源标属性的那张封面，样式必须写成单选择器**；否则克隆层脱离祖先即失效。
     这条已写入 `heroTransition.ts` 与 `AGENTS.md` 相关的 hero 约定。
  2. **祖先 + 后代的 scoped 选择器 = 不可移植**。任何「把元素搬到别处去」的动效
     （hero / 拖拽预览 / 跨容器 portal）都必须先固化计算样式。
  3. 写死阴影是错的：克隆层应该继承源元素的视觉，而不是套一层通用的 elevation。

---



## 2026-10-17 · 文档真源重建（AGENTS / SPEC / LOG / README）

- **commit**: `35f50f8`（本轮 docs-only；基线 `596e4f5`）
- **status**: 未验证（文档改动，无运行时行为；由用户人眼确认）
- **做了什么**：
  1. **`doc/AGENTS.md` 整体重写**（121 行 → 237 行）：从 Tauri 单进程基线改为 Electron 三进程基线
     （Electron 主进程 + Rust sidecar + fqapi sidecar）。补齐 splash 是父进程、
     `X-SilverMoon-Token` 双向鉴权、`POST /_host` 反向调用、`extraResources` 只写平台级等约束。
     顶部新增「如何核对」段，声明**与代码冲突时以代码与 CI 为准**。
  2. **新建 `doc/SPEC.md`**：定位与边界（做什么 / 不做什么）、设计原则（界面 / 技术 / 工程）、
     红线、验收标准、已知未达标项。
  3. **新建 `doc/LOG.md`**（本文件）：三层分工 + 条目格式 + 倒序施工记录。
  4. **四份 README 全部对账**（`README.md` / `README_en.md` / `apps/desktop/README.md` /
     `apps/desktop/README_zh.md`）：架构段、技术栈、目录结构、快速开始、命令数全部改到 Electron 基线。
     另修 `kugou_server` 路径（`src-tauri/` → `backend/`）。
- **为什么**：
  - **触发**：`/grill-me` 五问的答复（Q1 选 B+C：机制守卫 + 缩小为事实卡；
    Q2 三层分工；Q3 LOG 带验证状态；Q4 不做 LOG-INDEX；Q5「重大」只有重构项目与移植功能两条）。
  - **直接证据**：四份 README 里**只有 `README_en.md` 讲的是真架构**（但命令数写成 164），
    中文三份全是 Tauri。说明上一轮迁回 Tauri 时改了中文、迁回 Electron 时只改了英文 ——
    两轮迁移都没人做全量对账，**横跨 133 个提交与 v0.1.1 发版无人发现**。
  - **AGENTS.md 最要紧**：它作为「Additional instructions」**每轮自动注入**，写错比文档写错更严重。
- **教训**：
  1. **规则写了但没生效 = 没有规则**。README 从 `94bfe2f`（2026-10-11）起就在撒谎，跨 133 个提交。
     文档约束必须做成 CI 断言（本仓库已有先例：`check-version` / `verify:m3-tokens` /
     `verify:settings-index` / `verify-ext-slots`），**靠自觉必漂**。
  2. **命令数必须脚本对账**：`#[silvermoon_ipc::command]` 出现 183 次，其中 **3 次在注释里**；
     真实定义 180 条，`generate_handler!` 注册 180 条，双向零差集。
     手数会多算 3 条，README 里旧写的 154 / 164 都不对。
  3. **`ext:` 协议未注册**（本轮发现的功能缺陷）：`ExtensionEmbed.vue` / `ExtensionHost.vue`
     用 `toAssetUrl(dir, "ext")` 生成 `ext://localhost/...`，但 `electron/protocols.ts`
     只注册 `app` / `asset` / `app-cover` 三个。Tauri 时代实现在
     `src-tauri/src/ext_protocol.rs`（`ee88689`），迁回 Electron 后没搬回来。
     **症状：扩展 UI 的 iframe 加载不出来。**
  4. **用户点名某个文件时，那个文件就是唯一交付物**。本轮我先跑去做记忆整理，被纠正：
     「????你在干什么，让你维护提示词相关文件，不是让你维护记忆」。
  5. **核实要克制**：本轮为写文档查了 30+ 次工具调用才动笔，观感上像「空转」。
     正确做法是**先写、再按需补证**，而不是先把所有细节核完。
- **未完成 / 下一步**：
  - ⚠️ `ext:` 协议仍未注册 —— 需在 `protocols.ts` 补第 4 个 scheme + handler，
    语义照抄 `ext_protocol.rs`（只服务 `extensions/<id>/` 之内、拒绝 `..`、Windows 忽略大小写）。
  - 四份 README 改完后**未做机制化守卫**：建议加 `scripts/verify-docs.mjs`
    （断言 README 不出现 `Tauri 2 + Vue`、命令数一致、路径存在），接入 CI。

---

## 2026-10-17 · 番茄内容源（fqapi）建成并随 v0.1.1 发布

- **commit**: `e38933c` → `c6f1299` → `a86f53e` → `e95e4d9`（含 `302f68d` / `00ef027` / `c5b49c4` / `32f2520`）
- **status**: 已人眼验证（用户装完自己确认 sidecar 存在，端到端链路实测通过）
- **做了什么**：新增番茄小说在线源。**裁剪自 fqapp** 的 `sign`(1333行) / `device`(1887) /
  `upstream`(834) / `endpoints`(10877)，剥掉 `api/`（FRB 桥）、`server.rs`、`webui`、`frb_generated`。
  协议 = stdio 行分隔 JSON、**零端口**，握手行 `FQAPI_READY {…}`。
  前端四视图 + 推荐流 + 排行榜 + 我的书架（复用 `novel_shelf_*` 表）。
- **为什么**：
  - 用户回「A」选定 A 方案（**独立 sidecar**，仿 lyrics 形态），否决 B 方案（编进 backend）。
  - **B 被否的原因**：要先升 `reqwest 0.12→0.13`、`axum 0.7→0.8`、TLS 改 rustls，
    风险波及全仓库。fqapi 独立成 crate 后可以**刻意隔离**依赖
    （0.13 + rustls vs backend 的 0.12 + native-tls），同 crate 会出现两份 reqwest
    且 TLS provider 只能选一个。
  - **登录不做**（成本 = 逆向 passport + 风控，且会把用户数据绑到番茄账号、反噬设备池优势）。
- **教训**：
  1. **裁剪时的三个隐性依赖**（都踩过）：`upstream/mod.rs` 别漏拷（缺它 rustfmt 直接崩
     "failed to resolve mod"）；`testdata/manga_image_fixture.json` 与
     `cenc_sample_fixture.json` 被单测 `include_str!`（不带就 compile error）；
     `audio.rs` 依赖 `video::derive_spade_content_key`，`video.rs` 不能删。
  2. **mac 产物目录不固定**：`mac` / `mac-arm64` / `mac-universal` 随架构变。
     实测 runner 是 arm64 → 落 `release/mac-arm64/`。脚本里用 `find` 找 `SilverMoon.app`。
  3. **明说能力边界**：设备池 = 批量注册匿名设备（灰产性质）；上游一封全灭且无降级；
     只覆盖一家内容（不提供冗余）。用户要的是「我知道我拿到的是什么」，不是漂亮话。

---

## 2026-10-17 · 配色改为真正的 MCU 动态主题

- **commit**: `39572c2`（CI run 39017394695 四 job 全绿）
- **status**: CI 绿，用户人眼验证
- **做了什么**：配色内核重做为真正的 MCU 动态主题。算法内核 `shared/m3-theme.ts`
  （浏览器 + Electron 主进程共用，**零 DOM 依赖**），口径写死
  **Tonal Spot · M3 Expressive color spec 2025 · platform=phone · contrastLevel=0**。
  MCU 升 0.4.0，角色 56 个（2025 新增 dim / fixed 系列 / surface-variant / surface-tint，
  外加项目语义色 success/warning/link）。
- **为什么**：
  - 用户追问过「这三个页面，哪个才是正统MD3/MD3E」，会核查实现层级 ——
    **不接受「看起来像 MD3」的手写 CSS**。
  - `theme.css` 的两个色令牌段改由 `scripts/gen-m3-tokens.mjs` 生成，
    手改被 `m3Theme.test.ts` 挡下：**颜色是生成的，不是手写的**（沿用同仓库既有主张）。
  - `scrim` 被 `TOKEN_OVERRIDES` 改成半透明 —— 项目里它直接当蒙层底色用。
- **教训**：改配色后要同步**皮肤白名单** `skinSchema.ts` 的 `COLOR_TOKEN_GROUPS`
  （`scrim` / `shadow` 有意排除）。文档真源是 [`doc/M3配色系统.md`](M3配色系统.md)。

---

## 2026-10-17 · 桌面歌词（含任务栏歌词的尝试与回滚）

- **commit**: `dfac9d9` → `5485d77` → `6cd450e`（回滚到 `997646b`）→ `2582f5c`
- **status**: 已人眼验证（用户实机确认浮窗可用；真嵌入方案已废弃）
- **做了什么**：
  1. 先按上游 TaskbarLyrics 思路做**任务栏锚定**（任务栏矩形 = Electron `bounds` 与 `workArea`
     的差集，**零 Win32 依赖**）+ 逐字填充 + 频谱回退。
  2. 再尝试 **`SetParent` 真嵌入任务栏**（Rust 原生窗口）。
  3. 最终**整体回滚**：删掉内置任务栏歌词整套，改为在设置页加引导卡，
     指路原项目 TaskbarLyrics，并**明确说明内置的是浮窗**（可拖动 / 可吸附任务栏上方，**不是嵌入**）。
  4. 修「开了桌面歌词什么都不显示」两个根因。
- **为什么**：
  - **不做 `SetParent` 真嵌入**：上游自己代码注释就写明「re-parent 会让 DWM 合成面失效、
    同一 HWND 救不回来」；Chromium 的 DirectComposition 对此更敏感，Electron 下大概率黑屏，
    且 Electron 无官方 API 支持嵌入他进程窗口。
  - **用户决策原话**：「你直接回滚到我让你加任务栏歌词之前版本吧，设置里加一个引导让用户想用
    任务栏歌词的去下载原项目去」。
  - **锚定默认 `manual` 而非 `taskbar`**：老用户已存 `desktopLyricsBounds`，
    改默认会让窗口升级后自己跳位置，属**破坏性变更**。
  - **不搬 C# 代码，只做对标补齐**：上游是播放器无关的伴侣应用，SilverMoon 自己就是播放器。
- **教训**（**本轮最严重的一课**）：
  **「去掉 X 吧」必须先确认是「删掉功能」还是「换一种实现」**。
  我理解成「砍掉桌面歌词，用 Rust 版顶上」就删了整套可用实现，结果 Rust 版没跑通、
  旧版又没了 → **用户两边落空，功能完全失效**。原话：「不是任务栏歌词，是可以拖动的原来的桌面歌词」。
  **规则**：①「去掉 A，只保留 B」先问清 B 是否**已经能用**；B 没验证通过前 A **绝不能删**；
  ②删功能前先把会消失的文件列清楚让用户确认；③更好的是**新旧并存**（B 走 flag），
  等 B 真机验证通过再删 A。
  **第二个教训**：`watch(desktopLyricsEnabled)` 只在值变化时触发，重启后值恒为 true →
  开窗函数永不调用。**修法：`onMounted` 末尾补启动兜底**。
  同时歌词推送被改成 `pushLyricsState`（推 Rust 进程）后**漏接回** `emitDesktopLyricsState`，
  窗口开着也收不到歌词 —— **修法：两套并存期间两边都推**。

---

## 2026-10-17 · Hero 动画（迷你播放条 → 播放器封面飞行）

- **commit**: `2f2f1d8` → `87e0167` → `4d48bfc` → `471447f`
- **status**: CI 绿；用户人眼验证黑屏已修
- **做了什么**：`utils/heroTransition.ts` —— overlay 克隆层 + WAAPI transform 补间，
  420ms / `cubic-bezier(0.05,0.7,0.1,1)`（MD3 emphasized decelerate）。
  最终形态是**声明式属性 + 全局 capture 监听 + `router.afterEach` 起飞**：
  `data-hero-source` / `data-hero-coverage` / `data-hero-skip`。新增入口只需在模板标属性。
- **为什么**：用户要「一进播放器封面就飞过去」的连续感；纯路由抽屉（420ms 黑场空档）观感断裂。
  跨路由交接用模块级 `holdHeroFlight` / `releaseHeroFlight` / `hasPendingHero`；
  飞行期间 `<html>` 挂 `.lm-hero-flying`，页面级路由过渡据此**关掉整页位移**。
- **教训**：
  1. **`settleEntryAnimations` 只快进影响布局的动画**（`LAYOUT_PROP_RE` 过滤）——
     纯 opacity 的必须放它继续播，否则目标页淡入被直接掐掉。
  2. **hero 属性过滤别用字符串数组**：会让图标字体扫描 CI 变红，改用正则。
  3. **黑屏真根因**：scoped 样式里的 `:global` 后代选择器**被编译丢弃**。
     这类问题看现象是查不出的，必须看编译产物。

---

## 2026-10-17 · 播放页卡顿修复 + B 站封面骨架屏

- **commit**: `74f25c9`
- **status**: CI 绿，**未实机验证**（性能修复是静态分析，已在交付时明说并要求用户看 DevTools）
- **做了什么**：卡顿三项修复 + 新增 `composables/useLazyCover.ts`
  （IntersectionObserver + `rootMargin` 下扩 400px 约两行 + 骨架屏时序），
  `BilibiliCard.vue` 改造；图片解码完成后 220ms 淡入，失败退回 `COVER_FALLBACK_DATA_URL`。
- **为什么**：用户原话「先修好卡顿问题，顺带做个小更新，让B站视频在封面图加载完成前先显示骨架图占位，
  **参考其他地方骨架图做法**，另外封面加载在显示范围的基础上提前加载视图外后两行的封面图」。
  - 「参考其他地方的做法」= **复用仓库既有基元** `.lm-skeleton`（与 MediaGrid 同一套），不另造视觉。
- **教训**：
  1. 用户说「先修好 X，顺带做个小更新」→ **顺序是先修、再改、一次提交、一次推、一次看 CI**。
  2. 区别于「顺带」也要走完整验证链，不能因为是附带项就跳过单测。
  3. **性能修复必须明说「这是静态分析，未实机验证」**并给下一步判据，
     否则用户会误以为已确认修好。

---

## 2026-10-17 · 随访修复批次

- **commit**: `596e4f5` / `54a0848` / `a5ff657`（其余见 `git log`）
- **status**: CI 绿
- **做了什么**：
  - `596e4f5`：`check-version` 的正则用 `{2}` 代替连续空格（`no-regex-spaces` 会拦下）。
  - `54a0848`：**修「关于」页版本停在旧值 + 自动更新不可用**。
  - `a5ff657`：重新生成图标字体子集（新增 `local_library`）。
- **为什么 / 教训**：
  1. `vite.config.ts` 曾**误读 `src-tauri/silvermoon.config.json`**（Tauri 遗留副本）来注入
     `__APP_VERSION__` → 改版本号界面仍显示旧值、**CI 却全绿**。真源是 `backend/silvermoon.config.json`。
     **这类「CI 绿但界面错」的问题只能靠人眼发现。**
  2. `check-version.mjs` 校验 **9 处**，但**不覆盖 `fqapi/`** —— fqapi 的
     `Cargo.toml` / `Cargo.lock` 必须手动一起改，否则「关于」页与 sidecar 自报版本
     （`env!("CARGO_PKG_VERSION")`）对不上。

---

## 2026-10-14 · 设置页布局稳定化

- **commit**: `0f478ec`（修宽度回归）→ 承接 `4e88217`（两栏各自滚动）
- **status**: 已人眼验证（用户连发三张设置页截图配「？？？」，卡片宽度各不相同 = fit-content 铁证）
- **做了什么**：修 `.settings-view` 卡片宽度「随内容乱跳」。
- **为什么**：**父级是 flex 容器**时，子元素的 `margin:0 auto` 成了自动外边距、
  会吞掉交叉轴空间使宽度塌成 `fit-content`。
  最终三者配合：`width:100%` 撑满 → `max-width:1180px` 封顶 → `margin:0 auto` 居中。
- **教训**：
  1. `App.vue` 的 `.settings-page .main-content { display:flex; flex-direction:column }`
     **看着多余、实则不能删**（保留它是为了让扩展注入块能参与高度分配）；
     `SettingsView.vue` 的 `.settings-view { width:100% }` 同理。**改动前先读那两处注释。**
  2. **旧实现是反例**：整页滚动 + 左栏 sticky `max-height: calc(100vh - 120px)` ——
     那个魔法数字没算 72px 固定迷你播放条，最后几个分类被压住滚不出来。
     `.has-player .main-content` 已给 padding-bottom 留位置，**别再自己猜高度**。

---

## 2026-10-13 · 宿主迁回 Electron（阶段 1–5）

- **commit**: `d44b5ce`（阶段1）→ `b04ea6c`（阶段2+3 契约层 + Rust 脱壳）→ `6f2b588`（阶段4 前端桥）
  → `2aa13a0`（阶段5 package.json 与 CI）＋ `d98f7ee` / `1f9be69`
- **status**: 已人眼验证（v0.1.1 已发布并安装）
- **做了什么**：宿主从 Tauri 2 换回 Electron 44。**恢复 `silvermoon-ipc` 契约层**
  （Tauri 时代被删掉的 15 个文件），Rust 侧完成脱壳；前端 `src/ipc/` 切回 preload 通道。
- **为什么**：**用户原话「重构回到electron吧」**，选 A 方案，
  且明确要求「**不走本地验证，走 github action**」（本机没有 MSVC 链接器）。
- **教训**（CI 十轮收敛，每轮约 20 分钟）：
  1. lock 不同步 → ② ESLint 挂一次性脚本 → ③ 补 `kugou_server` → ④ Rust 编译错误
     （漏改**不带 `tauri::` 前缀**的 `use` 导入、契约层缺 `app_log_dir`、缺 `semver`/`sha1`）
     → ⑤ 单测 mock 过时（仍 mock Tauri 桥）→ ⑥ `build:main` 脚本路径
     → ⑦ 图标扫描把 IPC channel 名当图标 → ⑧ `package.json` 缺 `main` 字段
     → ⑨ **安装包启动失败**（`silvermoon.config.json` 缺 `sidecar` 段）→ ⑩ `smtc.rs` 多余 import。
  2. **最重要的教训**：不要拿 `src-tauri/` 当底去补缺，要**以基线 `backend/` 为底再叠加**。
     因为 `src-tauri` 里那些文件是「Tauri 期为了单进程而**删改过**的版本」，
     删掉的东西正是 Electron 需要的（Cargo.toml 缺 semver/sha1、package.json 缺 `main`、
     配置缺 `sidecar` 段）。
  3. **脱壳是改名而非重写**：`917b751` 有 202 个 R（重命名）+ 35 M + 14 A + **仅 15 D**。
     业务代码 19891 行里含 tauri 引用的只有 537 行（2.7%）。

---

## 2026-10-11 · 扩展系统补完

- **commit**: `94bfe2f`（独立 ext: 协议）→ `338293e`（注入主界面）→ `667aded`（通用具名插槽）
  → `b849b61` → `e4df6f7` → `57b6b45`
- **status**: CI 绿；用户实机验证过导航项与皮肤列表
- **做了什么**：
  1. 扩展 UI 从 `asset:` 迁到**独立 `ext:` 协议**（独立 origin）。
  2. **扩展可注入主界面**：`contributes.nav` 加导航项、`contributes.ui` 往页面塞块。
  3. **通用具名插槽** `contributes.ui surface=slot`，宿主在**真实位置**开槽（7 个）。
  4. 皮肤改由扩展承载（`contributes.themes`），设置页移除皮肤板块。
- **为什么**：
  - **用户原话**：「扩展不能改软件本体 UI 吗，比如 UI 加点什么新元素的，你现在调用方式还是太隐蔽了，
    再不济你扩展管理页面也可以规定注册相关界面啊，你这样还要弹出一个框再显示内容」。
    → 落地为**发现性优先于隔离性**：导航栏看得见、点得着，才叫装了扩展。
  - **安全动因**：扩展原来站在 `asset.localhost` 上，与**任意** asset URL 同源，
    可以 `fetch()` 读本机任意文件 —— 独立 origin 后跨域被挡。
- **教训**：
  1. **导航靠拉取，不靠推送**：宿主存 `last_nav`，挂载时调 `ext_current_nav` ——
     **`emit` 早于 `listen` 会丢事件**（踩过：扩展窗口空白）。
  2. **白名单里只放有渲染点的插槽**：本仓库已两次踩「声明了没人读」
     （`settings.schema`、`extension-host-page`）。
  3. **slot 写错只会静默不显示**，所以安装时直接拒绝。
  4. `themes:list` 忽略 `extId` 的形状契约 bug 修过两次（`667aded` 又修一次）。

---

## 2026-09-24 ~ 10-09 · 宿主多次迁移（Tauri → Electron → Flutter → Tauri）

- **commit**: `9a25438` / `738adb7`（→Electron 44，更名 SilverMoon，2026-09-24）
  → `15fc5cd`（→Flutter P0 界面框架，2026-10-01，**未成**）
  → `917b751`（→Tauri 2，2026-10-09）
- **status**: 均已验证或已废弃（详见 CHANGELOG 的 0.1.1 段）
- **做了什么 / 为什么**：
  - `9a25438`：从 Tauri 2 迁移到 Electron 44，更名 SilverMoon。
  - `738adb7`：**彻底移除 Tauri 依赖**（`@tauri-apps/*` 六个 npm 包与六个 `tauri-plugin-*` crate
    全部移除）+ 中文名定为「银月」+ CI 提速。**但 `src-tauri/` 目录树被留下来了 —— 这就是
    今天 192 个文件遗留树的来源。**
  - `15fc5cd`：Windows 宿主由 Electron 重构为 Flutter（P0 界面框架）—— 验证后**撤掉**。
  - `917b751`：换回 Tauri 2。**几乎全是 `git mv`**（202 个 R）。
    唯一被删的 15 个文件就是 `crates/silvermoon-ipc/` 契约层（可从 `git show '917b751~1:<path>'` 取回）。
    Tauri 真正新增只有 14 个文件。
- **教训**：
  1. **「换壳不换芯」的代价全在契约层**：两次迁移的机械性，来自 `silvermoon-ipc` 逐项复刻了
     Tauri 的 `Builder` / `Host` / `HostApi` / `Window` / `WindowBuilder` / `rt` 与四个宏。
     业务代码里 473 处 `silvermoon_ipc::` 与旧 Tauri 版 `tauri::` **一一对应**。
  2. **误删功能模块**：`e95226f` 修过一次「宿主网络层把所有文本响应变成空 body」——
     主进程对 `text/*` / `application/json` 直接交字符串，渲染端却 `new Uint8Array(body)` 收字节，
     原始字符串被构造器**当成长度**（`ToIndex("…")` → 0），静默得到空数组。
     表现为 **QQ / 酷狗逐字歌词失效**。修法：响应体**一律以字节过桥**（形态唯一，出错面更小），
     并剥掉 `content-encoding` / `content-length`。
  3. **宿主迁移最容易漏的不是代码，是配置**：`package.json` 的 `main`、配置里的 `sidecar` 段、
     Cargo 依赖 —— 这三样各让 CI 红过一轮。

---

## 更早的历史（前身项目 LumiLuna）

v1.1.0 / v1.2.0 / v1.2.1 属**前身项目**版本线（详见 [`../CHANGELOG.md`](../CHANGELOG.md) §1.2.1）。
Electron 版是相对 Tauri 版的重构分支，版本号从 1.2.1 **回落到 0.0.1**——
「直接沿用会让首个 release 名不副实」。

---

## 待办（从 LOG 汇总）

| 项 | 来源 | 状态 |
|---|---|---|
| 注册 `ext:` 协议（补第 4 个 scheme + handler） | 2026-10-17 文档轮发现 | **已完成**（2026-10-22，见本节下方「屎山报告 P0/P1 落地」） |
| 加 `scripts/verify-docs.mjs` 守卫 README 与 AGENTS | 2026-10-17 文档轮 | **已完成**（35f50f8，接入 `npm run lint` 与 CI） |
| `verify-ext-slots` / `verify-splash-*` 接入 CI | 2026-10-17 盘点 | **未做**（手动可跑）；`verify-capability-scopes` 已随 `src-tauri/` 删除 |
| 清理 `src-tauri/` 遗留树（192 文件 / 7.6MB） | 2026-09-24 遗留 | **已完成**（2026-10-22，整树删除，基线 `c9cee4b`） |
| 设置页 19 个分类的 IA 收敛 | `_review/11-settings-ia-plan.md` | 部分完成 |