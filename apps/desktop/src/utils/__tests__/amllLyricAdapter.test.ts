/**
 * 项目歌词 → AMLL 歌词行的适配器回归测试。
 *
 * 这里锁住的是「接进 AMLL 官方组件」时最容易踩的几个坑：
 * 秒/毫秒换算、间奏三点行必须丢弃（交给 AMLL 自己的 InterludeDots）、
 * 和声行要变成独立的 isBG 行、以及点击跳转用的下标映射。
 */
import { describe, expect, it } from "vitest";
import { toAmllLyricBundle, toAmllLyricLines } from "@/utils/amllLyricAdapter";
import type { LyricLine } from "@shared/types";

function line(partial: Partial<LyricLine> & { time: number }): LyricLine {
  return { text: "line", ...partial };
}

describe("toAmllLyricBundle", () => {
  it("秒转毫秒，并保留逐字时间轴", () => {
    const lines = [
      line({
        time: 1,
        text: "你好",
        units: [
          { text: "你", start: 1, end: 1.5 },
          { text: "好", start: 1.5, end: 2 },
        ],
      }),
      line({ time: 3, text: "世界" }),
    ];
    const { lines: out } = toAmllLyricBundle(lines);
    expect(out).toHaveLength(2);
    expect(out[0].words).toEqual([
      { word: "你", startTime: 1000, endTime: 1500 },
      { word: "好", startTime: 1500, endTime: 2000 },
    ]);
    expect(out[0].startTime).toBe(1000);
    expect(out[0].endTime).toBe(2000);
    // 末行没有逐字数据：退回整行一个词元
    expect(out[1].words).toHaveLength(1);
    expect(out[1].words[0].startTime).toBe(3000);
  });

  it("丢弃间奏三点行（交给 AMLL 自己推导），但不影响其余行的结束时间", () => {
    const lines = [
      line({ time: 1, text: "A", units: [{ text: "A", start: 1, end: 2 }] }),
      line({ time: 2.1, text: "•••", instrumental: true }),
      line({ time: 9, text: "B", units: [{ text: "B", start: 9, end: 10 }] }),
    ];
    const { lines: out, indexMap } = toAmllLyricBundle(lines);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.words[0].word)).toEqual(["A", "B"]);
    // 下标映射指向项目数组里的真实行，而不是 0/1
    expect(indexMap).toEqual([0, 2]);
  });

  it("和声子行变成紧跟主行的独立 isBG 行，且共享主行下标", () => {
    const lines = [
      line({
        time: 1,
        text: "main",
        units: [{ text: "main", start: 1, end: 2 }],
        bg: { text: "bg", units: [{ text: "bg", start: 0.5, end: 1.5 }] },
      }),
    ];
    const { lines: out, indexMap } = toAmllLyricBundle(lines);
    expect(out).toHaveLength(2);
    expect(out[0].isBG).toBe(false);
    expect(out[1].isBG).toBe(true);
    expect(out[1].startTime).toBe(500);
    expect(out[1].endTime).toBe(1500);
    expect(indexMap).toEqual([0, 0]);
  });

  it("对唱标记与副行模式按设置透传", () => {
    const lines = [
      line({ time: 1, text: "A", duet: true, translation: "译", romaji: "ro" }),
      line({ time: 2, text: "B", translation: "译2", romaji: "ro2" }),
    ];
    const translation = toAmllLyricLines(lines, { subMode: "translation" });
    expect(translation[0].isDuet).toBe(true);
    expect(translation[0].translatedLyric).toBe("译");
    // 二选一：翻译模式下拉马音必须留空，否则 AMLL 会同时显示两行副行
    expect(translation[0].romanLyric).toBe("");

    const romaji = toAmllLyricLines(lines, { subMode: "romaji" });
    expect(romaji[1].translatedLyric).toBe("");
    expect(romaji[1].romanLyric).toBe("ro2");
  });

  it("关闭逐字后每行压成单个词元（走 AMLL 的非逐词渲染）", () => {
    const lines = [
      line({
        time: 1,
        text: "你好",
        units: [
          { text: "你", start: 1, end: 1.5 },
          { text: "好", start: 1.5, end: 2 },
        ],
      }),
    ];
    const out = toAmllLyricLines(lines, { wordLevel: false });
    expect(out[0].words).toHaveLength(1);
    expect(out[0].words[0].word).toBe("你好");
  });

  it("坏时间戳不会抛出，退化成合法区间（AMLL 对 start>end 会抛错）", () => {
    const lines = [
      line({
        time: 1,
        text: "A",
        units: [
          { text: "x", start: 2, end: 1.5 },
          { text: "y", start: Number.NaN, end: 3 },
        ],
      }),
    ];
    const { lines: out } = toAmllLyricBundle(lines);
    expect(out).toHaveLength(1);
    for (const w of out[0].words) {
      expect(Number.isFinite(w.startTime)).toBe(true);
      expect(w.startTime).toBeGreaterThanOrEqual(0);
      expect(w.startTime).toBeLessThanOrEqual(w.endTime);
    }
    expect(out[0].startTime).toBeLessThanOrEqual(out[0].endTime);
  });

  it("空歌词返回空结果（不崩）", () => {
    expect(toAmllLyricBundle([]).lines).toEqual([]);
    expect(toAmllLyricLines([])).toEqual([]);
  });
});
