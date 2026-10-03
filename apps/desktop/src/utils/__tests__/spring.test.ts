/**
 * 弹簧求解器与参数策略的回归测试。
 *
 * 这些数值是「观感」的载体：策略表一旦被改动，切行节奏就会整体变味，
 * 所以把 AMLL 的口径固定下来。
 */
import { describe, expect, it } from "vitest";
import { getPosYSpringPolicy, Spring } from "@/utils/spring";

describe("Spring", () => {
  it("初始就位，setTargetPosition 后逐帧收敛到目标", () => {
    const s = new Spring(0);
    s.setPosition(100);
    expect(s.getCurrentPosition()).toBe(100);
    expect(s.arrived()).toBe(true);

    s.setTargetPosition(300);
    expect(s.arrived()).toBe(false);
    for (let i = 0; i < 600; i++) s.update(1 / 60);
    expect(s.getCurrentPosition()).toBeCloseTo(300, 1);
    expect(s.arrived()).toBe(true);
  });

  it("位移是连续的：改目标不会瞬移，也不会回到零速度重来", () => {
    const s = new Spring(0);
    s.setPosition(0);
    s.setTargetPosition(200);
    // 推进到中途
    for (let i = 0; i < 10; i++) s.update(1 / 60);
    const mid = s.getCurrentPosition();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(200);

    // 目标改成反向：位置必须从 mid 连续演变（不瞬移）
    s.setTargetPosition(-50);
    const before = s.getCurrentPosition();
    s.update(0.001);
    expect(Math.abs(s.getCurrentPosition() - before)).toBeLessThan(5);
  });

  it("不更新就不动（dt <= 0 直接返回）", () => {
    const s = new Spring(0);
    s.setTargetPosition(500);
    s.update(0);
    expect(s.getCurrentPosition()).toBe(0);
  });

  it("updateParams 改变刚度后收敛更快", () => {
    const slow = new Spring(0);
    slow.updateParams({ stiffness: 90, damping: 15 });
    slow.setTargetPosition(100);
    const fast = new Spring(0);
    fast.updateParams({ stiffness: 220, damping: 33 });
    fast.setTargetPosition(100);

    for (let i = 0; i < 12; i++) {
      slow.update(1 / 60);
      fast.update(1 / 60);
    }
    expect(fast.getCurrentPosition()).toBeGreaterThan(slow.getCurrentPosition());
  });
});

describe("getPosYSpringPolicy", () => {
  it("跳转与间奏用慢速档", () => {
    expect(getPosYSpringPolicy(true, false)).toEqual({ stiffness: 90, damping: 15 });
    expect(getPosYSpringPolicy(false, true)).toEqual({ stiffness: 90, damping: 15 });
  });

  it("曲末用中速档", () => {
    expect(getPosYSpringPolicy(false, false, 500, true)).toEqual({ stiffness: 140, damping: 22 });
  });

  it("首尾行（无间隔）退回慢速档", () => {
    expect(getPosYSpringPolicy(false, false, undefined)).toEqual({ stiffness: 90, damping: 15 });
  });

  it("间隔越短刚度越高，且阻尼始终为 sqrt(stiffness) * 2.2", () => {
    const short = getPosYSpringPolicy(false, false, 100);
    const long = getPosYSpringPolicy(false, false, 800);
    expect(short.stiffness).toBeCloseTo(220, 0);
    expect(long.stiffness).toBeCloseTo(170, 0);
    expect(short.stiffness!).toBeGreaterThan(long.stiffness!);
    expect(short.damping).toBeCloseTo(Math.sqrt(short.stiffness!) * 2.2, 5);
    // 超出范围的间隔被钳住
    expect(getPosYSpringPolicy(false, false, 5000).stiffness).toBeCloseTo(170, 0);
  });
});
