/**
 * 逐字填充纯函数测试。
 *
 * 这些分支在真实窗口里很难复现（要精确控制播放时间），但都是会**肉眼可见**
 * 出错的地方：行首闪一下、空隙乱跳、emoji 让进度算错、末行永远填不满。
 */
import { describe, expect, it } from "vitest";
import { computeLineFill, countChars, resolveLineEnd, type FillLine } from "../karaokeFill";

const line = (time: number, text: string, units?: { start: number; end: number }[]): FillLine => ({
  time,
  text,
  units,
});

describe("computeLineFill", () => {
  it("行未开始返回 0，已结束返回 1", () => {
    const l = line(10, "abc");
    expect(computeLineFill(l, 20, 9)).toBe(0);
    expect(computeLineFill(l, 20, 20)).toBe(1);
    expect(computeLineFill(l, 20, 25)).toBe(1);
  });

  it("无逐字时间轴时整行匀速", () => {
    const l = line(0, "abcd");
    expect(computeLineFill(l, 4, 1)).toBeCloseTo(0.25, 5);
    expect(computeLineFill(l, 4, 2)).toBeCloseTo(0.5, 5);
    expect(computeLineFill(l, 4, 3)).toBeCloseTo(0.75, 5);
  });

  it("有逐字时间轴时按字符位置插值", () => {
    // 4 个字、4 个词，每词 1 秒
    const l = line(0, "abcd", [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ]);
    expect(computeLineFill(l, 5, 0.5)).toBeCloseTo(0.125, 5);
    expect(computeLineFill(l, 5, 1)).toBeCloseTo(0.25, 5);
    expect(computeLineFill(l, 5, 2.5)).toBeCloseTo(0.625, 5);
  });

  it("长词与短词的填充速度按字符数分配", () => {
    // 5 个字，第一个词占 3 字，第二个词占 2 字
    const l = line(0, "abcde", [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    // 第一个词过半 → 字符进度约 1.5/5
    expect(computeLineFill(l, 6, 1)).toBeCloseTo(1.5 / 5, 5);
    // 第一个词结束 → 正好 3/5
    expect(computeLineFill(l, 6, 2)).toBeCloseTo(3 / 5, 5);
    // 第二个词结束 → 5/5
    expect(computeLineFill(l, 6, 4)).toBe(1);
  });

  it("词与词之间的空隙停在上一词末尾，不跳到下一词", () => {
    const l = line(0, "abcd", [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
    // t=2 落在 1~3 的空隙里：应停在第一词结束的字符位置（2/4），而不是第二词起点
    expect(computeLineFill(l, 5, 2)).toBeCloseTo(0.5, 5);
    // 刚过空隙进入第二词
    expect(computeLineFill(l, 5, 3)).toBeCloseTo(0.5, 5);
  });

  it("emoji 按一个字符计数，不会算成两个", () => {
    expect(countChars("a🎵b")).toBe(3);
    const l = line(0, "a🎵b", [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
    // 三词各占 1 字符：过完第一词应正好 1/3
    expect(computeLineFill(l, 4, 1)).toBeCloseTo(1 / 3, 5);
  });

  it("词数多于字符数时不越界", () => {
    const l = line(0, "ab", [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
    const v = computeLineFill(l, 4, 2.5);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("空文本不产生 NaN", () => {
    const l = line(0, "");
    const v = computeLineFill(l, 4, 2);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe("resolveLineEnd", () => {
  it("优先取下一行起点", () => {
    expect(resolveLineEnd(line(0, "abc"), 5)).toBe(5);
  });

  it("末行无逐字时间轴时按字数估算（每字 0.4s，最少 2s）", () => {
    expect(resolveLineEnd(line(0, "a"), undefined)).toBe(2);
    expect(resolveLineEnd(line(0, "abcdefghij"), undefined)).toBeCloseTo(4, 5);
  });

  it("末行有逐字时间轴时取末词结束", () => {
    const l = line(0, "ab", [
      { start: 0, end: 1 },
      { start: 1, end: 2.5 },
    ]);
    expect(resolveLineEnd(l, undefined)).toBe(2.5);
  });
});
