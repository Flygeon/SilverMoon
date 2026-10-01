# 银月（SilverMoon）交互卡顿 · 性能复核与建议

> 复核时间：本次会话 · 复核对象：`src/`（Vue 3 渲染层）+ `electron/`（主进程中转层）+ `backend/`（Rust 侧车）
> 结论基于**逐文件代码核对**，每条都带 `文件:行` 证据，可自行验证。
> 本文只回答两件事：**卡在哪** / **该不该往下沉**。不含未经验证的猜测；标 `[需实测]` 的项建议先测再改。

---

## 0. 先纠正一个前提

"点击卡" 在这套架构里**大概率不是后端往返慢**。

单条命令的链路是：

```
渲染进程 --structuredClone--> contextBridge --> ipcMain
        --> JSON.stringify --> HTTP POST /cmd --> Rust serde
        <-- JSON.parse <-- HTTP <-- 主进程
```

这条链路的**固定开销约 0.5–2ms**，一次点击点下去感知不到。
真正会造成"点一下卡一下"的，是下面三类：

| 类别 | 表现 | 本文档 |
|---|---|---|
| **A. 每帧 GPU 被榨干** | 所有页面、所有操作都钝，动画掉帧 | P0-2 |
| **B. 点击触发的命令数量是 O(n)** | 滚动/切页越用越卡 | P0-4、P0-5 |
| **C. 把已有数据丢掉重新等后端** | 骨架屏闪烁、白一下 | P0-3 |
| **D. 主进程事件循环被大 payload 阻塞** | 窗口拖拽/缩放也卡 | P1-7 |

**所以"把业务逻辑下沉到后端"对这个问题基本无效，甚至更慢**——见 §3。

---

## 1. 先测量，别猜（半天工作量，收益最高）

在动手前先插一层计时，把"传输慢"和"渲染慢"分开：

1. **命令级计时**：在 `electron/sidecar.ts` 的 `post()` 里包一层
   `performance.now()`，记录 `cmd` / 耗时 / `JSON.stringify(body).length` / `text.length`，
   聚合出每条命令的 p50 / p95 和平均 payload 字节数。
   一次点击如果打了 30 条命令，日志会直接暴露出来。
2. **渲染级**：DevTools Performance 面板录一次"点击 + 滚动"，
   看 Long Task 落在 Script / Recalc Style / Layout / Paint / Composite 哪一段。
   若 Composite/Paint 占大头 → 走 P0-1、P0-2；若 Script 占大头 → 走 P0-3~P0-5。
3. 已有 `app_log` 通道（`src/capabilities/index.ts:87`）可直接复用，无需新基础设施。

---

## 2. P0：立即可做，收益最大，风险最低

### P0-1 ⭐ `.layer` 的 `will-change: transform` 挂在"整卷高度"的元素上

**证据** `src/components/MediaGrid.vue:280-288`

```css
.virtual-root { position: relative; width: 100%; }   /* 模板内联 height = totalH px */
.layer { position: absolute; inset: 0; will-change: transform; }
```

`.virtual-root` 的高度是 `totalH`（`MediaGrid.vue:88` = 行数 × 行高）。
上万条媒体时它可以是**几万到十几万像素高**，而 `.layer` 是 `inset:0` 的绝对定位子元素，
高度等于父容器 → `will-change: transform` 把这个**整卷高度**的元素提升为独立合成层。

合成层纹理按元素尺寸分配，Chromium 只能分块/截断，结果是每帧的光栅化范围、显存占用、
层管理开销都被放大。滚动和点击都会抖。

**修法（任选，推荐第 1 个）**
1. 删掉 `.layer` 上的 `will-change`。`translateY` 本身就走合成器，不需要显式提升。
2. 若确需提升，把 `will-change` 移到**只覆盖视口高度**的内层容器（`position: sticky; top: 0` 的包裹层），
   而不是整卷元素。

---

### P0-2 ⭐ FluidBackground 每帧做一次全屏模糊

**证据** `src/components/FluidBackground.vue:92-100、121-142、197-205`

```js
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width  = w * dpr;        // 2560×1440 窗口 @2x → 5120×2880
canvas.height = h * dpr;
// rAF 循环：每帧 clearRect + 4 次 drawImage(screen 混合)
```
```css
.fluid-canvas { transform: scale(1.5); filter: blur(30px) saturate(2.5) brightness(0.5); }
```

canvas 内容**每帧都在变**，所以 `blur(30px)` 每帧都要在 ~1500 万像素的纹理上重算一次。
这是全应用最贵的一件事，而且是**持续**的：它会把 GPU 队列占满，
导致**其它页面**的点击、滚动、动画一起变钝。

**修法（视觉几乎无差别，成本降一个数量级）**
- **把 canvas 内部渲染分辨率砍到 ~0.3x**：`canvas.width = w * 0.3`（CSS 尺寸仍是 `w + 'px'`，
  由 `scale(1.5)` 拉回去）。最终要过 30px 模糊，细节早就没了，
  但模糊的像素数从 1500 万降到 ~130 万。
- 循环暂停策略现在只有 `document.hidden`（`FluidBackground.vue:107-111`）。
  建议**窗口失焦时也暂停**，并在设置里给"动态封面"一个开关
  （低端机/核显用户会直接受益）。
- 注意：`AGENTS.md` 说 "Magic numbers from Apple Music reference — do not change"，
  所以**不要动 blur/scale 的数值**，只动 canvas 的内部分辨率——观感不变。

---

### P0-3 每次查询都丢掉旧数据、显示骨架屏

**证据** `src/stores/library.ts:59-77` + `src/components/MediaGrid.vue:208-221`

```ts
async function refresh(type: string) {
  loading.value = true;          // ← 无条件置 loading
  const list = await capabilities.listFiles({...});
  entriesByType.value = { ...entriesByType.value, [type]: list };
}
```

`MediaGrid` 在 `loading` 为真时渲染的是**骨架屏分支**（`v-if="loading"`），
把已经拿到的数据整个换掉。触发点：

- 首次进入每个 tab（`ImagesView.vue:39` `onMounted(load)`）
- 工具栏排序/筛选变化（`LibraryToolbar.vue:44` `emit("changed")`）
- 搜索防抖命中后（`LibraryToolbar.vue:29-35`，已防抖 260ms，这点做得对）

结果：**每次搜索/排序都是"白一下 → 等一次完整后端往返 → 重新拉缩略图"**。

**修法：stale-while-revalidate**
```ts
async function refresh(type: string, opts?: { silent?: boolean }) {
  const cached = entriesByType.value[type];
  if (!cached?.length) loading.value = true;   // 只有首次才骨架屏
  try { /* ... 拿到新数据后原地替换 ... */ }
  finally { loading.value = false; }
}
```
有缓存就立刻渲染旧数据、后台刷新、回来原地替换。切回已看过的 tab 应当是**零等待**的。

---

### P0-4 ⭐ 缩略图是 N+1 次进程往返

**证据** `src/stores/library.ts:97-133` + `src/capabilities/index.ts:190-194`

```ts
const url = await capabilities.getThumbnail(id, 320);   // ← 每个 id 一次独立命令
```

每个缩略图 = 一次独立 IPC + 一次 HTTP `get_thumbnail`。滚动一屏 30 张卡片
就是 **30 次进程往返**，6 并发也得分 5 批。滚动越猛、图越多，越明显。

**修法（两档，推荐第二档）**
1. **小改**：加批量命令 `get_thumbnails(ids: string[])`，一次往返拿一批。
2. **大改（推荐）**：让 `list_files` 的返回里**直接带上每条的 `thumbPath`**
   （SQLite 里本来就有或可推导），前端本地 `toAssetUrl(thumbPath)` 拼 URL。
   于是缩略图加载**零命令**——`asset://` 协议本身就是流式加载，走 webview 自己的网络栈，
   不需要经过命令通道。这也是 `MediaGrid.vue:9` 注释里已经认定的方向，只是没走到底。

---

### P0-5 设置页：拖一次滑块 / 敲一个字符 = 一次全量落盘

**证据** `src/stores/settings.ts:380-391、430-436` + `src/ipc/store.ts:19-31` + `src/views/SettingsView.vue:674、825、834、843`

```ts
watch(Object.values(fields), () => { if (loaded.value) void save(); }, { deep: true });

async function save() {
  const payload = {};                                   // 全部字段
  for (const [k, r] of Object.entries(fields)) payload[k] = r.value;
  await store.set("settings", payload);                 // → toCloneable() 里 JSON.parse(JSON.stringify())
  await store.save();                                   // → 再序列化一次 + HTTP + Rust 写整文件
}
```

而 `SettingsView` 里滑块用的是 `@input`（`SettingsView.vue:674、825、834、843…`），
**拖动过程中会连续触发**。文本框（`SettingsView.vue:1214 v-model="bangumiTokenDraft"`、
`1294 v-model="settings.pixivRefreshToken"`）是**逐键触发**。

于是拖一次字号滑块 = 几十次「整个 settings 对象 JSON 序列化 ×2 + IPC + HTTP + 写整个文件」。
这是设置页明显发涩的直接原因。

**修法**
1. `save()` 加 **300–500ms debounce**（并保留退出前兜底落盘，现有机制不变）。
2. 滑块/文本框改用 `@change`（松开/失焦才提交），或至少对 `@input` 走同一 debounce。
3. `toCloneable()`（`src/ipc/store.ts:24`）对已经是纯对象的值做无谓的全量深拷贝；
   可以先用 `structuredClone` 尝试、失败再退化到 JSON，或按需浅拷。

---

## 3. P1：中等改动，看 P0 做完后的实测结果再决定

### P1-6 命令通道没有批量能力

现在一次点击里的 N 个 `capabilities.*` 调用 = N 次往返。
加一个 `batch` 通道（`call([{cmd,args},…])`）或请求合并层，前端 `Promise.all` 变成 1 次 HTTP。
配合 P0-4 的批量缩略图命令，是同一件事的两个面。

### P1-7 大 payload 的序列化发生在主进程单线程上

**证据** `electron/sidecar.ts:254-272` + `electron/ipc.ts:43-52`

```ts
private async post(route, body) {
  body: JSON.stringify(body),      // ← 主进程线程
  const text = await response.text();
  return JSON.parse(text);         // ← 主进程线程
}
```

主进程这条 JS 线程同时负责窗口事件（拖拽、缩放、焦点、菜单、托盘）。
列表几千条时，每次命令都在主线程上做一次大 JSON 往返 → **窗口本身也会卡**，
不只渲染层。

**修法**
- 列表接口**分页**（`limit/offset` 或游标），别一次拉全库；
- 大二进制一律走 `asset://` / 流式，不走 JSON；
- 或者把侧车 HTTP 中转挪到 `utilityProcess` / Worker，把主进程事件循环让出来。

### P1-8 keep-alive 没有上限，组件只增不减

**证据** `src/App.vue:293`

```html
<keep-alive :exclude="['PlayerView']">
```

没有 `max`。你**访问过的每个页面都会永远留在内存里**（连同它的 DOM、
虚拟滚动层、在线图片/动漫面板）。会话越长，内存和 GC 压力越大 →
正好对应"用一会儿之后感觉越来越卡"。

**修法**：`:max="8"` 之类的上限，或按"是否含重型面板"精细化 exclude。

### P1-9 `translate()` 每次调用都 split + 逐层走对象

**证据** `shared/i18n.ts:1454-1462`

```ts
export function translate(lang, key) {
  const keys = key.split(".");           // 每次调用都分配数组
  let node = messages[lang];
  for (const k of keys) { /* 逐层 */ }   // 每次调用都走一遍
}
```

`t()` 在 `v-for` 的每一行/每个卡片里被调用（`MediaGrid.vue:49-51、270`），
滚动时是每帧几十上百次 `split` + 属性查找。

**修法**：模块级 `Map<string,string>` 缓存（`lang + "\u0000" + key` → 结果），
或启动时把嵌套表**预编译成扁平表**。改动小，纯收益。

---

## 4. 关于"把业务逻辑下沉到后端"——判据与清单

### 4.1 判据：不要按"逻辑复杂"下沉，按"是否需要 IO + 是否可缓存/可批处理"下沉

| 下沉的理由 | 是否成立 |
|---|---|
| "前端逻辑太复杂，想挪到后端" | ❌ 只会**多一次进程往返**，点击更慢 |
| "这块要读磁盘/DB/网络，且结果可缓存" | ✅ 成立（缩略图、封面 URL、元数据归一） |
| "这块是纯 CPU 计算，占住了 UI 线程" | ⚠️ 成立，但**优先用 Web Worker**，不是后端 |
| "这块今天造成了 N 次往返" | ✅ 成立（合并成 1 条命令 = P0-4 / P1-6） |

**关键区分**：纯计算放 **Web Worker**（零序列化成本、不用过进程边界、可取消）；
需要 IO 的放**后端**。这个仓库已经有正确先例——`src/workers/wordAnalysis.worker.ts`
（FFT 逐字歌词分析）就是按这个原则放的。

### 4.2 具体清单

**值得下沉到后端（IO / 可缓存）**
- 缩略图路径解析（P0-4）——一次性并入 `list_files`，前端零命令
- `src/utils/onlineCache.ts` 的 host 白名单 + 代理路由
- `src/utils/kugou.ts` 的 `mergeNested` 浅展开、时长单位判定、封面 URL 模板改写
- 封面/媒体 URL 里散落的 host 改写逻辑

> 这四条与 `doc/BACKEND_MIGRATION_PLAN.md` §6 的判断一致，可以直接采纳。

**值得下沉到 Web Worker（纯计算，别放后端）**
- 歌词解析 `parseLrc()` / `buildLyricSequence`（`src/stores/player.ts` 42KB 里的热路径）
- `src/utils/animeRules.ts`（25KB）+ `animeXPath.ts`（11KB）的规则求值/预览
- `src/utils/shareCode.ts`（37KB）、`qrc.ts`（20KB）的编解码
- `src/utils/preciseLyrics.ts`（11KB）

**不要下沉**
- 已经下推到 SQL 的过滤/排序/分页（`library.ts:58` 注释已说明）——这是对的，别往回搬
- 纯视图状态（当前 tab、滚动位置、选中项）

### 4.3 ⚠️ 一个更激进但收益更大的选项（需权衡）

目前 **渲染进程 → 主进程 → HTTP → 侧车**，主进程是个**纯中转**，
却为每个 payload 付了完整的两轮序列化成本。

既然侧车已经监听 `127.0.0.1` + `X-SilverMoon-Token` 鉴权，
可以考虑**让渲染进程直接访问侧车 HTTP**，只把 `/_host` 反向通道留在主进程。
收益：每条命令省掉一次 structuredClone + 一次 JSON 往返 + 一次进程跳转。

代价：token 要下发到渲染进程（需限制在 `app://` origin、CSP 放行 `connect-src`、
侧车加 CORS 白名单），安全边界变窄。
**建议先做完 P0/P1 并实测**——如果 P1-7 实测确认主进程是瓶颈，再评估这一项。

---

## 5. 已经被优化好的部分（别动）

复核中确认以下做法是对的，避免"优化"时误伤：

- `MediaGrid.vue:1-10` 三层大图库策略（虚拟滚动 / 可视区批量缩略图 / `asset://` 而非 base64）——方向完全正确
- `library.ts:20-21` `shallowRef` + 版本号手动触发，规避大 Map 的 Proxy 开销
- `library.ts:11` `THUMB_CACHE_LIMIT` + LRU 淘汰
- `library.ts:173-181` 事件驱动扫描进度，替代旧的 500ms 轮询
- `LibraryToolbar.vue:29-35` 搜索防抖 260ms
- `library.ts:58` 搜索/排序/体积过滤下推到 SQL
- `FluidBackground.vue:219` 已移除 `.dark-overlay` 的 `backdrop-filter`（注释里明确写了"逐帧整屏重采样，最耗 GPU"）
- `src/workers/wordAnalysis.worker.ts` 把 FFT 放到 Worker

---

## 6. 建议落地顺序

| 顺序 | 项 | 预估 | 为什么这个顺序 |
|---|---|---|---|
| 1 | §1 插桩计时 | 半天 | 后面所有决策都靠它，避免瞎改 |
| 2 | P0-1 去掉 `.layer` 的 `will-change` | 10 分钟 | 改一行，零风险 |
| 3 | P0-2 canvas 内部分辨率降到 0.3x | 半小时 | 全应用受益，观感不变 |
| 4 | P0-3 stale-while-revalidate | 半天 | 消除骨架屏闪烁，用户感知最强 |
| 5 | P0-5 设置保存 debounce | 1 小时 | 设置页立刻不涩 |
| 6 | P1-8 keep-alive `:max` | 10 分钟 | 治"越用越卡" |
| 7 | P1-9 `translate` 缓存 | 半小时 | 纯收益，滚动更稳 |
| 8 | P0-4 缩略图并入 `list_files` | 1–2 天 | 收益最大但动到契约，放最后 |

---

## 7. 一句话总结

**卡顿的主因不在"后端往返慢"，而在：**
**① 每帧一次全屏模糊把 GPU 榨干（P0-2）；**
**② 缩略图/设置保存这类 O(n) 命令风暴（P0-4、P0-5）；**
**③ 有缓存却丢掉重等的刷新策略（P0-3）；**
**④ 一个挂错位置的合成层（P0-1）与无上限的 keep-alive（P1-8）。**

**"业务逻辑下沉后端"解决不了这四条**；它该做的是**把 IO/可缓存的东西合并成更少的命令**
（§4.1 判据），而纯计算应当下沉到 **Web Worker**，不是后端。
