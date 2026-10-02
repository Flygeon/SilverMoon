import { describe, expect, it } from "vitest";
import { beatMatchRate, equalPowerGains, snapToBar, snapToBeat } from "@/utils/autoMix";
import { planMix, type AutoMixSettings } from "@/utils/autoMixEngine";
import type { TrackAnalysis } from "@/utils/autoMixAnalysis";

/** 构造分析结果的便捷函数 */
function analysis(o: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    bpm: 120,
    beatGrid: [],
    silenceStart: 0,
    silenceEnd: 0,
    confidence: 0.9,
    durationSec: 200,
    analyzerVersion: 1,
    elapsedMs: 0,
    ...o,
  };
}

const CFG: AutoMixSettings = {
  enabled: true,
  durationSec: 8,
  beatMatch: true,
  trimSilence: true,
  maxRateDeviation: 0.06,
};

describe("equalPowerGains（等功率交叉淡化）", () => {
  it("两端分别是全 A / 全 B", () => {
    expect(equalPowerGains(0)).toEqual({ a: 1, b: 0 });
    const end = equalPowerGains(1);
    expect(end.a).toBeCloseTo(0, 6);
    expect(end.b).toBeCloseTo(1, 6);
  });

  it("中点两个增益都是 sqrt(2)/2，不是 0.5", () => {
    const mid = equalPowerGains(0.5);
    expect(mid.a).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.b).toBeCloseTo(Math.SQRT1_2, 6);
    // 线性插值会给 0.5/0.5，那正是「音量塌一下」的来源
    expect(mid.a).toBeGreaterThan(0.6);
  });

  it("全程满足功率守恒 gA^2 + gB^2 = 1", () => {
    for (let i = 0; i <= 20; i++) {
      const g = equalPowerGains(i / 20);
      expect(g.a * g.a + g.b * g.b).toBeCloseTo(1, 6);
    }
  });

  it("输入越界时被钳到 [0,1]", () => {
    expect(equalPowerGains(-5)).toEqual({ a: 1, b: 0 });
    expect(equalPowerGains(5).b).toBeCloseTo(1, 6);
  });
});

describe("beatMatchRate（对拍速度比）", () => {
  it("BPM 相同时比值为 1", () => {
    expect(beatMatchRate(120, 120)).toBeCloseTo(1, 6);
  });

  it("差距在阈值内取 cur/next", () => {
    expect(beatMatchRate(124, 120)).toBeCloseTo(124 / 120, 4);
  });

  it("差距超出阈值返回 null（放弃对拍，避免明显走音）", () => {
    expect(beatMatchRate(140, 100)).toBeNull();
  });

  it("识别倍频关系：140 与 70 视为可对拍", () => {
    const r = beatMatchRate(140, 70);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(1, 4);
  });

  it("BPM 无效（0 / 负数）返回 null", () => {
    expect(beatMatchRate(0, 120)).toBeNull();
    expect(beatMatchRate(120, 0)).toBeNull();
    expect(beatMatchRate(-1, 120)).toBeNull();
  });

  it("120 对 60 走倍频修正后可比", () => {
    expect(beatMatchRate(120, 60)).toBeCloseTo(1, 4);
  });
});

describe("snapToBeat / snapToBar（节拍网格吸附）", () => {
  it("空网格返回目标本身（调用方据此降级）", () => {
    expect(snapToBeat([], 12.3)).toBe(12.3);
    expect(snapToBar([], 12.3)).toBe(12.3);
  });

  it("吸附到最近的拍点", () => {
    const grid = [0, 0.5, 1, 1.5, 2];
    expect(snapToBeat(grid, 1.2)).toBe(1);
    expect(snapToBeat(grid, 1.4)).toBe(1.5);
  });

  it("小节吸附回退到所在小节的第一个拍（4/4）", () => {
    const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    // 3.6 最近拍是 3.5（下标 7）→ 所在小节起点是下标 4 → 2.0
    expect(snapToBar(grid, 3.6)).toBe(2);
  });

  it("beatsPerBar=3 时按三拍分组", () => {
    const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    expect(snapToBar(grid, 2.6, 3)).toBe(1.5);
  });
});

describe("planMix（过渡决策）", () => {
  it("没有分析结果时仍给出可用的淡化方案（降级不失败）", () => {
    const p = planMix(200, null, null, 0, CFG);
    expect(p.fadeOutAt).toBeCloseTo(192, 3);
    expect(p.rate).toBeNull();
    expect(p.nextStartAt).toBe(0);
    expect(p.reasons.length).toBeGreaterThan(0);
  });

  it("对拍成功时给出速度比", () => {
    const p = planMix(200, analysis({ bpm: 124 }), analysis({ bpm: 120 }), 0, CFG);
    expect(p.rate).toBeCloseTo(124 / 120, 4);
  });

  it("BPM 差过大时不做对拍并说明原因", () => {
    const p = planMix(200, analysis({ bpm: 140 }), analysis({ bpm: 90 }), 0, CFG);
    expect(p.rate).toBeNull();
    expect(p.reasons.some((r) => r.includes("差过大"))).toBe(true);
  });

  it("设置关闭对拍时不计算速度比", () => {
    const p = planMix(200, analysis({ bpm: 120 }), analysis({ bpm: 120 }), 0, {
      ...CFG,
      beatMatch: false,
    });
    expect(p.rate).toBeNull();
    expect(p.reasons.some((r) => r.includes("关闭"))).toBe(true);
  });

  it("裁静音：下一曲从其开头静音之后起播", () => {
    const p = planMix(200, analysis(), analysis({ silenceStart: 2.5 }), 0, CFG);
    expect(p.nextStartAt).toBe(2.5);
  });

  it("裁静音关闭时下一曲从头起播", () => {
    const p = planMix(200, analysis(), analysis({ silenceStart: 2.5 }), 0, {
      ...CFG,
      trimSilence: false,
    });
    expect(p.nextStartAt).toBe(0);
  });

  it("过渡终点会吸附到小节边界", () => {
    const grid: number[] = [];
    for (let t = 0; t <= 200; t += 0.5) grid.push(Math.round(t * 1000) / 1000);
    const p = planMix(200, analysis({ beatGrid: grid }), analysis(), 0, CFG);
    expect(p.reasons.some((r) => r.includes("吸附"))).toBe(true);
  });

  it("小节边界偏移过大（>2s）时不吸附", () => {
    const p = planMix(200, analysis({ beatGrid: [0, 50, 100, 150] }), analysis(), 0, CFG);
    expect(p.fadeOutAt).toBeCloseTo(192, 3);
    expect(p.reasons.some((r) => r.includes("偏移过大"))).toBe(true);
  });

  it("淡出点早于当前播放位置时钳到当前位置（不会立刻切歌）", () => {
    const p = planMix(20, analysis(), analysis(), 19, CFG);
    expect(p.fadeOutAt).toBe(19);
    expect(p.reasons.some((r) => r.includes("钳到"))).toBe(true);
  });

  it("尾部静音让淡出点提前（避免淡到寂静里干等）", () => {
    const withSilence = planMix(200, analysis({ silenceEnd: 10 }), analysis(), 0, CFG);
    const without = planMix(200, analysis({ silenceEnd: 0 }), analysis(), 0, CFG);
    expect(withSilence.fadeOutAt).toBeLessThan(without.fadeOutAt);
  });

  it("每个决策都留下 reasons，便于控制台排查", () => {
    const p = planMix(200, analysis({ bpm: 124 }), analysis({ bpm: 120 }), 0, CFG);
    expect(p.reasons.length).toBeGreaterThanOrEqual(3);
    for (const r of p.reasons) expect(typeof r).toBe("string");
  });
});
