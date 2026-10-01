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

## 附录 A：本地 `vite build` 存量报错

`npx vite build`（Node 24.15.0，本机）报：
`[vite:html-inline-proxy] Could not load index.html?html-proxy&inline-css&index=0.css`。

- 已验证：stash 全部改动后在基线上同样报错 → **非本次 AMLL 引入**；
- CI（GitHub Actions，Build Windows/Linux）同配置构建**成功**（run 36210820819）→ 生产路径无碍；
- 触发源大概率是 `index.html:7-65` 的内联 `<style>`（boot-splash）与本地 Vite 版本的
  `html-inline-proxy` 兼容性问题。定位方向：对比本地/CI 的 node 版本（24 vs 22）、
  重装 node_modules、或把内联样式抽成独立 CSS 文件（保留首帧显示需权衡）。
