import { describe, expect, it } from "vitest";

/**
 * 续播策略的纯逻辑测试。
 *
 * 规则（与 stores/bilibili.ts 的 loadResumePoint 一致）：
 * - 进度 <= 5s 视为刚开始，从头播（避免「一进来就续播」的噪声）
 * - 进度 >= 总时长 95% 视为已看完，从头播（否则会贴在结尾）
 * - 其余情况续播到该位置
 */
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
    expect(resumeTarget(94, 100)).toBe(94);
  });

  it("已看完（>=95%）从头播", () => {
    expect(resumeTarget(95, 100)).toBe(0);
    expect(resumeTarget(100, 100)).toBe(0);
  });

  it("时长未知时不判「看完」，只按 5s 阈值", () => {
    expect(resumeTarget(3, 0)).toBe(0);
    expect(resumeTarget(600, 0)).toBe(600);
  });
});

/**
 * 进度上报节流：与上次上报相差 < 5s 就不发，避免同一秒重复打。
 * 上游对 heartbeat 有频控，重复上报会触发 -799 风控。
 */
function shouldReport(seconds: number, lastReported: number): boolean {
  // lastReported < 0 表示本次会话还没报过 —— 必须发
  if (lastReported < 0) return true;
  return Math.abs(Math.floor(seconds) - lastReported) >= 5;
}

describe("进度上报节流", () => {
  it("首次（lastReported=-1）必发", () => {
    expect(shouldReport(1, -1)).toBe(true);
  });

  it("短时间内重复位置不重发", () => {
    expect(shouldReport(30, 30)).toBe(false);
    expect(shouldReport(32, 30)).toBe(false);
  });

  it("位置前进足够多就发", () => {
    expect(shouldReport(35, 30)).toBe(true);
    expect(shouldReport(36, 30)).toBe(true);
  });
});
