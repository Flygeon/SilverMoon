/**
 * AMLL TTML DB 歌词源（amll-dev/amll-ttml-db）。
 *
 * 数据源（官方文档 README「歌词库使用方式 → 接入到其他项目」）：
 *   - 索引：`metadata/raw-lyrics-index.jsonl`，每行
 *     `{"metadata":[["musicName",["..."]],["artists",[...]],["ncmMusicId",[...]],...],"rawLyricFile":"<时间戳>-<作者>-<随机>.ttml"}`
 *   - 歌词：`raw-lyrics/<rawLyricFile>`（TTML，逐字时间轴 + 翻译 + 音译 + 背景和声）
 *
 * 为什么用「索引 + raw 文件」而不是某个镜像站的搜索 API：官方文档给出的接入方式就是
 * 按文件路径取歌词；镜像站的 `/api/search-lyrics` 是站点自己的实现，随时可能变，
 * 而且每个镜像的路径各不相同。索引只有 1.6MB（jsDelivr 上 br 压缩后约 370KB），
 * 拉一次按 TTL 缓存即可，比每次搜索打一次第三方接口更稳。
 *
 * 解析实现对齐 AMLL 官方解析器（packages/ttml/src/parser.ts）的语义：
 *   - 行时间取 `<p begin>`；逐字取子 `<span begin end>`；
 *   - `ttm:role="x-translation"` / `x-roman` 分别落到翻译 / 音译；
 *   - `ttm:role="x-bg"` 是背景和声，落成 `line.bg` 子行（自己的正文 + 逐字时间轴）；
 *   - `ttm:agent` 按 ttm:type 的交替状态机推导 `line.duet`（对唱行靠右）；
 *   - `tts:ruby` 只取 base 文本，注音片段的时间作为该音节的起止；
 *   - `amll:obscene` 记到词级 `WordUnit.obscene`，由渲染层在绘制前遮蔽；
 *   - 空格规则：AMLL 规范第 6 节——span 内自带空白才保留，纯排版换行/缩进不算；
 *   - 也支持 Apple Music 写在 `<head>` 里的整行翻译（`<translation><text for="L1">`），
 *     按 `itunes:key` 关联（真实文件里有约 7% 用这种写法）。
 */
import { hasBridge } from "@/ipc/bridge";
import type { LyricLine, WordUnit } from "@shared/types";
import { TtlCache } from "./ttlCache";
// lyricMatch 是叶子模块（不 import 任何项目内文件），这里引用不会成环。
// 搜索粗筛与最终判等必须用同一套折叠规则，否则会出现「搜得到但判不过」的空转。
import { foldTitle } from "./lyricMatch";

/** TTML 命名空间（与 AMLL packages/ttml/src/constants.ts 一致） */
const NS_TTM = "http://www.w3.org/ns/ttml#metadata";
const NS_ITUNES = "http://music.apple.com/lyric-ttml-internal";
const NS_TTS = "http://www.w3.org/ns/ttml#styling";
/** AMLL 私有扩展命名空间（amll:obscene / amll:empty-beat / amll:meta 都挂在这里） */
const NS_AMLL = "http://www.example.com/ns/amll";

/** 默认基地址：AMLL 官方仓库的 jsDelivr 镜像（带 CORS、有 br 压缩） */
export const AMLL_DEFAULT_BASE = "https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main";

/** 索引有效期：社区库更新不频繁，1 小时足够；失败 10 分钟内不重试 */
const INDEX_TTL_MS = 60 * 60 * 1000;
/** 单次搜索最多返回的候选数（与 QQ/酷狗源保持一致的数量级） */
export const AMLL_MAX_CANDIDATES = 5;

/** 索引里的一条歌词（只保留匹配与取词需要的字段） */
export interface AmllTtmlSong {
  /** 索引里的主 id（通常是某个平台的音乐 id） */
  id: string;
  /** 各平台的音乐 id（索引里同一条歌词可能对应多个平台的同一首歌） */
  ncmIds: string[];
  qqIds: string[];
  /** 歌名（索引里可能给出多个别名） */
  title: string;
  titles: string[];
  artists: string[];
  /** Apple Music 曲目 id（索引里 2116/3291 条有，用于跨平台精确点名） */
  appleMusicIds: string[];
  /** Spotify 曲目 id（2069/3291 条有） */
  spotifyIds: string[];
  /** ISRC（2112/3291 条有），跨平台通用的录音唯一标识 */
  isrcs: string[];
  /** raw-lyrics 目录下的文件名 */
  rawFile: string;
  /**
   * 文件名里的上传时间戳（毫秒）。索引按时间升序排列，所以它就是入库先后。
   *
   * 同名多版本时越靠后 = 越新近的投稿，通常也是维护得更好的一版；旧逻辑
   * 无条件取第一条，等于永远优先最旧的打轴。取不到时为 0（排最前）。
   */
  uploadedAt: number;
}

interface RawIndexEntry {
  metadata?: [string, string[]][];
  rawLyricFile?: string;
}

/** 从 rawLyricFile（时间戳-作者-随机.ttml）里取上传时间戳（毫秒），取不到返回 0 */
export function amllUploadedAt(rawFile: string): number {
  const m = /^(\d{10,})/.exec(rawFile);
  if (!m) return 0;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 已解析的索引（进程内缓存）。
 *
 * 与歌词文件缓存一样按**基地址**分桶：用户把镜像换掉之后，旧镜像的索引不能再命中，
 * 否则会拿着旧 rawFile 去新镜像下载（多数会 404）。
 */
const indexCache = new Map<string, { at: number; songs: AmllTtmlSong[] }>();
/** 在途去重：并发搜索只下一次索引（同样按基地址分桶，否则换镜像时会复用旧镜像的在途请求） */
const indexInflight = new Map<string, Promise<AmllTtmlSong[]>>();

/**
 * 歌词文件缓存：rawFile → 解析结果（成功 6h / 失败 10min）。
 *
 * 与旧版的区别：**缓存里带上原始 TTML 文本与估出的曲长**。
 *
 * 1. 估时长（body dur / 最后一个 p end）以前要再解析一次 DOM；版本比对时每个候选都要
 *    算一次时长，缓存文本能让「同一首歌反复播放」不再重复下载同样的大小。
 * 2. `lines === null` 表示「下载成功但解析不出歌词行」，与「下载失败」区分开：
 *    前者没必要重试，后者要继续试下一个候选。
 */
interface AmllLyricPayload {
  /** 解析好的歌词行；null = 文件能下下来但没有可用歌词 */
  lines: LyricLine[] | null;
  /** 原始 TTML 文本（用于 amllTtmlDurationMs 估曲长），下载失败时为 null */
  ttml: string | null;
  /** 估算曲长（毫秒），0 = 估不出来（调用方据此跳过时长校验） */
  durationMs: number;
}
const lyricCache = new TtlCache<AmllLyricPayload>("amll-ttml", {
  ttlMs: 10 * 60 * 1000,
  okTtlMs: 6 * 60 * 60 * 1000,
  isOk: (p) => !!p.lines?.length,
  maxEntries: 256,
});

/** 归一化基地址：去掉结尾斜杠，空值回退默认地址 */
export function amllNormalizeBase(base?: string): string {
  const s = (base ?? "").trim();
  if (!s) return AMLL_DEFAULT_BASE;
  return s.replace(/\/+$/, "");
}

/** 桌面端走宿主网络栈（绕 CORS）；浏览器预览退回原生 fetch（jsDelivr 带 CORS，可直连） */
async function amllFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (hasBridge()) {
    const { fetch: hostFetch } = await import("@/ipc/http");
    return hostFetch(url, init);
  }
  return fetch(url, init);
}

/** 索引条目 → AmllTtmlSong */
function songFromEntry(entry: RawIndexEntry): AmllTtmlSong | null {
  const raw = (entry.rawLyricFile ?? "").trim();
  if (!raw) return null;
  const md = new Map<string, string[]>();
  for (const [key, values] of entry.metadata ?? []) {
    const list = Array.isArray(values) ? values : [];
    md.set(key, [...(md.get(key) ?? []), ...list.map((v) => String(v))]);
  }
  const titles = (md.get("musicName") ?? []).filter(Boolean);
  const artists = (md.get("artists") ?? []).filter(Boolean);
  const ncmIds = (md.get("ncmMusicId") ?? []).filter(Boolean);
  const qqIds = (md.get("qqMusicId") ?? []).filter(Boolean);
  const appleMusicIds = (md.get("appleMusicId") ?? []).filter(Boolean);
  const spotifyIds = (md.get("spotifyId") ?? []).filter(Boolean);
  const isrcs = (md.get("isrc") ?? []).filter(Boolean);
  return {
    id: ncmIds[0] ?? qqIds[0] ?? raw,
    ncmIds,
    qqIds,
    title: titles[0] ?? "",
    titles,
    artists,
    appleMusicIds,
    spotifyIds,
    isrcs,
    rawFile: raw,
    uploadedAt: amllUploadedAt(raw),
  };
}

/**
 * 拉取并解析索引（进程内 TTL 缓存 + 在途去重）。
 *
 * 索引是「一行一条」的 JSONL：整体 parse 后常驻内存，之后每次搜索都是纯内存过滤。
 * 失败时清掉在途状态，让下一次调用能重试（不要把一个瞬时网络错误钉成一小时的不可用）。
 */
export async function amllLoadIndex(base?: string): Promise<AmllTtmlSong[]> {
  const root = amllNormalizeBase(base);
  const now = Date.now();
  const hit = indexCache.get(root);
  if (hit && hit.at + INDEX_TTL_MS > now) return hit.songs;
  const pending = indexInflight.get(root);
  if (pending) return pending;
  const task = (async () => {
    const res = await amllFetch(`${root}/metadata/raw-lyrics-index.jsonl`);
    if (!res.ok) throw new Error(`AMLL 歌词索引下载失败：HTTP ${res.status}`);
    const text = await res.text();
    const songs: AmllTtmlSong[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const song = songFromEntry(JSON.parse(trimmed) as RawIndexEntry);
        if (song) songs.push(song);
      } catch {
        // 单行坏数据不该让整份索引不可用：跳过并继续
      }
    }
    if (!songs.length) throw new Error("AMLL 歌词索引为空或格式异常");
    indexCache.set(root, { at: Date.now(), songs });
    return songs;
  })().finally(() => {
    indexInflight.delete(root);
  });
  indexInflight.set(root, task);
  return task;
}

/** 清空索引与歌词缓存（换基地址 / 手动刷新用） */
export function amllClearCache(): void {
  indexCache.clear();
  lyricCache.clear();
}

/** 粗筛最多返回的候选数：只做相关度截断，精确判等由调用方完成 */
export const AMLL_SEARCH_MAX = 200;

/**
 * 粗筛用的「折叠」比较键。
 *
 * 直接复用 `lyricMatch.foldTitle`，保证搜索层与判分层对「什么算同一个写法」的口径
 * 完全一致：小写 + 全角转半角 + 去掉所有空白与标点。
 *
 * 为什么要多这一档：includes 只处理「子串」关系，而真实歌名里的写法差异极大
 * （索引里的 world.execute (me) ; vs 本地常写的 world.execute(me);、全角的 Ｉｄｏｌ
 * vs Idol、Apple Music 的 ME! vs 大家写的 ME、日文名里的中点与波浪线等）。
 * 折叠掉之后这些差异归零，能救回一批「明明有歌词却搜不到」的歌。
 *
 * 它会把 A-B 与 AB 视作同一个词，所以只用于**粗筛**；最终判等仍要过 preciseLyrics
 * 的标题 + 艺人相似度评分，不能拿它当判等结果。
 */
export const amllFoldTitle = foldTitle;

/**
 * 把查询词展开成「原文」与「折叠」两组。
 *
 * 调用方会同时传「原始标题」和「剥掉括注的标题」两种变体：有些歌名**本身整体被括号
 * 包住**（索引里就有 （……醉鬼阿Q）（feat. 孙燕姿）），剥完变成空串，只用剥离后的
 * 关键词搜索会一条都搜不到。
 */
function keywordForms(keyword: string | string[]): { raw: string[]; folded: string[] } {
  const list = (Array.isArray(keyword) ? keyword : [keyword])
    .map((k) => (k ?? "").trim().toLowerCase())
    .filter(Boolean);
  const raw: string[] = [];
  const folded: string[] = [];
  for (const k of list) {
    if (!raw.includes(k)) raw.push(k);
    const f = amllFoldTitle(k);
    if (f && !folded.includes(f)) folded.push(f);
  }
  return { raw, folded };
}

/** 单条候选的粗筛得分（0 = 与关键词无关）。分档保证「精确 > 前缀 > 包含」。 */
function roughScore(titles: string[], raw: string[], folded: string[]): number {
  let best = 0;
  for (const t of titles) {
    const lower = t.trim().toLowerCase();
    if (!lower) continue;
    const f = amllFoldTitle(t);
    for (const w of raw) {
      if (lower === w) best = Math.max(best, 300);
      else if (lower.startsWith(w)) best = Math.max(best, 180);
      else if (lower.includes(w)) best = Math.max(best, 90);
    }
    for (const w of folded) {
      if (f === w) best = Math.max(best, 240);
      else if (f.startsWith(w)) best = Math.max(best, 140);
      else if (f.includes(w)) best = Math.max(best, 60);
      // 反向包含：本地标签带了索引里没有的后缀（最典型的是「偶像【MV】」对「偶像」）。
      // 旧实现只做「索引名包含关键词」，这类本地命名一条都搜不到。
      else if (w.includes(f) && f.length >= 2) best = Math.max(best, 45);
    }
    if (best >= 300) break; // 已命中最高档，不必再看别名
  }
  return best;
}

/**
 * 按歌名搜索 AMLL TTML DB（粗筛）。
 *
 * 与旧实现的区别：
 * 1. 支持同时传多个关键词变体（原文 / 剥括注后的标题），任一命中即可；
 * 2. 多一档「折叠」比较（忽略空白与标点），救回标点写法不同的歌名；
 * 3. 结果按**相关度**排序后再截断。旧实现按索引顺序收满 200 条就 break
 *    （长歌名会把短关键词的精确同名条目挤出候选），现在截断掉的只会是最不相关的。
 *
 * 判等与最终选择仍交给调用方（preciseLyrics 做标题 + 艺人评分），
 * 这里只负责别把该有的候选漏掉。
 */
export async function amllSearchSongs(
  keyword: string | string[],
  base?: string,
): Promise<AmllTtmlSong[]> {
  const { raw, folded } = keywordForms(keyword);
  if (!raw.length && !folded.length) return [];
  const songs = await amllLoadIndex(base);
  const scored: { song: AmllTtmlSong; score: number }[] = [];
  for (const s of songs) {
    const titles = s.titles.length ? s.titles : [s.title];
    const score = roughScore(titles, raw, folded);
    if (score > 0) scored.push({ song: s, score });
  }
  // 同分时新投稿优先：旧实现等于「最旧的打轴优先」，这里只在相关度相同时才用时间做次级排序
  scored.sort((a, b) => b.score - a.score || b.song.uploadedAt - a.song.uploadedAt);
  return scored.slice(0, AMLL_SEARCH_MAX).map((x) => x.song);
}

// ------------------------------------------------------------------ TTML 解析

/** 解析 `00:01.500` / `1:02.25` / `1.5s` / `12` 等 TTML 时间写法，返回毫秒 */
export function parseAmllTime(raw: string | null | undefined): number {
  const s = (raw ?? "").trim();
  if (!s) return 0;
  if (s.endsWith("s")) {
    const sec = Number(s.slice(0, -1));
    return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
  }
  const parts = s.split(":");
  if (parts.length === 1) {
    const sec = Number(parts[0]);
    return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
  }
  const seconds = Number(parts[parts.length - 1]);
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length > 2 ? Number(parts[parts.length - 3]) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

/** 命名空间 → 标签前缀（本项目只用到这三个） */
const PREFIX: Record<string, string> = {
  [NS_TTM]: "ttm",
  [NS_ITUNES]: "itunes",
  [NS_TTS]: "tts",
  [NS_AMLL]: "amll",
  xml: "xml",
};

/**
 * 取属性：先按限定名（`ttm:role`）取，再按本地名（`role`）兜底。
 *
 * 两种写法在真实文件里都出现过：规范要求限定名，但手写 / 转换过的文件常只剩本地名（jsdom 的 getAttribute 对
 * 限定名是按字面量匹配的，不会自动按命名空间解析）。
 */
function attr(el: Element, ns: string, name: string): string | null {
  const prefix = PREFIX[ns];
  if (prefix) {
    const byQualified = el.getAttribute(`${prefix}:${name}`);
    if (byQualified !== null) return byQualified;
  }
  return el.getAttribute(name);
}

function roleOf(el: Element): string {
  return attr(el, NS_TTM, "role") ?? "";
}

function itunesKeyOf(el: Element): string {
  return attr(el, NS_ITUNES, "key") ?? "";
}

/** 纯排版空白（含换行）不算歌词内容，也不代表词间空格 */
function isFormattingWhitespace(raw: string): boolean {
  return raw.includes("\n") && raw.trim() === "";
}

/**
 * ruby（注音 / 振假名）容器判定：AMLL 规范用 `tts:ruby="container"` 包住 base + textContainer。
 *
 * 本项目没有注音栏位，只取 base 文本（唱的是 base，注音只是读音提示）。如果照常把
 * textContainer 里的注音当普通 span 处理，它就会混进正文与 units，屏幕上变成
 * 「これは 所 しょ 詮 せ ん」这种读起来莫名其妙的样子（AMLL 官方解析器同样只取 base）。
 */
function rubyAttrOf(el: Element): string {
  return attr(el, NS_TTS, "ruby") ?? "";
}

/** 从 ruby 容器里取 base 文本（取不到时退回容器全部文本，至少不丢字） */
function rubyBaseText(el: Element): string {
  for (const child of Array.from(el.getElementsByTagName("span"))) {
    if (rubyAttrOf(child) === "base") return child.textContent ?? "";
  }
  return el.textContent ?? "";
}

/**
 * ruby 容器内注音片段（`tts:ruby="text"`）覆盖的时间范围（毫秒）。
 *
 * **ruby 容器的 begin/end 通常挂在注音上、容器自身是空的**，所以不能拿容器属性当时间。
 * AMLL 的做法是取所有注音片段的 min(begin) / max(end) 作为该音节的起止；否则这个字
 * 会退回「行时间 → 行结束」，逐字填充变成「一个字亮了一整行」。
 */
function rubyTimeRange(el: Element): { startMs: number; endMs: number } | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const child of Array.from(el.getElementsByTagName("span"))) {
    if (rubyAttrOf(child) !== "text") continue;
    const b = parseAmllTime(attr(child, "xml", "begin"));
    const t = parseAmllTime(attr(child, "xml", "end"));
    if (!b && !t) continue;
    if (b && b < startMs) startMs = b;
    if (t > endMs) endMs = t;
  }
  if (startMs === Infinity && endMs === -Infinity) return null;
  return {
    startMs: startMs === Infinity ? 0 : startMs,
    endMs: endMs === -Infinity ? 0 : endMs,
  };
}

/** 不雅用语标记（`amll:obscene`）：只有字面量 "true" 才算 */
function obsceneAttrOf(el: Element): boolean {
  return attr(el, NS_AMLL, "obscene") === "true";
}

/** 去掉和声正文最外层的半角 / 全角圆括号（TTML 的书写惯例，渲染时不该显示） */
function stripBgBrackets(raw: string): string {
  return raw
    .replace(/^[(（]+/, "")
    .replace(/[)）]+$/, "")
    .trim();
}

/** 括号常被拆到相邻的 span 上：首词去前导括号、末词去尾随括号 */
function stripEdgeBracketsFromWords(words: WordToken[]): WordToken[] {
  if (!words.length) return words;
  const out = words.map((w) => ({ ...w }));
  out[0].text = out[0].text.replace(/^[(（]+/, "");
  out[out.length - 1].text = out[out.length - 1].text.replace(/[)）]+$/, "");
  return out.filter((w) => w.text.trim() !== "");
}

/** 单个词（来自 <span begin end>，含背景和声的词） */
interface WordToken {
  text: string;
  startMs: number;
  endMs: number;
  /** 不雅用语标记（amll:obscene），渲染前统一遮蔽 */
  obscene?: boolean;
}

/** 背景和声子行（x-bg）的解析中间态 */
interface BgTokens {
  text: string;
  words: WordToken[];
  translation: string;
  romaji: string;
}

/** 行的解析中间态 */
interface LineTokens {
  text: string;
  words: WordToken[];
  translation: string;
  romaji: string;
  /** 没有 span 的逐行歌词：整行一个词 */
  fallback: boolean;
  /** 背景和声子行（AMLL 的 backgroundVocal；没有就是 null） */
  bg: BgTokens | null;
}

/** 取词尾是否带空白（词间空格的唯一真相，决定 units 拼接时补不补空格） */
function endsWithSpace(word: WordToken): boolean {
  return /\s$/.test(word.text);
}

const EMPTY_LINE: LineTokens = {
  text: "",
  words: [],
  translation: "",
  romaji: "",
  fallback: false,
  bg: null,
};

/** 把词序列转成 units（≤1 个词不给 units：那样填充动画会退化成整行高亮） */
function toWordUnits(words: WordToken[], beginMs: number, endMs: number): WordUnit[] | undefined {
  if (words.length <= 1) return undefined;
  return words.map((w) => ({
    text: w.text,
    // 没有独立时间（括号 / 连接词）就挂在行首，交给渲染层按顺序填充
    start: (w.startMs || beginMs) / 1000,
    end: (w.endMs || endMs || beginMs) / 1000,
    ...(w.obscene ? { obscene: true } : {}),
  }));
}

/** 拼接词序列为整行文本（词自带空白就保留，避免英文单词粘在一起） */
function joinWords(words: WordToken[]): string {
  return words
    .map((w) => w.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析一个 `<p>` 或 `<span>` 的子节点。
 *
 * `bg` 为真表示当前处在 `ttm:role="x-bg"` 里：整段用半角括号包住追加到正文
 * （AMLL 把背景和声渲染成子行；本项目没有该栏位，包括号是最接近的等价表达）。
 */
function parseChildren(parent: Element): LineTokens {
  const state: LineTokens = { ...EMPTY_LINE, words: [] };

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const raw = node.textContent ?? "";
      if (isFormattingWhitespace(raw)) continue;
      const normalized = raw.replace(/\s+/g, " ");
      if (!normalized) continue;
      state.text += normalized;
      // 词间空格的第二种写法（真实库里很常见）：空格是**标签之间的纯文本节点**，
      // 例如 `<span>You</span> <span>said</span>`。它不属于任何词，只累加进整行文本的话
      // units 拼接就会丢掉空格，逐字渲染出来是 "Yousaid"。按 AMLL 规范第 6 节
      // （解析器的 endsWithSpace）把它挂到**前一个词**的词尾，才能既保住整行、也保住逐字。
      if (normalized.trim() === "" && state.words.length) {
        const last = state.words[state.words.length - 1];
        // 词尾已经有空白就不重复追加（写法 a：空格写在 span 内部）
        if (!endsWithSpace(last)) {
          state.words[state.words.length - 1] = { ...last, text: `${last.text} ` };
        }
      }
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const el = node as Element;
    const role = roleOf(el);

    if (role === "x-translation") {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text && !state.translation) state.translation = text;
      continue;
    }
    if (role === "x-roman") {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text && !state.romaji) state.romaji = text;
      continue;
    }
    if (role === "x-bg") {
      // 背景和声：AMLL 把它当作**独立子行**（backgroundVocal），有自己完整的逐字时间轴，
      // 挂在主行上/下方。本项目同样落成 `line.bg`，渲染层画成一条小字号子行——
      // 早先版本把它合成「正文里加括号的一个词」，结果是整段和声一次性点亮、也没有层级。
      const inner = parseChildren(el);
      const text = (inner.words.length ? joinWords(inner.words) : inner.text).trim();
      if (text) {
        // 规范要求作者自带半角括号、机器人也会补，所以这里统一剥掉，渲染时不显示括号。
        // 括号可能被拆到相邻 span 上，所以先按整段剥、再逐词剥一次。
        const words = stripEdgeBracketsFromWords(inner.words);
        state.bg ??= { text: "", words: [], translation: "", romaji: "" };
        const bg = state.bg;
        bg.text = bg.text ? `${bg.text} ${stripBgBrackets(text)}` : stripBgBrackets(text);
        bg.words.push(...words);
        // 和声自带的翻译 / 音译归和声子行，**不占主行栏位**：主行翻译可能写在 <head>
        // sidecar 里、要到后面才合并进来，这里若直接写 state.translation 会把主行挤掉。
        if (inner.translation && !bg.translation) bg.translation = inner.translation;
        if (inner.romaji && !bg.romaji) bg.romaji = inner.romaji;
      }
      continue;
    }

    // ruby（注音）容器：只取 base 文本，注音不进正文与 units（唱的是 base，注音只是读音提示）。
    // 时间取注音片段的 min/max —— 容器自身通常没有 begin/end。
    const isRubyContainer = rubyAttrOf(el) === "container";
    const rubyRange = isRubyContainer ? rubyTimeRange(el) : null;
    const begin = parseAmllTime(attr(el, "xml", "begin")) || rubyRange?.startMs || 0;
    const end = parseAmllTime(attr(el, "xml", "end")) || rubyRange?.endMs || 0;
    const raw = isRubyContainer ? rubyBaseText(el) : (el.textContent ?? "");
    const text = raw.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, (m) => (m ? " " : ""));
    if (text) {
      const obscene = obsceneAttrOf(el) ? { obscene: true } : {};
      state.text += text;
      state.words.push({ text, startMs: begin, endMs: end, ...obscene });
    }
  }

  return state;
}

/** 把中间态转成项目统一的 LyricLine（时间单位：秒） */
function toLyricLine(tokens: LineTokens, beginMs: number, endMs: number): LyricLine | null {
  const text = (tokens.fallback ? tokens.text : joinWords(tokens.words) || tokens.text).trim();
  if (!text) return null;
  const line: LyricLine = { time: beginMs / 1000, text };
  // 这里只写**主行自己**的翻译 / 音译。和声的翻译不是「兜底给主行」，而是挂在 line.bg 上，
  // 否则主行翻译（常写在 <head> sidecar 里）会被和声那句挤掉。
  if (tokens.translation) line.translation = tokens.translation;
  if (tokens.romaji) line.romaji = tokens.romaji;
  const units = toWordUnits(tokens.words, beginMs, endMs);
  if (units) line.units = units;
  // 背景和声子行：正文 + 自己的逐字时间轴（时间缺失时退回行的起止）
  const bgTokens = tokens.bg;
  const bgText = bgTokens ? stripBgBrackets(bgTokens.text) : "";
  if (bgTokens && bgText) {
    const bgUnits = toWordUnits(bgTokens.words, beginMs, endMs);
    line.bg = {
      text: bgText,
      ...(bgUnits ? { units: bgUnits } : {}),
      ...(bgTokens.translation ? { translation: bgTokens.translation } : {}),
      ...(bgTokens.romaji ? { romaji: bgTokens.romaji } : {}),
    };
  }
  return line;
}

// ---- 对唱推导（ttm:agent 交替状态机）----

/** 演唱者类型：person / group / other */
type AgentType = "person" | "group" | "other";

/**
 * 解析 head 里的 agent 表：xml:id → ttm:type。
 *
 * AMLL 约定 v1 = 非对唱、v2 = 对唱；Apple Music 还会出现 v3 / v4（各演唱者）
 * 与 v1000（合唱）。语义只在 ttm:type 上，v 编号本身不携带信息。
 */
function parseAgents(doc: Document): Map<string, AgentType> {
  const out = new Map<string, AgentType>();
  for (const el of Array.from(doc.getElementsByTagNameNS(NS_TTM, "agent"))) {
    const id = attr(el, "xml", "id");
    if (!id) continue;
    const type = (attr(el, NS_TTM, "type") ?? "person").toLowerCase();
    out.set(id, type === "group" ? "group" : type === "other" ? "other" : "person");
  }
  return out;
}

/**
 * 按 AMLL 的交替规则推导每一行是否对唱（逐行推进，必须按顺序调用）。
 *
 * 规则（packages/ttml/src/utils/amll-converter.ts:118-141）：
 * - group（合唱）恒非对唱，且**不影响**交替状态；
 * - 第一个登场的非 group 演唱者：other 判对唱，否则非对唱；
 * - 之后同一演唱者保持状态，换人则翻转。
 *
 * 注意：本函数只看 ttm:type。若文件只写了 ttm:agent="v2" 而没声明对应的 agent 元素，
 * 按 AMLL 自己的书写约定 v2 就是「对唱」，所以这里对缺声明的 v2 单独放行——
 * 比 AMLL 原实现（缺声明一律当 person）更贴合它自己的约定。
 */
export function makeDuetResolver(agents: Map<string, AgentType>) {
  let lastPersonId: string | null = null;
  let lastPersonDuet = false;
  return (agentId: string): boolean => {
    const type = agents.get(agentId) ?? (agentId === "v2" ? "other" : "person");
    if (type === "group") return false;
    if (lastPersonId === null) {
      lastPersonId = agentId;
      lastPersonDuet = type === "other";
      return lastPersonDuet;
    }
    if (lastPersonId === agentId) return lastPersonDuet;
    lastPersonId = agentId;
    lastPersonDuet = !lastPersonDuet;
    return lastPersonDuet;
  };
}

/** Apple Music 风格：<head> 里按 itunes:key 关联的整行翻译 / 音译 */
function parseHeadSidecar(doc: Document): Map<string, { translation: string; romaji: string }> {
  const out = new Map<string, { translation: string; romaji: string }>();
  const process = (containerTag: string, kind: "translation" | "romaji"): void => {
    for (const block of Array.from(doc.getElementsByTagName(containerTag))) {
      const lang = attr(block, "xml", "lang") ?? "";
      for (const text of Array.from(block.getElementsByTagName("text"))) {
        const key = text.getAttribute("for");
        if (!key) continue;
        let value = (text.textContent ?? "").replace(/\s+/g, " ").trim();
        // 逐字翻译的 text 里还有 <span>，textContent 已拼好；括号内的背景和声保留
        if (!value) continue;
        const entry = out.get(key) ?? { translation: "", romaji: "" };
        if (kind === "translation") {
          // 同一 key 可能有多种语言：优先中文，其次英文，最后兜底第一条
          const preferZh = /^zh/i.test(lang);
          const preferEn = /^en/i.test(lang);
          if (!entry.translation || preferZh || (preferEn && !/^zh/i.test(entry.translation))) {
            if (!entry.translation || preferZh || (preferEn && entry.translation !== value)) {
              entry.translation = value;
            }
          }
        } else if (!entry.romaji) {
          entry.romaji = value;
        }
        out.set(key, entry);
        value = "";
      }
    }
  };
  process("translation", "translation");
  process("transliteration", "romaji");
  return out;
}

/**
 * 解析 TTML 文本为标准 LyricLine[]。
 *
 * `host` 仅供测试注入 DOMParser（node 环境没有全局 DOMParser）。
 */
export function parseAmllTtml(ttml: string, host?: { DOMParser: typeof DOMParser }): LyricLine[] {
  const Parser = host?.DOMParser ?? (typeof DOMParser !== "undefined" ? DOMParser : undefined);
  if (!Parser) throw new Error("当前环境没有 DOMParser，无法解析 AMLL TTML");
  if (!ttml || !ttml.trim()) throw new Error("AMLL 歌词内容为空");

  const doc = new Parser().parseFromString(ttml, "application/xml");
  const failed = doc.getElementsByTagName("parsererror")[0];
  if (failed)
    throw new Error(`AMLL TTML 解析失败：${failed.textContent?.slice(0, 120) ?? "格式错误"}`);

  const sidecar = parseHeadSidecar(doc);
  const body = doc.getElementsByTagName("body")[0];
  if (!body) throw new Error("AMLL TTML 缺少 <body>");
  const bodyDurMs = parseAmllTime(body.getAttribute("dur"));

  const lines: LyricLine[] = [];
  /** 对唱交替状态机：必须按 <p> 出现顺序逐行推进 */
  const resolveDuet = makeDuetResolver(parseAgents(doc));
  /** body 直属与 div 里的 <p> 都要收（真实文件基本都包在 <div> 里） */
  const paragraphs = Array.from(doc.getElementsByTagName("p"));
  paragraphs.forEach((p, index) => {
    const tokens = parseChildren(p);
    const beginMs = parseAmllTime(attr(p, "xml", "begin"));
    // 行结束时间：p 的 end → 缺失时用最后一个词的 end → 再退到 body 的 dur
    const lastWord = tokens.words[tokens.words.length - 1];
    const endMs =
      parseAmllTime(attr(p, "xml", "end")) ||
      lastWord?.endMs ||
      (index === paragraphs.length - 1 ? bodyDurMs : beginMs);
    const line = toLyricLine(tokens, beginMs, endMs);
    if (!line) return;
    // 对唱：读 ttm:agent 并推进交替状态机（缺省按 v1 口径参与交替）
    const agentId = attr(p, NS_TTM, "agent");
    if (agentId) line.duet = resolveDuet(agentId);
    const side = sidecar.get(itunesKeyOf(p));
    if (side) {
      if (!line.translation && side.translation) line.translation = side.translation;
      if (!line.romaji && side.romaji) line.romaji = side.romaji;
    }
    lines.push(line);
  });

  if (!lines.length) throw new Error("AMLL TTML 没有任何歌词行");
  return lines;
}

/**
 * 下载并解析一条 AMLL 歌词（含原始文本与估出的曲长，供版本的时长比对使用）。
 *
 * 命中缓存直接返回；404 抛可读错误（调用方据此换下一个候选，而不是把「文件没了」
 * 当成「这首歌没有歌词」）。解析不出歌词行时不抛错，而是把 lines 置 null 缓存下来
 * ——「文件在但没内容」重试多少次都是一样的结果。
 */
export async function amllFetchLyricsDetailed(
  song: AmllTtmlSong,
  base?: string,
): Promise<AmllLyricPayload> {
  const root = amllNormalizeBase(base);
  const key = `${root}|${song.rawFile}`;
  const cached = lyricCache.get(key);
  if (cached) return cached;

  const res = await amllFetch(`${root}/raw-lyrics/${song.rawFile}`);
  if (!res.ok) throw new Error(`AMLL 歌词下载失败：HTTP ${res.status}`);
  const text = await res.text();
  let lines: LyricLine[] | null = null;
  try {
    const parsed = parseAmllTtml(text);
    lines = parsed.length ? parsed : null;
  } catch {
    // 坏文件不该让整首歌连候选都换不了：记成「无歌词」，继续看下一个候选
    lines = null;
  }
  const payload: AmllLyricPayload = { lines, ttml: text, durationMs: amllTtmlDurationMs(text) };
  lyricCache.set(key, payload);
  return payload;
}

/**
 * 下载并解析一条 AMLL 歌词，只要 LyricLine[]。
 *
 * 命中缓存直接返回；下载失败（404 / 网络）抛错，解析不出歌词返回空数组。
 */
export async function amllFetchLyrics(song: AmllTtmlSong, base?: string): Promise<LyricLine[]> {
  const payload = await amllFetchLyricsDetailed(song, base);
  return payload.lines ?? [];
}

/**
 * 从 TTML 文本里估出这首歌的时长（毫秒），用于与本地音频做「同名 + 时长接近」校验。
 *
 * 两个来源：`<body dur>`（作者标的整首时长）与所有 `<p end>` 的最大值。取两者较大值：
 * 有的文件 dur 只标到最后一行的起点，有的干脆没写 dur，取较大值更接近真实曲长。
 * 两者都没有时返回 0，调用方据此跳过时长校验（只用歌名匹配）。
 */
export function amllTtmlDurationMs(ttml: string): number {
  const m = /<body[^>]*\bdur="([^"]+)"/.exec(ttml);
  const bodyMs = m ? parseAmllTime(m[1]) : 0;
  let lastEndMs = 0;
  const re = /<p\b[^>]*\bend="([^"]+)"/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(ttml)) !== null) {
    const value = parseAmllTime(hit[1]);
    if (value > lastEndMs) lastEndMs = value;
  }
  return Math.max(bodyMs, lastEndMs);
}
