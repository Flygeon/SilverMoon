# 04 · 歌词系统技术规格（Flutter 重写基线）

> 来源：只读分析 `apps/desktop`（Electron 44 + Vue 3 + TS）现有实现。
> 覆盖文件：`src/utils/lyricTimeline.ts`、`qrc.ts`、`krc.ts`、`preciseLyrics.ts`、`wordAnalysis.ts`、`wordCache.ts`、`src/workers/wordAnalysis.worker.ts`、`src/components/LyricsView.vue`、`src/views/DesktopLyrics.vue`、`src/stores/player.ts`、`src/utils/desktopLyrics.ts`、`shared/types.ts`。
> 仓库内附带两个 Flutter 参考实现（`酷狗音乐平台参考/`、`ECHO播放器参考/`），本文在「原实现缺失但重写必需」处显式引用并标注来源。
> 约定：`t` = 播放位置（秒，浮点）；TS 侧所有 `time/start/end` 一律**秒**，解析中间结构（QRC/KRC/TTML）一律**毫秒**。

---

## 1. 歌词数据模型

### 1.1 运行时模型（`apps/desktop/shared/types.ts` L134–152）

```ts
/** 逐字单元：一个字/词的起止时间（秒） */
interface WordUnit {
  text: string;
  start: number;   // 秒
  end: number;     // 秒（绝对，不是时长）
}

interface LyricLine {
  time: number;           // 行起始（秒）
  text: string;           // 原文（必填；空串行在解析阶段被丢弃）
  translation?: string;   // 翻译
  romaji?: string;        // 罗马音（日韩官方罗马音轨）
  units?: WordUnit[];     // 逐字时间轴；缺省 = 整行一次性高亮
  instrumental?: boolean; // 前奏/间奏「三点」标记行，不是真实歌词
}
```

要点：

- **行没有 `end` 字段**。行结束时间按需推导：`end = lines[i+1].time`；末行 `end = time + max(2, text.length * 0.4)`（`estimateLineEnd`）。
- `units` 是**可选**字段，渲染层必须按「有 units 走逐字、无 units 走整行」双分支。
- `instrumental === true` 的行 `text` 固定为 `"•••"`，`units` 为 3 个 `"•"`。
- 无默认值填充逻辑，缺省即 `undefined`；推送到桌面歌词窗口时显式传 `translation/romaji`（可能为 `undefined`）。

### 1.2 中间结构（解析器内部，毫秒）

**QRC（`qrc.ts` L494–502）**

```ts
interface QrcLine {
  start: number;  // 毫秒
  end: number;    // 毫秒 = start + duration
  words: { text: string; start: number; end: number }[]; // 毫秒，绝对
}
```

**KRC（`krc.ts` L44–49）** 与 QrcLine 同构，但 `words[].start` 是**相对行首**的毫秒偏移（见 §3.6）。

### 1.3 精排缓存模型（`wordCache.ts` L6–12）

```ts
interface PreciseLine {
  idx: number;      // 行索引，对应 lines[idx]
  times: number[];  // 每字起始时间（秒），长度 === lines[idx].units.length
  end: number;      // 行结束时间（秒）；末字 end 用它
}
```

### 1.4 桌面歌词窗口模型（`desktopLyrics.ts` L20–39）

```ts
interface DesktopLyricLine { time: number; text: string; translation?: string; romaji?: string; }
interface DesktopLyricsState {
  lines: DesktopLyricLine[];
  currentTime: number;   // 秒
  playing: boolean;
  title: string;
  artist: string;        // 无歌手时为 ""（不是 undefined）
}
type DesktopLyricsControlAction = "toggle" | "next" | "prev" | "close";
interface DesktopLyricsBounds { x?: number; y?: number; width: number; height: number; } // 逻辑像素
```

事件名常量（跨窗口 IPC 契约）：

| 常量 | 值 | 方向 |
|---|---|---|
| `DESKTOP_LYRICS_LABEL` | `"desktop-lyrics"` | 窗口 label |
| `DL_STATE_EVENT` | `"desktop-lyrics:state"` | main → 歌词窗（节流 200ms） |
| `DL_READY_EVENT` | `"desktop-lyrics:ready"` | 歌词窗 → main（触发回推） |
| `DL_CONTROL_EVENT` | `"desktop-lyrics:control"` | 歌词窗 → main |
| `DL_BOUNDS_EVENT` | `"desktop-lyrics:bounds"` | 歌词窗 → main（300ms 去抖） |

### 1.5 多语言（原文 / 翻译 / 罗马音）合并规则

**(a) LRC 双语（`parseLrc`）**——三种形态，优先级从高到低：

1. `[tr:翻译]` 标签：`translation = 标签内容`。
2. **同时间戳双行**：毫秒键 `Math.round(time*1000)` 相同时，第二行成为第一行的 `translation`。若第二行自带 `[tr:]` 用其内容，否则用第二行正文。已存在 `translation` 时不覆盖。
3. **同行尾部括号译文**（meting 常见）：正则 `/\s*[（(]([^（）()]*)[）)]\s*$/`，且括号前必须还有非空正文才拆分；匹配后从正文中**删除**该括号段。

LRC 路径**不产出 romaji**。

**(b) QRC（`mergeQqLyrics`，`qrc.ts` L582–624）**——三轨独立解析后合并：

- 行数相等 → 直接按索引 `i` 配对。
- 行数不等 → 贪心最近时间匹配：对全部 `(ia, ib)` 组合按 `|orig[ia].time - track[ib].time|` 升序排序，逐个占用未使用的 `ia`/`ib`；未匹配的 `ia` 映射为 `-1`（保留原文，无副行）。
- 合并后 `translation` 来自 trans 轨 `text`，`romaji` 来自 roma 轨 `text`；两者可同时存在。

**(c) KRC（`krcToRawLines` + `krcLinesToLyricLines`）**——走 `[language:]` 标签（base64 JSON）：

- `type === 1` → 逐行翻译，`translations[i] = row[0]`。
- `type === 0` → **逐字**罗马音，按行对齐；原文中 `words` 全为空的行走 `offset` 跳过（罗马音字典不含该行）。
- 空/缺行 → `null` → 转换时 `?.trim() || undefined` 归一为 `undefined`。

**(d) 副行显示选择**：`settings.lyricSubMode ∈ {"translation","romaji"}`，默认 `"translation"`。`LyricsView.subText(line)` 是**二选一**，不并排显示。

---

## 2. 设置项（字段名 / 默认值 / 取值域）

来自 `src/stores/settings.ts` L58–80 与 L140–151：

| 字段 | 默认值 | 取值域 | 语义 |
|---|---|---|---|
| `lyricFontSize` | `30` | px | 主歌词字号 |
| `lyricLineHeight` | `2.5` | 倍数 | CSS `line-height` |
| `lyricLineGap` | `20` | px | 相邻行竖直间距（参与位移累加） |
| `lyricFont` | `"system"` | `system\\|sans\\|serif\\|kai\\|yuan` | 字体栈，见 §4.6 |
| `lyricTranslationSize` | `62` | 百分比 | 副行字号（相对主字号） |
| `lyricTranslationGap` | `4` | px | 主行与副行间距（`margin-top`） |
| `lyricSubMode` | `"translation"` | `translation\\|romaji` | 副行显示哪一轨 |
| `wordLyrics` | `true` | bool | 逐字填充总开关 |
| `preciseLyrics` | `false` | bool | 是否走云端逐字回退链 |
| `lyricSourcePrefs` | `{}` | `Record<key, "qq"\\|"kg"\\|"meting"\\|"local">` | key = `normalizeTitle(title)\\|round(durationMs)` |
| `detectInstrumental` | `true` | bool | 前奏/间奏三点识别 |
| `lyricBlur` | `true` | bool | 非当前行按距离模糊 |
| `desktopLyricsEnabled` | `false` | bool | |
| `desktopLyricsFontSize` | `28` | px | |
| `desktopLyricsOpacity` | `90` | 0–100 | 渲染时 `/100` |
| `desktopLyricsLocked` | `false` | bool | 锁定时窗口不可拖动 |
| `desktopLyricsAlwaysOnTop` | `true` | bool | |
| `desktopLyricsShowNext` | `false` | bool | 显示「下一句」 |
| `desktopLyricsShowTranslation` | `false` | bool | |
| `desktopLyricsClickThrough` | `false` | bool | 鼠标穿透 |
| `desktopLyricsToolbar` | `"click"` | `click\\|always` | |
| `desktopLyricsDoubleClick` | `"toggle"` | `none\\|toggle` | |
| `desktopLyricsAnimation` | `"fade"` | `fade\\|slide\\|scale\\|glow` | |
| `desktopLyricsBounds` | `{width:420,height:120}` | 逻辑 px；`x/y` 可选 | 窗口最小 260×70 |

---

## 3. 解析算法

### 3.1 分词 `tokenizeLyric(text): string[]`（`lyricTimeline.ts` L16–54）

1. 优先 `Intl.Segmenter(undefined, { granularity: "grapheme" })` 按**字素簇**切分；无 `Segmenter` 时降级 `Array.from(text)`（按码点）。
2. 逐段归类：
   - 命中 `/[A-Za-z0-9'’’-]/` → 累积进 `latin` 缓冲。
   - 命中 `/\s/`：
     - `latin` 非空 → **把空格并入词尾**后 flush（保留英文词间分隔，逐字渲染时不粘连）；
     - 否则若已有 token → 追加到**上一个 token 尾部**；
     - 否则丢弃（行首空格）。
   - 其他（CJK 单字 / 标点）→ 先 flush `latin`，再 push 该字符本身。
3. 末尾 flush 残余 `latin`。

例：`"We 我们"` → `["We ", "我", "们"]`（注意 `"We "` 带尾空格）。

### 3.2 粗排时间轴 `buildRoughUnits(text, start, end)`（L57–68）

```
tokens = tokenizeLyric(text)
total  = max(0.05, end - start)      // 至少 50ms，防除零
sung   = total * 0.85                // 末尾 ~15% 留作尾音停顿
step   = max(0.03, sung / tokens.length)
units[i].start = start + i * step
units[i].end   = (i === last) ? start + sung : start + (i + 1) * step
```

- 单 token：`start = start`、`end = start + sung`。
- `text` 为空 → 返回 `[]`。
- 末行兜底时长 `estimateLineEnd(text) = max(2, text.length * 0.4)`（L71–73）。

### 3.3 序列构建 `buildLyricSequence(rawLines, detectInstrumental = true)`（L135–176）

`detectInstrumental === false`：逐行附粗排 `units`（end = 下一行 start），原样返回，不插点。

`detectInstrumental === true`：

1. 用 `META_RE` 把行分为 `meta` / `lyrics` 两组；`lyrics` 为空则整体原样返回。
   ```
   META_RE = /^\s*(作词|作曲|编曲|制作人|出品人|OP|SP|监制|混音|录音|和声|母带|编曲人|制作|出品|词|曲)\s*[:：]|^QQ音乐享有本[^。]*著作权/
   ```
2. **前奏**：`introStart = meta.length ? meta[0].time : 0`；若 `lyrics[0].time - introStart >= 1.0` 秒，插入 `makeDotsLine(introStart, lyrics[0].time)`。
3. 逐行（真实歌词）：
   - `end = next ? next.time : time + max(2, text.length*0.4)`；`gap = end - time`。
   - `sing = min(gap, singingEstimate(text))`；`pause = max(0, gap - sing)`。
   - `units = buildRoughUnits(text, time, time + sing)`（注意第 3 参是 `time + sing`，不是 `end`）。
   - 若 `next` 存在且 `pause >= 3.0`（`INSTRUMENTAL_THRESHOLD`）→ 插入 `makeDotsLine(time + sing, next.time)`。

`singingEstimate(text)`（L104–112）：逐字符，`/[\p{L}\p{N}]/u` 命中记 `sung++`，否则 `other++`；返回 `max(1.2, sung*0.3 + other*0.05)`。目的：标点密集的感叹句不被高估演唱时长，避免间奏被吞进歌词时长。

`makeDotsLine(start, end)`（L115–128）：
```
duration = max(0.3, end - start); step = duration / 3
{ time: start, text: "•••", instrumental: true,
  units: [0,1,2].map(i => ({ text: "•", start: start + i*step, end: start + (i+1)*step })) }
```

### 3.4 LRC 解析 `parseLrc(text, detectInstrumental = true)`（L200–270）

时间戳正则：`/\[(\d{2}):(\d{2})(?:[:.]((?:\d{2}|\d{3})))?\]/g`

- 一行的**所有**时间戳都会被收集（一行多时间戳 = 同一句重复出现）。
- 小数部分：`m[3]` 长度 3 → 毫秒直接取值；长度 2 → **厘秒 ×10 转毫秒**；缺失 → 0。
- `time = minutes*60 + seconds + ms/1000`（秒）。
- **冒号厘秒格式 `[mm:ss:cc]` 必须支持**（QQ 普通 LRC 使用），否则整首歌词会被丢弃（历史 bug）。

翻译标签：`/\[tr:(.*?)\]/g`。

正文清洗：依次删除 `[mm:ss]`、`[tr:]`、`[lang:]`、`[ar:]`、`[ti:]`、`[al:]`、`[by:]` 后 `trim()`；为空则跳过该行。

去重/合并键：`Math.round(time * 1000)`（毫秒）。同键第二行按 §1.5(a) 写入 `translation`。

输出前按 `time` 升序排序，然后交给 `buildLyricSequence`。

**纯音乐占位过滤** `filterInstrumentalPlaceholder(lines)`（L282–285）：
```
INSTRUMENTAL_PLACEHOLDER_RE =
  /^\s*(?:此歌曲为没有填词的纯音乐[^\n]*|没有填词[^\n]*|纯音乐[，,、]?\s*(?:请欣赏|请聆听)[^\n]*)\s*$/
```
过滤后为空数组 → 返回 `null`（= 无可用歌词）。

### 3.5 QRC（QQ 逐字）`qrc.ts`

**解密链**：`hex 文本或原始字节 → （可选 QMC1）→ 3DES/ECB → zlib inflate → UTF-8`

- 密钥：`QRC_KEY = TextEncoder().encode("!@#)(*$%123ZXC!@!@#)(NHL")`（24 字节）。
- 3DES 密钥调度（`tripledesKeySetup`，L375–388）：
  - ENCRYPT：`[ks(key[0:8], ENCRYPT), ks(key[8:16], DECRYPT), ks(key[16:24], ENCRYPT)]`
  - **DECRYPT：`[ks(key[16:24], DECRYPT), ks(key[8:16], ENCRYPT), ks(key[0:8], DECRYPT)]`**
- 分组：`blocks = ceil(len/8)`，末块不足 8 字节**补零**成 8 字节；逐块 `tripledesCrypt`（3 轮 `crypt`，每轮 16 轮 Feistel，`crypt` 内部先 `initialPermutation`，15 轮 `s1 = f(s1, key[idx]) ^ s0`，最后 `s0 = f(s1, key[15]) ^ s0`，再 `inversePermutation`）。
- 位运算陷阱：JS 位运算是 int32，凡涉及高位的取位必须用 `>>>`（Python `>>` 作用于无符号位模式）。
- 解压：**必须容忍流结束后的填充垃圾**（3DES 末块填充产生 trailing junk）。Python `zlib.decompress` 与 pako 都会忽略，浏览器原生 `DecompressionStream` 会报错——故此处用 pako。
- QMC1（本地 `.qrc` 文件）：先逐字节异或 `QMC1_PRIVKEY[i > 0x7fff ? (i % 0x7fff) & 0x7f : i & 0x7f]`，再 `subarray(11)` 跳过 11 字节头。

**解析**（`qrcToRawLines`，L508–555）：

```
QRC_PATTERN            = /<Lyric_1 LyricType="1" LyricContent="(.*?)"\/>/s
LINE_SPLIT_PATTERN     = /^\[(\d+),(\d+)\](.*)$/
WORD_SPLIT_PATTERN     = /(?:\[\d+,\d+\])?((?:(?!\(\d+,\d+\)).)*)\((\d+),(\d+)\)/g
WORD_TIMESTAMP_PATTERN = /^\(\d+,\d+\)$/
TAG_SPLIT_PATTERN      = /^\[(\w+):([^\]]*)\]$/
```

- 行：`lineStart = m[1]`（毫秒），`lineDuration = m[2]`，`lineEnd = lineStart + lineDuration`。
- **纯字时间戳行**（正文形如 `(1234,567)`，即 `WORD_TIMESTAMP_PATTERN` 命中）：push `{start,end,words: []}` 并 `continue`（后续转 LyricLine 时因文本为空被丢弃）。
- 逐字：`WORD_SPLIT_PATTERN` 捕获 `(text, start, duration)`；**`start` 是绝对毫秒**（与 KRC 不同！），`end = start + duration`。文本恰为 `"\r"` 时跳过。
- 无任何 word 命中 → 兜底整行 `{text: lineContent, start: lineStart, end: lineEnd}`。
- `rawLinesToLyricLines`：`text = words.map(w=>w.text).join("")`；`text.trim()` 为空则跳过；`units` 的 start/end 除以 1000 转秒。

**`hasWordLevel(lines)`**：`lines.some(l => (l.units?.length ?? 0) > 1)`。

### 3.6 KRC（酷狗，含解密）`krc.ts`

**解密链**：`base64 → 跳过前 4 字节 → 逐字节异或 → zlib inflate → UTF-8`

```
KRC_KEY = [0x40,0x47,0x61,0x77,0x5e,0x32,0x74,0x47,0x51,0x36,0x31,0x2d,0xce,0xd2,0x6e,0x69]
          // = b"@Gaw^2tGQ61-\xce\xd2ni"（16 字节）
data      = base64Decode(b64content.trim()).subarray(4)
decrypted[i] = data[i] ^ KRC_KEY[i % 16]
plain     = inflate(decrypted) → UTF-8
```

KRC **无 3DES**，只有异或 + zlib，比 QRC 简单得多。

**解析**（`krcToRawLines`，L55–137）：

```
TAG_SPLIT_PATTERN  = /^\[(\w+):([^\]]*)\]$/
LINE_SPLIT_PATTERN = /^\[(\d+),(\d+)\](.*)$/
WORD_SPLIT_PATTERN = /(?:\[\d+,\d+\])?<(\d+),(\d+),\d+>((?:.(?!\d+,\d+,\d+>))*)/g
```

- 只处理以 `[` 开头的行；其余跳过。
- 标签行（`[ti:]`、`[language:]` 等）→ 存入 `tags` map。
- 行：`lineStart = m[1]`、`lineDuration = m[2]`、`lineEnd = lineStart + lineDuration`。
- 逐字：`start = lineStart + parseInt(wm[1])`（**相对行首偏移**），`duration = parseInt(wm[2])`，`end = start + duration`，`text = wm[3]`；`text` 为空跳过。第三个数（`\d+`）被忽略。
- 无 word 命中 → 兜底整行 `{text: lineContent, start: lineStart, end: lineEnd}`。
- `lines` 为空 → 返回 `null`（非 KRC 格式）。

**`[language:]` 标签**：base64 → UTF-8 → JSON
```json
{ "content": [ { "type": 1, "lyricContent": [["译文"], "..."] },
               { "type": 0, "lyricContent": [["ro","ma","ji"], "..."] } ] }
```
- `type 1` → 翻译，`translations[i] = row[0]`（`row` 是数组，取第 0 个字符串）。
- `type 0` → 罗马音，`romaji[i] = row.filter(string).join("")`；**遇到 `words` 全为空的行则 `offset++` 并跳过**，取 `roma.lyricContent[i - offset]`。
- 整个副轨解析包在 try/catch 中：失败不影响原文。

**`krcLinesToLyricLines`**：`text = words.map(w=>w.text).join("")`，`text.trim()` 为空跳过；units 转秒；`translation/romaji` 经 `?.trim() || undefined`。

### 3.7 TTML 解析

**重要事实：`apps/desktop` 中不存在 TTML 实现**（全仓 grep `ttml` 仅命中两个参考项目）。TTML 是 Flutter 重写时新增的能力，算法要点取自仓库内两个参考实现：

- `酷狗音乐平台参考/lib/widgets/apple_lyrics/parsers/ttml_parser.dart`（`package:xml`，命名空间感知，356 行）——**推荐采用**。
- `ECHO播放器参考/src/main/lyrics/lyricsParser.ts` 的 `parseTtmlLyrics`（正则实现，更脆弱，仅作行为对照）。

TTML 要点：

- 命名空间：`ttm = http://www.w3.org/ns/ttml#metadata`、`itunes = http://music.apple.com/lyric-ttml-internal`、legacy `http://music.apple.com/itunes/ttml`。属性读取需「带命名空间优先 → 裸属性名兜底 → 遍历 attributes 匹配 localName」三级回退。
- **阶段 1**：收集 `<translation><text for="KEY">…</text></translation>` → `Map<key, 译文>`。
- **阶段 2**：遍历所有 `<p>`：
  - `begin`/`end` 均为空 → 跳过该 `<p>`。
  - `role`（`ttm:role`）分轨：`"x-translation"` → 翻译轨，`"x-romanization"` → 罗马音轨，`"x-bg"` → 丢弃（无背景轨），其他 → 主轨。
  - `key`（`itunes:key`，含 legacy 与裸属性回退）用于关联头部翻译；`ttm:agent` 为对唱标识（主行携带，副行不带）。
  - 递归遍历子节点：文本节点累计正文；带 `begin` 的 `<span>` 生成 `LyricWord{startTime, duration = end > begin ? end - begin : 0, text}`；**不带 begin 的元素继续下钻**；`x-translation`/`x-romanization` 的子节点文本分流到对应缓冲；格式化空白（`normalized.isEmpty && 含 \n 或 \r`）忽略。
  - 出现字级时间戳之后的**游离文本**合并到最后一个 word 的 text 尾部（对齐 Lyrico 行为）。
  - 无 words 时用行 `begin/end` 造一个覆盖整行的 word。
- **阶段 3**：合并——翻译优先取行内联，其次 `metadataTranslations[linkKey]`，再次按 `startTime` 精确相等的翻译轨行。
- 行 duration：优先 `end - begin`；否则 `(last.startTime + last.duration) - start`；否则 0。负值截为 0。
- 时间解析 `_parseTtmlTimeMs`：`(\d+(\.\d+)?)ms` → 直接取整；`…s` → ×1000；**裸数字按秒** ×1000；`hh:mm:ss(.fff)` 与 `mm:ss(.fff)`，小数部分右补零到 3 位后取前 3 位为毫秒。无法解析 → 0。
- 文本规范化 `_normalizeText`：仅当含 `\n`/`\r` 时把 `\s+` 折叠为单空格；`trimEdges` 控制是否 `trim`。
- 任何异常 → 返回空列表，**不抛出**。结果按 `startTime` 升序排序。

### 3.8 逐字时间戳的语义（起止 vs 时长）

| 格式 | 字段形态 | 语义 |
|---|---|---|
| 本项目 `WordUnit` | `{start, end}`（秒） | **绝对起止** |
| QRC 原始 | `(start, duration)`，start **绝对**毫秒 | 转 `end = start + duration` |
| KRC 原始 | `<start, duration, ?>`，start **相对行首**毫秒 | `absStart = lineStart + start`，`end = absStart + duration` |
| KRC 行 | `[lineStart, lineDuration]` | `lineEnd = lineStart + lineDuration` |
| TTML | `begin`/`end` 属性（绝对） | 内部转 `duration = end - begin` |
| `PreciseLine.times` | 仅存**起始**数组 | `units[i].end = times[i+1] ?? p.end`（末字用行 end） |

**重写必须注意**：QRC 是绝对时间戳，KRC 是相对时间戳；两者混淆会导致整首歌字级时间错位到第 0 秒附近。

### 3.9 云端逐字歌词回退链 `preciseLyrics.ts`

**入口**：`fetchCloudLyrics({ title, durationMs, artist?, preferredSource?, force?, fallbackToMeting? })`

前置校验：`title.trim()` 为空 **或** `durationMs` 缺失/非有限 → 立即返回 `{ ok:false, reason:"missing-info" }`。

**来源顺序构造**（L306–312）：
```
base = []
if (preferred) base.push(preferred)
if (preferred !== "qq") base.push("qq")
if (preferred !== "kg" && !base.includes("kg")) base.push("kg")
if (fallbackToMeting && !base.includes("meting")) base.push("meting")
```
默认（无 preferred）= `["qq", "kg"]`（+ 可选 meting）。

**结果缓存**：进程内 `Map`，key = `${normalizeTitle(title)${|${Math.round(durationMs)${|${preferredSource ?? "auto"${|${fallbackToMeting ? "meting" : "no-meting"${`。
TTL：成功 `60*60*1000`（1h），失败 `10*60*1000`（10min）。`force=true` 绕过。命中成功缓存时返回体带 `fromCache: true`。

**匹配常量**：`DURATION_TOLERANCE_MS = 1000`（±1s）、`MAX_CANDIDATES = 5`。

**标题归一化**：
```ts
stripBrackets(t) = t.replace(/[（(][^（）()]*[）)]/g, " ").replace(/\s+/g, " ").trim()
normalizeTitle(t) = stripBrackets(t).toLowerCase()
  .replace(/\u3000/g, " ")
  .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角→半角
  .replace(/\s+/g, " ")
```

**QQ/KG 单源流程**：搜索词 = `stripBrackets(title)` → 取「`normalizeTitle` 完全同名」的候选 → 过滤 `|candidate.durationMs - durationMs| <= 1000` → 按时长差升序取前 5 → 逐个拉取；**任一候选含逐字数据（`hasWordLevel`）立即返回**（`wordLevel: true`）；全部无逐字则记住第一个逐行结果，循环结束后回退返回它（`wordLevel: false`）。

**Meting 单源流程**：搜索关键词 `stripBrackets(title)`；Meting 结果无时长字段 → 先按归一化标题全等过滤，再在其中优先歌手名互相包含者，否则取首个；最终兜底 `songs[0]`。`lrc` 字段若以 `http` 开头则先查 `onlineCache`（`lrcGet/lrcSet`，key = `song.id || song.lrc`），未命中再 `fetch`；否则若含 `[` 直接当 LRC 文本。解析用 `parseLrc(text, true)` + `filterInstrumentalPlaceholder`。Meting 结果**永不产生逐字**（`wordLevel: false`）。

**失败原因枚举**：`"missing-info" | "search-failed" | "no-match" | "no-lyrics"`；成功结果含 `source`、`lines`、`songId`、`songTitle`、`wordLevel`、`fromCache`。每个来源失败只记 `console.warn`，继续下一个来源；全部失败返回最后一个失败原因。

**HTTP 端点与参数**

QQ（`qqMusic.ts`）：`POST https://u.y.qq.com/cgi-bin/musicu.fcg`
- Headers：`cookie: "tmeLoginType=-1;"`、`content-type: application/json`、`user-agent: okhttp/3.14.9`；超时 `REQUEST_TIMEOUT_MS = 8000`。
- Body：`{ comm, request: { method, module, param } }`；`comm` 见 L33–43：`{ ct:11, cv:"1003006", v:"1003006", os_ver:"15", phonetype:"24122RKC7C", rom:"Redmi/miro/...:user/release-keys", tmeAppID:"qqmusiclight", nettype:"NETWORK_WIFI", udid:"0" }`。
- 成功判定：`data.code === 0 && data.request.code === 0`，返回 `data.request.data`。
- **GetSession**（先于其他请求，单飞 + 失败可重试）：`method="GetSession", module="music.getSession.session", param={caller:0, uid:"0", vkey:0}`；把 `session.uid/sid/userip` 合并进 `comm`。
- **搜索**：`method="DoSearchForQQMusicLite", module="music.search.SearchCgiService"`
  `param = { search_id, remoteplace:"search.android.keyboard", query, search_type:0, num_per_page:20, page_num:1, highlight:0, nqc_flag:0, page_id:1, grp:1 }`
  `search_id = ((1 + rand(0..19)) << 54) + (rand(0..4194304) << 32) + (Date.now() % 86400000)`（**超过 2^53，JS 必须用 BigInt**）。
  结果路径 `data.body.item_song[]` → `{ id: String(info.id), mid, title, subtitle, artist: singer[].name.join("/"), album: album.name, durationMs: interval * 1000 }`。缓存 key = keyword，TTL 1h。
- **歌词**：`method="GetPlayLyricInfo", module="music.musichallSong.PlayLyricInfo"`
  `param = { albumName: b64(album), crypt:1, ct:19, cv:2111, interval: floor(durationMs/1000), lrc_t:0, qrc:1, qrc_t:0, roma:1, roma_t:0, singerName: b64(artist), songID: Number(id), songName: b64(title), trans:1, trans_t:0, type:0 }`
  （`b64` = **UTF-8 字节**的 base64，不是 latin1。）
  响应：原文取 `resp.lyric`，其时间轴判定 `origT = (resp.qrc_t ?? 0) !== 0 ? resp.qrc_t : resp.lrc_t`；**`String(origT) === "0"` 视为无歌词**。翻译 `resp.trans`/`resp.trans_t`、罗马音 `resp.roma`/`resp.roma_t` 同规则，仅在原文解析成功后才处理。
  单轨解析 `parseTrack`：先 `qrcDecrypt` → `qrcToRawLines`，命中走 QRC；否则若明文含 `[` 且含 `]` → `parseLrc(plain, false)` + 占位过滤；都失败返回 `null`。
  缓存 key = `song.id`，TTL 1h，失败也写缓存（`lines: null`）。

KG（`kgMusic.ts`）：`SIGN_KEY = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA"`
- 通用头：`User-Agent: Android14-1070-11070-201-0-${module${-wifi`、`Connection: Keep-Alive`、`Accept-Encoding: gzip, deflate`、`KG-Rec: 1`、`KG-RC: 1`、`KG-CLIENTTIMEMS: now`、`mid = md5(String(now))`。
- 基础参数：`module === "Lyric"` → `{ appid:"3116", clientver:"11070", ...params }`；否则 `{ userid:"0", appid:"3116", token:"", clienttime: floor(now/1000), iscorrection:"1", uuid:"-", mid, dfid:"-", clientver:"11070", platform:"AndroidFilter", ...params }`。
- **签名**：把所有参数按 key 升序、以 `k=v`（对象值 `JSON.stringify`）拼接成 `sortedPairs`，则
  `signature = md5(SIGN_KEY + sortedPairs + (data ?? "") + SIGN_KEY)`。
- 成功判定：`Number(error_code) === 0 || === 200`；超时 8000ms。GET 时全部参数走 query string。
- **搜索**：`http://complexsearch.kugou.com/v2/search/song`（额外头 `x-router: complexsearch.kugou.com`），`module="SearchSong"`，`param={sorttype:"0", keyword, pagesize:20, page:1}`；结果 `data.data.lists[]`。
  失败回退旧接口 `http://{随机域名}/api/v3/search/song`，域名池 `["mobiles.kugou.com","msearchcdn.kugou.com","mobilecdnbj.kugou.com","msearch.kugou.com"]`，`param={showtype:"14", highlight:"", pagesize:"30", tag_aggr:"1", plat:"0", sver:"5", keyword, correct:"1", api_ver:"1", version:"9108", page:1}`，结果 `data.data.info[]`。
  字段映射见 `formatNewSong`（`ID/FileHash/SongName/Auxiliary/Singers[].name/AlbumName/Duration`）与 `formatOldSong`（`album_audio_id/hash/songname/topic/singername（"、"分隔）/album_name/duration`）。缓存 key = keyword，TTL 1h。
- **歌词候选**：`GET https://lyrics.kugou.com/v1/search`，`module="Lyric"`，`param={album_audio_id: song.id, duration: song.durationMs, hash: song.hash, keyword: artist ? "artist - title" : title, lrctxt:"1", man:"no"}`；候选在**响应顶层** `candidates[]`（不是 `data.candidates`），接口按匹配度排序，取 `candidates[0]`。
- **歌词下载**：`GET http://lyrics.kugou.com/download`，`module="Lyric"`，`param={accesskey: best.accesskey, charset:"utf8", client:"mobi", fmt:"krc", id: best.id, ver:"1"}`；取 `data.content`（base64 KRC）与 `data.contenttype`。
  **`contenttype === 2` = base64 纯文本歌词（无时间轴）→ 直接视为无可用歌词返回 null**（不要尝试解析）。
- 缓存 key = `${song.id${:${song.hash${`，TTL 1h，失败也缓存 null。

Meting（`meting.ts`）：`API_BASE = "https://meting.mikus.ink/api"`
- `GET ${API_BASE${?server=${server${&type=${type${&id=${encodeURIComponent(id)${`，`type ∈ {search, playlist, lrc, url, pic}`。
- 响应为数组；非数组时取 `data.message` 抛错（形如 `{status:400, message:"…"}`）。
- 字段归一化：`id` 缺失时从 `url|lrc|pic` 里正则 `/[?&]id=(\d+)/` 兜底；`name = title || name`，`artist = author || artist`。

---

## 4. 逐字卡拉 OK 渲染

### 4.1 当前行计算

**主界面**（`player.ts` L297–304）——线性扫描，遇首个不满足即 break（依赖 `lyrics` 已按 `time` 升序）：
```ts
function updateActiveLine() {
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (currentTime >= lyrics[i].time) idx = i; else break;
  }
  activeLine = idx;   // 初始 -1
}
```
调用时机：`<audio>` 的 `timeupdate` 事件（约 4Hz），以及 loadSong / seek 后各手动调用一次。`activeLine === -1` 时 `currentLyric` 为空串。

**桌面歌词窗口**（`DesktopLyrics.vue` L29–44）——同一算法，输入是事件推送的 `state.currentTime`（节流 200ms）：
```ts
currentIndex = 最后一个满足 currentTime >= lines[i].time 的 i
current = currentIndex >= 0 ? lines[currentIndex] : undefined
next    = currentIndex >= 0 ? lines[currentIndex + 1] : undefined
```

### 4.2 行内词进度插值（`updateWordFill`，L179–198）

```ts
t = player.audioEl?.currentTime ?? player.currentTime   // 秒
for each (u, i) of line.units:
  pct = t >= u.end ? 100
      : t >  u.start ? ((t - u.start) / (u.end - u.start)) * 100
      : 0
  el.style.backgroundPosition = (100 - pct).toFixed(2) + "% 0"
  el.classList.toggle("sung", t >= u.end)
```

关键约束：

- **时间源必须是 `audioEl.currentTime`（真实播放位置），不能是节流后的 `currentTime` ref**。4Hz 的 ref 会让填充按 ~250ms 阶梯跳动，产生明显顿感。
- `background-position-x = 100 - pct`（%）：100% 全暗 → 0% 全亮。
- 由 `requestAnimationFrame` 循环驱动，**只改 `style` 与 `classList`，不触发框架重渲染**。
- 仅当前行渲染 `<span class="word">`；非当前行整行纯文本（`{{ line.text }}`）。
- 总开关 `settings.wordLyrics` 关闭时整个函数直接 return。
- `u.end - u.start` 为 0 时按 `t >= u.end` 分支处理（先判 `t >= u.end`），不会除零。

### 4.3 逐字渐变 / 高亮算法（CSS 结构）

当前行每个 `.word` 的填充是「**固定结构渐变 + 移动 background-position**」，而不是每帧改渐变 stop（更平滑省资源）：

```css
.word {
  display: inline-block;
  white-space: pre;                                  /* 保留英文词尾空格 */
  transition: transform 0.5s cubic-bezier(0.34, 1.2, 0.64, 1);
}
.lyric-item.active .word {
  color: transparent;
  background-image: linear-gradient(to right,
    var(--word-sung)   0%,
    var(--word-sung)   47%,
    var(--word-unsung) 53%,
    var(--word-unsung) 100%);
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position: 100% 0;                       /* 默认全暗，JS 每帧推进 */
  -webkit-background-clip: text;
  background-clip: text;
}
```

配色令牌：

| 状态 | `--word-sung` | `--word-unsung` | `color` |
|---|---|---|---|
| 非当前行 | `rgba(255,255,255,0.2)` | `rgba(255,255,255,0.2)`（同色 = 无填充效果） | `rgba(255,255,255,0.2)` |
| 当前行 `.active` | `#ffffff` | `rgba(255,255,255,0.35)` | `rgba(255,255,255,1)` |

**47%/53% 软边**：渐变在 47%–53% 之间过渡，等价于约 3% 宽度的柔化前沿，避免硬边割字。

**唱完上浮**：`.word.sung { transform: translateY(-2px); }`——唱完即上浮并**保持**（不回弹），直到该行失去 `.active` 随行重置。

**三点行放大**：`.lyric-item.active.instrumental .word { transform-origin: center; transform: scale(1.5); margin: 0 4px; }`，且 `.sung` 态叠加为 `translateY(-2px) scale(1.5)`。用 `scale` 而非 `font-size`，避免改变布局高度。

**行入场弹簧**：`.lyric-text.pop` 触发单次关键帧
```css
animation: lyric-pop 0.5s cubic-bezier(0.34, 1.2, 0.64, 1);  /* scale 0.97 → 1 */
```

### 4.4 滚动定位与缓动

**布局模型（硬约束）**：每行 `position: absolute; top: 0; left: 0; width: 100%`，**不是滚动容器**。每行独立 `translateY`，容器 `overflow: hidden`。源码注释明确：「容器 scrollTo 只能整体平移，做不出每行独立缓动 + 逐行错开的 Apple Music 波浪感」。

**当前行停靠高度**（L45）：
```ts
lyricsOffset() = containerRef.clientHeight / 2.6     // 容器未挂载时兜底 240
```
（参考实现用 `innerHeight / 3.5`；本项目分栏布局改为 `/2.6`，否则当前行会贴近顶部。≈ 0.385 的相对对齐位置。）

**目标位移 `getLayout(now, to)`**（L58–72）——按**行实际 offsetHeight 累加**，因此双语行、不同字号都能精确对齐：
```ts
lineGap = settings.lyricLineGap
if (to > now) res = Σ_{i=now}^{to-1} (lines[i].offsetHeight + lineGap)
else          res = -Σ_{i=to}^{now-1} (lines[i].offsetHeight + lineGap)
return res + lyricsOffset()
```

**`updateLayout(index, animate)`**（L82–112）：
```ts
for each line i:
  distance = |i - index|
  filter   = settings.lyricBlur ? "blur(" + distance + "px)" : "none"
  opacity  = (i === index) ? "1" : String(max(0.22, 1 - distance * 0.22))
  position = getLayout(index, i)

  n = i - index + 1
  if (n > 10) n = 0                       // 距离超过 10 行直接同步归位，避免长尾卡顿
  delay = (n * 70 - n * 10) * animate     // animate ∈ {0,1}

  delay <= 0 ? 立即 el.style.transform = translateY(position px)
             : setTimeout(..., delay)
```

- `animate = 0`：换歌/初始化/字号变化/ResizeObserver 触发，全部立即就位。
- `animate = 1`：`activeLine` 变化时（watch）触发级联。
- 每次调用先 `clearTimers()` 清空全部挂起的 `setTimeout`，避免旧动画追赶。
- 注意 `n` 可为负（当前行之上的行），此时 `delay < 0` 走「立即就位」分支；级联只对**下方**的行产生错开效果。

**过渡曲线**（Apple Music 参考曲线，注释标注「勿改」）：
```css
.lyric-item { transition: all 0.7s cubic-bezier(0.19, 0.11, 0, 1);
              transform-origin: left center; will-change: transform, filter, opacity; }
.lyric-item.no-transition { transition: none !important; }
```

**`resetLayout()`（换歌 / 首次渲染）**：清空 `lineRefs` → `await nextTick()` → 给所有行加 `.no-transition` → `updateLayout(max(0, activeLine), 0)` → **强制回流**（`void container.offsetHeight`）→ `requestAnimationFrame` 中移除 `.no-transition`。强制回流是必需的，否则两次变更会被合并成一次带动画的变更。

**重新布局的触发条件**：`ResizeObserver`（容器尺寸）、以及 `lyricFontSize / lyricLineHeight / lyricLineGap / lyricTranslationSize / lyricTranslationGap` 任一变化（均 `await nextTick()` 后 `updateLayout(activeLine, 0)`）。

**容器遮罩**：
```css
mask-image: linear-gradient(to bottom, transparent 0%, black 22%, black 74%, transparent 100%);
```

**其余行样式**：`.lyric-item { padding: 0 25px; box-sizing: border-box; font-weight: bold; letter-spacing: 0.6px; cursor: pointer; }`；`.lyric-text { word-wrap: break-word; text-shadow: 0 1px 12px rgba(0,0,0,0.35); }`；`.lyric-translation { font-weight: 500; opacity: 0.72; font-size: settings.lyricTranslationSize + "%"; margin-top: settings.lyricTranslationGap + "px"; }`。

**点击跳转**：`@click="player.seekToLyric(i)"` → `seek(lyrics[i].time)` → `audioEl.currentTime = max(0, t)`；越界索引直接 return。

### 4.5 手动滚动后的暂停跟随与恢复

**原实现没有这个能力**：`LyricsView` 不是滚动容器，无 wheel/touch 监听（`apps/desktop/src` 内 grep `wheel|touchstart|userScroll|followPaused` 在歌词相关文件中零命中）。重写时必须新增。

**推荐算法**（取自仓库内 Flutter 参考实现 `酷狗音乐平台参考/lib/widgets/apple_lyrics/controllers/lyric_scroll_controller.dart`，与 AMLL 一致，可直接移植）：

状态：`posY`（弹簧位移）、`_isUserScrolling`、`_autoReturnRemainingMs`、`_autoReturned`、`_initialJumpDone`。

- **目标位置**：`targetY = -(lineTop + lineHeight/2 - viewportHeight * alignPosition)`，`alignPosition` 默认 0.35（可调；对应原实现 `clientHeight/2.6 ≈ 0.385`，建议默认取 0.385 对齐原视觉）。`lineTop` 是前面所有行高度累加（自动换行场景必须传实际值，不能用 `index * lineHeight` 线性假设）。
- **拖动中** `onUserScroll(delta)`：`spring.setPosition(spring.position + delta, 0)`（**直接改 position 而非 setTarget**，弹簧暂不回弹）；`isUserScrolling = true`；`_autoReturnRemainingMs = autoReturnMs`；`_autoReturned = false`。
- **行切换时若用户正在拖动**：只更新 `_currentLineIndex/_currentLineHeight/_currentLineTop`，**不调用 setTarget**，避免瞬间回弹覆盖用户位置。
- **松手** `onUserScrollEnd(velocity)`：`isUserScrolling = false`；惯性距离 `inertiaDistance = (velocity * 0.3).clamp(-300, 300)`（velocity 单位 px/s）；`|inertiaDistance| > 5` 时先 `setPosition(currentPos, velocity)` 注入速度，再 `setTarget(currentPos + inertiaDistance)`；重置倒计时（仅当尚未回弹）。
- **倒计时** `autoReturnMs = 3000`（**以代码常量 3000 为准**；同文件注释中出现的 5000ms 是旧值描述）。`tick(dt)` 中 `_autoReturnRemainingMs -= dt * 1000`，≤0 时 `_returnToCurrentLine()`：置 `_autoReturned = true`、触发 `onAutoReturn` 回调（用于恢复模糊效果）、`setTarget(targetYForLine(当前行))`。
- **首次定位瞬移**：新建控制器/切歌时弹簧从 0 出发，若直接 setTarget 会看到「从顶部滚到当前行」的长动画。首次 `setCurrentLine` 且 viewport > 0 时用 `setPosition(targetY, 0)` 瞬移，并置 `_initialJumpDone = true`。切歌时 `resetInitialJump()`。
- **点击 vs 拖动判定**：`totalDelta.abs() < clickThresholdPx (=10)` 视为点击（触发 seek），否则视为拖动。
- **弹簧参数**（`lyric_layout.dart`）：
  - seeking：`stiffness = 90, damping = 15`（固定，更稳定）
  - 间奏激活：`stiffness = 40, damping = 10`（更柔和，约 500ms 到位而非瞬移）
  - 普通播放：`intervalMs` 先 clamp 到 `[100, 800]`，`ratio = (1 - (intervalMs - 100)/700) ** 0.2`，`stiffness = 110 + ratio * 30`（100ms→140 最灵敏，800ms→110 最迟缓）；`damping = sqrt(stiffness) * 2.2`
  - 优先级：seeking > 间奏 > 普通
  - `intervalMs` 定义 = `下一行 startTime - 当前行 endTime`
  - 弹簧求解器：`m*x'' + c*x' + k*(x-target) = 0`，稳定阈值 0.01，子步长上限 0.016s（dt 过大时子步进）
- **性能开关**：`isConverged = !isUserScrolling && !isWaitingForAutoReturn && spring.isSettled` 为 true 时可停 Ticker。

### 4.6 字体栈（`LyricsView.vue` L31–38）

```ts
LYRIC_FONTS = {
  system: '"SarasaGothicSC-Regular","SFPro-Regular","Helvetica Neue","Microsoft YaHei",system-ui,sans-serif',
  sans:   '"Helvetica Neue","Microsoft YaHei","Hiragino Sans GB",sans-serif',
  serif:  'Georgia,"Songti SC","SimSun",serif',
  kai:    '"KaiTi","STKaiti","Kai",cursive',
  yuan:   '"Yuanti SC","YouYuan","Microsoft JhengHei UI",sans-serif',
}
```

空态：无歌词时居中显示 `lyrics` 图标（48px，opacity 0.5，下边距 12px）+ `t("player.noLyrics")` + 提示行（13px，opacity 0.7，上边距 8px），文字色 `rgba(255,255,255,0.5)`。

---

## 5. 本地 FFT 词级时间轴分析

### 5.1 流水线（`wordAnalysis.ts`）

```
getPreciseWordTimes(source, lines, key)
  ├─ wordCacheGet(key) 命中 → 直接返回（不重新分析）
  └─ 未命中 → analyzeSongWords(source, lines, key)
        ├─ getAudioBytes(source)
        ├─ decodePcm(bytes)
        ├─ 裁剪 PCM
        ├─ 构造 jobs（跳过 instrumental 行）
        ├─ Web Worker FFT
        ├─ wordCacheSet(key, result)
        └─ return result
     任何异常 → console.warn("[逐字精排] 分析失败，保持粗排:") + 返回 null（静默降级为粗排）
```

**取音频字节**：
- `kind === "local"` 且 `isDesktop`：`readFile(filePath)` → `data.buffer.slice(byteOffset, byteOffset + byteLength)`。
- `kind === "online" | "webdav"`：`fetch(url)`，非 2xx 抛 `在线音频获取失败 (HTTP ${status${)`。
- 其他 → 抛 `无法获取音频源`。

**解码**：
```ts
const ctx = new OfflineAudioContext(1, 1, 44100);   // 1 声道、1 帧、44100Hz
const buf = await ctx.decodeAudioData(bytes);
return { pcm: buf.getChannelData(0), sampleRate: buf.sampleRate };  // 取第 0 声道
```
多声道**只取第 0 声道**（起音在声道间一致，省混音开销）。`sampleRate` 用的是**解码后的实际采样率**（`buf.sampleRate`），不是构造时的 44100。

**PCM 裁剪**（L89–92）：
```ts
MAX_SECONDS = 300;                       // 只分析前 5 分钟
lastTime = lines[last]?.time ?? 0;
limit = min(pcm.length, floor(min(MAX_SECONDS, lastTime + 1) * sampleRate));
mono  = pcm.slice(0, max(limit, sampleRate));   // 至少保留 1 秒
```

**jobs 构造**：每行 `{ idx, start: l.time, end: estimateEnd(lines, idx), count: l.units?.length ?? 0 }`；**过滤掉 `count === 0` 或 `lines[idx].instrumental` 的行**（三点行保持均分，不做起音分析）。jobs 为空 → 直接返回 `[]`（不写缓存）。`estimateEnd` 与粗排一致：下一行 start，末行 `time + max(2, text.length*0.4)`。

**Worker 通信**：`new Worker(new URL("../workers/wordAnalysis.worker.ts", import.meta.url), { type: "module" })`；`postMessage({ pcm, sampleRate, lines: jobs }, [pcm.buffer])`（**transferable 零拷贝，PCM 所有权转移**）；`onmessage` 里先 `worker.terminate()` 再 resolve。

**应用结果** `applyPreciseWordTimes(lines, precise)`（L127–139）：
```ts
for (const p of precise) {
  const line = lines[p.idx];
  if (!line?.units?.length) continue;
  const n = line.units.length;
  if (!p.times.length || p.times.length !== n) continue;   // 数量不符 → 保留粗排
  const texts = line.units.map(u => u.text);               // 只改时间，保留原文
  line.units = texts.map((text, i) => ({ text, start: p.times[i], end: p.times[i+1] ?? p.end }));
}
```

**编排**（`player.ts` `scheduleWordAnalysis` L386–412）：`settings.wordLyrics` 关闭则 return；`wordAnalysisInflight: Set<string>` 去重；完成后校验 `song.value?.id === meta.id` 才应用（防止分析期间切歌）；`finally` 中从 inflight 移除。

### 5.2 缓存（`wordCache.ts`）

- IndexedDB：`DB_NAME = "lumiluna"`，version `1`，`STORE = "wordTimes"`（无 keyPath，out-of-line key）。
- 写入值：`{ v: 1, lines: PreciseLine[] }`，key 为字符串。
- 读取校验：`data && data.v === 1 && Array.isArray(data.lines)`，否则返回 `null`（**版本不匹配 = 缓存失效**）。
- 所有异常静默吞掉：读失败 → `null`，写失败 → 忽略（不阻塞主流程）。
- `dbPromise` 单例缓存连接；`onupgradeneeded` 里 `createObjectStore(STORE)`（幂等判断 `objectStoreNames.contains`）。

**缓存 key 格式**（`player.ts` L396）：
```
key = ${meta.kind${:${meta.id${        // kind ∈ {local, online, webdav}
```
（策划书另述为 `local:<fileId>` / `online:<songId>`，语义一致。）

**前置约束**：renderer 必须由 `app://` 提供而非 `file://`——Chromium 在 opaque origin 下禁用 IndexedDB（项目 `AGENTS.md` 明确记录此坑）。

### 5.3 Worker 算法（`wordAnalysis.worker.ts`）

常量：
```ts
FFT_SIZE = 1024;       // ~23ms @44.1kHz
HOP = 512;             // 50% 重叠
MIN_WORD = 0.06;       // 每字最短 60ms
SEARCH_RADIUS = 0.18;  // 均匀位置 ±180ms 内吸附
VOCAL_MIN = 300;       // Hz
VOCAL_MAX = 3000;      // Hz
```

**`analyzeLine(pcm, sampleRate, job)`**：
1. `count <= 1` → 返回 `[start]`。
2. `s0 = max(0, floor(start*sampleRate))`，`s1 = min(pcm.length, floor(end*sampleRate))`。
3. 若 `s1 - s0 < sampleRate * 0.3`（行 < 300ms）→ 直接 `uniformStarts(start, end, count)`。
4. 否则 `detectOnsets` → `pickBoundaries(onsets, count-1, start, end)` → 返回 `[start, ...bounds]`。

**`uniformStarts(start, end, count)`**：`start + (i/count) * (end - start)`，i ∈ [0, count)。

**`detectOnsets(pcm, sampleRate, s0, s1, t0)`**：
- `binMin = max(1, floor((300/sampleRate) * 1024))`；`binMax = min(512, ceil((3000/sampleRate) * 1024))`。
- 逐帧（`off` 从 `s0` 起，步长 `HOP`，条件 `off + FFT_SIZE <= s1`）：
  1. 把 `pcm[off .. off+1023]` 拷进 `re`（`Float64Array`），`im` 清零。
  2. 原地 radix-2 迭代 FFT（`fft(re, im)`：位反转置换 + 蝶形，`ang = -2π/len`）。
  3. **谱通量**：对 `b ∈ [binMin, binMax]`：`mag = hypot(re[b], im[b])`；`d = mag - prevMag[b]`；**仅 `d > 0` 时累加** `fl += d`；`prevMag[b] = mag`。`flux.push(fl)`；`times.push(t0 + (off - s0)/sampleRate)`。
- 返回 `peakPick(smooth(flux, 5), times)`。

**`smooth(arr, win = 5)`**：滑动窗口均值，前缀不足时除以 `min(win, i+1)`。

**`peakPick(flux, times)`**：
```ts
mean = Σflux / n;  std = sqrt(max(0, Σflux²/n - mean²));
thresh = mean + std * 1.2;
// 局部极大 + 超阈 + 最小间隔
for i in [1, n-1):
  if (flux[i] > flux[i-1] && flux[i] > flux[i+1] && flux[i] > thresh) {
    if (times[i] - last >= MIN_WORD) { peaks.push({time, strength: flux[i]}); last = times[i]; }
  }
```

**`pickBoundaries(onsets, needed, start, end)`**（needed = count - 1）：
1. `N = needed + 1`；`uniforms = uniformStarts(start, end, N).slice(1)`（去掉首字起点）。
2. 对每个均匀位置 `u`：在 `|o.time - u| <= SEARCH_RADIUS` 的 onsets 中取 **strength 最大**者；若满足 `start + MIN_WORD <= best.time <= end - MIN_WORD` 则采用，否则用 `u`。
3. **单调性校验**：若任一 `bounds[i] - bounds[i-1] < MIN_WORD` → **整体回退为 uniforms**（乱序/过近即放弃吸附）。
4. 返回 bounds。

**精度定位（策划书 §10）**：FFT 起音是启发式，伴奏/弱声母/长音会误切或漏切；且行时间本身有误差——字建立在行上。可达「视觉流畅、节奏大致对齐」的主流 karaoke 水准，**达不到完全精准**（完全精准需 ASR 强制对齐，Phase 3）。

---

## 6. 桌面歌词窗口

### 6.1 窗口与状态

创建参数（`desktopLyrics.ts` `openDesktopLyricsWindow`）：`transparent: true, decorations: false, alwaysOnTop: true, skipTaskbar: true, shadow: false, resizable: true, minWidth: 260, minHeight: 70`，尺寸取自 `settings.desktopLyricsBounds`（默认 420×120），URL `${location.href.split("#")[0]${#/desktop-lyrics`，`title: "桌面歌词"`。已存在同 label 窗口则 `show() + setFocus()`。

主窗口 → 歌词窗状态推送：节流 **200ms**（`syncDesktopLyrics`）；`watch([lyrics, song, playing])` 时 `force=true` 立即推；`play`/`pause` 事件也 `force=true`。未启用桌面歌词或无歌曲时直接 return。

歌词窗 → 主窗口：位置/尺寸变化经 `scheduleReportBounds` **300ms 去抖**，坐标除以 `window.devicePixelRatio || 1` 转逻辑像素后上报（`Math.round`）。挂载时 `setAlwaysOnTop` / `setIgnoreCursorEvents` 各按设置同步一次，并 `watch` 设置变化实时生效。挂载流程：校验 `isDesktopLyricsWindow()` → 注册 `blur` 监听 → `listen(DL_STATE_EVENT)` → 设置窗口属性 → 监听 moved/resized → `emitDesktopLyricsReady()`。

### 6.2 主文本与副文本

```ts
mainText        = current?.text || state.title || "暂无歌词"
subText         = settings.desktopLyricsShowNext
                  && next?.text && next.text !== mainText
                  ? "下一句 · " + next.text : ""
translationText = settings.desktopLyricsShowTranslation
                  && current?.translation && current.translation !== mainText
                  ? current.translation : ""
```

渲染结构：`Transition`（`:name="'dl-' + settings.desktopLyricsAnimation"`，`mode="out-in"`）包裹 `div.line-stack`（`:key="currentIndex"`），内含 `.line.current` 与（可选）`.line.translation`；`.line.next` 在 Transition **之外**（不参与切换动画）。

### 6.3 四种过渡动画

设 `--fast = var(--md-sys-motion-spring-effects-fast)`（M3 令牌）；控制条用 `--md-sys-motion-spring-spatial-fast`。

**1. `fade`（默认）**
```css
.dl-fade-enter-active, .dl-fade-leave-active { transition: opacity 300ms var(--fast); }
.dl-fade-enter-from, .dl-fade-leave-to { opacity: 0; }
```

**2. `slide`**
```css
.dl-slide-enter-active, .dl-slide-leave-active {
  transition: opacity 320ms var(--fast), transform 320ms cubic-bezier(0.22, 1, 0.36, 1); }
.dl-slide-enter-from { opacity: 0; transform: translateY(18px); }
.dl-slide-leave-to   { opacity: 0; transform: translateY(-14px); }
```

**3. `scale`**
```css
.dl-scale-enter-active, .dl-scale-leave-active {
  transition: opacity 280ms var(--fast), transform 280ms cubic-bezier(0.34, 1.4, 0.64, 1); }
.dl-scale-enter-from { opacity: 0; transform: scale(0.9); }
.dl-scale-leave-to   { opacity: 0; transform: scale(1.06); }
```

**4. `glow`（模糊浮现）**
```css
.dl-glow-enter-active, .dl-glow-leave-active {
  transition: opacity 360ms var(--fast), filter 360ms var(--fast),
              transform 360ms cubic-bezier(0.22, 1, 0.36, 1); }
.dl-glow-enter-from { opacity: 0; filter: blur(8px);  transform: translateY(8px); }
.dl-glow-leave-to   { opacity: 0; filter: blur(10px); }
```

**控制条出现/消失**（独立 Transition `dl-bar`）：
```css
.dl-bar-enter-active, .dl-bar-leave-active {
  transition: opacity 200ms var(--fast), transform 220ms var(--md-sys-motion-spring-spatial-fast); }
.dl-bar-enter-from, .dl-bar-leave-to { opacity: 0; transform: translateY(-6px); }
```

### 6.4 样式与交互

**根容器** `.desktop-lyrics`：`position: fixed; inset: 0; flex column; align-items/justify-content: center; gap: 6px; padding: 8px 12px; color: #fff; text-shadow: 0 1px 8px rgba(0,0,0,0.55); overflow: hidden; transition: box-shadow 200ms var(--fast);`；`font-size = settings.desktopLyricsFontSize px`；`opacity = settings.desktopLyricsOpacity / 100`。

**锁定 / 拖动**：`.desktop-lyrics:not(.locked) { -webkit-app-region: drag; }`，控制条内 `no-drag`。

**工具栏可见态**：`.toolbar-visible` 加 `box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15), 0 0 24px rgba(0,0,0,0.25)`，并用 `::after` 在底部画 18px 高 `linear-gradient(to top, rgba(0,0,0,0.2), transparent)`（`pointer-events: none`）。同时 `.lyrics-main` 的 `padding-top` 从 0 → **34px**（`transition: padding-top 180ms var(--fast)`），给控制条让位。

**文本行**：`.line { margin: 0; line-height: 1.3; text-align: center; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }`
- `.line.current`：`font-weight: 700; background: rgba(0,0,0,0.25); padding: 2px 16px; border-radius: 999px;`
- `.line.translation`：`font-size: 0.62em; opacity: 0.82; font-weight: 500;`
- `.line.next`：`font-size: 0.6em; opacity: 0.55; font-weight: 500;`
- `.line-stack`：`flex column; align-items: center; gap: 2px; max-width: 100%; min-width: 0;`

**控制条**：`position: absolute; top: 6px; right: 8px; left: 8px;`（高约 36px = `padding: 4px 6px` + 28px 按钮），`border-radius: 999px; background: rgba(20,20,24,0.72); backdrop-filter: blur(8px); box-shadow: 0 4px 16px rgba(0,0,0,0.35); z-index: 2;`
- `.meta`：`font-size: 12px; opacity: 0.75; max-width: 220px; ellipsis;`，内容 `title` + （有歌手时）`" · " + artist`，无标题显示 `"—"`。
- `.ctr`：28×28 圆形按钮，透明背景，hover `rgba(255,255,255,0.18)`。
- `.ctr.play`：`background: rgba(255,255,255,0.92); color: #000;`
- `.ctr.close:hover`：`background: rgba(255,80,80,0.85);`
