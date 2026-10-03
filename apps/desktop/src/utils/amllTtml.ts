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
 *   - `ttm:role="x-bg"` 是背景和声，AMLL 渲染成一行的子行；本项目 LyricLine 没有
 *     这一栏，所以并入正文并用半角括号包住（保留时间轴，观感与 AMLL 一致）；
 *   - 空格规则：AMLL 规范第 6 节——span 内自带空白才保留，纯排版换行/缩进不算；
 *   - 也支持 Apple Music 写在 `<head>` 里的整行翻译（`<translation><text for="L1">`），
 *     按 `itunes:key` 关联（真实文件里有约 7% 用这种写法）。
 */
import type { LyricLine, WordUnit } from "@shared/types";
import { TtlCache } from "./ttlCache";

/** TTML 命名空间（与 AMLL packages/ttml/src/constants.ts 一致） */
const NS_TTM = "http://www.w3.org/ns/ttml#metadata";
const NS_ITUNES = "http://music.apple.com/lyric-ttml-internal";

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
  /** raw-lyrics 目录下的文件名 */
  rawFile: string;
}

interface RawIndexEntry {
  metadata?: [string, string[]][];
  rawLyricFile?: string;
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

/** 歌词文件缓存：rawFile → 解析好的 LyricLine[]（成功 6h，失败 10min） */
const lyricCache = new TtlCache<LyricLine[]>("amll-ttml", {
  ttlMs: 10 * 60 * 1000,
  okTtlMs: 6 * 60 * 60 * 1000,
  isOk: (lines) => lines.length > 0,
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
  if (typeof window !== "undefined" && window.__SILVERMOON__) {
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
  return {
    id: ncmIds[0] ?? qqIds[0] ?? raw,
    ncmIds,
    qqIds,
    title: titles[0] ?? "",
    titles,
    artists,
    rawFile: raw,
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

/**
 * 按歌名搜索 AMLL TTML DB。
 *
 * 匹配规则与其它歌词源一致：只用「歌名」，判等与归一化交给调用方
 * （preciseLyrics 用 normalizeTitle 统一比较，避免这里再写一套规则跑偏）。
 */
export async function amllSearchSongs(keyword: string, base?: string): Promise<AmllTtmlSong[]> {
  const songs = await amllLoadIndex(base);
  const want = keyword.trim().toLowerCase();
  if (!want) return [];
  const out: AmllTtmlSong[] = [];
  for (const s of songs) {
    if (s.titles.some((t) => t.trim().toLowerCase().includes(want))) out.push(s);
    if (out.length >= 200) break; // 只做粗筛，精确匹配由调用方完成
  }
  return out;
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

/** 单个词（来自 <span begin end>，含背景和声的词） */
interface WordToken {
  text: string;
  startMs: number;
  endMs: number;
}

/** 行的解析中间态 */
interface LineTokens {
  text: string;
  words: WordToken[];
  translation: string;
  romaji: string;
  /** 没有 span 的逐行歌词：整行一个词 */
  fallback: boolean;
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
};

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
      // 背景和声：AMLL 渲染成主行下方的子行，本项目 LyricLine 没有该栏位，
      // 折中成「括号内容接在主行后面」，并把整段合成一个词（逐字填充仍连贯）。
      const inner = parseChildren(el);
      const bgText = (inner.words.length ? joinWords(inner.words) : inner.text).trim();
      if (bgText) {
        // 规范要求作者自带半角括号、机器人也会补，所以只在这个文件确实没写时才补，
        // 否则会出现「((和声))」这样的双层括号。
        const wrapped = bgText.startsWith("(") && bgText.endsWith(")") ? bgText : `(${bgText})`;
        const timed = inner.words.filter((w) => w.startMs > 0 || w.endMs > 0);
        const start = timed.length ? Math.min(...timed.map((w) => w.startMs)) : 0;
        const end = timed.length ? Math.max(...timed.map((w) => w.endMs)) : 0;
        state.words.push({ text: wrapped, startMs: start, endMs: end });
        state.text += wrapped;
      }
      if (!state.translation && inner.translation) state.translation = inner.translation;
      if (!state.romaji && inner.romaji) state.romaji = inner.romaji;
      continue;
    }

    // 普通词 span：有 begin/end 就是逐字，没有就把整段文字当一个词。
    // 空白折叠成单个空格但**不 trim**：英文歌词里词首/词尾的空格就是词间分隔，
    // 去掉就会让 units 拼接（.word 是 white-space:pre）粘成一片。
    const begin = parseAmllTime(attr(el, "xml", "begin"));
    const end = parseAmllTime(attr(el, "xml", "end"));
    const text = (el.textContent ?? "")
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, (m) => (m ? " " : ""));
    if (text) {
      state.text += text;
      state.words.push({ text, startMs: begin, endMs: end });
    }
  }

  return state;
}

/** 把中间态转成项目统一的 LyricLine（时间单位：秒） */
function toLyricLine(tokens: LineTokens, beginMs: number, endMs: number): LyricLine | null {
  const text = (tokens.fallback ? tokens.text : joinWords(tokens.words) || tokens.text).trim();
  if (!text) return null;
  const line: LyricLine = { time: beginMs / 1000, text };
  if (tokens.translation) line.translation = tokens.translation;
  if (tokens.romaji) line.romaji = tokens.romaji;
  // 只有「真的逐字」才有意义：一个词一行时给 units 反而让填充动画退化成整行高亮
  if (tokens.words.length > 1) {
    const units: WordUnit[] = tokens.words.map((w) => ({
      text: w.text,
      // 没有独立时间（括号 / 连接词）就挂在行首，交给渲染层按顺序填充
      start: (w.startMs || beginMs) / 1000,
      end: (w.endMs || endMs || beginMs) / 1000,
    }));
    line.units = units;
  }
  return line;
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
 * 下载并解析一条 AMLL 歌词。
 *
 * 命中缓存直接返回；404 抛可读错误（调用方据此换下一个候选，而不是把「文件没了」
 * 当成「这首歌没有歌词」）。
 */
export async function amllFetchLyrics(song: AmllTtmlSong, base?: string): Promise<LyricLine[]> {
  const root = amllNormalizeBase(base);
  const key = `${root}|${song.rawFile}`;
  const cached = lyricCache.get(key);
  if (cached) return cached;

  const res = await amllFetch(`${root}/raw-lyrics/${song.rawFile}`);
  if (!res.ok) throw new Error(`AMLL 歌词下载失败：HTTP ${res.status}`);
  const text = await res.text();
  const lines = parseAmllTtml(text);
  lyricCache.set(key, lines);
  return lines;
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
