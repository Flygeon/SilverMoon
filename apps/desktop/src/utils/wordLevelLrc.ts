/**
 * 逐字歌词的**增强型 LRC** 编解码（写音乐标签用）。
 *
 * 写标签时歌词只有一个纯文本字段（USLT / 内嵌歌词），放不下 TTML/QRC/KRC 这些
 * 富格式，因此把逐字时间轴编码成通行度最高的增强型 LRC：
 *
 * ```
 * [00:12.34]<00:12.34>原<00:12.61>谅<00:12.88>我
 * ```
 *
 * 为什么是增强型 LRC 而不是别的：
 * - 网易云 / QQ 音乐桌面版、foobar2000（Lyric Show 3）、MusicBee、AMLL 都能识别
 *   `<mm:ss.xx>` 词级时间戳，写进去**别的播放器也吃到逐字**；
 * - 不认识逐字标记的播放器会把它当普通 LRC，去掉标记后正常按行显示（优雅降级）；
 * - 我们自己的 `parseLrc`（见 utils/lyricTimeline.ts）同样识别它，写完立刻回放即逐字。
 *
 * 精度取**厘秒**（2 位小数）：这是增强型 LRC 的事实标准，第三方播放器更认；
 * 毫秒写 3 位虽然更准，但部分实现会整条忽略词级标记，得不偿失。
 */
import type { LyricLine, WordUnit } from "@shared/types";

/** 单个 `<mm:ss.xx>` 词级时间戳（毫秒部分 2~3 位都接受） */
export const WORD_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** 时间戳换算：两位小数按厘秒（×10ms），三位按毫秒，与 parseLrc 的 [..] 规则一致。 */
export function wordTagSeconds(minutes: string, seconds: string, fraction?: string): number {
  const ms = fraction ? (fraction.length === 3 ? Number(fraction) : Number(fraction) * 10) : 0;
  return Number(minutes) * 60 + Number(seconds) + ms / 1000;
}

/** 秒 → `mm:ss.xx`（厘秒，四舍五入；向零兜底到 0 秒） */
export function formatLrcTime(total: number): string {
  const safe = Number.isFinite(total) && total > 0 ? total : 0;
  // 先换算到厘秒再拆位，避免 59.996 → "00:60.00" 这种进位错误
  const centis = Math.round(safe * 100);
  const mm = String(Math.floor(centis / 6000)).padStart(2, "0");
  const ss = String(Math.floor((centis % 6000) / 100)).padStart(2, "0");
  const cc = String(centis % 100).padStart(2, "0");
  return `${mm}:${ss}.${cc}`;
}

/**
 * 一行是否带**真正的**逐字时间轴。
 *
 * 判据是「单元数 > 1」：粗排（buildRoughUnits）也会给每行塞 units，单字行只有 1 个单元，
 * 那种行用普通 LRC 表达即可，写逐字标记反而啰嗦；多字行只要有 ≥2 个单元就值得逐字写。
 */
export function hasWordUnits(line: Pick<LyricLine, "units">): boolean {
  return (line.units?.length ?? 0) > 1;
}

/** 整份歌词里是否存在任一逐字行 */
export function hasAnyWordUnits(lines: LyricLine[]): boolean {
  return lines.some((line) => hasWordUnits(line));
}

/**
 * 词元拼接是否等于行文本。
 *
 * 回读端（parseLrc）只在两者一致时套用词级时间轴；写出端用同一判据，
 * 避免产生「自己写得出去、自己读不回来」的伪逐字（如词元漏了空格）。
 */
function unitsMatchText(units: WordUnit[], text: string): boolean {
  return units.map((unit) => sanitizeWord(unit.text ?? "")).join("") === text;
}

/** 词元文本里不能出现的字符（会被解析器当成标记） */
function sanitizeWord(text: string): string {
  return text.replace(/[<>\r\n]/g, "");
}

/**
 * 把一行的逐字时间轴摊平成 `<t>词<t>词` 形式。
 *
 * 单元的 end 不单独编码：增强型 LRC 里「下一个词的起点」就是上一个词的终点，
 * 末词没有下一词时把它的 end 补一个空标记（`<end>`），这样回读能拿到正确尾音时长。
 */
function encodeUnits(units: WordUnit[]): string {
  const parts: string[] = [];
  for (const unit of units) {
    const text = sanitizeWord(unit.text ?? "");
    if (!text) continue;
    parts.push(`<${formatLrcTime(unit.start)}>${text}`);
  }
  const last = units[units.length - 1];
  if (parts.length && last && Number.isFinite(last.end) && last.end > last.start) {
    parts.push(`<${formatLrcTime(last.end)}>`);
  }
  return parts.join("");
}

/**
 * 歌词行 → 增强型 LRC 文本。
 *
 * - 有逐字时间轴（≥2 个单元）的行输出词级标记，否则退回普通 `[mm:ss.xx]行`；
 * - 翻译行紧随原文行、共用同一时间戳（`parseLrc` 会把同时间戳的第二行当翻译合并）；
 * - 间奏三点行（instrumental）按普通行写出，不带逐字标记；
 * - 全空返回空串（调用方据此提示「没有可用歌词」）。
 */
export function serializeWordLevelLrc(lines: LyricLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.instrumental) continue; // 三点是**渲染态**的占位，不该写进文件
    const text = String(line.text ?? "")
      .replace(/[\r\n]/g, " ")
      .trim();
    if (!text) continue;
    const stamp = `[${formatLrcTime(line.time)}]`;
    // 逐字只在「词元拼起来 == 行文本」时写：否则回读会因为对不上而退回粗排，
    // 写出去等于白写，不如直接按逐行写（文本永远不丢）。
    if (hasWordUnits(line) && unitsMatchText(line.units!, text)) {
      out.push(stamp + encodeUnits(line.units!));
    } else {
      out.push(stamp + text);
    }
    const translation = String(line.translation ?? "")
      .replace(/[\r\n]/g, " ")
      .trim();
    // 翻译与原文同一时间戳：回读时按「同时间戳第二行」合并回 translation
    if (translation && translation !== text) out.push(stamp + translation);
  }
  return out.join("\n");
}

/**
 * 逐字歌词是否「值得」以逐字形式写入：至少一行有真实词级时间轴。
 *
 * 咪咕 / 酷我的取词接口只有逐行时间轴，拿到的是粗排 units——那种情况下写普通 LRC
 * 更干净，也避免把「伪逐字」固化进用户文件。
 */
export function isWordLevelLyrics(lines: LyricLine[]): boolean {
  return hasAnyWordUnits(lines);
}

/**
 * 剥掉所有行上的 `units`（返回新数组，不改动入参）。
 *
 * 为什么需要它：`parseLrc` 会给每行附**粗排** units（按字数均分的近似，仅供渲染），
 * 这类 units 同样满足「≥2 个词元」，只看 units 分不出「官方逐字」与「伪逐字」。
 * 写标签前若不剥掉，逐行歌词会被序列化成增强型 LRC，把伪时间轴固化进用户文件。
 */
export function stripWordUnits(lines: LyricLine[]): LyricLine[] {
  return lines.map((line) => (line.units ? { ...line, units: undefined } : line));
}

// ---------------------------------------------------------------------------
// 网易云 yrc（逐字轨）
// ---------------------------------------------------------------------------

/**
 * 解析网易云 `yrc` 逐字轨。
 *
 * 格式与 QRC/KRC 都不同：
 *
 * ```
 * [40450,4620](40450,280,0)原(40730,260,0)谅...
 * ```
 *
 * 行首 `[行起点ms,行时长ms]`，随后每段 `(词起点ms,词时长ms,保留)` + 词文本。
 * ⚠️ **词时间是绝对毫秒**（按 KRC 的相对行首语义去读会整行错位到行首）。
 *
 * 放在本模块（而非取词编排层）是为了保持「纯函数、可单独打包验证」：
 * 编排层依赖渲染进程的网络栈，Node 验证脚本跑不动。
 */
/** 一个 yrc 词元标记：`(词起点ms,词时长ms,保留)` */
const YRC_WORD_MARK_RE = /\((\d+),(\d+),\d+\)/g;

export function parseNeteaseYrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;
    const lineStart = Number(head[1]);

    // 1) 行文本**独立**于词元提取：去掉 `[..]` 头与所有 `(a,b,c)` 标记后剩下的就是正文。
    //    这样即使某个词元里本身带括号（坏数据），也不会丢字或串行。
    const body = line.slice(head[0].length);
    const content = body.replace(/\(\d+,\d+,\d+\)/g, "");
    if (!content.trim()) continue;

    // 2) 词级时间轴：标记 + 其后到下一个标记之间的文本（best effort）
    const units: WordUnit[] = [];
    const marks: { start: number; duration: number; from: number; to: number }[] = [];
    YRC_WORD_MARK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = YRC_WORD_MARK_RE.exec(body)) !== null) {
      marks.push({
        start: Number(m[1]),
        duration: Number(m[2]),
        from: m.index,
        to: m.index + m[0].length,
      });
    }
    for (let i = 0; i < marks.length; i += 1) {
      const next = marks[i + 1];
      const word = body.slice(marks[i].to, next ? next.from : body.length);
      if (!word) continue;
      units.push({
        text: word,
        start: marks[i].start / 1000,
        end: (marks[i].start + marks[i].duration) / 1000,
      });
    }

    // 词元拼起来必须等于行文本（括号出现在词内等坏数据会让两者对不上）：
    // 此时**保文本、弃时间轴**——宁可整行高亮，也不要按错位的时间逐字点亮。
    const consistent = units.length > 1 && units.map((u) => u.text).join("") === content;
    out.push({
      time: lineStart / 1000,
      text: content,
      // 单字样行逐字没有意义，留给渲染端整行高亮
      units: consistent ? units : undefined,
    });
  }
  return out;
}
