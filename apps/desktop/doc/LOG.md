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

---

## 2026-10-17 · 文档真源重建（AGENTS / SPEC / LOG / README）

- **commit**: `pending`（本轮 docs-only 提交；提交后回填 hash。基线 `596e4f5`）
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
  （`scrim` / `shadow` 有意排除）。文档真源是 [`doc/M3配色系统.md`](doc/M3配色系统.md)。

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
| 注册 `ext:` 协议（补第 4 个 scheme + handler） | 2026-10-17 文档轮发现 | **未做** |
| 加 `scripts/verify-docs.mjs` 守卫 README 与 AGENTS | 2026-10-17 文档轮 | **未做** |
| `verify-ext-slots` / `verify-capability-scopes` / `verify-splash-*` 接入 CI | 2026-10-17 盘点 | **未做**（手动可跑） |
| 清理 `src-tauri/` 遗留树（192 文件 / 7.6MB） | 2026-09-24 遗留 | **未做** |
| 设置页 19 个分类的 IA 收敛 | `_review/11-settings-ia-plan.md` | 部分完成 |
