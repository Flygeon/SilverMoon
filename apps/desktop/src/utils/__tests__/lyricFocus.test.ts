/**
 * 已读完歌词行的「失去焦点」过渡契约（对齐 AMLL 的 LyricLineGroup / LyricLineEl）。
 *
 * 这套数值决定「唱完一句往下走」的观感：非当前行要缩小、暂停时不缩小、
 * 和声行比主行更小。改错任何一项都会让整块歌词的层次感变味。
 */
import { describe, expect, it } from "vitest";
import {
  lyricLineScale,
  LYRIC_SCALE_FOCUS,
  LYRIC_SCALE_UNFOCUSED,
  LYRIC_SCALE_BG_UNFOCUSED,
  PASSED_LINE_RISE_RATIO,
  SCALE_SPRING_PARAMS,
  SCALE_SPRING_PARAMS_BG,
} from "@/utils/lyricFocus";

describe("lyricLineScale", () => {
  it("当前行是满值（不缩放）", () => {
    expect(lyricLineScale(true, true)).toBe(LYRIC_SCALE_FOCUS);
    expect(lyricLineScale(true, false)).toBe(LYRIC_SCALE_FOCUS);
  });

  it("非当前行在播放中缩到 97%（AMLL 的 SCALE_ASPECT）", () => {
    expect(lyricLineScale(false, true)).toBe(LYRIC_SCALE_UNFOCUSED);
    expect(LYRIC_SCALE_UNFOCUSED).toBe(97);
  });

  it("暂停时非当前行回到满值（不该继续「收」下去）", () => {
    // AMLL 同样只在播放中缩放；否则暂停后每行会僵在一个变小的状态
    expect(lyricLineScale(false, false)).toBe(LYRIC_SCALE_FOCUS);
  });

  it("和声行比主行更小（AMLL 的 bgScale = 75）", () => {
    expect(lyricLineScale(false, true, true)).toBe(LYRIC_SCALE_BG_UNFOCUSED);
    expect(LYRIC_SCALE_BG_UNFOCUSED).toBe(75);
    expect(LYRIC_SCALE_BG_UNFOCUSED).toBeLessThan(LYRIC_SCALE_UNFOCUSED);
  });

  it("和声行作为当前行时仍是满值", () => {
    expect(lyricLineScale(true, true, true)).toBe(LYRIC_SCALE_FOCUS);
  });
});

describe("弹簧参数", () => {
  it("缩放弹簧与 AMLL 的 scaleSpringParams 一致（mass 2 / damping 25 / stiffness 100）", () => {
    expect(SCALE_SPRING_PARAMS).toEqual({ mass: 2, damping: 25, stiffness: 100 });
  });

  it("和声行用更软的弹簧（AMLL 的 scaleForBGSpringParams）", () => {
    expect(SCALE_SPRING_PARAMS_BG.stiffness).toBeLessThan(SCALE_SPRING_PARAMS.stiffness);
    expect(SCALE_SPRING_PARAMS_BG).toEqual({ mass: 1, damping: 20, stiffness: 50 });
  });
});

describe("已读行的上移量", () => {
  it("是行高的一个正比例，且小于半行（否则相邻行会挤在一起）", () => {
    expect(PASSED_LINE_RISE_RATIO).toBeGreaterThan(0);
    expect(PASSED_LINE_RISE_RATIO).toBeLessThan(0.5);
  });
});
