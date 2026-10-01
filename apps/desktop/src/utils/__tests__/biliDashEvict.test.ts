import { describe, expect, it } from "vitest";

/**
 * DASH 缓冲回收策略的测试。
 *
 * 曾经的 evict() 只回收 feeders[0]（视频），音频那条一路 append 到片尾：
 * 2 小时的视频音频能累积上百 MB，命中 Chromium 的 SourceBuffer 配额后
 * 该轨道 error 停摆，长视频播到中途卡死，且回退重拉还会再撞配额。
 * 这里把「两路都要各自判」的策略固定下来。
 */

/** 一段缓冲的时间区间 [start, end]。 */
type FakeRange = [number, number];

/** 纯策略：给定各路缓冲区间与播放点，返回每路应回收到的位置（null = 不回收）。 */
function evictPlan(
  buffers: FakeRange[][],
  currentTime: number,
  keepBehind = 30,
  keepWindow = 90,
): (number | null)[] {
  const keepFrom = Math.max(0, currentTime - keepBehind);
  return buffers.map((ranges) => {
    if (!ranges.length) return null;
    const first = ranges[0][0];
    return keepFrom - first > keepWindow ? keepFrom : null;
  });
}

describe("DASH 缓冲回收策略", () => {
  it("视频与音频都要各自回收（不能只回收第一路）", () => {
    const video: FakeRange[] = [[0, 300]];
    const audio: FakeRange[] = [[0, 300]];
    // keepFrom = 250 - 30 = 220；220 - 0 > 90 → 两路都要回收
    expect(evictPlan([video, audio], 250)).toEqual([220, 220]);
  });

  it("缓冲不长于窗口时不回收（避免频繁 remove 卡顿）", () => {
    const video: FakeRange[] = [[0, 100]];
    const audio: FakeRange[] = [[0, 100]];
    expect(evictPlan([video, audio], 90)).toEqual([null, null]);
  });

  it("没有任何缓冲的轨道跳过", () => {
    const empty: FakeRange[] = [];
    const audio: FakeRange[] = [[0, 300]];
    expect(evictPlan([empty, audio], 250)).toEqual([null, 220]);
  });

  it("播放点靠前时 keepFrom 不为负", () => {
    const video: FakeRange[] = [[0, 300]];
    expect(evictPlan([video], 10)).toEqual([null]);
  });
});

/** 续播位置决策（与 stores/bilibili.ts 的 loadResumePoint 一致）。 */
function resumeTarget(lastSeconds: number, total: number): number {
  if (lastSeconds <= 5) return 0;
  if (total > 0 && lastSeconds >= total * 0.95) return 0;
  return lastSeconds;
}

describe("续播位置决策", () => {
  it("刚开始（<=5s）从头播", () => {
    expect(resumeTarget(0, 100)).toBe(0);
    expect(resumeTarget(5, 100)).toBe(0);
  });

  it("中间位置续播", () => {
    expect(resumeTarget(42, 100)).toBe(42);
  });

  it("已看完（>=95%）从头播", () => {
    expect(resumeTarget(95, 100)).toBe(0);
    expect(resumeTarget(100, 100)).toBe(0);
  });

  it("时长未知时不判看完，只按 5s 阈值", () => {
    expect(resumeTarget(3, 0)).toBe(0);
    expect(resumeTarget(600, 0)).toBe(600);
  });
});
