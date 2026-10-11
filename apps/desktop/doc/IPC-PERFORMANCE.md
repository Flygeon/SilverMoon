# IPC 性能分析与优化清单

> 本文是**阅读现有代码**得出的结论，未做运行时测量。
> 标注「实测」的都有具体来源；标注「估算」的是推算。

## 先看架构：谁是瓶颈

```text
渲染进程（Vue）
   │  invoke(命令名, 参数)          [src/ipc/invoke.ts → bridge.ts]
   ▼
@tauri-apps/api/core 的 invoke
   │  参数与返回都会先变成 JSON 字符串（serde）
   ▼
WebView2 的 postMessage 通道（Windows）
   ▼
Rust 主进程  68 条命令 [src-tauri/src/lib.rs]
```

**关键事实：Tauri 2 的 IPC 载荷是 JSON**（不是 Electron 的结构化克隆）。
这不是实现细节，而是所有优化都要围绕的中心：

| 载荷 | 过桥形态 | 成本 |
|---|---|---|
| 普通对象 / 数组 | JSON 字符串 | 序列化 + 解析，随体积线性增长 |
| `Uint8Array` / `Vec<u8>` | 二进制（`InvokeBody::Raw`）| **零 JSON 成本** |
| `Map` / `Set` / `Date` | 需显式降级 | 见 `toCloneablePayload` |

Electron 时代的一些直觉在 Tauri 下**不成立** —— 这是后面几条的前提。

## 一、一个确凿的 bug：批量缩略图命令从未被使用

这是本次阅读中**唯一确定的性能缺陷**，也最容易修。

### 现状

Rust 侧有两条命令，都已在 `lib.rs` 注册：

```text
commands/thumbnail.rs:281  pub fn get_thumbnail(app, file_id: String, size) -> Option<String>          // 单张
commands/thumbnail.rs:295  pub fn get_thumbnails(app, file_ids: Vec<String>, size) -> Vec<Option<String>> // 批量
```

批量命令的注释明确写了它的用途：

> 单张版 `get_thumbnail` 在网格滚动时会变成 N 次进程往返（30 张卡片 = 30 次
> IPC + HTTP + JSON 信封），这是列表滚动卡顿的主要来源之一。批量通道把它压成一次。

**但前端零处调用它。** `capabilities.getThumbnails()` 的实现是：

```ts
const results = await invokeBatch<string | null>(
  fileIds.map((fileId) => ({ cmd: "get_thumbnail", args: { fileId, size } })),
);
```

而 `invokeBatch` 的真实语义（`bridge.ts:162`）是 `Promise.all` 包 N 次**独立** invoke：

```ts
return Promise.all(
  calls.map(async (call) => {
    const data = await invokeRaw<T>(call.cmd, call.args);   // ← N 次独立 invoke
    return { ok: true, data };
  }),
);
```

也就是说：**「批量」只是前端并发发起，往返次数一次没少**。

### 成本

以滚动一屏 30 张卡片为例：

| | 往返次数 |
|---|---|
| 现在（`invokeBatch` + `THUMB_BATCH=16` 分块）| 30 次 |
| 改用 `get_thumbnails` 批量命令 | **2 次**（30 ÷ 16 向上取整）|

### 修法

`capabilities.getThumbnails()` 直接调 `get_thumbnails`（复数），传 `fileIds` 数组。
返回值是按**下标一一对应**的 `(string | null)[]`，与现在的形状一致，
调用方（`library.ts`）无需改动。

`THUMB_BATCH` / `concurrency` 可以重新调参 —— 既然一次往返能吃下整批，
分块的意义只剩「限制单次 Rust 侧处理时长」。

## 二、按收益排序的优化项

### P0 —— 明确、低风险

**1. 修掉上面的批量缩略图 bug。** ✅ **已完成**

`capabilities.getThumbnails()` 已改为直接调 `get_thumbnails`（复数）。
回归测试 `src/capabilities/__tests__/thumbnailBatch.test.ts` 钉住「只发生一次调用、
命令名是复数形」—— 已验证：改回老实现时该测试会失败。

**2. 返回二进制的命令改用 `tauri::ipc::Response`。**

当前有若干命令返回 `Vec<u8>`（图片字节）：
`extract_frame` / `embedded_cover` / `sidecar_cover` / `epub_cover`。

走 JSON 时 `Vec<u8>` 会被序列化成**数字数组** —— 一个 100 KB 的 JPEG 变成
`[255,216,255,...]` 这种形式，体积膨胀约 **3～4 倍**，两端还要各做一次解析/构造。

Tauri 2 提供零 JSON 的二进制返回（已核对 v2.12.1 源码）：

```rust
#[tauri::command]
pub fn extract_frame(...) -> tauri::ipc::Response {
    tauri::ipc::Response::new(jpeg_bytes)   // → InvokeResponseBody::Raw，零 JSON
}
```

`InvokeResponseBody` 只有 `Json(String)` 与 `Raw(Vec<u8>)` 两个变体，
`Vec<u8>` 会走 `Raw` —— 前端收到 `ArrayBuffer`，由 `toBytes()` 接住
（`bridge.ts` 里已经写好了这个转换器，只是目前没有命令在用它）。

**但要注意**：我逐个查过，`extract_frame` / `embedded_cover` 等**前端目前零调用**。
所以这条的优先级取决于是否计划启用它们（例如视频抽帧做封面）。
现阶段不必改 —— 除非确实要用。

**3. 高频事件改用 `Channel` 而不是 `emit`。**

`scan:progress` 走 `app.emit()`（全局广播）。已核对源码，Tauri 2 有
`tauri::ipc::Channel<T>`（Rust 侧 `send()`，前端 `new Channel(cb)`），
它是**点对点**的，且有**顺序保证**（前端实现里有 `index` + `pendingMessages`）。

当前发送频率**已经节流**（`scan.rs` 的 `set_stage` 只在 `i % 500 == 0`、
`n % 25 == 0` 时发），所以收益不在频率，而在于：

- `emit` 是广播，多窗口时每个窗口都要过一次事件系统；
- 载荷同样走 JSON。

若将来出现「扫描时 UI 卡顿」，这是第一个该看的地方。**现在不必改。**

### P1 —— 有收益，但需要先测量

**4. 给 IPC 加计量，用数据而不是直觉决定后续优化。** ✅ **已完成**

`src/utils/ipcMetrics.ts` + `bridge.ts` 的 `invokeRaw`（唯一收口）已接入。
可直接量出：

- 每次调用的往返耗时；
- 载荷大小；
- 按命令名聚合的 P50 / P95。

**我建议先做这个，再决定 5～7 做不做。** 理由见文末「方法论」。

**5. `list_files` 的载荷瘦身。**

`MediaEntry` 是 `files` 与 `media_metadata` 的扁平连接，而 `MediaMetadata`
有 **32 个字段**（大多 `Option`，序列化后大量 `null`）。`PAGE_SIZE = 400`，
所以一次首页 = 400 × 32 个键的 JSON。

可考虑：

- 列表页只返回展示真正需要的字段（单独的 `MediaSummary`），详情页再取全量；
- 加 `#[serde(skip_serializing_if = Option::is_none)]` 去掉 `null` 键 ——
  一行属性，前端读到的仍是 `undefined`，在判空场景与 `null` 等价。

**注意**：改 `MediaEntry` 字段必须同步检查前端判空逻辑，不能只看体积。

**6. 启动期串行 await。**

`App.vue` 的启动链已有优化痕迹（「设置 785ms → 皮肤 1204ms」那条注释），
说明这里被优化过一轮。剩下可做的：确认 `settings.load()` 与 `skins.load()`
之间是否真有依赖 —— 若无，`Promise.all` 可省掉一次串行往返。

### P2 —— 结构性，收益大但改动大

**7. 大列表改游标分页。**

`fillRemaining` 用 `offset += PAGE_SIZE` 逐页拉全量。对 10 万条图库，
这本身是 O(n) 次往返；且 SQLite 的 `OFFSET` 是**线性扫描**（越翻越慢）。
改为按 `(mtime, id)` 的游标分页可走索引。

但这是**数据库层**优化，不纯是 IPC —— 且要先确认用户是否真有这么大的库。

**8. 极限情形下绕开 IPC。**

缩略图这条路已经做对了：返回**磁盘路径**，前端拼 `asset://` 交给 `<img>` 流式加载，
不经 IPC 传字节。`capabilities.getThumbnail` 的注释也解释了原因（base64 会撑爆内存）。

任何「要把大块数据送进渲染进程」的新需求，都应先问：**能不能只传路径 / URL？**

## 三、已经做对的地方（不要动）

**事件订阅是「一个事件一次原生订阅」**（`ipc/events.ts`）：内部维护
`handlers: Map<event, Set<handler>>`，每个事件只建一次 `tauriListen`。
这避免了「每个组件各 listen 一次、同一事件被原生投递 N 次」的常见错误。

**二进制透传**：`toCloneablePayload` 对 `ArrayBuffer.isView` **原样返回**，
并注释「转成 JSON 数组反而会膨胀数倍」—— 判断正确。

**列表页带 `thumbPath`**：`MediaEntry.thumb_path` 让缓存命中的缩略图**零命令**
（`lib.rs:113` 注释：「命令数从 O(可见项) 降到 0」）。方向正确，
只差未命中那条路径没走批量（见 P0-1）。

**`Map` / `Set` 显式降级**并有单测覆盖
（`bridgeClone.test.ts` / `localTagIpcClone.test.ts`）。

## 四、怎么用这套计量（已实现）

**默认关闭**（不给普通用户加每调用一次的开销）。需要时在控制台打开：

```js
// 1) 打开计量（写入 localStorage，重开窗口仍生效）
localStorage.setItem("silvermoon:ipcMetrics", "1")

// 2) 操作一会儿（滚动图库、切页、扫描…）

// 3) 看结果（按总耗时降序，带占比）
window.__silvermoonIpcStats()

// 4) 清空重来
window.__silvermoonIpcReset()
```

输出形如：

```text
命令            次数  总耗时ms  占比    平均ms  P95ms  最大ms  失败  平均参数B
list_files        12    1840.2   62.1%   153.4  402.1   512.3     0      8421
get_thumbnails    30     612.7   20.7%    20.4   45.2    88.1     0       412
scan_start         1     220.5    7.4%   220.5  220.5   220.5     0        18
```

**怎么读它**：

- **看占比**：优化应当从占比最高的那项开始，而不是凭感觉；
- **看 P95 与最大值的差距**：平均值小但 P95 大，说明「偶尔卡一下」，
  通常来自缓存未命中或磁盘抖动；
- **看平均参数B**：载荷大且占比高的命令，才值得考虑瘦身或改二进制。

计量本身的成本：`performance.now()` 两次 + 一次 `JSON.stringify`（估算参数大小）。
关闭时只有一次 `performance.now()`。样本按命令各自保留最近 **512** 次（环形缓冲），
内存有界。

## 五、方法论：先测再改

上面列了 8 项，但**不建议按顺序全做**。理由：

IPC 往返的真实成本高度依赖环境 —— 本次会话就见识过：同一台机器上
wgpu 的 Vulkan 后端会原生崩溃，而 DX12 正常。没有计量就说
「换成二进制能快 X%」是猜测，不是工程。

建议顺序：

1. **先做 P0-1**（批量缩略图）—— 这是确凿的功能缺陷，不是猜测；
2. **加 IPC 计量**（P1-4）—— 让后续每一项都有前后对比的数字；
3. 拿真实操作的耗时分布，再决定 P1 其余项。

判别标准：**若某项优化后用户感知不到指标只提升个位数百分比，它就不值得引入复杂度。**
