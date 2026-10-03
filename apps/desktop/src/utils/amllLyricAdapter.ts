/**
 * 项目歌词模型 → AMLL `LyricLine` 的转换。
 *
 * 项目里歌词是「一行一个起始时间 + 可选逐字 units + 可选一条和声子行」的扁平模型；
 * AMLL 的 `DomLyricPlayer` 要的是「行数组 + words 时间轴（毫秒）」，且把和声当作
 * **独立的 isBG 行**插在主行之后。两者语义一致，只是排布与单位不同，这里做无损搬运。
 *
 * 几个必须处理的差异：
 * - **单位**：项目用秒，AMLL 用毫秒。AMLL 会对非有限 / 负值 / start>end 的时间戳抛错，
 *   所以这里统一清洗，坏数据退化成整行一个词元而不是让整个播放器崩掉。
 * - **间奏三点**：项目把前奏/间奏做成真实行（`instrumental: true` 的「•••」），而 AMLL
 *   有自己的 InterludeDots，按「上一行结束到下一行开始」的纯停顿自动生成。所以这里
 *   **丢弃**项目的三点行，把这段空白交回 AMLL 推导（AMLL 的阈值是 7s）。
 * - **下标**：丢掉三点行、插入和声行之后，AMLL 的行下标与项目下标不再一一对应。
 *   点击跳转必须走 `indexMap`，否则会跳错行。
 */
import type {
  LyricLine as AmllLyricLine,
  LyricWord as AmllLyricWord,
} from "@applemusic-like-lyrics/core";
import type { BgVocal, LyricLine, WordUnit } from "@shared/types";
import type { LyricSubMode } from "@/stores/settings";

/** 转换选项 */
export interface AmllAdapterOptions {
  /**
   * 是否保留逐字时间轴。关闭时每行压成单个整行词元，
   * AMLL 会走「非逐词」渲染（整行渐变淡入），与项目的「逐字歌词」开关语义一致。
   */
  wordLevel?: boolean;
  /**
   * 副行显示模式：none 只显示原文、translation 只给翻译、romaji 只给音译。
   *
   * AMLL 会把 translatedLyric 与 romanLyric **同时**渲染成两行副行；
   * 项目惯用的是一次只显示一条（与自研视图一致），所以这里按模式只填其中一条，
   * none 则两条都留空 = 只显示原文。
   */
  subMode?: LyricSubMode;
}

/** 转换结果：AMLL 歌词行 + 「AMLL 行下标 → 项目行下标」映射 */
export interface AmllLyricBundle {
  lines: AmllLyricLine[];
  /** `indexMap[amllLineIndex]` = 该行对应的项目歌词下标（和声行归属其主行） */
  indexMap: number[];
}

/** 秒 → 毫秒：非有限值判废，负值归零，end 不早于 start */
function toMs(startSec: number, endSec: number): [number, number] | null {
  const rawStart = startSec * 1000;
  const rawEnd = endSec * 1000;
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
  const start = Math.max(0, Math.round(rawStart));
  return [start, Math.max(start, Math.round(rawEnd))];
}

/** 词元数组 → AMLL words；全空时退回「整行一个词元」 */
function toWords(
  units: WordUnit[] | undefined | null,
  fallbackText: string,
  fallbackStartSec: number,
  fallbackEndSec: number,
): AmllLyricWord[] {
  const words: AmllLyricWord[] = [];
  for (const unit of units ?? []) {
    const range = toMs(unit.start, unit.end);
    if (!range) continue;
    const word: AmllLyricWord = {
      word: unit.text,
      startTime: range[0],
      endTime: range[1],
    };
    if (unit.obscene) word.obscene = true;
    words.push(word);
  }
  if (words.length) return words;

  const range = toMs(fallbackStartSec, fallbackEndSec) ?? [0, 1];
  return [{ word: fallbackText || " ", startTime: range[0], endTime: range[1] }];
}

/** 由 words 求行的起止（毫秒） */
function boundsOf(words: AmllLyricWord[]): [number, number] {
  const first = words[0];
  const last = words[words.length - 1];
  const start = first.startTime;
  return [start, Math.max(start, last.endTime)];
}

/** 相邻真实歌词行的起点作为兜底行尾（秒）；末行按字数估算，至少 50ms */
function estimatedEnd(line: LyricLine, nextStartSec: number | undefined): number {
  const next = nextStartSec ?? line.time + Math.max(0.05, (line.text?.length ?? 1) * 0.3);
  return Math.max(line.time + 0.05, next);
}

/** 和声子行 → AMLL 的 isBG 行（取自己的逐字时间轴，没有就跟随主行区间） */
function bgToAmllLine(
  bg: BgVocal,
  lineTimeSec: number,
  lineEndSec: number,
  wordLevel: boolean,
  subMode: LyricSubMode,
): AmllLyricLine {
  const ownStart = bg.units?.[0]?.start ?? lineTimeSec;
  const ownEnd = bg.units?.length ? bg.units[bg.units.length - 1].end : lineEndSec;
  const units = wordLevel ? bg.units : undefined;
  const words = toWords(units, bg.text, ownStart, Math.max(ownStart + 0.05, ownEnd));
  const [startTime, endTime] = boundsOf(words);
  return {
    words,
    // 与主行同口径：副行二选一
    translatedLyric: subMode === "translation" ? (bg.translation ?? "") : "",
    romanLyric: subMode === "romaji" ? (bg.romaji ?? "") : "",
    startTime,
    endTime,
    isBG: true,
    isDuet: false,
  };
}

/**
 * 把项目歌词转成 AMLL 歌词行，并给出下标映射。
 *
 * 遮蔽（obscene）不在这里做：store 里已经按设置遮好了文本，AMLL 侧要关掉自己的遮蔽，
 * 否则会被二次遮蔽。
 */
export function toAmllLyricBundle(
  lines: LyricLine[],
  options: AmllAdapterOptions = {},
): AmllLyricBundle {
  const wordLevel = options.wordLevel ?? true;
  const subMode: LyricSubMode = options.subMode ?? "translation";
  const out: AmllLyricLine[] = [];
  const indexMap: number[] = [];

  /** 真实歌词行下标（间奏三点不算），用于求「下一行起始」 */
  const realIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) if (!lines[i].instrumental) realIndexes.push(i);
  const nextStart = new Map<number, number>();
  for (let k = 0; k < realIndexes.length; k++) {
    const nextIdx = realIndexes[k + 1];
    if (nextIdx !== undefined) nextStart.set(realIndexes[k], lines[nextIdx].time);
  }

  for (const index of realIndexes) {
    const line = lines[index];
    const endSec = estimatedEnd(line, nextStart.get(index));
    const units = wordLevel ? line.units : undefined;
    const words = toWords(units, line.text, line.time, endSec);
    const [startTime, endTime] = boundsOf(words);

    out.push({
      words,
      // 副行二选一：AMLL 会把两条都渲染出来，项目惯用一次只显示一条
      translatedLyric: subMode === "translation" ? (line.translation ?? "") : "",
      romanLyric: subMode === "romaji" ? (line.romaji ?? "") : "",
      startTime,
      endTime,
      isBG: false,
      isDuet: line.duet ?? false,
    });
    indexMap.push(index);

    // AMLL 的和声行必须紧跟其主行（每个主行最多一条）
    if (line.bg?.text) {
      out.push(bgToAmllLine(line.bg, line.time, endSec, wordLevel, subMode));
      indexMap.push(index);
    }
  }

  return { lines: out, indexMap };
}

/** 只要歌词行、不关心映射时的便捷封装 */
export function toAmllLyricLines(
  lines: LyricLine[],
  options: AmllAdapterOptions = {},
): AmllLyricLine[] {
  return toAmllLyricBundle(lines, options).lines;
}
