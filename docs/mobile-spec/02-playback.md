# 02 · 播放与音效 技术规格（Flutter 重写用）

> 证据来源（只读分析，未修改任何源码）：
> `apps/desktop/src/stores/player.ts`（1245 行）、`apps/desktop/src/stores/audioEffects.ts`（683 行）、
> `apps/desktop/src/utils/audioEffects.ts`（210 行）、`apps/desktop/src/utils/shareCode.ts`（271 行）、
> `apps/desktop/src/stores/settings.ts`（512 行）、`apps/desktop/src/components/AudioEffectsPanel.vue`（839 行）；
> 交叉核对：`apps/desktop/shared/types.ts`、`apps/desktop/src/views/PlayerView.vue`、
> `apps/desktop/src/ipc/store.ts`、`apps/desktop/backend/src/commands/{smtc,stats,song,mod}.rs`。
>
> 约定：时间单位在**前端 store 内一律为秒（浮点）**，只有跨 IPC / 数据库 / SMTC 时才乘 1000 转毫秒。
> 文中标注「⚠️ 未实现」的条目在当前源码中**确实不存在**，Flutter 侧属于新增设计，不要误当成既有行为。

---

## 1. 播放队列模型

### 1.1 队列项类型（`QueueItem`）

```ts
export type QueueItem = MediaEntry | OnlineSong | WebDavEntry;
export type NowPlaying = {
  id: string; title: string; artist: string; album: string;
  cover: string;    // 本地=dataURL；在线=http(s) URL
  src: string;      // 本地=asset:// 转换结果；在线=http(s) URL
  lyrics: LyricLine[];
  filePath?: string;    // 本地磁盘路径（SMTC 提封面用）
  coverUrl?: string;    // 在线封面 URL（SMTC 直连用）
  durationMs?: number;
  kind: "local" | "online" | "webdav";
};
```

队列**只存轻量条目**（列表页拿到的 `MediaEntry` / `OnlineSong` / `WebDavEntry`），切歌时才按需拉全量（`getSong(fileId)` / 解析在线直链）。

判别函数（三者的结构判别，必须与 Dart 端一致，否则队列项会被误判）：

```ts
function isOnline(item): item is OnlineSong { return "url" in item; }
function isWebDav(item): item is WebDavEntry { return "isDir" in item; }
// 展示字段兜底
queueTitle(item):  online|webdav -> item.name ; 否则 item.title || item.name
queueArtist(item): webdav -> "WebDAV" ; online -> item.artist ; 否则 item.artist || "未知艺术家"
queueDuration(item): online|webdav -> null ; 否则 item.durationMs ?? null
```

- `MediaEntry` 关键字段：`id, path, parent, name, ext, type, size, mtime, scannedAt, deleted, title?, artist?, album?, durationMs?, hasCover, favorite, thumbPath?`
- `OnlineSong` 关键字段：`id, name, artist, url, pic, lrc, album?, server?("netease"|"kugou"), hash?, albumAudioId?, albumId?, trial?, durationMs?`；`url` 对酷狗初始为空串，播放时惰性解析并**写回队列项**（避免重复请求）
- `WebDavEntry`：`name, path, isDir, size, mtime`

### 1.2 队列状态与当前索引

| 状态 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `queue` | `QueueItem[]` | `[]` | 内存队列，**不持久化** |
| `currentIndex` | number | `0` | 当前曲目在 `queue` 中的下标 |
| `shuffleMode` | boolean | `false` | 随机开关，**不持久化** |
| `repeatMode` | `"off" / "all" / "one"` | `"off"` | 循环模式，**不持久化** |
| `shuffledIndices` | number[] | `[]` | 内部字段，未导出；Fisher-Yates 生成的播放顺序 |

### 1.3 播放模式枚举与随机算法

- 枚举：`RepeatMode = "off" | "all" | "one"`（顺序播放 = off、列表循环 = all、单曲循环 = one）。
- `cycleRepeat()`：`off -> all -> one -> off`（数组 `["off","all","one"]` 取模前进）。
- `toggleShuffle()`：翻转 `shuffleMode`；置 true 时**立即**重算随机序。
- **随机算法（精确复刻）**：对整个队列下标做 Fisher-Yates 洗牌，结果存 `shuffledIndices`。

```ts
function generateShuffleOrder() {
  const indices = Array.from({ length: queue.value.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  shuffledIndices.value = indices;
}
```

要点（Flutter 必须保持一致的行为细节）：
1. 随机序是**全队列一次洗牌**，不是「每首随机挑下一首」；顺序在开启随机 / 队列变更（`setQueue`、`playOnline`、`addToQueue`、`playNext`、`removeFromQueue`、`clearQueue`）时整体重算。
2. 播放定位靠 `shuffledIndices.indexOf(currentIndex)`；`next` 取 +1 位，`previous` 取 -1 位（首尾环绕）。
3. 重算随机序**不会**把当前曲目挪到队首；因此开启随机后当前曲目在随机序中的位置是随机的。
4. `repeatMode === "one"` 时 `next()` 直接回到 0 秒重播，**不消费**随机序。

### 1.4 队列操作 API（签名与语义）

| API | 签名 | 语义 |
|---|---|---|
| `setQueue` | `(entries: QueueItem[], startIndex = 0) => void` | 整体替换队列；若随机开启则重算随机序；设置 `currentIndex = startIndex`。**不起播** |
| `playOnline` | `async (songs: OnlineSong[], index: number) => void` | `queue = songs; currentIndex = index`；随机开启则重算随机序；随后 `await playFromQueue(index)` |
| `playFromQueue` | `async (index) => void` | 越界直接 return；`currentIndex = index`；按类型分派 `loadWebDavSong / loadOnlineSong / loadById` |
| `addToQueue` | `async (item) => void` | 队列为空 -> `queue=[item]; currentIndex=0`（不起播）；否则追加队尾；随机开启则重算随机序 |
| `playNext` | `(item) => void` | **插播**：插到 `currentIndex + 1`（即「下一首播放」），不立即播放；队列为空时等价 `addToQueue`；随机开启则重算随机序 |
| `removeFromQueue` | `(index) => void` | 越界忽略；**不允许移除正在播放的当前曲目**（`index === currentIndex` 直接 return）；移除后若 `index < currentIndex` 则 `currentIndex -= 1`；队列清空则 `currentIndex = 0`；随机开启则重算随机序 |
| `clearQueue` | `() => void` | 仅保留当前曲目：`queue = [queue[currentIndex]]; currentIndex = 0` |
| `setIndex` | `(i: number) => void` | 仅改下标，不做任何副作用 |

### 1.5 next / previous 状态机（精确伪代码）

```ts
async function next() {
  if (queue.length === 0) return;
  if (repeatMode === "one") {
    el.currentTime = 0;                 // 重播当前曲
    if (song) beginSession(song);       // 旧会话已由 ended 事件 flush
    void el.play().catch(() => {});
    return;
  }
  let nextIndex;
  if (shuffleMode) {
    const pos = shuffledIndices.indexOf(currentIndex);
    const npos = pos + 1;
    if (npos >= shuffledIndices.length) {
      if (repeatMode === "all") { generateShuffleOrder(); nextIndex = shuffledIndices[0]; }
      else { playing = false; syncSmtc(true); return; }   // 停在队尾，不换歌
    } else nextIndex = shuffledIndices[npos];
  } else {
    nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) {
      if (repeatMode === "all") nextIndex = 0;
      else { playing = false; syncSmtc(true); return; }
    }
  }
  await playFromQueue(nextIndex);
}

async function previous() {
  if (queue.length === 0) return;
  if (el && el.currentTime > 3) { el.currentTime = 0; return; }  // 3 秒阈值：先回开头
  let prevIndex;
  if (shuffleMode) {
    const pos = shuffledIndices.indexOf(currentIndex);
    prevIndex = pos > 0 ? shuffledIndices[pos - 1] : shuffledIndices[shuffledIndices.length - 1];
  } else {
    prevIndex = currentIndex > 0 ? currentIndex - 1 : queue.length - 1;  // 恒环绕
  }
  await playFromQueue(prevIndex);
}
```

注意：
- `previous` **无条件环绕**（队列首曲按上一首回到最后一首），与 `repeatMode` 无关。
- `next` 在「顺序模式 + 队尾」时不环绕，只把 `playing=false` 并同步一次 SMTC，**不清空队列、不换歌**。
- `ended` 事件 -> `playing=false; flushSession(true); next()`。

### 1.6 播放历史与播放计数（后端 SQLite）

两条互相独立的链路：

**(A) 历史（仅本地库歌曲）** — `recordPlay(fileId)` 只在 `loadById`（本地歌曲）成功起播后调用一次：

```sql
CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL);                       -- Unix 秒
CREATE INDEX idx_history_time ON history(played_at DESC);
```
```sql
-- list_history：按曲目聚合最近一次播放，倒序，LIMIT 200
SELECT ... FROM (SELECT file_id, MAX(played_at) AS last_played FROM history GROUP BY file_id) h
JOIN files f ON f.id = h.file_id LEFT JOIN media_metadata m ON m.file_id = f.id
WHERE f.deleted = 0 ORDER BY h.last_played DESC LIMIT 200;
```
⚠️ 在线歌曲与 WebDAV 歌曲**不写 history**（`loadOnlineSong` / `loadWebDavSong` 无 `recordPlay` 调用）。

**(B) 听歌统计（全来源）** — 基于会话表：

```sql
CREATE TABLE play_session (
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL, source TEXT NOT NULL,   -- local|online|webdav
  started_at INTEGER NOT NULL, ended_at INTEGER,
  listened_ms INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
  quality_br INTEGER, title TEXT, artist TEXT, album TEXT,
  file_path TEXT, file_name TEXT, content_hash TEXT, cover_url TEXT, src_url TEXT);
CREATE TABLE listen_daily (day TEXT PRIMARY KEY, play_count INTEGER NOT NULL DEFAULT 0,
  unique_tracks INTEGER NOT NULL DEFAULT 0, total_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE listen_day_track (day TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY (day, track_id));
```

IPC 命令（等价于 HTTP 端点，参数为 camelCase 单对象）：
| 命令 | 参数 | 行为 |
|---|---|---|
| `start_play_session` | `{ input: PlaySessionStart }` | `INSERT OR REPLACE`，`ended_at=NULL, listened_ms=0, completed=0` |
| `end_play_session` | `{ input: PlaySessionEnd }` | `INSERT ... ON CONFLICT(id) DO UPDATE`（`COALESCE` 保留旧的非空元数据） |
| `get_listen_stats` | `{ day?: string }` | 单日 `ListenStats` |
| `list_listen_stats` | `{ days?, fromDay?, toDay? }` | 区间/近 N 日数组 |
| `list_top_tracks` | `{ limit, days?, fromDay?, toDay? }` | `TopTrackStat[]`（含 `play_count, total_ms`） |
| `listen_source_breakdown` | `{ days?, fromDay?, toDay? }` | `ListenSourceStat{ source, play_count, total_ms }[]` |
| `record_play` | `{ fileId }` | 写一条 history |
| `list_history` | — | `MediaEntry[]`，≤200 条 |

**计数判定规则（必须逐字复刻）**，在 `end_play_session` 中：

```text
completed   = 前端传入的 completed 标志
counts      = completed || listened_ms >= 30000        // 「有效听歌」阈值 30 秒
若 counts：  listen_daily(day) 的 play_count += 1、total_ms += listened_ms
            listen_day_track 插入 (day, track_id)（去重）
            listen_daily.unique_tracks = COUNT(listen_day_track WHERE day)
day         = epoch_ms_to_day(ended_at)                // 注意：按 UTC 天数切分，非本地时区
```

### 1.7 播放会话状态机（前端 `flushSession` / `beginSession`）

非响应式会话变量（`timeupdate` 高频读写，不触发重渲染）：
`sessionId: string|null`、`sessionTrack: NowPlaying|null`、`sessionStartedAt: number`、`sessionListenedMs: number`、`lastTickPos: number`。

```text
beginSession(track):
  if (sessionId && sessionTrack) flushSession(由当前进度推算 completed)
  sessionId = crypto.randomUUID() ?? "ps-<Date.now()>-<random6>"
  sessionTrack = track; sessionStartedAt = Date.now(); sessionListenedMs = 0; lastTickPos = 0
  capabilities.startPlaySession(payload)   // fire-and-forget，失败静默

flushSession(completed):
  if (!sessionId || !sessionTrack) return
  listenedMs = max(0, round(sessionListenedMs))
  pos = currentTime; dur = duration || sessionTrack.durationMs || 0
  isCompleted = completed || (dur > 0 && (pos/dur >= 0.8 || listenedMs >= dur*0.8))
  capabilities.endPlaySession({...})       // fire-and-forget
  清空会话变量
```

触发点：`ended` -> `flushSession(true)`；`beginSession` 内部先 flush 旧会话；`window.beforeunload` -> 兜底 flush。
`timeupdate` 内的累计条件：`playing === true && el.currentTime > lastTickPos` 时 `sessionListenedMs += (el.currentTime - lastTickPos) * 1000`；`seeked` 后重置 `lastTickPos`（防止 seek 造成虚假增量）。

**完成度阈值 0.8**（80%）与后端「有效听歌 30 秒」是两条独立阈值，都要实现。

`PlaySessionStart` / `PlaySessionEnd` 字段：
`id, trackId, source("local"|"online"|"webdav"), startedAt, (endedAt), (listenedMs), (completed), title?, artist?, album?, filePath?, fileName?, contentHash?, coverUrl?, srcUrl?, qualityBr?`。
前端实际赋值：`fileName/contentHash/qualityBr = null`；`srcUrl` 仅在线歌曲取 `track.src`；`filePath` 仅本地。

### 1.8 断点续播（⚠️ 当前源码未实现，Flutter 需新增）

已核实：`queue`、`currentIndex`、`shuffleMode`、`repeatMode`、`currentTime`、`playbackRate` **全部不落盘**；全局 `localStorage` 只用于 `lumiluna-devtools-enabled`（与播放无关）。应用重启后队列为空、`song = null`，只能从列表页重新起播。

Flutter 建议新增（与现有 `JsonStore` 语义对齐）：`playback-state.json` 的 `state` 键保存
`{ queue: QueueItem[], currentIndex: int, positionSec: double, shuffleMode: bool, repeatMode: string, playbackRate: double, updatedAt: int }`，
冷启动恢复时只重建队列与下标、**不自动播放**，并在首次 `play` 时 `seek(positionSec)`。

---

## 2. 播放器状态字段全集、默认值与持久化

### 2.1 store 状态表（`usePlayerStore`，Pinia setup store）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `song` | `NowPlaying | null` | 当前曲目 |
| `playing` | boolean | `false` | 由 `play`/`pause` 事件同步，不乐观更新 |
| `currentTime` | number(秒) | `0` | `timeupdate` 同步 |
| `duration` | number(秒) | `0` | `loadedmetadata` 同步；加载前为 0 |
| `currentIndex` | number | `0` | 见 §1.2 |
| `audioEl` | `HTMLAudioElement | null` | **全局唯一**，由 store 持有（路由销毁播放器页也不中断） |
| `queue` | `QueueItem[]` | `[]` | |
| `loadingSong` | boolean | `false` | 拉全量歌曲期间的 loading |
| `lastError` | `string | null` | 播放失败文案 |
| `shuffleMode` | boolean | `false` | |
| `repeatMode` | `RepeatMode` | `"off"` | |
| `lyrics` | `LyricLine[]` | `[]` | |
| `activeLine` | number | `-1` | 当前高亮行下标，-1 = 无 |
| `coverColors` | `string[]` | `[]` | 4 个 `rgba(r,g,b,0.8)` |
| `lyricsSource` | `"qq" | "kg" | "meting" | "local" | null` | `null` | 仅开启「更精确的逐字歌词」后有值 |
| `lyricFallbackReason` | `QqFallbackReason | null` | `null` | |
| `lyricFallbackDetail` | `string | null` | `null` | |
| `lyricNotice` | string | `""` | 全局 toast，4000ms 后自动清空 |
| `currentLyric` | computed string | `""` | `activeLine >= 0 ? lyrics[activeLine]?.text : ""` |

`activeLine` 算法（线性扫描，遇第一个未到时间的行即 break）：

```ts
let idx = -1;
for (let i = 0; i < lyrics.length; i++) {
  if (currentTime >= lyrics[i].time) idx = i; else break;
}
activeLine = idx;
```

`LyricLine`：`{ time: number(秒), text: string, translation?: string, romaji?: string, units?: WordUnit[], instrumental?: boolean }`；`WordUnit = { text, start, end }`。

### 2.2 audio 元素事件 -> 状态映射（逐条实现）

| 事件 | 处理 |
|---|---|
| `timeupdate` | `currentTime = el.currentTime`；累计 `sessionListenedMs`（条件见 §1.7）；`lastTickPos = el.currentTime`；`updateActiveLine()`；`syncSmtc()`（节流 500ms）；`syncDesktopLyrics()`（节流 200ms） |
| `loadedmetadata` | `duration = el.duration`；`syncSmtc(true)` |
| `play` | `playing = true`；`audioEffects.resume()`；`syncSmtc(true)`；`syncDesktopLyrics(true)` |
| `pause` | `playing = false`；`audioEffects.suspend()`；`syncSmtc(true)`；`syncDesktopLyrics(true)` |
| `seeked` | `lastTickPos = el.currentTime`；`syncSmtc(true)` |
| `ended` | `playing = false`；`flushSession(true)`；`next()` |
| `error` | `playing = false`；`lastError = "无法播放：" + (song?.title ?? "")` |

元素创建：`new Audio(); el.preload = "auto"`。**全流程从不设置 `el.volume`**（原生默认 1.0）。

### 2.3 唯一「起播路径」

```ts
async function startPlayback() {
  const src = song?.src; if (!src) return;
  const el = ensureAudio(); lastError = null;
  el.src = src; el.load();
  try { await el.play(); } catch (e) { lastError = String(e); }  // 自动播放被拒/解码失败
}
```

`loadById(fileId)`：`loadingSong=true` -> `getSong(fileId)` -> `loadSong` -> `startPlayback` -> `recordPlay(fileId)` -> `finally loadingSong=false`。

`loadSong(s)`（本地）：解析元数据（`title = meta.title ?? 文件名去扩展名`）-> 组装 `NowPlaying{kind:"local"}` -> `beginSession` -> 重置 `activeLine/lyrics/coverColors/currentTime/duration` -> 提取封面主色 -> 云端逐字歌词编排 -> `smtcSetMedia`。

`loadOnlineSong(item)`（在线）：酷狗缺 `url` 时先 `resolveKugouUrl(item)` 并写回；歌词 `item.lrc` 若以 `http` 开头则先查 IndexedDB 缓存（`lrcGet(id)`）未命中再 `fetch` 并 `lrcSet`，若含 `[` 则视为内嵌文本；随后起播，`await waitAudioDuration(5000)` 拿真实时长用于逐字歌词匹配；`smtcSetMedia` 的 `durationMs=0, filePath=""`。

`loadWebDavSong(entry)`：`src = webdavMediaUrl(entry.path)`（凭据在 Rust 侧，支持拖动进度）；尝试同目录同名 `.lrc`；`id = "webdav:" + path`，`artist="WebDAV"`。

`waitAudioDuration(timeoutMs)`：`duration` 已有限且 > 0 直接返回 `duration*1000`；否则监听 `loadedmetadata` 或超时返回 `undefined`（在线/WebDAV 用 5000ms）。

### 2.4 持久化（**不是 localStorage**）

持久化全部走 `JsonStore`（`apps/desktop/src/ipc/store.ts`）-> 主进程桥 `callBridge("store", { op, file, key, value })` -> 应用数据目录（`app_data_dir()`）下的**整文件 JSON**：

| 文件 | 键 | 值 | 写盘时机 |
|---|---|---|---|
| `settings.json` | `"settings"` | 全部设置项的扁平对象（见 §6） | 深度 watch 触发，**400ms 防抖**；`beforeunload` / `visibilitychange(hidden)` 立即 flush |
| `audio-effects.json` | `"config"` | `AudioEffectConfig` | 300ms 防抖后 `set(config)` + `set(userPresets)` + `save()` |
| `audio-effects.json` | `"userPresets"` | `AudioEffectPreset[]` | 同上 |
| （其余） | — | `bangumi.json` 等 | 与播放无关 |

写入前统一做一次 JSON 深拷贝降级为纯对象（Electron 结构化克隆兼容）。`JsonStore` 提供 `get/set/delete/has/keys/values/entries/length/clear/reset/reload/save/close`；`set` **不落盘**，必须再 `save()`。

音效配置加载合并逻辑（`init()`，必须复刻）：

```ts
const merged = flatConfig(savedConfig.presetId || "flat");
config = { ...merged, ...savedConfig,
  eqBands: savedConfig.eqBands?.length === 10 ? savedConfig.eqBands : clone(DEFAULT_EQ_BANDS) };
```

即：缺字段回落到 `flat` 默认值；`eqBands` 长度不为 10 一律丢弃、用默认频点。

---

## 3. 音效引擎

### 3.1 配置模型 `AudioEffectConfig`

| 字段 | 类型 | 默认值 | 取值域 | 备注 |
|---|---|---|---|---|
| `enabled` | boolean | `false` | — | 关闭时走 bypass 直通，节点不销毁 |
| `eqBands` | `EqBand[]` | 10 段默认频点，`gain` 全 0 | 长度必须 = 10 | `EqBand = { frequency: number(Hz), gain: number(dB) }` |
| `bassBoost` | number(dB) | `0` | `[-12, 12]` 整数 | |
| `reverb` | number | `0` | `[0, 100]` 整数 | 混响干湿比百分比 |
| `stereoWidth` | number | `50` | `[0, 100]` 整数 | 0=单声道，50=原始，100=加宽 |
| `presetId` | string | `"flat"` | 内置 id / `"custom"` / `"custom-<Date.now()>"` | 手动改任一参数即置 `"custom"` |

`AudioEffectPreset = { id: string, name: string, config: AudioEffectConfig, builtin?: boolean }`。
所有 setter 都做 `Math.max(min, Math.min(max, Math.round(v)))` 后 `syncEngine() + persist()`。
`setEnabled(false)` 时额外把 `presetId` 置为 `"flat"`。

### 3.2 10 段 EQ 频点与滤波器类型

`DEFAULT_EQ_BANDS`（顺序固定，索引 0..9）：

| 索引 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| frequency (Hz) | 31 | 62 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 | 16000 |
| BiquadFilter type | lowshelf | peaking | peaking | peaking | peaking | peaking | peaking | peaking | peaking | highshelf |

- 首段（31Hz）为 `lowshelf`、末段（16000Hz）为 `highshelf`，其余 `peaking`；`Q = 1`（常量 `EQ_Q`）。
- 频点可变（仅通过 LLFX3 分享码导入自定义频点时），但**滤波器类型判定只看该频点是否等于首/末默认频点**。

### 3.3 信号链与参数公式

```text
source(createMediaElementSource) -> input --+-> bypass ----------------------------> output -> destination
                                             +-> EQ[0..9] -> bass(120Hz lowshelf) -+-> dry -> sum
                                                                                  +-> convolver -> wet -> sum
                                                                                       sum -> splitter(2)
                                                                                            -> lOut0/lOut1/rOut0/rOut1 -> merger(2) -> effectMix -> output
```

| 节点 | 参数 | 公式 / 值 |
|---|---|---|
| `bypass.gain` | 直通增益 | `enabled ? 0 : 1` |
| `effectMix.gain` | 效果总增益 | `enabled ? 1 : 0` |
| `eqFilters[i].gain` | 各段增益 | `band.gain`，`setTargetAtTime(..., ctx.currentTime, 0.03)` |
| `bassFilter` | 低音增强 | type=lowshelf，frequency=**120Hz**，gain=`bassBoost`，时间常数 0.03 |
| `dryGain` | 干声 | `1 - reverb/100`，时间常数 0.03 |
| `wetGain` | 湿声 | `reverb/100`，时间常数 0.03 |
| 混响脉冲 | `makeImpulse(ctx, 1.8s, decay=3)` | 2 声道，`length = floor(sampleRate * 1.8)`；`data[i] = (Math.random()*2-1) * (1 - i/length)^3`（白噪 × 幂衰减） |
| 立体声宽度 | mid/side 简易矩阵 | `width = clamp(stereoWidth,0,100)/100; factor = width*2;` `gLL=gRR=(1+factor)/2`，`gLR=gRL=(1-factor)/2`；四个增益各 `setTargetAtTime(g, t, 0.03)` |

常量：`EQ_Q = 1`、`REVERB_SECONDS = 1.8`、`REVERB_DECAY = 3`、所有参数平滑时间常数 **0.03 s**。

生命周期：
- `attach(media)` **幂等**（`if (this.ctx) return`）：同一个 media element 只能 `createMediaElementSource` 一次，因此关闭音效不销毁节点，只切 bypass。
- **首次开启音效才创建 AudioContext**；未开启时保持原生直通（避免 Web Audio 对跨域/本地协议的未知影响）。
- 开启时若音频已加载且 `crossOrigin !== "anonymous"`，需 `enableWithReload()`：记录 `src/currentTime/wasPlaying` -> `pause()` -> `crossOrigin="anonymous"` -> 清空 `src` 重设 -> `load()` -> 等 `loadedmetadata` -> 恢复 `currentTime = min(time, duration)` -> `attach + update + resume` -> 若原来在播放则 `play()`；任何一步失败都 `config.enabled = false`（自动降级关闭音效并落盘）。
- `resume()/suspend()`：AudioContext `state === "suspended"/"running"` 时切换，由 player store 的 `play`/`pause` 事件调用。

### 3.4 内置预设（8 个，精确参数）

生成规则：`preset(id, name, mutate)` 先取 `flatConfig(id)`（`enabled:false, eqBands=默认0, bassBoost:0, reverb:0, stereoWidth:50`）再强制 `enabled = true`，然后施加下表增益；未列出的段恒为 0。

| id | name | 参数（段索引: 增益 dB） |
|---|---|---|
| `flat` | Flat | 无改动（全 0，bass 0，reverb 0，width 50） |
| `pop` | Pop | 1:+3, 3:+2, 5:+1, 7:+3, 9:+2 |
| `rock` | Rock | 1:+4, 2:+3, 5:+2, 7:+3, 9:+4 |
| `classical` | Classical | 0:+3, 4:-1, 8:+3, 9:+4 |
| `dance` | Dance | 1:+5, 3:+3, 5:0, 7:+2, 9:+4 |
| `bass_boost` | Bass Boost | `bassBoost=8`, 0:+6, 1:+5 |
| `vocal` | Vocal | 2:-2, 3:-1, 4:+2, 5:+4, 6:+3, 8:-1 |

（共 7 个有参数的条目 + flat = 8 项，顺序即 UI 展示顺序。）

预设管理 API：
| API | 语义 |
|---|---|
| `applyPreset(id)` | 在内置 + 用户预设中查找；`clone(found.config)` 后强制 `enabled=true`，`applyConfig` |
| `resetToFlat()` | 重置为 flat，但**保留当前 `enabled`** |
| `saveUserPreset(name)` | `trim()` 为空则忽略；`id = "custom-" + Date.now()`；`config.enabled = true; presetId = id`；push 到 `userPresets` |
| `deleteUserPreset(id)` | 过滤删除；若当前 `presetId === id` 则回落到 `"flat"` |
| `exportUserPreset(id)` | 返回 `[字符码, LLFX3码]`，非用户预设返回 `null` |
| `importUserPreset(code)` | 按行尝试解码，成功返回预设名，失败返回 `null` |

### 3.5 LLFX3 分享码（紧凑二进制，完整算法）

前缀 `"LLFX3:"`；正文为 **base64url**（把 `+` 换成 `-`、`/` 换成 `_`、去掉尾部 `=` 填充）。
位流 **MSB-first**（高位先写）。

**位布局**

| 字段 | 位数 | 编码 |
|---|---|---|
| `freqMode` | 1 | `0` = 使用当前 `DEFAULT_EQ_BANDS` 固定频点（不写频点，最短）；`1` = 频点不固定 |
| `frequencies[0..9]` | `freqMode===1 ? 10×16 : 0` | 各段频率 uint16，按 `eqBands` 顺序 |
| `enabled` | 1 | `1/0` |
| `eqGains[0..9]` | 10×5 | `gain + 12`（gain 属于 [-12,12] -> 0..24，5bit 容量 0..31） |
| `bassBoost` | 5 | `bassBoost + 12` -> 0..24 |
| `reverb` | 7 | 原值 0..100 |
| `stereoWidth` | 7 | 原值 0..100 |
| `nameLength` | 8 | 预设名 UTF-8 字节数（≤255） |
| `nameBytes` | 8×nameLength | UTF-8 字节 |

默认频点情况下总位数 = `1+1+50+5+7+7+8 + 8*nameLen = 79 + 8*nameLen`，末字节不足 8 位时**低位补 0**。
`freqMode` 判定：`eqBands.length === 10 && 每段 frequency === DEFAULT_EQ_BANDS[i].frequency`。
预设名先 `trim().slice(0, 80)`（80 个 UTF-16 code unit；中文 80 字 = 240 字节 ≤ 255）。

**参考实现（可直接照抄）**

```ts
class BitWriter {
  private bytes: number[] = []; private current = 0; private count = 0;
  write(value: number, bitCount: number) {
    for (let i = bitCount - 1; i >= 0; i--) {
      this.current = (this.current << 1) | ((value >>> i) & 1); this.count++;
      if (this.count === 8) { this.bytes.push(this.current); this.current = 0; this.count = 0; }
    }
  }
  finish(): Uint8Array {
    if (this.count > 0) { this.bytes.push(this.current << (8 - this.count)); this.current = 0; this.count = 0; }
    return Uint8Array.from(this.bytes);
  }
}
class BitReader {
  constructor(private bytes: Uint8Array) {}
  private byteIndex = 0; private bitIndex = 0;
  read(bitCount: number): number {
    let value = 0;
    for (let i = 0; i < bitCount; i++) {
      if (this.byteIndex >= this.bytes.length) throw new Error("Unexpected end of share code");
      const bit = (this.bytes[this.byteIndex] >> (7 - this.bitIndex)) & 1;
      value = (value << 1) | bit; this.bitIndex++;
      if (this.bitIndex === 8) { this.bitIndex = 0; this.byteIndex++; }
    }
    return value;
  }
}

function encodeSharePayload(p: { name: string; config: AudioEffectConfig }): string {
  const name = p.name.trim().slice(0, 80);
  const nameBytes = new TextEncoder().encode(name);
  const w = new BitWriter();
  const useDefaultFrequencies =
    p.config.eqBands.length === DEFAULT_EQ_BANDS.length &&
    p.config.eqBands.every((b, i) => b.frequency === DEFAULT_EQ_BANDS[i].frequency);
  w.write(useDefaultFrequencies ? 0 : 1, 1);
  if (!useDefaultFrequencies) for (const b of p.config.eqBands) w.write(b.frequency, 16);
  w.write(p.config.enabled ? 1 : 0, 1);
  for (const b of p.config.eqBands) w.write(b.gain + 12, 5);
  w.write(p.config.bassBoost + 12, 5);
  w.write(p.config.reverb, 7);
  w.write(p.config.stereoWidth, 7);
  w.write(nameBytes.length, 8);
  for (const byte of nameBytes) w.write(byte, 8);
  return "LLFX3:" + bytesToBase64Url(w.finish());
}

function decodeV3(code: string) {
  const bytes = base64UrlToBytes(code.slice("LLFX3:".length)); if (!bytes) return null;
  const r = new BitReader(bytes);
  const useDefaultFrequencies = r.read(1) === 0;
  const eqBands = DEFAULT_EQ_BANDS.map((d) => ({
    frequency: useDefaultFrequencies ? d.frequency : r.read(16), gain: 0 }));
  const enabled = r.read(1) === 1;
  for (const b of eqBands) b.gain = r.read(5) - 12;
  const bassBoost = r.read(5) - 12;
  const reverb = r.read(7);
  const stereoWidth = r.read(7);
  if (reverb > 100 || stereoWidth > 100) return null;      // 合法性校验
  const nameLength = r.read(8);
  const nameBytes = new Uint8Array(nameLength);
  for (let i = 0; i < nameLength; i++) nameBytes[i] = r.read(8);
  const name = new TextDecoder().decode(nameBytes).trim().slice(0, 80);
  if (!name) return null;
  return { version: 3, name, config: { enabled, eqBands, bassBoost, reverb, stereoWidth } };
}
```

**旧版 LLFX1**（兼容解码，不产出）：前缀 `"LLFX1:"`，正文 base64url 解出 UTF-8 JSON `{ version: 1, name, config }`；校验 `version===1`、`eqBands.length===10` 且各 `frequency` 与默认一致，数值 clamp 后使用（`gain` 属于 [-12,12]、`bassBoost` 属于 [-12,12]、`reverb/stereoWidth` 属于 [0,100]，均 round），任一非法即整码失败。

**解码分发**（`decodeSharePayload`）：`trim()` 后以 `"LLFX3:"` 开头 -> V3；以 `"LLFX1:"` 开头 -> V1；否则 -> 字符码（§3.6）。

### 3.6 「字符码」分享格式（版本 4，`<预设名称>@<字符码>`）

> 算法来自「五字符互转器」：**双射 7537 进制 + 仿射置换网络 + 预设覆盖表**。

**13 组数值顺序**（混合进制打包）：
`[0..9] = 10 段 EQ 增益映射值（0..24）`，`[10] = 低音增强映射值（0..24）`，`[11] = reverb（0..100）`，`[12] = stereoWidth（0..100）`。

增益映射（注意是**可逆的分段映射**，非简单加 12）：

```ts
encodeGain(g) = g >= 0 ? g : 12 - g      // -12->24, -1->13, 0->0, 12->12
decodeGain(v) = v <= 12 ? v : -(v - 12)  // 24->-12, 13->-1, 12->12
```

**字库与进制**
- `CHARSET`：**7537 个唯一汉字**的字符串（必须从 `apps/desktop/src/utils/shareCode.ts` 第 19 行原样复制；其中原全角符号 U+FF20 已替换为 `氪`，**字库不含 `@`**，保证 `@` 拆分唯一）。
- `BASE = BigInt(CHARSET.length) = 7537`；`INDEX` 为 char -> index 的 Map。
- `RADICES = [25,25,25,25,25,25,25,25,25,25,25,101,101]`（前 11 组 25 进制，后 2 组 101 进制）。
- `TOTAL_STATES = 25^11 × 101^2 = 24321079254150390625`（约 2.43e19）。

**数值 <-> state（混合进制）**

```ts
valuesToState(values): state = 0n; for i in 0..12: state = state * BigInt(RADICES[i]) + BigInt(values[i])
stateToValues(state): 从 i=12 倒推：values[i] = Number(temp % RADICES[i]); temp /= RADICES[i]
```

**仿射置换**

```ts
PERM_M = 11451419198103347n;  PERM_C = 98765432101234567n;
PERM_M_INV = modInverse(PERM_M, TOTAL_STATES);        // 扩展欧几里得求模逆
basePermute(s)   = (s * PERM_M + PERM_C) % TOTAL_STATES
baseUnpermute(r) = (((r - PERM_C) % TOTAL_STATES + TOTAL_STATES) % TOTAL_STATES * PERM_M_INV) % TOTAL_STATES
forwardMap(s) = stateToRankMap.get(s) ?? basePermute(s)     // 预设覆盖优先
reverseMap(r) = rankToStateMap.get(r) ?? baseUnpermute(r)
```

**state <-> rank 的字符编解码（1-5 字符）**

```ts
codeToRank(code):                       // 解码
  chars = [...code].filter(c => c.trim().length > 0);   // 忽略所有空白字符
  if (chars.length < 1 || chars.length > 5) return null;
  n = 0n;
  for (const c of chars) { const i = INDEX.get(c); if (i === undefined) return null; n = n * 7537n + BigInt(i + 1); }
  return n - 1n;

rankToCode(rank):                       // 编码（不补零，长度自然 1-5）
  n = rank + 1n; out = [];
  while (n > 0n) { n -= 1n; out.push(CHARSET[Number(n % 7537n)]); n /= 7537n; }
  return out.reverse().join("");
```

**预设覆盖表（保双射的双向交换）** — 启动时按顺序注册 116 条 `{code, eq}`：

```ts
registerPreset(values, code):
  targetState = valuesToState(values); targetRank = codeToRank(code);
  if (targetRank === null) return;
  currentRank = forwardMap(targetState); currentState = reverseMap(targetRank);
  if (targetState === currentState) return;              // 已就位
  stateToRankMap.set(targetState, targetRank); rankToStateMap.set(targetRank, targetState);
  stateToRankMap.set(currentState, currentRank); rankToStateMap.set(currentRank, currentState);
```

即把 `targetState <-> currentState` 与 `targetRank <-> currentRank` 两对互换，保持整体双射。
注册顺序敏感（后注册的会基于已注册结果继续交换），**必须按源码数组顺序注册**。完整 116 条表见附录 A。

**编解码入口**

```ts
encodeEqCode(values: number[]): string   // valuesToState -> forwardMap -> rankToCode
decodeEqCode(code: string): number[]|null// codeToRank -> rank >= TOTAL_STATES ? null : reverseMap -> stateToValues
```

**字符码分享码的组装 / 解析**

```ts
configToEqArray(cfg) = [...cfg.eqBands.map(b => encodeGain(b.gain)), encodeGain(cfg.bassBoost),
                       cfg.reverb, cfg.stereoWidth];      // 长度 13
导出（exportUserPreset 的第 0 项）= 名称 + "@" + encodeEqCode(configToEqArray(cfg))

解码 decodeCharSharePayload(code):
  trimmed = code.trim();
  sepIndex = 从右往左第一个属于 "@" 的位置（CHAR_SHARE_SEPARATORS = "@"）
  if (sepIndex > 0) { name = trimmed[0..sepIndex).trim(); chars = trimmed.slice(sepIndex+1); }
  else              { name = ""; chars = trimmed; }        // 只有字符码
  values = decodeEqCode(chars); if (!values) return null;
  finalName = (name || chars).trim().slice(0, 80); if (!finalName) return null;
  eqBands = DEFAULT_EQ_BANDS.map((b, i) => ({ frequency: b.frequency, gain: decodeGain(values[i]) }));
  return { version: 4, name: finalName,
           config: { enabled: true, eqBands,
                     bassBoost: decodeGain(values[10]), reverb: values[11], stereoWidth: values[12] } };
```

### 3.7 分享码的 UI / 导入导出流程

- `exportUserPreset(id)` 返回两套：`[0]` 字符码（名称@码），`[1]` `LLFX3:...`。
- 复制到剪贴板按设置 `shareCodePreference`：
  - `"chinese"` -> 只复制 `[0]`；
  - `"original"` -> 只复制 `[1]`（缺失时回落 `[0]`）；
  - `"both"`（默认）-> 两行文本，行首标签为 `中文预设码` 与 `原版预设码`（后接全角冒号），两行之间换行（标签走 i18n）。
- `importUserPreset(code)`：`trim()` 后按行拆分（兼容 CR/LF/CRLF）、逐行 trim、过滤空行；每行先原样、再 `stripShareLabel()` 后各试一次解码；首个成功者入库（`id="custom-"+Date.now()`，`enabled=true`）并返回名称。
- `stripShareLabel` 识别并剥离行首标签（其后允许全角/半角冒号与空白）：`中文预设码`、`原版预设码`、`Chinese preset code`、`Original preset code`。
- 「上传至预设市场」弹窗把 `[1] (LLFX3)` 作为 `shareCode`，导出 JSON 文件：`{ name, version: 1, description, shareCode }`（缩进 2 空格），文件名 `preset-<name 过滤非 [a-zA-Z0-9_-]>.json`，随后打开 `https://github.com/Flygeon/LumiLuna-Presets`。

---

## 4. 淡入淡出 / 交叉淡化 / 倍速 / 音量归一化

**现状核对结果（务必按此理解，避免实现出不存在的行为）**

| 能力 | 现状 | 证据 |
|---|---|---|
| 淡入淡出 / 交叉淡化 | ⚠️ **未实现**。源码中无 crossfade / fadeIn / fadeOut / gapless 任何实现（全仓 grep 命中 0） | — |
| 倍速 | 已实现，但**仅 UI 层循环切换**：`[1, 1.5, 2, 0.5, 0.75]` 顺序循环，默认 `1`；`player.setPlaybackRate(rate)` 即 `ensureAudio().playbackRate = rate`；**不持久化**，`PlayerView onMounted` 会重置回 `1` | `PlayerView.vue:21,103-107,128`；`player.ts:1145` |
| 音量归一化 / ReplayGain / 响度 | ⚠️ **未实现**。无音量滑杆、无 `el.volume` 赋值、无 ReplayGain/loudness 分析 | 全仓 grep 0 命中 |
| 音量控制 | ⚠️ **未实现**（音乐播放器无音量控件；只有视频播放器 `AnimePlayer` 用 ArtPlayer `volume: 0.8`） | — |
| 静音/淡出暂停 | 无：`pause` 直接暂停，音效引擎 `suspend()` 无渐变 | `player.ts:258-263` |

**Flutter 新增规格建议**（明确标注为新增设计，非既有行为）：
- 淡入/淡出：`fadeInMs = 300`、`fadeOutMs = 300`，线性或 easeOut；作用在播放器总增益节点（GainNode 等价物），与 `bypass/effectMix` 并列，避免与 EQ 混用。
- 交叉淡化：`crossfadeMs = 0`（默认关闭，可选 0/2000/4000/6000/8000/12000）；实现需**双解码器/双播放器实例**（单 AudioPlayer 无法真正交叉），在「当前曲剩余 ≤ crossfadeMs」时预起下一首并做等功率交叉（cos/sin 曲线）。
- 音量归一化：建议读 ReplayGain / R128 标签，`gainDb = clamp(trackGain + 89 - 6, -24, +12)`（播放器惯例），无标签时回落峰值归一化；须提供开关与「预增益」参数。
- 倍速：持久化到 `playback-state.json`，范围建议 0.5-2.0（与现状枚举一致），并用 setSpeed + setPitch 保持音高。

---

## 5. 与系统媒体控制（SMTC）的映射

### 5.1 前端 -> 后端 IPC（命令名即端点）

| 命令 | 参数（camelCase） | 调用时机 |
|---|---|---|
| `smtc_set_media` | `{ title, artist: string|null, album: string|null, durationMs, filePath, coverUrl: string|null }` | 每次换歌一次（`loadSong` / `loadOnlineSong` / `loadWebDavSong`） |
| `smtc_set_playback` | `{ playing: boolean, positionMs, durationMs }` | 节流 500ms 的 `timeupdate`，以及 `loadedmetadata` / `play` / `pause` / `seeked` 的 `force=true` |
| 事件 `smtc:command` | `{ kind: "play"|"pause"|"next"|"prev"|"stop"|"seek", positionMs?: number }` | 后端 -> 前端 |

节流实现：`lastSmtcSync` 时间戳，`!force && now - lastSmtcSync < 500` 则跳过；前置 `if (!isDesktop || !song) return`。

### 5.2 元数据字段映射（前端值 -> SMTC）

| 前端来源 | 参数 | 本地歌曲 | 在线歌曲 | WebDAV |
|---|---|---|---|---|
| `title` | title | `meta.title ?? 文件名去扩展名` | `item.name` | 文件名去扩展名 |
| `artist` | artist | `meta.artist ?? ""` -> `null`（空串转 null） | `item.artist` | `"WebDAV"` |
| `album` | album | `meta.album ?? ""` -> `null` | `item.album ?? null` | `null` |
| — | durationMs | `round(meta.durationMs ?? 0)` | `0`（真实值由 `smtc_set_playback` 兜底重发） | `round(durationMs ?? 0)` |
| — | filePath | `s.file.path` | `""` | `""` |
| — | coverUrl | `null`（Rust 从 filePath 提封面） | `item.pic` | `null` |

### 5.3 后端（Windows）行为

- `set_media`：`art_url = coverUrl 非空 ? coverUrl : cover_from_file(filePath)`；调用 `manager.set_metadata(title, artists: string[], album, duration_ms, art_url)`。
- 本地封面：`embedded_cover(filePath)` 失败则 `sidecar_cover(filePath)`（同目录 cover.jpg）-> 归一化为 **≤512×512 JPEG** -> 存入内存缓冲 -> 由绑定 `127.0.0.1:0`（随机端口）的 tiny_http 单线程服务提供，URL 形如 `http://127.0.0.1:{port}/cover.jpg?v={n}`，**每次提取递增版本号 `?v=N` 以破坏系统侧缓存**。
- `set_playback`：若从未推送过元数据（`last_title` 空且 `durationMs === 0`）-> `set_stopped()`；若 `duration_ms > 0` 且与已存时长不同 -> 用缓存的 title/artist/album/art_url **重发一次 metadata**（更新时间轴）；然后 `set_playback_status(playing)` + `set_position(positionMs)`。
- 事件映射：`Play/Pause/Next/Previous/Stop` -> 对应 kind（`positionMs: null`）；`SetPosition(ms)` -> `{ kind: "seek", positionMs: ms }`。

### 5.4 前端命令分发（`onSmtcCommand`）

```ts
if (!song) return;                       // 无当前曲目忽略一切命令
play  -> if (!playing) togglePlay()
pause -> if (playing)  togglePlay()
next  -> next()
prev  -> previous()
stop  -> if (playing) togglePlay()        // 等价于暂停，不停止/不清队列
seek  -> seek((positionMs ?? 0) / 1000); syncSmtc(true)
```

⚠️ 注意 `stop` 语义是「暂停」，且队尾结束时只 `playing=false + syncSmtc`，**从不推送 Stopped 状态**。

### 5.5 桌面歌词同步（相邻能力，同一 store 内）

`syncDesktopLyrics(force)`：节流 200ms；前置 `isDesktop && settings.desktopLyricsEnabled && song`；载荷
`{ lines: [{time, text, translation?, romaji?}], currentTime, playing, title, artist }`；`watch([lyrics, song, playing])` 时 `force=true`。

---

## 6. 设置项清单（音乐播放相关，取自 `settings.ts` DEFAULTS）

存储：`settings.json` 的 `"settings"` 键（整对象）。加载时逐字段覆盖（`undefined/null` 跳过），保存时整对象写出；**400ms 防抖**。

| key | 类型 | 默认值 | 取值域 | UI 控件（SettingsView「播放」分区） |
|---|---|---|---|---|
| `lang` | string | `"zh"` | zh / en | 全局语言 |
| `lyricFontSize` | number | `30` | 16-48（px） | slider，step 1 |
| `lyricLineHeight` | number | `2.5` | 1.6-3.2 | slider，step 0.1 |
| `lyricLineGap` | number | `20` | 0-64（px） | slider |
| `lyricFont` | string | `"system"` | system/sans/serif/kai/yuan | filter-chip 组 |
| `lyricTranslationSize` | number | `62` | 40-120（%） | slider，step 5 |
| `lyricTranslationGap` | number | `4` | 0-24（px） | slider |
| `lyricSubMode` | string | `"translation"` | translation / romaji | **无设置页控件**，由播放器徽标切换 |
| `wordLyrics` | boolean | `true` | — | switch |
| `preciseLyrics` | boolean | `false` | — | switch |
| `lyricSourcePrefs` | Record<string,string> | `{}` | value 属于 qq/kg/meting/local；key = `normalizeTitle(title) + "|" + round(durationMs)` | 无控件（徽标点击写入） |
| `detectInstrumental` | boolean | `true` | — | switch |
| `playerBg` | string | `"animated"` | animated/amll/image/off | segmented |
| `lyricBlur` | boolean | `true` | — | switch |
| `musicViewMode` | string | `"grid"` | grid / list | segmented |
| `gridColumns` | number | `6` | — | 无设置页控件（列表页内调） |
| `scanDirs` | string[] | `[]` | — | 音乐库目录 |
| `minFileSizeMb` | number | `0` | 0=不过滤 | slider + 预设 chip |
| `enableOnlineMusic` | boolean | `false` | — | switch（在线音乐卡片） |
| `musicServer` | string | `"netease"` | netease / kugou | segmented（平台切换条，长度 ≥2 才渲染） |
| `onlinePlaylists` | array | `[]` | `{server,id,name}[]` | 在线音乐卡片 |
| `playlistRenames` | Record<string,string> | `{}` | key = `server:id` | 重命名 |
| `webdavEnabled` | boolean | `false` | — | switch |
| `webdavUrl` | string | `""` | — | input |
| `webdavUser` | string | `""` | — | input |
| `webdavPass` | string | `""` | — | input（明文存 settings.json） |
| `neteaseEnabled` | boolean | `false` | — | switch（实验性） |
| `kugouEnabled` | boolean | `false` | — | switch（实验性） |
| `kugouAutoSignIn` | boolean | `true` | — | switch |
| `shareCodePreference` | string | `"both"` | chinese / original / both | segmented（音效卡片） |
| `desktopLyricsEnabled` | boolean | `false` | — | switch |
| `desktopLyricsFontSize` | number | `28` | 16-64（px） | slider |
| `desktopLyricsOpacity` | number | `90` | 30-100（%） | slider，step 5 |
| `desktopLyricsLocked` | boolean | `false` | — | switch |
| `desktopLyricsAlwaysOnTop` | boolean | `true` | — | switch |
| `desktopLyricsShowNext` | boolean | `false` | — | switch |
| `desktopLyricsShowTranslation` | boolean | `false` | — | switch |
| `desktopLyricsClickThrough` | boolean | `false` | — | switch |
| `desktopLyricsToolbar` | string | `"click"` | click / always | segmented |
| `desktopLyricsDoubleClick` | string | `"toggle"` | none / toggle | segmented |
| `desktopLyricsAnimation` | string | `"fade"` | fade/slide/scale/glow | filter-chip 组 |
| `desktopLyricsBounds` | object | `{width:420,height:120}` | 可含 x,y；逻辑坐标 | 拖拽记忆 + 「重置位置」按钮 |

补充：`normalizeTitle(t)` 的规则 = 去掉括号及其内容（左括号半角或全角、右括号半角或全角）并替换为空格 -> `toLowerCase()` -> U+3000 转普通空格 -> 全角区 U+FF01..U+FF5E 逐字减 0xFEE0 转半角 -> 空白折叠为单空格 -> `trim()`。

---

## 7. 交互手势、布局尺寸与动画（`PlayerView.vue` / `AudioEffectsPanel.vue`）

### 7.1 播放器页布局

| 元素 | 尺寸 / 值 |
|---|---|
| 页面 | 全屏 `#000` 底、白字、`overflow: hidden`；顶部渐变遮罩 `linear-gradient(to bottom, rgba(0,0,0,.5), transparent)`，padding `16px 24px` |
| 主体 | `padding-top: 60px`；左栏 `flex: 5`（padding `0 20px`），右栏 `flex: 5.5`（padding `0 20px`） |
| 封面 | `width: min(42vw, 52vh)`，`aspect-ratio: 1`，圆角 = 该尺寸的 **14%**，双层阴影 `0 8px 32px rgba(0,0,0,.35), 0 4px 16px rgba(0,0,0,.25)` |
| 歌曲信息 | `margin-top: 28px` 居中；标题 24px/700；副行 14px、`opacity: .6`、`margin-top: 6px` |
| 进度条 | 宽 **425px**、高 **6px**（hover/drag 时 **12px**），圆角 full；`margin-top: 24px` |
| 进度 thumb | 14×14 圆形 + 主色 28% 透明外发光 4px；默认 `opacity: 0`，hover 显 1 |
| 时间行 | `margin-top: 6px`、12px、`opacity: .7`；左为当前时间，右为剩余时间（前缀减号） |
| 控制行 | 宽 425px、`margin-top: 16px`；三组左/中/右，组内 gap 10px |
| 主播放键 | **64×64** 圆，主色填充 + 70% 主色描边；图标 34×30 |
| 侧键 | **44×44** 圆，1px 22% 描边，半透明 surface-container-high 底；激活态主色描边 + primary-container 底 |
| 倍速键 | 同侧键 44×44，文字 13px（显示 1x / 1.5x / 2x / 0.5x / 0.75x） |
| 功能面板 | `bottom: calc(100% + 12px)`、水平居中、`min-width: 240px`、padding 14px、圆角 dialog、`rgba(28,28,30,.82)` + `backdrop-filter: blur(20px) saturate(180%)`、1px `rgba(255,255,255,.12)` 描边、阴影 `0 12px 40px rgba(0,0,0,.5)`、`z-index: 30` |
| 分段控件 | gap 6px、padding 3px、`rgba(255,255,255,.12)` 底、圆角 12px；按钮 padding `6px 18px`、圆角 10px、13px；激活为白底黑字 |
| 来源徽标 | 圆角 999px、padding `5px 12px`、12px；配色：qq `rgba(76,217,100,.16)/#7cfc9b`、kg `rgba(56,160,255,.18)/#7cc4ff`、meting `rgba(236,72,91,.18)/#ff94a3`、local 白 10% / 白 65% |
| 队列项 | padding `9px 12px`、圆角 10px、gap 12px；当前项 `rgba(255,255,255,.14)` 底 + 白字；序号列宽 22px；标题 14px/500，歌手 12px/opacity .6，时长 12px/opacity .55；空态居中 `margin-top: 40%` |

### 7.2 手势与交互

- 进度条：`mousedown` 置 dragging 并开始随 `mousemove` seek（拖拽中实时 seek，非松手才 seek）；`mouseup`/`mouseleave` 结束；`click` 也 seek。换算：`pct = (clientX - rect.left) / rect.width; seek(pct * duration)`。
- 封面点击：有权限时切换评论面板（仅「已登录网易云 + 当前为在线网易云歌曲」）。
- 功能面板：document 捕获阶段 `pointerdown` 判断点击是否在 `panel-anchor` 外 -> 关闭；`Escape` -> 关闭。
- 顶栏空白处 `pointerdown` 触发窗口拖拽（`useWindowDrag`），内部按钮 `@pointerdown.stop`。
- 播放器页卸载**不中断播放**（audio 由 store 持有），仅 `detachAudio()` 空实现。
- 键位：播放器页仅有 `Escape` 关面板；⚠️ **无空格/方向键等媒体快捷键实现**（设置页只有一行 `player.hotkeysHint` 提示文案）。

### 7.3 动画时长与曲线（`--md-sys-motion-*` 令牌）

| 元素 | 动画 |
|---|---|
| 封面 hover | `transform: scale(1.05)` + `filter: brightness(0.85)`，250ms `cubic-bezier(0.25,0.8,0.25,1)` |
| 封面评论提示 | opacity 220ms spring-effects-fast |
| 进度条高度 | 6px <-> 12px，220ms spring-soft |
| 进度 thumb | opacity 200ms spring-effects-fast |
| 主播放键 | hover `scale(1.04)` 200ms spring；active `scale(0.8)` |
| 侧键 | active `scale(0.8)` |
| 功能面板展开 | `panel-pop` 200ms spring-spatial：`opacity 0->1`、`translateX(-50%) translateY(10px) scale(0.94) -> translateX(-50%) translateY(0) scale(1)` |
| 队列项 hover | background 180ms spring-effects-fast |
| 分段按钮 | all 200ms spring-effects-fast |
| 来源徽标 hover | background 180ms spring-effects-fast |
| 音效弹窗遮罩 | `popup-fade` 180ms spring-effects-fast（`rgba(0,0,0,.48)` + `blur(2px)`） |
| 音效弹窗卡片 | `popup-scale` 220ms spring-spatial：`scale(0.92) opacity 0 -> scale(1) opacity 1` |
| 上传中图标 | spin 1s linear infinite |

### 7.4 音效面板布局（`AudioEffectsPanel.vue`）

- 面板：纵向 flex、gap 14px、`height: 100%`、`overflow-y: auto`、padding `2px 4px 12px 0`。
- 启用行：gap 10px、padding `10px 14px`、圆角 extra-large、surface-container-low 底 + 1px 内阴影 hairline；图标 22px 主色；右侧开关。
- 禁用态：`fieldset[disabled]` 整体 `opacity: 0.5`（**不是隐藏**）。
- 分区：纵向 gap 16px；标题 label-large、`letter-spacing: 0.4px`、`text-transform: uppercase`、on-surface-variant 色。
- 预设列表：flex wrap、gap 6px；chip 高 **30px**、左右 padding 14px；用户预设的分享/删除按钮 **24×24** 圆形，图标 14px，默认 `opacity: .65`，hover 时分享 -> secondary-container、删除 -> error-container。
- 保存/导入行：input 与按钮 gap 8px；input padding `8px 12px`、1px outline-variant 描边、圆角 small、body-small 字号；按钮小号高 36px。
- EQ 区：`grid-template-columns: repeat(auto-fill, minmax(66px, 1fr)); gap: 8px`；每段纵向 flex、gap 6px、padding `8px 4px`、圆角 medium、surface-container-low 底；频率与增益文字 11px；竖向 slider 高 **90px**。
- 环境音效行：gap 10px、padding `6px 2px`；左侧标签固定宽 **150px**（图标 18px 主色）；滑块 flex:1；数值列宽 **36px** 右对齐、12px。
- 频率显示格式：`hz >= 1000 ? (hz/1000).toFixed(0) + "k" : String(hz)`（即 31/62/125/250/500/1k/2k/4k/8k/16k）。
- EQ 增益显示：`gain > 0 ? "+" + gain : gain`。
- 弹窗：分享选择卡 **380px**（`max-width: 90vw`、`max-height: 80vh`、padding `24px 28px 20px`）；上传卡 **440px**；关闭按钮 30×30 圆、定位 `top:12px right:12px`。
- 滑块事件桥（Vue 专属，Flutter 不需要但反映语义）：值挂在 slider-thumb 上，所有 setter 前 `Math.round`。

---

## 8. Flutter 落地建议

### 8.1 播放内核
- **音频播放**：`just_audio`（`AudioPlayer` 单例、`setUrl/setFilePath`、`positionStream/durationStream/playerStateStream` 分别对应 timeupdate / loadedmetadata / play|pause）。**必须把 player 实例放在全局 Provider/Riverpod 单例**（对应「audio 由 store 持有」），否则路由 pop 会中断播放。
- **队列/播放模式**：用纯 Dart 类复刻 §1 的 `next/previous/generateShuffleOrder`（Fisher-Yates + shuffledIndices），**不要**用 shuffle() 或 LoopMode 直接替代——语义不同（队尾不环绕、previous 3 秒阈值、单曲循环不吃随机序）。`ConcatenatingAudioSource` 可用，但自定义队列逻辑更可控（酷狗惰性解析 url、WebDAV 代理 URL、插播都要写回队列项）。
- **倍速**：`setSpeed` + `setPitch(1.0)`；持久化倍速（现状不持久化，属改进项）。
- **媒体通知/锁屏（替代 SMTC）**：`audio_service` + `just_audio_background`（或自定义 `MediaItem@@）。映射 `MediaItem{id,title,artist,album,duration,artUri}` -> §5.2；`artUri` 本地歌曲需先写临时 JPEG（≤512px，对应后端 normalize_jpeg 缩略），在线歌曲直接用 pic URL。Android 走 MediaSession/通知栏，iOS 走 MPNowPlayingInfoCenter + MPRemoteCommandCenter（play/pause/next/prev/changePlaybackPosition 一一对应 smtc:command）。
- **音频会话**：Android AudioAttributes(usage: media) + `audio_session` 处理耳机拔出/来电打断（对应桌面端不存在的场景）。

### 8.2 音效引擎（最大风险点）
- 用 `just_audio` 的 **AudioPipeline**（Android）或直接原生层；更稳妥是 **Android `android.media.audiofx.Equalizer/BassBoost/PresetReverb/Virtualizer`**：
  - 10 段 EQ 频点 31..16000Hz 在 `Equalizer` 上必须按设备实际 `getNumberOfBands()/getBandFreqRange()` 做**最近邻映射**（多数手机只有 5 段），否则无法逐段复刻桌面参数。
  - `bassBoost`（120Hz lowshelf）与 `Virtualizer`（stereoWidth 0/50/100 -> strength）参数域与 Web Audio 不同，需要**在 Dart 侧做归一化映射表**。
  - iOS 无系统 EQ，需 `AVAudioEngine` + `AVAudioUnitEQ(numberOfBands: 10)` 自行搭建，混响用 `AVAudioUnitReverb`（`wetDryMix = reverb`）。
- 若追求与桌面**逐参数一致**，建议自建 DSP：EQ 用 cascaded biquad（RBJ peaking/lowshelf/highshelf，Q=1）、混响用卷积（1.8s、(1-t)^3 白噪脉冲）、宽度用 §3.3 的 mid/side 矩阵。可考虑 PCM/FFI 方案。
- 参数平滑统一用 **30ms 线性斜坡**（对应 `setTargetAtTime(t, 0.03)`），避免爆音。
- 关闭音效时**不要销毁引擎**（对应 bypass 设计），仅切直通，防止重开失败。

### 8.3 持久化
- 对应 `JsonStore`：用 `path_provider` 的 app support 目录 + `settings.json` / `audio-effects.json` / `playback-state.json`，结构与键名**保持同名同形**，便于将来与桌面端互导。
- 防抖：settings 400ms、audio-effects 300ms；`AppLifecycleState.paused/inactive` 时立即 flush（对应 visibilitychange/beforeunload）。
- 分享码：`BigInt` 在 Dart 原生支持，直接照抄 §3.5/§3.6；base64 用 `base64Url`（记得先 padEnd 补 `=` 再 decode）；UTF-8 用 `utf8` codec。**CHARSET 7537 字必须整串复制**，且初始化时按顺序执行 116 条 `registerPreset`（建议加单测：`decodeEqCode(encodeEqCode(v)) == v` 且对若干预设 code 断言）。

### 8.4 UI / 交互
- 布局用 `LayoutBuilder` 复刻 `min(42vw, 52vh)`；进度条 `GestureDetector` + `onHorizontalDragUpdate`（拖拽中实时 seek）；封面圆角 14% 用 `BorderRadius.circular(size * 0.14)`。
- 动画用 `AnimatedContainer/AnimatedOpacity` 或 `flutter_animate`，时长/曲线照 §7.3（`Curves.easeOutCubic` 近似 spring-soft/spatial，`Curves.easeOut` 近似 spring-effects-fast）。
- 功能面板用 `OverlayPortal`/`showModalBottomSheet`；音效面板照 §7.4 尺寸（EQ 竖向 slider 90px 高、每段 minmax(66px,1fr)）。
- 底部弹层/队列：`ReorderableListView` 可支持拖拽排序（桌面端不支持，属增强），当前项禁止删除（对应 removeFromQueue 规则）。
- 手势：移动端建议补「上下滑关闭、左右滑切歌」，桌面端无此手势。

### 8.5 必须补齐的缺口（当前源码没有）
1. 音量控制与持久化（桌面端完全缺失）。2. 淡入淡出/交叉淡化（需双播放器实例）。3. 音量归一化/ReplayGain。4. 队列与播放位置的断点续播。5. 在线/WebDAV 歌曲的播放历史（现仅本地写 history）。6. 音乐快捷键（空格/方向键/媒体键）。7. 蓝牙/耳机中断处理、音频焦点。

---

## 附录 A：字符码预设覆盖表（116 条，按源码顺序注册）

> 每条 code -> eq（13 组：10 段 EQ 的 0..24 映射值 + bassBoost 映射值 + reverb + stereoWidth）。
> 数据源 `apps/desktop/src/utils/shareCode.ts` 的 `PRESETS` 数组，**必须原样、按序复制**（注册顺序影响双射结果）。

```text
安秋        [2,9,2,9,2,9,2,9,2,9,2,92,29]
潘多拉      [24,24,22,18,20,22,24,24,24,24,24,100,100]
宿命        [24,24,23,20,16,12,18,22,24,23,21,98,95]
理论值      [12,12,12,12,12,12,12,12,12,12,12,100,100]
粉键        [8,12,16,18,19,21,23,24,24,22,20,95,92]
鸟加        [10,13,16,18,19,21,23,24,23,21,19,96,94]
莎露朵      [6,9,13,16,19,22,24,24,23,21,18,93,92]
盐巴        [6,9,13,16,19,22,24,24,23,21,19,94,93]
乙姬        [24,23,20,15,12,14,18,21,23,24,22,98,95]
奶糖        [8,12,15,17,18,20,22,23,21,19,18,92,90]
姬宫桃李    [4,7,11,14,17,21,24,24,23,21,18,93,92]
紫之创      [7,10,13,15,17,19,21,23,22,20,17,88,86]
仙石忍      [9,12,15,16,18,20,22,21,19,17,14,91,88]
朔间零      [22,23,21,17,14,13,15,17,16,14,12,95,88]
月永雷欧    [15,16,18,17,19,22,24,23,22,20,18,96,96]
菜月昴      [14,16,15,13,14,17,19,18,16,14,12,90,95]
蕾姆        [18,20,18,15,16,18,20,22,23,21,18,96,93]
爱蜜莉雅    [6,8,11,13,15,18,21,23,24,23,21,94,92]
夜神月      [22,19,16,12,10,14,19,23,24,24,22,98,96]
琉克        [24,22,18,13,9,7,10,14,17,19,18,90,85]
计划通      [10,12,15,17,19,22,24,23,20,16,12,95,90]
弥海砂      [3,6,9,12,16,20,23,24,24,22,20,92,94]
星乃一歌    [10,12,14,15,17,20,22,21,19,16,13,91,90]
天马咲希    [6,9,12,15,18,21,23,24,22,20,18,93,91]
望月穗波    [18,20,16,13,14,16,18,17,16,14,12,90,87]
日野森志步  [22,23,21,17,12,9,11,10,8,6,4,94,82]
花里实乃理  [7,10,13,16,18,21,23,24,23,21,19,95,93]
桐谷遥      [8,11,14,16,17,19,22,23,22,20,18,93,90]
桃井爱莉    [5,8,12,15,18,22,24,24,23,21,19,94,92]
日野森雫    [6,9,12,14,16,19,22,24,24,23,21,95,91]
小豆泽心羽  [6,9,12,15,18,21,24,24,23,21,18,94,94]
白石杏      [11,14,16,17,18,20,22,22,20,18,16,94,92]
东云彰人    [17,19,18,16,17,19,21,21,19,17,15,95,92]
青柳冬弥    [16,18,17,15,16,18,20,21,20,18,16,92,90]
天马司      [15,17,18,19,21,23,24,22,20,18,16,99,99]
凤笑梦      [5,8,12,16,20,24,24,24,24,22,20,97,96]
草薙宁宁    [6,8,11,13,16,20,23,24,24,22,20,95,90]
神代类      [14,16,17,16,18,20,22,23,22,20,18,94,95]
宵崎奏      [5,7,9,11,13,15,17,19,22,24,23,75,98]
朝比奈真冬  [12,12,12,12,12,12,12,12,12,12,12,80,50]
东云绘名    [14,15,13,11,14,17,20,18,16,15,13,88,88]
晓山瑞希    [10,12,15,14,13,16,19,22,21,19,17,90,91]
户山香澄    [8,11,14,16,18,21,23,24,22,20,18,95,93]
美竹兰      [14,17,19,18,17,19,22,22,20,17,15,94,92]
丸山彩      [5,8,12,15,18,22,24,23,22,20,18,93,92]
凑友希那    [6,8,11,13,16,20,23,24,23,20,17,96,92]
弦卷心      [12,14,17,19,21,23,24,24,24,22,21,98,97]
仓田真白    [5,7,10,13,15,18,21,23,24,22,20,89,92]
和奏瑞希    [18,20,19,17,18,21,23,24,23,21,19,98,96]
高松灯      [11,13,14,16,19,22,21,18,15,12,10,92,95]
千早爱音    [8,11,13,14,15,17,19,18,16,14,12,88,86]
要乐奈      [6,9,12,14,16,20,23,24,22,19,16,90,98]
长崎爽世    [24,23,21,17,12,8,6,5,4,3,2,98,70]
椎名立希    [19,21,16,11,12,15,18,20,19,16,13,91,89]
丰川祥子    [20,18,16,15,17,19,21,23,24,22,20,95,96]
若叶睦      [16,18,15,12,11,13,16,18,17,14,11,85,80]
八幡海铃    [22,23,20,16,13,11,12,11,9,7,5,95,83]
爱本邻久    [8,11,15,17,19,22,24,24,23,21,19,96,95]
山手响子    [16,18,19,18,18,20,22,23,22,20,18,96,94]
出云咲姬    [11,13,15,16,18,21,24,24,24,23,21,95,96]
濑户莉香    [18,20,19,17,18,21,23,24,23,21,19,97,95]
青柳椿      [15,17,18,17,18,21,23,24,23,21,18,95,93]
樱田美梦    [6,9,13,16,18,20,22,23,22,20,18,92,90]
高坂穗乃果  [9,12,15,17,19,22,24,24,23,21,19,97,96]
绚濑绘里    [10,13,15,16,18,20,22,23,22,20,18,94,91]
南小鸟      [4,7,10,13,17,21,24,24,24,22,19,93,95]
园田海未    [12,14,16,17,18,19,20,21,19,17,15,93,89]
星空凛      [7,10,13,16,19,22,24,23,22,20,18,94,92]
西木野真姬  [9,12,15,16,18,21,23,23,21,19,17,94,91]
东条希      [13,15,16,16,17,19,20,21,20,18,16,91,88]
小泉花阳    [5,8,11,14,17,20,23,24,23,21,18,91,90]
矢泽妮可    [4,7,11,15,19,23,24,24,23,21,19,96,96]
高海千歌    [8,11,14,16,18,21,23,24,23,21,19,95,94]
渡边曜      [10,13,15,17,19,21,23,23,22,20,18,94,92]
津岛善子    [14,16,18,17,18,20,23,24,23,21,19,95,94]
涩谷香音    [8,11,14,16,18,21,23,24,23,21,18,94,93]
放课后茶会  [11,14,16,16,15,17,20,22,21,18,15,94,90]
结束乐队    [15,18,19,16,13,12,17,22,24,22,18,92,96]
唯          [10,13,15,14,12,16,18,17,15,13,11,88,85]
澪          [21,23,20,16,11,9,13,11,8,6,4,95,80]
律          [18,22,13,9,11,14,19,20,21,17,14,92,88]
紬          [7,10,14,15,16,15,16,18,22,23,20,96,82]
梓          [5,8,11,12,14,17,21,22,18,14,10,90,84]
后藤一里    [14,16,18,15,11,8,17,22,24,21,16,82,99]
喜多郁代    [4,7,10,12,15,18,22,24,23,21,19,94,90]
山田凉      [23,24,22,18,12,8,7,6,5,4,3,85,75]
伊地知虹夏  [16,20,15,12,14,15,18,19,17,14,12,90,88]
洛天依      [7,10,13,15,17,19,21,23,22,19,16,92,88]
言和        [12,14,16,18,19,18,17,16,14,13,11,90,85]
乐正綾      [11,13,16,17,18,20,22,21,19,16,14,94,90]
诗岸        [9,12,14,16,17,18,17,16,15,13,11,86,84]
星尘        [13,14,15,16,18,21,23,24,24,23,21,96,96]
初音未来    [8,11,13,14,16,19,22,23,21,18,16,95,90]
巡音流歌    [16,18,17,15,14,16,18,19,18,17,15,91,87]
镜音铃      [6,9,12,14,17,21,23,24,22,19,16,93,89]
镜音连      [13,15,17,16,15,18,21,22,20,17,15,93,89]
百鬼綾目    [5,8,12,15,18,22,24,24,23,21,19,95,95]
东雪莲      [7,10,13,15,18,21,23,24,23,21,18,93,94]
永雏塔菲    [5,8,11,14,17,21,24,24,23,21,19,95,96]
孙笑川      [24,24,22,19,16,18,21,23,24,22,20,99,99]
神乐七奈    [9,12,14,16,18,20,22,23,21,18,15,92,89]
嘉然        [8,11,14,16,18,20,22,23,22,19,17,94,91]
梦梦        [6,9,13,15,17,21,23,24,24,22,19,94,95]
阿卡林      [0,0,0,0,0,0,0,0,0,0,0,0,0]
赤座灯里    [2,2,2,2,2,2,2,2,2,2,2,15,15]
一方通行    [24,0,24,0,24,0,24,0,24,0,24,100,100]
御坂美琴    [8,10,13,15,17,21,24,24,23,21,19,97,95]
食蜂操祈    [11,13,15,17,18,19,21,22,20,18,16,94,91]
上条当麻    [12,12,12,12,12,12,12,12,12,12,12,88,88]
鹿目圆      [14,16,18,19,20,22,24,24,24,23,22,99,99]
晓美焰      [16,19,16,12,11,13,16,19,21,22,20,93,90]
惠惠        [24,24,24,24,24,24,24,24,24,24,24,100,100]
阿库娅      [17,19,21,20,19,21,23,24,22,20,18,97,95]
达克妮斯    [24,24,22,20,16,12,9,7,5,4,3,99,60]
金色暗影    [8,11,13,14,16,19,22,24,23,21,18,92,90]
```

---

## 附录 B：Flutter 侧最小验收清单

1. `generateShuffleOrder` 用同一 seed 复现同一顺序；`next` 在「顺序+队尾」停住且 `playing=false`；`previous` 在 `currentTime > 3` 时仅 seek 0。
2. `playNext` 插到当前曲之后、不立刻播放；`removeFromQueue(currentIndex)` 无效果。
3. 会话统计：连续播放 29.9s 不计入 `listen_daily.play_count`，30.0s 计入；完成度 ≥80% 时 `completed=1`。
4. EQ 10 段频点/类型/默认值完全一致；reverb 干湿 `1 - r/100`；宽度矩阵 `(1±2w)/2`。
5. LLFX3 编解码对 8 个内置预设 + 任意自定义频点往返一致；非法 `reverb>100` 返回失败；空名返回失败。
6. 字符码：116 条预设的 code 能解出对应 eq，且 `encodeEqCode(decodeEqCode(c)) == c`。
7. `shareCodePreference` 三种模式的复制文本格式一致；导入能剥离四种行首标签。
8. `settings.json` / `audio-effects.json` 的键名与结构一致，缺字段回落默认、`eqBands` 长度非 10 丢弃。
9. 媒体通知元数据映射（title/artist/album/duration/art）与 §5.2 一致；seek 命令换算 `positionMs/1000`。
10. 动画时长/曲线与 §7.3 一致（200/220/250ms 三档）。
