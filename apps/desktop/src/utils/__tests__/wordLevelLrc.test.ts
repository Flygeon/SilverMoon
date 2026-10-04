import { describe, expect, it } from "vitest";
import {
  formatLrcTime,
  hasAnyWordUnits,
  hasWordUnits,
  isWordLevelLyrics,
  serializeWordLevelLrc,
  wordTagSeconds,
} from "@/utils/wordLevelLrc";
import { parseLrc } from "@/utils/lyricTimeline";
import type { LyricLine, WordUnit } from "@shared/types";

function line(partial: Partial<LyricLine> & { time: number; text: string }): LyricLine {
  return { ...partial };
}

function units(...pairs: [string, number, number][]): WordUnit[] {
  return pairs.map(([text, start, end]) => ({ text, start, end }));
}

describe("formatLrcTime", () => {
  it("厘秒四舍五入，不产生 60 进位错误", () => {
    expect(formatLrcTime(12.34)).toBe("00:12.34");
    expect(formatLrcTime(59.996)).toBe("01:00.00");
    expect(formatLrcTime(0)).toBe("00:00.00");
    expect(formatLrcTime(-5)).toBe("00:00.00");
    expect(formatLrcTime(Number.NaN)).toBe("00:00.00");
    expect(formatLrcTime(3599.999)).toBe("60:00.00");
  });
});

describe("wordTagSeconds", () => {
  it("两位小数按厘秒、三位按毫秒，与 [..] 规则一致", () => {
    expect(wordTagSeconds("00", "12", "34")).toBeCloseTo(12.34, 5);
    expect(wordTagSeconds("00", "12", "345")).toBeCloseTo(12.345, 5);
    expect(wordTagSeconds("01", "02")).toBeCloseTo(62, 5);
    expect(wordTagSeconds("00", "00", "10")).toBeCloseTo(0.1, 5);
  });
});

describe("serializeWordLevelLrc", () => {
  it("多字行写词级标记，末词补收尾标记", () => {
    const text = serializeWordLevelLrc([
      line({
        time: 12.34,
        text: "原谅我",
        units: units(["原", 12.34, 12.61], ["谅", 12.61, 12.88], ["我", 12.88, 13.2]),
      }),
    ]);
    expect(text).toBe("[00:12.34]<00:12.34>原<00:12.61>谅<00:12.88>我<00:13.20>");
  });

  it("单单元行退化为普通 LRC（不值得写伪逐字）", () => {
    const text = serializeWordLevelLrc([
      line({ time: 1, text: "啊", units: units(["啊", 1, 1.5]) }),
    ]);
    expect(text).toBe("[00:01.00]啊");
  });

  it("无 units 的行写普通 LRC", () => {
    expect(serializeWordLevelLrc([line({ time: 1, text: "hello" })])).toBe("[00:01.00]hello");
  });

  it("翻译与原文共用时间戳，作为同时间戳第二行写出", () => {
    const text = serializeWordLevelLrc([line({ time: 5, text: "hello", translation: "你好" })]);
    expect(text).toBe("[00:05.00]hello\n[00:05.00]你好");
  });

  it("翻译与原文相同时不重复写", () => {
    expect(serializeWordLevelLrc([line({ time: 5, text: "hi", translation: "hi" })])).toBe(
      "[00:05.00]hi",
    );
  });

  it("跳过间奏三点行（渲染态占位不该固化进文件）", () => {
    const text = serializeWordLevelLrc([
      line({ time: 0, text: "•••", instrumental: true }),
      line({ time: 10, text: "歌", units: units(["歌", 10, 10.5]) }),
    ]);
    expect(text).toBe("[00:10.00]歌");
  });

  it("词元里的 <> 会被剥离；剥离后与行文本对不上则退回逐行（保文本）", () => {
    // "a<" / "b>" 剥掉尖括号后拼成 "ab"，而行文本是 "a<b"（含一个 <），两者不一致。
    // 这时写逐字标记只会写出一份自己都读不回来的歌词，因此按逐行写，文本永不丢。
    const text = serializeWordLevelLrc([
      line({
        time: 1,
        text: "a<b",
        units: units(["a<", 1, 1.2], ["b>", 1.2, 1.4]),
      }),
    ]);
    expect(text).toBe("[00:01.00]a<b");
    // 回读后文本原样（尖括号不会被当成标记）
    expect(parseLrc(text, false)[0].text).toBe("a<b");
  });

  it("词元与行文本一致时正常写逐字（且行内 <> 不会破坏标记）", () => {
    const text = serializeWordLevelLrc([
      line({ time: 1, text: "ab", units: units(["a", 1, 1.2], ["b", 1.2, 1.4]) }),
    ]);
    expect(text).toBe("[00:01.00]<00:01.00>a<00:01.20>b<00:01.40>");
    // 行文本里出现尖括号时，序列化按逐行走，标记结构不会被污染
    const angled = serializeWordLevelLrc([
      line({ time: 2, text: "<chorus>", units: units(["<chor", 2, 2.2], ["us>", 2.2, 2.4]) }),
    ]);
    expect(angled).toBe("[00:02.00]<chorus>");
    expect(parseLrc(angled, false)[0].text).toBe("<chorus>");
  });

  it("全空返回空串", () => {
    expect(serializeWordLevelLrc([])).toBe("");
    expect(serializeWordLevelLrc([line({ time: 1, text: "   " })])).toBe("");
  });
});

describe("hasWordUnits / hasAnyWordUnits / isWordLevelLyrics", () => {
  it("只有 ≥2 个单元才算逐字", () => {
    expect(hasWordUnits(line({ time: 0, text: "a" }))).toBe(false);
    expect(hasWordUnits(line({ time: 0, text: "ab", units: units(["a", 0, 1]) }))).toBe(false);
    expect(
      hasWordUnits(line({ time: 0, text: "ab", units: units(["a", 0, 1], ["b", 1, 2]) })),
    ).toBe(true);
  });

  it("整份歌词只要有任一行逐字即为逐字歌词", () => {
    const plain = [line({ time: 0, text: "a" }), line({ time: 1, text: "b" })];
    const mixed = [...plain, line({ time: 2, text: "cd", units: units(["c", 2, 3], ["d", 3, 4]) })];
    expect(hasAnyWordUnits(plain)).toBe(false);
    expect(isWordLevelLyrics(plain)).toBe(false);
    expect(hasAnyWordUnits(mixed)).toBe(true);
    expect(isWordLevelLyrics(mixed)).toBe(true);
  });
});

describe("往返：serialize → parseLrc", () => {
  it("逐字时间轴与文本原样还原（厘秒精度）", () => {
    const source: LyricLine[] = [
      line({
        time: 12.34,
        text: "原谅我",
        units: units(["原", 12.34, 12.61], ["谅", 12.61, 12.88], ["我", 12.88, 13.2]),
      }),
      line({ time: 14.5, text: "不再送花" }),
    ];
    const parsed = parseLrc(serializeWordLevelLrc(source), false);
    const first = parsed.find((l) => Math.abs(l.time - 12.34) < 0.005);
    expect(first?.text).toBe("原谅我");
    expect(first?.units?.map((u) => u.text)).toEqual(["原", "谅", "我"]);
    expect(first?.units?.[0].start).toBeCloseTo(12.34, 2);
    expect(first?.units?.[2].end).toBeCloseTo(13.2, 2);
    // 普通行照常解析（并拿到粗排 units，不是逐字真值）
    const second = parsed.find((l) => Math.abs(l.time - 14.5) < 0.005);
    expect(second?.text).toBe("不再送花");
  });

  it("未启用增强标记的第三方 LRC 回读不受影响", () => {
    const parsed = parseLrc("[00:01.00]第一行\n[00:03.00]第二行", false);
    expect(parsed.map((l) => l.text)).toEqual(["第一行", "第二行"]);
  });

  it("词级时间轴非单调时整行退回粗排（不产生错位高亮）", () => {
    const text = "[00:10.00]<00:10.00>a<00:09.00>b";
    const parsed = parseLrc(text, false);
    expect(parsed[0].text).toBe("ab");
    // 粗排 units 起点就是行起点，不会被脏数据拉到 9 秒
    expect(parsed[0].units?.[0].start).toBeCloseTo(10, 2);
  });

  it("词元文本与清洗后的行文本一致时，逐字时间轴正常套用", () => {
    const text = "[00:10.00]<00:10.00>hello <00:10.50>world";
    const parsed = parseLrc(text, false);
    expect(parsed[0].text).toBe("hello world");
    expect(parsed[0].units?.map((u) => u.text)).toEqual(["hello ", "world"]);
    expect(parsed[0].units?.[1].start).toBeCloseTo(10.5, 2);
  });

  it("带词级标记的行不套用尾部括号译文启发式（括号是正文，不改字）", () => {
    // 回归：曾把 "Hello (Live)" 回读成 text="Hello" + translation="Live"，
    // 用户写进文件的歌词被静默改字（实测网易云 yrc 的 "…C.Y.Kong （江志仁）" 中招）。
    const source: LyricLine[] = [
      line({
        time: 1,
        text: "Hello (Live)",
        units: units(["H", 1, 1.2], ["ello (Live)", 1.2, 1.5]),
      }),
    ];
    const parsed = parseLrc(serializeWordLevelLrc(source), false);
    expect(parsed[0].text).toBe("Hello (Live)");
    expect(parsed[0].translation).toBeUndefined();
    expect(parsed[0].units?.map((u) => u.text).join("")).toBe("Hello (Live)");
  });

  it("无词级标记的普通 LRC 仍套用括号译文启发式（既有行为不变）", () => {
    const parsed = parseLrc("[00:10.00]hello world (你好)", false);
    expect(parsed[0].text).toBe("hello world");
    expect(parsed[0].translation).toBe("你好");
  });

  it("超过 99 分钟的时间戳能被自己读回（不再整行丢失）", () => {
    // 回归：formatLrcTime 会写出 "100:00.00"，而原来只认 2 位分钟 → 整行被丢弃
    const source: LyricLine[] = [
      line({ time: 6000, text: "hi", units: units(["h", 6000, 6000.5], ["i", 6000.5, 6001]) }),
    ];
    const text = serializeWordLevelLrc(source);
    expect(text).toContain("[100:00.00]");
    const parsed = parseLrc(text, false);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("hi");
    expect(parsed[0].time).toBeCloseTo(6000, 2);
    expect(parsed[0].units?.map((u) => u.text)).toEqual(["h", "i"]);
  });

  it("无词级标记的超长音轨普通 LRC 同样能读回", () => {
    const parsed = parseLrc("[100:00.00]第一行", false);
    expect(parsed.map((l) => l.text)).toEqual(["第一行"]);
  });

  it("独立译文行末尾带括号时不被截断（按同时间戳第二行处理）", () => {
    // 回归：serializeWordLevelLrc 会写「原文行」+「同时间戳译文行」。
    // 译文行本身以括号结尾时，括号译文启发式会把它截成 "你好" + 译文 "正式版"。
    const parsed = parseLrc("[00:20.00]hello\n[00:20.00]你好（正式版）", false);
    expect(parsed[0].text).toBe("hello");
    expect(parsed[0].translation).toBe("你好（正式版）");
  });

  it("译文行走 serialize → parse 往返不丢字", () => {
    const source: LyricLine[] = [line({ time: 20, text: "hello", translation: "你好（正式版）" })];
    const parsed = parseLrc(serializeWordLevelLrc(source), false);
    expect(parsed[0].text).toBe("hello");
    expect(parsed[0].translation).toBe("你好（正式版）");
  });

  it("attachRoughUnits=false：词级标记被一致性检查拒绝时也不留粗排 units", () => {
    // 回归：判定曾用「写过词级标记」而不是「真的套用成功」，导致被拒绝的行
    // 仍带着粗排 units 漏出去，写标签时又被当成逐字写回文件。
    const text = "[00:10.00]<00:10.00>hello <00:10.50>world [tr:你好]";
    const strict = parseLrc(text, false, false);
    expect(strict[0]?.units).toBeUndefined();
    // 默认（渲染链路）仍保留粗排，行为不变
    const loose = parseLrc(text, false);
    expect((loose[0]?.units?.length ?? 0) > 0).toBe(true);
  });
});
