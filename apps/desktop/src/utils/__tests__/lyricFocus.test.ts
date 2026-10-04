/**
 * 已读完歌词行的「失去焦点」过渡契约（对齐 AMLL 的 LyricLineGroup / LyricLineEl）。
 *
 * 这套数值决定「唱完一句往下走」的观感：非当前行要缩小、暂停时不缩小、
 * 和声行比主行更小、已读行比同距离的未读行更糊。改错任何一项都会让整块歌词的层次感变味。
 *
 * 尤其注意 lineOffset：它**不含**任何「已读行额外上移」的项。曾经加过
 * h * PASSED_LINE_RISE_RATIO 这类逐行累加的抬升，结果每切一行整摞歌词就被多顶一截，
 * 越靠上的已读行累计越多，表现就是切行瞬间「突然往上一跳」。
 */
import { describe, expect, it } from "vitest";
import {
  cascadeDelaySec,
  legacyCascadeDelayMs,
  legacyLineBlur,
  lineOffset,
  lyricLineBlur,
  lyricLineScale,
  LYRIC_MAX_BLUR,
  LYRIC_SCALE_BG_UNFOCUSED,
  LYRIC_SCALE_FOCUS,
  LYRIC_SCALE_UNFOCUSED,
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

describe("lineOffset：整摞刚性滚动，不逐行额外抬升", () => {
  const heights = [60, 60, 60, 60, 60];
  const gap = 30;
  const offset = 200;

  it("焦点行落在停靠位置", () => {
    expect(lineOffset(2, 2, heights, gap, offset)).toBe(offset);
  });

  it("下方行是行高 + 行距的累加", () => {
    expect(lineOffset(3, 2, heights, gap, offset)).toBe(offset + 90);
    expect(lineOffset(4, 2, heights, gap, offset)).toBe(offset + 180);
  });

  it("上方行是同样的累加取负（与下行完全对称）", () => {
    expect(lineOffset(1, 2, heights, gap, offset)).toBe(offset - 90);
    expect(lineOffset(0, 2, heights, gap, offset)).toBe(offset - 180);
  });

  it("切行时所有行的位移量完全相同 = 刚性滚动（这就是「不跳」的关键）", () => {
    // 焦点从 2 前进到 3，比较每一行的净位移
    const deltas = [0, 1, 2, 3, 4].map(
      (i) => lineOffset(i, 3, heights, gap, offset) - lineOffset(i, 2, heights, gap, offset),
    );
    // 每行都只走 -(行高 + 行距)
    for (const d of deltas) expect(d).toBe(-(60 + 30));
  });

  it("已读行与未读行的间距相等（不会被额外顶开）", () => {
    const gapAbove =
      lineOffset(1, 3, heights, gap, offset) - lineOffset(2, 3, heights, gap, offset);
    const gapBelow =
      lineOffset(4, 3, heights, gap, offset) - lineOffset(3, 3, heights, gap, offset);
    expect(gapAbove).toBe(-(60 + 30));
    expect(gapBelow).toBe(60 + 30);
  });
});

describe("cascadeDelaySec：级联延迟单调递增且收敛", () => {
  it("焦点行与上方行不延迟", () => {
    expect(cascadeDelaySec(0)).toBe(0);
    expect(cascadeDelaySec(-3)).toBe(0);
  });

  it("下方行逐行变晚（而不是中途掉回 0）", () => {
    let prev = -1;
    for (let d = 0; d <= 40; d++) {
      const v = cascadeDelaySec(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(cascadeDelaySec(1)).toBeGreaterThan(0);
    expect(cascadeDelaySec(20)).toBeGreaterThan(cascadeDelaySec(10));
  });

  it("增量按 1/1.05 衰减，远端收敛而不是无限增长", () => {
    // 公比 1/1.05 的几何级数收敛到 0.05 / (1 - 1/1.05) = 1.05s
    expect(cascadeDelaySec(400) - cascadeDelaySec(200)).toBeLessThan(0.001);
    // 收敛值有限：再远的行也不会无限等下去
    expect(cascadeDelaySec(1000)).toBeLessThanOrEqual(1.05);
    // 但确实在增长
    expect(cascadeDelaySec(100)).toBeGreaterThan(cascadeDelaySec(10));
  });
});

describe("lyricLineBlur：按行距分档，已读行更糊", () => {
  it("关闭模糊时一律 0", () => {
    expect(lyricLineBlur(0, 5, true, false)).toBe(0);
    expect(lyricLineBlur(9, 5, true, false)).toBe(0);
  });

  it("焦点行不糊", () => {
    expect(lyricLineBlur(5, 5, true, true)).toBe(0);
  });

  it("视口外的行给满档（AMLL 先判视口，返回 5）", () => {
    expect(lyricLineBlur(0, 5, false, true)).toBe(LYRIC_MAX_BLUR);
    expect(lyricLineBlur(5, 5, false, true)).toBe(LYRIC_MAX_BLUR);
  });

  it("已读行比同距离的未读行再糊一档（AMLL 的 +1）", () => {
    // 距焦点 1 行：已读 3，未读 2
    expect(lyricLineBlur(4, 5, true, true)).toBe(3);
    expect(lyricLineBlur(6, 5, true, true)).toBe(2);
    // 距焦点 2 行：已读 4，未读 3
    expect(lyricLineBlur(3, 5, true, true)).toBe(4);
    expect(lyricLineBlur(7, 5, true, true)).toBe(3);
  });

  it("档位封顶 LYRIC_MAX_BLUR（对齐 AMLL render 的 min(5, blur)）", () => {
    expect(lyricLineBlur(0, 9, true, true)).toBe(LYRIC_MAX_BLUR);
    expect(lyricLineBlur(9, 0, true, true)).toBe(LYRIC_MAX_BLUR);
  });
});

describe("legacyCascadeDelayMs：旧版换行的错开规则", () => {
  it("上方行不延迟（旧实现的 delay <= 0 分支）", () => {
    expect(legacyCascadeDelayMs(-1)).toBe(0);
    expect(legacyCascadeDelayMs(-5)).toBe(0);
  });

  it("当前行与下方行按 (n*70 - n*10) 错开，n = 行距 + 1（旧实现连当前行也延了 60ms）", () => {
    expect(legacyCascadeDelayMs(0)).toBe(60);
    expect(legacyCascadeDelayMs(1)).toBe(120);
    expect(legacyCascadeDelayMs(8)).toBe(540);
    expect(legacyCascadeDelayMs(9)).toBe(600);
  });

  it("距离 ≥ 10 行直接同步归位（旧实现的 `if (n > 10) n = 0`）", () => {
    expect(legacyCascadeDelayMs(10)).toBe(0);
    expect(legacyCascadeDelayMs(50)).toBe(0);
  });

  it("与新版收敛级数不同：更远的行反而回到 0 延迟", () => {
    // 这正是新版要把旧规则换掉的原因（远端行抢先动，波浪散架）
    expect(cascadeDelaySec(50)).toBeGreaterThan(cascadeDelaySec(9));
    expect(legacyCascadeDelayMs(50)).toBeLessThan(legacyCascadeDelayMs(9));
  });
});

describe("legacyLineBlur：旧版模糊档位", () => {
  it("关闭模糊时一律 0", () => {
    expect(legacyLineBlur(0, 5, false)).toBe(0);
    expect(legacyLineBlur(9, 5, false)).toBe(0);
  });

  it("焦点行不糊", () => {
    expect(legacyLineBlur(5, 5, true)).toBe(0);
  });

  it("就是「与焦点的行距」（不封顶、不区分已读 / 未读）", () => {
    expect(legacyLineBlur(4, 5, true)).toBe(1);
    expect(legacyLineBlur(6, 5, true)).toBe(1);
    // 新版给已读行再加一档、并封顶 5；旧版两样都没有
    expect(lyricLineBlur(4, 5, true, true)).toBe(3);
    expect(legacyLineBlur(0, 9, true)).toBe(9);
    expect(lyricLineBlur(0, 9, true, true)).toBe(LYRIC_MAX_BLUR);
  });
});
