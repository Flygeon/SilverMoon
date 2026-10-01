# 银月整体优化方案：启动时间 · 内存占用 · 运行时性能

> 制定时间：2026-09-26。基于逐文件代码核对（每条带 `文件:行` 证据）+ 实测 dist 包体积。
> 与 `doc/PERFORMANCE_REVIEW.md` 的关系：那份聚焦**交互卡顿**，其中部分项已落地（见 §3.1）；本方案补齐**启动时间**与**内存占用**两个维度，并给出统一的落地顺序。
>
> **落地进度（2026-09-26 更新）**：
> - ✅ S1 窗口创建与后端握手并行（`electron/main.ts`）
> - ✅ S4 启动打点（`electron/main.ts` bootstrap 内 `[启动]` 日志）
> - ✅ S2 AMLL/pixi·artplayer 动态 import + manualChunks（`FluidBackground.vue` / `AnimePlayer.vue` / `vite.config.ts`）
> - ✅ 封面 `app-cover://` 协议方案（`electron/protocols.ts` + `CachedCover.vue`，含磁盘缓存/并发去重/负缓存/防盗链 Referer 伪装）
> - ℹ️ S3/P1-9 修正：`translate()` 记忆化（`shared/i18n.ts` translationCache）**此前已实现**，i18n 扁平表无需再做；入口 chunk 瘦身由 S2 承担。
>
> 前置事实：`768494d`（AMLL 背景）CI 全绿；本地 `npx vite build` 报 `index.html?html-proxy&inline-css` 错为存量环境问题（CI 构建正常），见附录 A。

---

## 一、启动时间

### S1 ⭐ 主窗口创建与后端握手串行（收益最大）

**证据** `electron/main.ts:137-166`：

```ts
const started = await sidecar.start({ ... });   // 握手超时上限 15s（electron/sidecar.ts:190）
if (!started) { /* 降级提示 */ }
const mainWindow = createMainWindow();          // ← 排在 await 之后
```

后端没起来（或起来慢）时，窗口要白等最多 15 秒才出现。窗口本身用
`show: false` + `ready-to-show` 再显示（`electron/windows.ts:160,173`），**提前创建不会闪白屏**；
"后端未就绪"的降级弹窗逻辑也不依赖窗口创建顺序。

**改法**：`createMainWindow()` 提前到 `await sidecar.start()` 之前（或 `Promise.all` 并行），
渲染层本来就按"先转场、后加载"范式等待数据。降级对话框维持现状。

**预期**：冷启动到窗口可交互的时间从"等后端"变为"等前端"（后端正常时省 0.3–2s，
异常时从白等 15s 变成立即可见错误提示）。

### S2 ⭐ 把 pixi/artplayer 挡在首屏之外（双收益，见 M1）

**证据**：
- `@applemusic-like-lyrics/core` 顶层静态 import `@pixi/*` 6 个包（共 6.3MB 源码），
  引用链 `AmllBackground.vue → FluidBackground.vue → PlayerView.vue` 全静态；
- `artplayer` 静态 import（`src/components/AnimePlayer.vue:16`），经 `VideosView` 链路 278KB。

**改法**：
1. `FluidBackground.vue` 对 `AmllBackground` 用 `defineAsyncComponent(() => import(...))`；
2. `AnimePlayer` / artplayer 引用处改 `await import()`（hls.js 已是懒加载，照抄即可）；
3. `vite.config.ts` 加 `manualChunks`：`pixi`、`artplayer`、`hls`、`pdfjs`、`epub`、`leafer` 各自成块。

**预期**：PlayerView 首次进入不再拉 6.3MB 的 pixi 链（仅选 AMLL 模式才加载）；
懒块并行加载互不阻塞。

### S3 入口 chunk 1.10MB 的构成

**证据**：dist 实测入口 `index-*.js` 1.10MB（vue + m3e + i18n + stores + router）；
`shared/i18n.ts`（约 500 条 × 中英两份）为静态 import（`src/App.vue:16`）。

**改法**（按性价比排序）：
1. i18n **预编译扁平表**（模块加载时一次展开成 `Map`）——同时解决运行时每次 `t()` 的
   split + 逐层查找（PERFORMANCE_REVIEW P1-9），一鱼两吃；
2. m3e 组件已是按需注册（`src/m3e.ts:19-35` ✓），保持现状；
3. 28 个 `@font-face`（`src/assets/fonts.css`）确认都配了 `font-display: swap`，非首屏字重可延后。

### S4 启动打点（先量化再验证）

复用 `app_log` 通道（`src/capabilities/index.ts:87`）：主进程在
`app.whenReady` / `startHostServer` / `sidecar.start` / `createMainWindow` /
`ready-to-show` 五个点打 `performance.now()`；渲染层在 `main.ts` 顶部和 `App` 挂载完成各打一点。
一次日志即可看出时间花在哪段。**做 S1 前先加打点，做完对比。**

---

## 二、内存占用

### M1 ⭐ AMLL + pixi 链路的常驻开销（同 S2 改法）

当前静态链使 pixi 相关代码在**进过一次播放页后就常驻**（keep-alive 排除 PlayerView，
但模块缓存是进程级的）。改动态 import 后，切走 `amll` 模式时还可以在
`AmllBackground.vue` 卸载时 `dispose()`（已实现 ✓）让 GPU 资源随 renderer GC。

### M2 封面 dataURL 缓存无上限

**证据** `src/utils/onlineCache.ts:57-73`：封面以 dataURL 写入 IndexedDB 永久缓存，
**没有条数/体积上限**；解码后的位图由各组件 `<img>` 持有。

**改法**：给缓存表加上限（如 500 张 / 100MB，LRU 淘汰，超限删最旧）；
`CachedCover.vue` 展示侧维持现状（IndexedDB 在磁盘，主要收益是库不至于无限膨胀）。

### M3 已到位的（勿重复做）

- keep-alive `:max="8"` + `exclude PlayerView`（`src/App.vue:295`）✓
- FluidBackground 内部 0.35 倍分辨率渲染（`FluidBackground.vue:33`）✓
- 缩略图内存 Map LRU（`src/stores/library.ts:40`）✓
- AMLL 渲染参数 renderScale 0.5 / fps 30 / 卸载 dispose（`AmllBackground.vue`）✓

### M4 顺手修（影响小）

`src/views/DesktopLyrics.vue:159`：`window.addEventListener("blur", () => {...})` 用了匿名函数
且无对应 remove——好在它在**独立桌面歌词窗口**里、窗口即生命周期，实际影响可忽略；
改成具名函数 + `onUnmounted` 移除即可。

---

## 三、运行时性能（承接 PERFORMANCE_REVIEW.md 未完成项）

### 3.1 已落地（复核确认，勿重复做）

| 原 P0/P1 | 现状 |
|---|---|
| P0-2 全屏 blur | FluidBackground 已改 0.35 倍内部渲染 ✓；另有 AMLL 备选 ✓ |
| P1-8 keep-alive 无上限 | 已加 `:max="8"` ✓ |
| P1-7 涉及的扫描轮询 | 已改事件驱动 ✓ |

### 3.2 仍未落地（按原优先级继续）

| 项 | 证据 | 状态 |
|---|---|---|
| P0-1 `.layer` 整卷高度 `will-change` | `src/components/MediaGrid.vue:301`（注释已自知，仍未删） | **未做** |
| P0-3 刷新丢弃旧数据、骨架屏白闪 | `src/stores/library.ts:59-77` | **未做** |
| P0-5 设置滑块逐帧全量落盘 | `src/stores/settings.ts:380-391` + `SettingsView.vue` 多处 `@input` | **未做** |
| P0-4 缩略图 N+1 往返 | `src/stores/library.ts:97-133` | **未做**（动契约，放最后） |
| P1-9 `t()` 每次调用 split | `shared/i18n.ts` `translate()` | **已实现**（translationCache 记忆化，此前复核遗漏） |
| MusicView 裸 `v-for` 列表 | `MusicView.vue:752,776` | 待评估是否套 VirtualList |

### 3.3 建议新增的判据（与旧文档一致，重申）

纯 CPU 计算 → Web Worker（已有先例 `src/workers/wordAnalysis.worker.ts`）；
需要 IO/可缓存 → 后端并合并命令；**不要**为"逻辑复杂"下沉——那只会多一次进程往返。

---

## 四、量化目标与验收

| 指标 | 现状 | 目标 | 测法 |
|---|---|---|---|
| 冷启动 → 窗口可交互 | 未打点 | 打点后定基线，目标 ≤2s（后端正常） | S4 打点 + `app_log` |
| 渲染入口 chunk | 1.10MB | ≤800KB（pixi/artplayer 移出后） | `vite build` 输出（CI 或修复附录 A 后本地） |
| PlayerView 首次加载 | 含 pixi 全链 | 选 AMLL 模式才加载 pixi | Network 面板 |
| 播放页 GPU 峰值 | 动态模式仍有全屏 blur | 默认动画模式改 WebGL 单 pass（远期） | DevTools Performance / 任务管理器 GPU 列 |
| 稳态内存 | 未打点 | 打点后定基线；重点看"切 8 个页面后是否回落" | 任务管理器 per-process |

远期项（不在本轮）：FluidBackground「动态」模式重写为 WebGL 单 pass shader
（前一轮已论证，收益一个数量级），AMLL 模式上线后可视用户反馈决定是否投入。

---

## 五、落地顺序

| # | 项 | 工作量 | 风险 | 为什么排这里 |
|---|---|---|---|---|
| 1 | S4 启动打点 | 0.5 天 | 无 | 后面所有启动项的验收依据 |
| 2 | S1 窗口创建并行化 | 0.5 小时 | 低 | 改动极小、收益最大 |
| 3 | S2/M1 AMLL·artplayer 动态 import + manualChunks | 0.5 天 | 低 | 首包体积与内存双收益 |
| 4 | S3 + P1-9 i18n 扁平表 | 0.5 天 | 低 | 首包与滚动性能双收益 |
| 5 | M2 封面缓存 LRU | 0.5 天 | 低 | 独立改动 |
| 6 | P0-3 stale-while-revalidate | 0.5 天 | 低 | 用户感知最强 |
| 7 | P0-5 设置保存 debounce | 1 小时 | 低 | 设置页立刻不涩 |
| 8 | P0-1 删 `.layer` will-change | 10 分钟 | 低 | 一行改动 |
| 9 | P0-4 缩略图并入 list_files | 1–2 天 | 中（动 IPC 契约） | 收益大但需前后端同步改 |
| 10 | 附录 A 修本地 vite build | 待定位 | — | 只影响本地开发体验 |

每项做完跑一遍静态校验（prettier / vue-tsc / eslint），正确性交 CI——与项目惯例一致。

---

## 六、缓存层优化（2026-10 补录）

> 背景：对 Windows 端缓存做了全量盘点——**渲染层**（IndexedDB / 内存 Map）→
> **Electron 主进程**（`app-cover://` 磁盘缓存）→ **Rust 后端**（`thumbs/` + SQLite）。
> 本节只列**缺口**；已到位的一并列出（§6.1），避免重复做。

### 6.1 已到位（勿重复做）

| 能力 | 实现 |
|---|---|
| 本地媒体缩略图 | 磁盘缓存 `<cache>/thumbs/`，键 `xxh3(file_id:mtime:size:target)`，内容变即失效；列表侧一次 readdir 建索引 `(`commands/thumbnail.rs:19-71`)` |
| 在线封面 | 主进程 `app-cover://` 磁盘缓存 `<cache>/covers/`（sha256 分片）+ 按域伪装 Referer/UA + 并发去重 `(`electron/protocols.ts:200-318`)` |
| 封面离线 / 取主色 | IndexedDB `lumiluna-online` 的 `cover:` dataURL `(`src/utils/onlineCache.ts:57-73`)` |
| 逐字歌词精排 | IndexedDB `lumiluna` / `wordTimes`，`v:1` 版本校验 `(`src/utils/wordCache.ts`)` |
| WebDAV 目录 / 凭据 | IndexedDB `lumiluna-webdav` `(`src/utils/webdav.ts:20-36`)` |
| Bangumi 收藏 | 磁盘 `bangumi.json` `(`src/stores/bangumiCollect.ts:74-92`)` |
| 小说书架 + 章节正文 | SQLite `novel_shelf` / `novel_chapter_cache` `(`backend/src/commands/novel.rs:657,782`)` |
| 番剧历史 / 追番 | SQLite `anime_history` / `anime_favorites` `(`backend/src/anime.rs:661-742`)` |
| 媒体库列表 | stale-while-revalidate `(`src/stores/library.ts:95-137`)` + 缩略图内存 LRU 1200 `(`:58-71`)` |

规律：**用户"拥有"的列表（收藏 / 书架 / 历史 / 追番）基本都落盘了；平台"供给"的浏览型列表大多没缓存**——这是 M8/M9 的由来。

### 6.2 缺口（按性价比）

### M5 ⭐ 缩略图磁盘缓存无容量上限 / 无 LRU

**证据** `backend/src/commands/thumbnail.rs:353-367`：只有 `clear_thumbnail_cache` 手动全清；
文件改名或内容变化后旧键文件**永久残留**，库越大残留越多。

**改法**：加容量上限（如 2GB）+ 启动惰性 LRU 清理（按 `mtime` 淘汰最旧，复用列表侧那次 readdir 顺带统计）；
保留手动"清理缓存"入口。

> 注：`REWRITE_PROMPT_TAURI2.md:131` 早就规划了"带上限与 LRU 清理"，一直没落地。

### M6 ⭐ 在线封面磁盘缓存无淘汰、无清理入口

**证据** `electron/protocols.ts:235-246`（只写不删）、`src/views/SettingsView.vue:364`
（"清理缓存"**只清 `thumbs/`**，不动 `covers/`）。

**改法**：给 `covers/` 加 TTL（如 30 天）或容量上限 + 启动惰性清理；
并把 `covers/` 纳入设置页"清理缓存"（复用 `freed` 字节回显）。

### M7 负缓存只在内存

**证据** `electron/protocols.ts:207`（`coverFailedAt` Map，TTL 1h）——重启即失效，死链会再打一次网络。

**改法**：把失败时间戳写进 `covers/<hash>.json` 的 meta，读缓存时若处于负缓存窗口直接跳过；重启后仍生效。

### M8 ⭐ 在线歌单 / 歌曲列表基本不缓存

**证据**：

- `src/utils/meting.ts:78-86`：`metingPlaylist` / `metingSearch` **纯 fetch，零缓存**；
- `src/views/MusicView.vue:150-185`：仅 3 个预设榜单有内存 `playlistCache`（重启即丢、不覆盖用户歌单）；
- `src/stores/netease.ts:229-233`：我的歌单 / 云盘每次进入重拉；
- `src/utils/netease.ts:9-48`、`src/utils/kugou.ts:282-314`：只缓存**播放地址**（无 TTL、登出清空），不缓存歌曲列表。

**改法**：在 `metingPlaylist` / 网易云 / 酷狗 列表拉取处加一层 `key = server:id` 的 TTL 缓存
（建议 **10–30min**，歌单会变），落 IndexedDB 或内存 Map 均可。
搜索词缓存已有（QQ/kg 1h：`src/utils/qqMusic.ts:132`、`src/utils/kgMusic.ts:122`），可直接复用同一抽象。

### M9 笔趣阁 / 番剧浏览型列表未缓存

**证据**：

- `backend/src/novel_bqg.rs:117-129`：`get_api_json` 每次直连（带 fallback 域名），无 TTL、无落盘；
  前端 `src/components/NovelOnlineView.vue:120` 进页面重拉 rank/recommend，
  `src/components/NovelDetailPanel.vue:30` 打开详情重拉目录；
- `src/stores/anime.ts:192-211` 热播榜、`:141` 规则库、Bangumi 搜索：**无前端缓存**，每次重拉；
- 仅"搜索 / 换源抓取 HTML"有内存 TTL（`src/utils/animeFetcher.ts:27-103`，5min / 96 条 / 在途去重）。

**改法**：目录与榜单加 TTL 缓存（10–60min，后端侧可落 SQLite）；
番剧热播榜做 stale-while-revalidate（进页面先显旧数据再后台刷新，同媒体库列表的既有范式）。

### M10 统一 TTL 缓存抽象（消除重复样板）

**证据**：`src/utils/preciseLyrics.ts:30-32`（1h / 10min）、`src/utils/qqMusic.ts:132,179`、
`src/utils/kgMusic.ts:122,199`、`src/utils/animeFetcher.ts:27-103`——**四处各自手写** `Map + TTL + 在途去重`。

**改法**：抽一个 `src/utils/ttlCache.ts`（容量上限 + TTL + in-flight 去重 + `clear()`），四处替换；
M8 / M9 直接复用，避免再长出第五份样板。

### 6.3 结论记录：不引入 Redis

全仓（排除 `node_modules` 与 `*/参考` 第三方项目）**无任何 Redis 依赖或代码**——
命中项都在无关的参考项目（酷狗 / pixiv / ECHO）里。

对单机桌面应用，Redis 是**过度设计**：多一个常驻进程、增大安装与运维复杂度，
且封面 / 缩略图是二进制 blob，文件系统 + IndexedDB + SQLite 比 Redis 更契合"大值存储"。
**结论：不引入，勿再议。**

### 6.4 缓存项落地顺序

| # | 项 | 工作量 | 风险 | 备注 |
|---|---|---|---|---|
| 1 | M10 统一 TTL 缓存抽象 | 0.5 天 | 低 | M8 / M9 的前置 |
| 2 | M8 在线歌单列表 TTL 缓存 | 0.5 天 | 低 | 复用 M10 |
| 3 | M9 笔趣阁目录 / 番剧榜单 TTL | 0.5 天 | 低 | 后端目录可落 SQLite |
| 4 | M5 缩略图磁盘上限 + LRU | 1 天 | 中（动后端） | 与列表索引复用一次 readdir |
| 5 | M6 封面 `covers/` 上限 + 纳入清理 | 0.5 天 | 低 | 独立改动 |
| 6 | M7 负缓存落盘 | 1 小时 | 低 | 与 M6 同文件 |
| — | M2 封面 IndexedDB LRU | 0.5 天 | 低 | 已在 §五排期第 5 项，可与 M6 合并做 |

---

## 附录 A：本地 `vite build` 存量报错

`npx vite build`（Node 24.15.0，本机）报：
`[vite:html-inline-proxy] Could not load index.html?html-proxy&inline-css&index=0.css`。

- 已验证：stash 全部改动后在基线上同样报错 → **非本次 AMLL 引入**；
- CI（GitHub Actions，Build Windows/Linux）同配置构建**成功**（run 36210820819）→ 生产路径无碍；
- 触发源大概率是 `index.html:7-65` 的内联 `<style>`（boot-splash）与本地 Vite 版本的
  `html-inline-proxy` 兼容性问题。定位方向：对比本地/CI 的 node 版本（24 vs 22）、
  重装 node_modules、或把内联样式抽成独立 CSS 文件（保留首帧显示需权衡）。
