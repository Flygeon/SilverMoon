/**
 * 逐字歌词时间轴引擎。
 *
 * Phase 1 只提供「分词 + 比例粗排」：播放即用，零分析零延迟。
 * Phase 2 会把缓存里的精确时间轴 `applyPreciseTimeline` 覆盖上去（无缝替换）。
 *
 * 粗排策略：行 [start, end] 内把 N 个字均分到前 85% 时长，末尾留 ~15% 尾音停顿。
 * 行 end = 下一行 start（末行按字数估算）。纯比例，无音频分析。
 */
import type { LyricLine, WordUnit } from "@shared/types";
import { wordTagSeconds } from "./wordLevelLrc";

/**
 * 分词：CJK 每字一个单元；连续拉丁字母/数字/撇号/连字符合并为词。
 * 空格结束当前词并并入词尾（保留英文词间分隔），渲染时不会被吞掉。
 */
export function tokenizeLyric(text: string): string[] {
  let parts: string[];
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    parts = Array.from(seg.segment(text), (s) => s.segment);
  } else {
    // 降级：按码点拆
    parts = Array.from(text);
  }

  const tokens: string[] = [];
  let latin = "";
  const pushToken = (t: string) => {
    if (t) tokens.push(t);
  };
  for (const p of parts) {
    if (/[A-Za-z0-9'’’-]/.test(p)) {
      latin += p;
    } else if (/\s/.test(p)) {
      // 空格结束当前词；空格并入词尾，避免逐字渲染时词与词粘连
      if (latin) {
        latin += p;
        pushToken(latin);
        latin = "";
      } else if (tokens.length) {
        tokens[tokens.length - 1] += p;
      }
    } else {
      // CJK 单字或标点
      if (latin) {
        pushToken(latin);
        latin = "";
      }
      pushToken(p);
    }
  }
  pushToken(latin);
  return tokens;
}

/** 行内按字数比例生成粗略时间轴；end 为下一行 start */
export function buildRoughUnits(text: string, start: number, end: number): WordUnit[] {
  const tokens = tokenizeLyric(text);
  if (!tokens.length) return [];
  const total = Math.max(0.05, end - start); // 至少 50ms，防除零
  const sung = total * 0.85; // 末尾 ~15% 尾音停顿
  const step = Math.max(0.03, sung / tokens.length);
  return tokens.map((w, i) => ({
    text: w,
    start: start + i * step,
    end: i === tokens.length - 1 ? start + sung : start + (i + 1) * step,
  }));
}

/** 末行无下一行时按字数估算时长 */
function estimateLineEnd(text: string): number {
  return Math.max(2, text.length * 0.4);
}

/**
 * 为已排序的歌词行逐行附加粗排 units（就地修改）。
 * Phase 2 精确时间轴命中时，会用缓存结果覆盖这里的 units。
 */
export function attachRoughTimeline(lines: LyricLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextStart = lines[i + 1]?.time ?? line.time + estimateLineEnd(line.text);
    line.units = buildRoughUnits(line.text, line.time, nextStart);
  }
}

// ---- 前奏 / 间奏识别 ----

/** 纯停顿超过此秒数视为间奏，插入三点等待 */
const INSTRUMENTAL_THRESHOLD = 3.0;
/** 首行之前（前奏）的阈值更宽：开场就提示，短促停顿则不打扰 */
const INTRO_THRESHOLD = 1.0;
/**
 * 作词/作曲/编曲等元数据行（前奏信息，隐藏原文替换为三点）。
 * 兼容两种署名风格：完整「作词：」「作曲：」与 QQ 音乐逐字格式的「词：」「曲：」；
 * 另拦截 QQ 音乐的版权声明行（「QQ音乐享有本翻译作品的著作权」等）。
 */
export const META_RE =
  /^\s*(作词|作曲|编曲|制作人|出品人|OP|SP|监制|混音|录音|和声|母带|编曲人|制作|出品|词|曲)\s*[:：]|^QQ音乐享有本[^。]*著作权/;

/**
 * 行演唱时长估算：只把「真实演唱字符」（汉字/假名/字母/数字）按 0.3s 计，
 * 标点与空格几乎不占演唱时长，按 0.05s 计。
 * 否则感叹式短句（标点密集）会被高估演唱时长，间奏被吞进歌词时长里。
 */
function singingEstimate(text: string): number {
  let sung = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) sung++;
    else other++;
  }
  return Math.max(1.2, sung * 0.3 + other * 0.05);
}

/** 生成「三点」标记行：三个实心点逐字填充 */
function makeDotsLine(start: number, end: number): LyricLine {
  const duration = Math.max(0.3, end - start);
  const step = duration / 3;
  return {
    time: start,
    text: "•••",
    instrumental: true,
    units: [0, 1, 2].map((i) => ({
      text: "•",
      start: start + i * step,
      end: start + (i + 1) * step,
    })),
  };
}

/** 每行的 [start, end] 时间边界（秒） */
interface LineBounds {
  start: number;
  end: number;
}

/**
 * 求每行的真实时间边界。
 *
 * end 优先取**末字的结束时间**（官方逐字时间轴、以及粗排出来的 units 都覆盖行内演唱段），
 * 这比「下一行起点」准得多；没有 units 才退回下一行起点，末行按字数估算。
 * 再钳到不越过下一行起点：真实时间轴偶有标错 / 重叠，越界会吃掉后面的间奏判定。
 */
function resolveLineBounds(lines: LyricLine[], preferUnits: boolean): LineBounds[] {
  return lines.map((l, i) => {
    const nextStart = lines[i + 1]?.time;
    const gapToNext = nextStart !== undefined ? nextStart - l.time : estimateLineEnd(l.text);
    // 官方逐字时间轴：末字结束时间就是真实演唱结束点
    const lastUnitEnd = l.units?.length ? l.units[l.units.length - 1].end : 0;
    const singEnd = l.time + Math.min(gapToNext, singingEstimate(l.text));
    const raw = preferUnits && lastUnitEnd > 0 ? lastUnitEnd : singEnd;
    // 钳到不越过下一行起点：真实时间轴偶有标错 / 重叠，越界会吃掉后面的间奏判定
    let end = raw;
    if (nextStart !== undefined && end > nextStart) end = nextStart;
    if (end < l.time) end = l.time;
    return { start: l.time, end };
  });
}

/** 纯停顿区间（秒）；anchor 是区间**之前**最后一行在数组里的下标，-1 表示首行之前 */
interface InterludeSpan {
  start: number;
  end: number;
  anchor: number;
}

/**
 * 扫描纯停顿区间。
 *
 * 用「**前缀最大 end**」而不是相邻两行的间距：歌词行只保证按 start 升序，前一行的 end
 * 未必是此前所有行里最晚的 end——对唱 / 和声这类行会与主行重叠，拿相邻间距去减可能得到
 * 负数，长间奏就被漏判了（AMLL 的 calculateInterludes 就是这么扫的）。
 *
 * index -1 的那一轮落在「首行之前」，正好覆盖长前奏。
 */
function scanInterludes(
  lines: LyricLine[],
  opts: { threshold: number; preferUnits: boolean; leadingFrom: number },
): InterludeSpan[] {
  const bounds = resolveLineBounds(lines, opts.preferUnits);
  const out: InterludeSpan[] = [];
  let maxEnd = opts.leadingFrom;
  for (let i = -1; i < bounds.length - 1; i++) {
    if (i >= 0) maxEnd = Math.max(maxEnd, bounds[i].end);
    const gapStart = maxEnd;
    const gapEnd = Math.max(maxEnd, bounds[i + 1].start);
    // 首行之前是「前奏」，用更宽的阈值（1s）：长前奏要在开场就提示，短促停顿则不必
    const limit = i === -1 ? INTRO_THRESHOLD : opts.threshold;
    if (gapEnd - gapStart < limit) continue;
    // 已有三点行（instrumental）覆盖的区间不再插点：它自己就代表这段等待。
    // 注意 bounds 已把它的 units 末字算进 maxEnd，所以下一段不会被重复计入。
    if (i >= 0 && lines[i]?.instrumental) continue;
    if (lines[i + 1]?.instrumental) continue;
    out.push({ start: gapStart, end: gapEnd, anchor: i });
  }
  return out;
}

/**
 * 把停顿区间作为三点行插进歌词序列（不改动入参）。
 *
 * @param preferUnits 行结束时间优先取 units 末字（官方逐字时间轴）而非演唱估算
 * @param leadingFrom 首行之前那段停顿的起点（LRC 取元数据块起点，云端取 0）
 * @param tailEnd     整首结束时间（秒）；给定时结尾器乐段也补点
 */
function withInterludes(
  lines: LyricLine[],
  opts: { threshold: number; preferUnits: boolean; leadingFrom: number; tailEnd?: number },
): LyricLine[] {
  const spans = scanInterludes(lines, opts);
  const tailEnd = opts.tailEnd ?? 0;
  if (tailEnd > 0) {
    const last = lines[lines.length - 1];
    const bounds = resolveLineBounds(lines, opts.preferUnits);
    const singEnd = Math.max(bounds[bounds.length - 1]?.end ?? last.time, last.time);
    if (!last.instrumental && tailEnd - singEnd >= opts.threshold) {
      spans.push({ start: singEnd, end: tailEnd, anchor: lines.length - 1 });
    }
  }
  if (!spans.length) return lines.slice();

  const out: LyricLine[] = [];
  let cursor = 0;
  for (const span of spans) {
    const upTo = span.anchor + 1; // 三点要排在 anchor 行之后
    while (cursor < upTo) out.push(lines[cursor++]);
    out.push(makeDotsLine(span.start, span.end));
  }
  while (cursor < lines.length) out.push(lines[cursor++]);
  return out;
}

/**
 * 构建最终歌词序列：
 * - detectInstrumental=false：保留作词/作曲/编曲原文、不插点，仅附粗排 units
 * - detectInstrumental=true：隐藏元数据为前奏三点；长纯停顿插入间奏三点
 */
export function buildLyricSequence(rawLines: LyricLine[], detectInstrumental = true): LyricLine[] {
  if (!detectInstrumental) {
    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i];
      const nextStart = rawLines[i + 1]?.time ?? l.time + estimateLineEnd(l.text);
      l.units = buildRoughUnits(l.text, l.time, nextStart);
    }
    return rawLines;
  }

  const meta: LyricLine[] = [];
  const lyrics: LyricLine[] = [];
  for (const l of rawLines) {
    if (META_RE.test(l.text)) meta.push(l);
    else lyrics.push(l);
  }
  if (!lyrics.length) return rawLines;

  // 先给每行附粗排 units（三点行依赖它算真实演唱结束点）
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const nextStart = lyrics[i + 1]?.time ?? line.time + estimateLineEnd(line.text);
    const sing = Math.min(Math.max(0, nextStart - line.time), singingEstimate(line.text));
    line.units = buildRoughUnits(line.text, line.time, line.time + sing);
  }
  // 前奏起点：元数据块起点（隐藏作词/作曲后三点从那里开始），无元数据则从 0 起
  const leadingFrom = meta.length ? meta[0].time : 0;
  return withInterludes(lyrics, {
    threshold: INSTRUMENTAL_THRESHOLD,
    preferUnits: false,
    leadingFrom,
  });
}

/**
 * 给「已带完整时间轴」的云端歌词补间奏三点（AMLL / QQ / 酷狗 通用）。
 *
 * 这些官方时间轴里只有真实歌词行，长前奏、长间奏、结尾的器乐段都会留下大片空白；
 * 本地 LRC 那条链路本来就由 buildLyricSequence 补点，云端链路过去是直接把解析结果
 * 铺上去，于是同一首歌用云端歌词时中间会「卡住不动」。
 *
 * 与 LRC 链路共用同一套扫描（`withInterludes`），包括**首行之前的前奏**：
 * 官方 TTML 常把第一句排在半分钟后，不补点开场就是长时间静止。
 * 已有 `instrumental` 标记的行原样保留（不重复插点）。返回新数组，不改动入参。
 *
 * @param tailEnd 音频总时长（秒）；给定时结尾器乐段也补点
 */
export function insertInterludeDots(
  lines: LyricLine[],
  opts: { threshold?: number; tailEnd?: number } = {},
): LyricLine[] {
  if (!lines.length) return [];
  return withInterludes(lines, {
    threshold: opts.threshold ?? INSTRUMENTAL_THRESHOLD,
    // 云端歌词是官方逐字时间轴，用末字结束时间比演唱估算准
    preferUnits: true,
    leadingFrom: 0,
    ...(opts.tailEnd ? { tailEnd: opts.tailEnd } : {}),
  });
}

// ---- LRC 解析（从 player.ts 移入，供歌词源复用）----

/**
 * 双语 LRC 解析器
 * 支持格式：
 * 1. 同时间戳双行（如网易云/QQ音乐双语歌词）
 *    [00:12.34]Hello World
 *    [00:12.34]你好世界
 * 2. [tr:翻译] 标签
 *    [00:12.34]Hello World [tr:你好世界]
 * 3. 同行尾部括号译文（meting 歌词常见格式）
 *    [00:12.34]鉄の弾が (铁铸的子弹)
 * 4. 单语歌词（向后兼容）
 */
/**
 * LRC 时间戳：同时支持点号毫秒 [mm:ss.xx] / [mm:ss.xxx] 与冒号厘秒 [mm:ss:cc]
 * （QQ 音乐的普通 LRC 使用冒号厘秒格式，此前无法解析导致整首歌词被丢弃）。
 * 两位小数为厘秒（LRC 标准），三位为毫秒。
 */
// 分钟允许 2~3 位：formatLrcTime 对超过 99 分钟的音轨会写出 "100:00.00"，
// 只认 2 位会让这种行整条被丢弃（自己写出去的歌词自己读不回来）。
const LRC_TIME_RE = /\[(\d{2,3}):(\d{2})(?:[:.]((?:\d{2}|\d{3})))?\]/g;
const LRC_TR_RE = /\[tr:(.*?)\]/g;
/** 增强型 LRC 的词级标记 `<mm:ss.xx>`（写音乐标签时由 wordLevelLrc 生成） */
const LRC_WORD_TAG_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

/**
 * 从一行增强型 LRC 里抽出词级时间轴（`<00:12.34>原<00:12.61>谅`）。
 *
 * 词元文本 = 本标记之后到下一标记之前的字符；标记后没有文本的「收尾标记」
 *（serializeWordLevelLrc 给末词补的 end）用来给前一个词收尾。
 * 时间戳非单调（脏数据）时整体放弃，退回粗排——宁可不逐字，也不要错位高亮。
 */
function extractWordUnits(raw: string): WordUnit[] {
  const marks: { start: number; from: number; to: number }[] = [];
  LRC_WORD_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LRC_WORD_TAG_RE.exec(raw)) !== null) {
    const parsed = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/.exec(m[0]);
    if (!parsed) continue;
    marks.push({
      start: wordTagSeconds(parsed[1], parsed[2], parsed[3]),
      from: m.index,
      to: m.index + m[0].length,
    });
  }
  if (marks.length < 2) return [];

  const units: WordUnit[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const next = marks[i + 1];
    const text = raw.slice(marks[i].to, next ? next.from : raw.length).replace(/[\r\n]/g, "");
    if (!text) {
      // 收尾标记：把上一个词的 end 定到它
      if (units.length) units[units.length - 1].end = marks[i].start;
      continue;
    }
    units.push({ text, start: marks[i].start, end: next ? next.start : marks[i].start });
  }
  if (units.length < 2) return [];
  for (let i = 1; i < units.length; i += 1) {
    if (units[i].start < units[i - 1].start) return [];
  }
  return units;
}

/**
 * @param detectInstrumental 是否做前奏/间奏识别（隐藏作词作曲、插三点）
 * @param attachRoughUnits   是否给没有词级时间轴的行附**粗排** units。
 *   调用方若要用 `units.length > 1` 判断「有没有官方逐字时间轴」（例如写音乐标签
 *   决定是否写增强型 LRC），必须传 `false`——粗排 units 是渲染用的近似，
 *   留着会让「逐行 LRC」被误判成逐字，把伪时间轴固化进用户文件。
 */
export function parseLrc(
  text: string,
  detectInstrumental = true,
  attachRoughUnits = true,
): LyricLine[] {
  const lines = text.trim().split("\n");
  const map = new Map<number, LyricLine>();
  /** 词级时间轴：行时间戳(ms) → units；解析结束后覆盖粗排结果 */
  const wordTimeline = new Map<number, WordUnit[]>();

  for (const line of lines) {
    // 词级标记必须在剔除方括号之前抽——content 清洗会把 `<...>` 一并抹掉
    const words = extractWordUnits(line);
    // 提取所有时间戳
    const times: number[] = [];
    let m: RegExpExecArray | null;
    LRC_TIME_RE.lastIndex = 0;
    while ((m = LRC_TIME_RE.exec(line)) !== null) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      // 两位小数为厘秒（LRC 标准，×10 转毫秒），三位为毫秒
      const raw = m[3] ? parseInt(m[3], 10) : 0;
      const ms = m[3] ? (m[3].length === 3 ? raw : raw * 10) : 0;
      times.push(minutes * 60 + seconds + ms / 1000);
    }
    if (times.length === 0) continue;

    // 提取翻译标签 [tr:xxx]
    let translation = "";
    LRC_TR_RE.lastIndex = 0;
    const trMatch = LRC_TR_RE.exec(line);
    if (trMatch) {
      translation = trMatch[1].trim();
    }

    // 移除所有时间戳（含词级标记）和翻译标签，得到歌词文本
    let content = line
      .replace(/\[\d{2,3}:\d{2}(?:[:.]\d{2,3})?\]/g, "")
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "")
      .replace(/\[tr:.*?\]/g, "")
      .replace(/\[lang:.*?\]/g, "")
      .replace(/\[ar:.*?\]/g, "")
      .replace(/\[ti:.*?\]/g, "")
      .replace(/\[al:.*?\]/g, "")
      .replace(/\[by:.*?\]/g, "")
      .trim();

    if (!content) continue;

    // 同行尾部括号译文：如 "原文 (译文)" / "原文 （译文）"（meting 歌词常见格式）
    //
    // 三种情况**不**走这条启发式，否则会把正文当译文切掉（静默改字）：
    // 1. 已有 [tr:] 标签——译文来源明确；
    // 2. 带**词级标记**——词级时间轴是权威数据，括号就是正文的一部分
    //    （serializeWordLevelLrc 写出的 "Hello (Live)" 否则回读成 "Hello" + "Live"）；
    // 3. 同一时间戳**已有行**——这一行本身就是独立的译文行
    //    （"hello" + "你好（正式版）" 否则会被截成 "你好" + 译文 "正式版"）。
    const hasEarlierAtSameTime = times.some((time) => map.has(Math.round(time * 1000)));
    if (!translation && !words.length && !hasEarlierAtSameTime) {
      const m = content.match(/\s*[（(]([^（）()]*)[）)]\s*$/);
      if (m && content.slice(0, content.length - m[0].length).trim()) {
        translation = m[1].trim();
        content = content.slice(0, content.length - m[0].length).trim();
      }
    }

    if (!content) continue;

    for (const time of times) {
      const key = Math.round(time * 1000); // 精确到毫秒
      if (words.length && !wordTimeline.has(key)) wordTimeline.set(key, words);
      const existing = map.get(key);
      if (existing) {
        // 同一时间戳的第二行作为翻译
        if (translation) {
          existing.translation = translation;
        } else if (!existing.translation) {
          existing.translation = content;
        }
      } else {
        map.set(key, { time, text: content, translation: translation || undefined });
      }
    }
  }

  const sorted = Array.from(map.values()).sort((a, b) => a.time - b.time);
  // 前奏/间奏识别（隐藏作词/作曲/编曲，插入三点）+ 逐字粗排时间轴
  const sequence = buildLyricSequence(sorted, detectInstrumental);
  // 增强型 LRC 的官方词级时间轴覆盖粗排 units：粗排只是「播放即用」的近似，
  // 有真时间轴时必须用真的，否则逐字高亮会与歌声错开。
  //
  // `officialKeys` 收集**真正套用成功**的行时间戳。判定必须用这个集合而不是
  // `wordTimeline`：只写过词级标记、但时间轴被下面的文本一致性检查拒绝的行，
  // 其 units 仍是**粗排**，不能算官方逐字（否则 attachRoughUnits=false 会漏剥，
  // 写标签又把伪逐字写回文件）。
  const officialKeys = new Set<number>();
  for (const line of sequence) {
    const key = Math.round(line.time * 1000);
    const units = wordTimeline.get(key);
    // 只接受「词元拼起来 == 清洗后的行文本」的时间轴：尾部括号译文被剥离等
    // 情况会让两者对不上，此时宁可退回粗排，也不要让逐字宽度与整行错位。
    if (units?.length && units.map((u) => u.text).join("") === line.text) {
      line.units = units;
      officialKeys.add(key);
    }
  }
  // 不需要粗排 units 的调用方（写音乐标签）在这里统一剥掉：只留官方词级时间轴，
  // 下游用 `units.length > 1` 判断「是不是逐字」才成立。
  if (!attachRoughUnits) {
    for (const line of sequence) {
      if (!officialKeys.has(Math.round(line.time * 1000))) delete line.units;
    }
  }
  return sequence;
}

// ---- 纯音乐占位文案过滤 ----

/** 平台对无词曲目的占位文案（QQ：「此歌曲为没有填词的纯音乐，请您欣赏」等） */
const INSTRUMENTAL_PLACEHOLDER_RE =
  /^\s*(?:此歌曲为没有填词的纯音乐[^\n]*|没有填词[^\n]*|纯音乐[，,、]?\s*(?:请欣赏|请聆听)[^\n]*)\s*$/;

/**
 * 过滤纯音乐占位行；全部为占位时返回 null（视为无可用歌词）。
 * QQ / 酷狗 的逐词解析共用。
 */
export function filterInstrumentalPlaceholder(lines: LyricLine[]): LyricLine[] | null {
  const filtered = lines.filter((l) => !INSTRUMENTAL_PLACEHOLDER_RE.test(l.text));
  return filtered.length ? filtered : null;
}
