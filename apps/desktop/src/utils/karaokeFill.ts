/**
 * 逐字填充进度计算（桌面歌词用）。
 *
 * ## 为什么需要单独一个纯函数
 *
 * 桌面歌词窗口是**独立窗口**，它拿不到 player store，只有主窗口 200ms 推一次
 * 的 `currentTime`。若直接用那个值做填充，进度会以 5Hz 一跳一跳地走。
 * 正确做法是窗口内部用 rAF 自走一个本地时钟（见 DesktopLyrics.vue），
 * 每次收到推送再校准 —— 于是「给定时间算填充比例」就成了一个纯函数，
 * 抽出来单测能覆盖空隙、越界、无逐字时间轴等所有分支。
 *
 * ## 为什么按「字符位置」而不是「词序号」填充
 *
 * 逐字时间轴的单位是词（一个字或一个词），长度不等。若按词序号推进，
 * 遇到长词会突然跳一大格；按字符位置线性插值，长词与短词的填充速度
 * 才与视觉宽度一致，看起来才像「扫过去」。
 */

/** 词级时间轴单位（与 DesktopLyricUnit 一致） */
export interface FillUnit {
  start: number;
  end: number;
}

/** 参与填充的歌词行（只需要时间轴与文本长度） */
export interface FillLine {
  /** 行起始时间（秒） */
  time: number;
  /** 行文本（用于数出字符数） */
  text: string;
  /** 词级时间轴；无则整行按行起止时间匀速填充 */
  units?: FillUnit[];
}

/**
 * 计算某一行在给定时间的填充比例（0 = 未开始，1 = 已唱完）。
 *
 * - 行尚未开始 → 0
 * - 行已结束 → 1
 * - 有词级时间轴 → 按字符位置插值（词与词之间的空隙停在上一词末尾）
 * - 无词级时间轴 → 在 [行起始, 行结束] 区间内匀速
 *
 * @param line     目标行
 * @param nextTime 下一行的起始时间（秒），用于在无词级时间轴时确定行结束；
 *                 末行传 `undefined`，此时按文本长度估一个时长
 * @param time     当前播放时间（秒）
 */
export function computeLineFill(
  line: FillLine,
  nextTime: number | undefined,
  time: number,
): number {
  const start = line.time;
  const end = resolveLineEnd(line, nextTime);

  // 行还没开始（可能因为 seek 或时间轴回退）
  if (time <= start) return 0;
  if (time >= end) return 1;

  const units = line.units;
  if (!units || units.length === 0) {
    // 无逐字时间轴：整行匀速
    const span = end - start;
    return span <= 0 ? 1 : clamp01((time - start) / span);
  }

  // 按字符位置插值：先把每个词映射到它在整行里的字符区间
  const totalChars = countChars(line.text);
  if (totalChars <= 0) return 0;

  // 词的时间轴可能不覆盖整行（例如行尾还有没标注的字），
  // 因此用「已消耗的字符数」而不是「第几个词」来定位。
  const charSpans = buildCharSpans(line.text, units);

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const span = charSpans[i];
    if (time < u.start) {
      // 落在上一个词结束与当前词开始之间的空隙：停在上一词的字符位置
      return clamp01(span.start / totalChars);
    }
    if (time < u.end) {
      const unitSpan = u.end - u.start;
      const ratio = unitSpan <= 0 ? 1 : (time - u.start) / unitSpan;
      const charPos = span.start + (span.end - span.start) * ratio;
      return clamp01(charPos / totalChars);
    }
  }

  // 时间已过最后一个词：若行还没结束，停在行尾（最后一个词的字符位置）
  const last = charSpans[charSpans.length - 1];
  return clamp01(last.end / totalChars);
}

/**
 * 行结束时间：优先下一行起点；末行按文本长度估一个时长。
 *
 * 估算口径与 lyricTimeline 的粗排保持一致（每字 0.4s，最少 2s），
 * 这样桌面歌词与主界面的行切换时机不会打架。
 */
export function resolveLineEnd(line: FillLine, nextTime: number | undefined): number {
  if (nextTime !== undefined && nextTime > line.time) return nextTime;
  const units = line.units;
  if (units && units.length > 0) return units[units.length - 1].end;
  return line.time + Math.max(2, countChars(line.text) * 0.4);
}

/** 每个词在整行文本里占据的字符区间 [start, end) */
function buildCharSpans(text: string, units: FillUnit[]): Array<{ start: number; end: number }> {
  const chars = splitChars(text);
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  for (let i = 0; i < units.length; i++) {
    const remainingUnits = units.length - i;
    const remainingChars = chars.length - cursor;
    // 均匀分配剩余字符给剩余词；这样即使 units 数量与字符数不一致
    // （例如英文按词切分）也不会越界，且整体覆盖整行。
    const take = remainingUnits <= 1 ? remainingChars : Math.round(remainingChars / remainingUnits);
    const size = Math.max(1, Math.min(take, remainingChars));
    spans.push({ start: cursor, end: cursor + size });
    cursor += size;
  }
  return spans;
}

/**
 * 数「视觉字符数」。
 *
 * 用 Array.from 而不是 .length：后者对 emoji / 部分生僻字会把一个字符算成
 * 两个代理项，导致填充比例算错（歌词里 emoji 并不罕见）。
 */
export function countChars(text: string): number {
  return splitChars(text).length;
}

function splitChars(text: string): string[] {
  return Array.from(text);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
