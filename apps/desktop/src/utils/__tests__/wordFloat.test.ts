/**
 * 逐词上浮的回归测试（对齐 AMLL 的 createFloatAnimation）。
 *
 * 数值口径直接决定观感：起浮时机从「唱完」提前到「词开始」、幅度改成随字号缩放的 em、
 * 曲线从带过冲的弹性换成 ease-out —— 改错任何一项都会让整个歌词视图的手感不一样。
 */
import { describe, expect, it } from "vitest";
import {
  cubicBezierEaseOut,
  floatProgress,
  WORD_FLOAT_EM,
  wordFloatOffsetEm,
} from "@/utils/wordFloat";
import type { WordUnit } from "@shared/types";

const unit = (start: number, end: number): WordUnit => ({ text: "x", start, end });

describe("cubicBezierEaseOut", () => {
  it("端点固定：0 → 0，1 → 1", () => {
    expect(cubicBezierEaseOut(0)).toBe(0);
    expect(cubicBezierEaseOut(1)).toBe(1);
    expect(cubicBezierEaseOut(-1)).toBe(0);
    expect(cubicBezierEaseOut(2)).toBe(1);
  });

  it("单调递增", () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = cubicBezierEaseOut(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("是 ease-out：前段涨得比线性快（导数递减）", () => {
    // ease-out 起步快、后段放缓；x=0.5 时应已过半
    expect(cubicBezierEaseOut(0.5)).toBeGreaterThan(0.5);
    // 且增量递减
    const d1 = cubicBezierEaseOut(0.2) - cubicBezierEaseOut(0.1);
    const d2 = cubicBezierEaseOut(0.9) - cubicBezierEaseOut(0.8);
    expect(d1).toBeGreaterThan(d2);
  });

  it("与 CSS cubic-bezier(0,0,0.58,1) 的解析解一致（抽样比对）", () => {
    // 用高精度二分独立复算，确认实现没有写错控制点
    const ref = (x: number): number => {
      const cx = (t: number) => 3 * (1 - t) * t * t * 0.58 + t ** 3;
      const cy = (t: number) => 3 * (1 - t) * t * t * 1 + t ** 3;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2;
        if (cx(m) < x) lo = m;
        else hi = m;
      }
      return cy((lo + hi) / 2);
    };
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(cubicBezierEaseOut(x)).toBeCloseTo(ref(x), 3);
    }
  });
});

describe("floatProgress", () => {
  it("词开始之前为 0，词结束之后为 1（fill: both → 停在最大位移）", () => {
    const u = unit(10, 12);
    expect(floatProgress(u, 9.9)).toBe(0);
    expect(floatProgress(u, 12)).toBe(1);
    expect(floatProgress(u, 20)).toBe(1);
  });

  it("词一开始就起浮（AMLL 的 delay = startTime - lineStartTime，不是等唱完）", () => {
    const u = unit(10, 12);
    // 刚起步就已有位移，且为正
    expect(floatProgress(u, 10.1)).toBeGreaterThan(0);
    // 唱到一半时应已过半（ease-out）
    expect(floatProgress(u, 11)).toBeGreaterThan(0.5);
  });

  it("时长不足 1s 的词按 1s 计（否则短促的字会瞬间弹起）", () => {
    const short = unit(10, 10.2);
    // 0.2s 的词，走到 0.1s 时只应是 1s 曲线在 10% 处的值，而不是「已完成」
    expect(floatProgress(short, 10.1)).toBeLessThan(1);
    expect(floatProgress(short, 10.1)).toBeCloseTo(cubicBezierEaseOut(0.1), 5);
    // 满 1s 后才浮满
    expect(floatProgress(short, 11)).toBe(1);
  });
});

describe("wordFloatOffsetEm", () => {
  it("幅度是 0.05em（AMLL 的 up = 0.05）", () => {
    expect(WORD_FLOAT_EM).toBe(0.05);
    const u = unit(0, 1);
    expect(wordFloatOffsetEm(u, 1)).toBeCloseTo(-0.05, 6);
  });

  it("方向向上（负值）", () => {
    const u = unit(0, 2);
    expect(wordFloatOffsetEm(u, 1)).toBeLessThan(0);
    expect(wordFloatOffsetEm(u, 0)).toBe(0);
  });

  it("和声行幅度是主行的两倍（isBG → up *= 2）", () => {
    const u = unit(0, 1);
    expect(wordFloatOffsetEm(u, 1, true)).toBeCloseTo(-0.1, 6);
    expect(wordFloatOffsetEm(u, 1, true)).toBeCloseTo(2 * wordFloatOffsetEm(u, 1, false), 6);
  });

  it("浮满是单调的：位移随时间单调不减", () => {
    const u = unit(0, 2);
    let prev = 0;
    for (let t = 0; t <= 2; t += 0.1) {
      const v = -wordFloatOffsetEm(u, t); // 取正值比较
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});
