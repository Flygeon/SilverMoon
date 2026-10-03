/**
 * 逐词上浮的回归测试（对齐 AMLL 的 createFloatAnimation）。
 *
 * 数值口径直接决定观感：起浮时机从「唱完」提前到「词开始」、幅度随字号缩放的 em、
 * 曲线用 ease-out、时长不足 1s 按 1s 拖长 —— 改错任何一项都会让歌词视图的手感变味。
 *
 * 另一个重点是**驱动方式**：上浮必须交给 Web Animations API，而不是逐帧读播放位置
 * 自己插值再写 CSS 变量。后者会走成台阶（播放位置的推进粒度不等于帧率）并在主线程
 * 每帧重算样式，表现就是「字、词上浮有顿感」。这里把 WAAPI 的参数钉住。
 */
import { describe, expect, it } from "vitest";
import { floatAnimationSpec, floatTiming, WORD_FLOAT_EM } from "@/utils/wordFloat";
import type { WordUnit } from "@shared/types";

const unit = (start: number, end: number, text = "x"): WordUnit => ({ text, start, end });

describe("floatTiming", () => {
  it("delay 是相对**行首**的偏移（AMLL 的 startTime - lineStartTime）", () => {
    // 行从 10s 开始，词从 12s 开始 → 相对行首 2000ms
    expect(floatTiming(unit(12, 13), 10).delayMs).toBe(2000);
  });

  it("词起点早于行首时 delay 为负（动画开局就已在进行中），不会被截成 0", () => {
    // 背景和声常早于主行首；截成 0 会让它在行首重新从零起浮，出现一次回弹
    expect(floatTiming(unit(9, 10), 10).delayMs).toBe(-1000);
  });

  it("时长取 max(1s, 词时长)：不足 1s 按 1s（否则短促的字会弹一下）", () => {
    expect(floatTiming(unit(0, 0.2), 0).durationMs).toBe(1000);
    expect(floatTiming(unit(0, 2.5), 0).durationMs).toBe(2500);
  });

  it("endMs = delay + duration，供调用方判断「是否还需继续播」", () => {
    const t = floatTiming(unit(1.5, 2), 1);
    expect(t.endMs).toBe(t.delayMs + t.durationMs);
  });

  it("非有限时间戳不会产生 NaN 时序（坏数据退化成 0 而不是毁掉整行）", () => {
    const t = floatTiming(unit(Number.NaN, 1), 0);
    expect(Number.isFinite(t.delayMs)).toBe(true);
    expect(Number.isFinite(t.durationMs)).toBe(true);
  });

  it("幅度：主词 0.05em 向上，和声行翻倍（AMLL 的 if (isBG) up *= 2）", () => {
    expect(WORD_FLOAT_EM).toBe(0.05);
    expect(floatTiming(unit(0, 1), 0).offsetEm).toBeCloseTo(-0.05, 6);
    expect(floatTiming(unit(0, 1), 0, true).offsetEm).toBeCloseTo(-0.1, 6);
  });
});

describe("floatAnimationSpec", () => {
  it("关键帧从 0em 到终态 em，方向向上（负值）", () => {
    const spec = floatAnimationSpec(unit(0, 1), 0);
    expect(spec.keyframes).toHaveLength(2);
    expect(spec.keyframes[0].transform).toBe("translateY(0em)");
    expect(spec.keyframes[1].transform).toBe("translateY(-0.05em)");
  });

  it("easing / fill / composite 与 AMLL 一致", () => {
    const { options } = floatAnimationSpec(unit(0, 1), 0);
    // ease-out：与 AMLL 的 createFloatAnimation 同曲线
    expect(options.easing).toBe("ease-out");
    // both：delay 期间停在起点、结束后停在最大上浮（fill: both）
    expect(options.fill).toBe("both");
    // add：叠加在词自身 transform 上（间奏三点自带 scale，不能被覆盖）
    expect(options.composite).toBe("add");
  });

  it("选项里的 duration / delay 就是算好的时序", () => {
    const spec = floatAnimationSpec(unit(2, 3), 1);
    expect(spec.options.duration).toBe(1000);
    expect(spec.options.delay).toBe(1000);
  });
});
