/**
 * heroTransition 的跨路由交接单测。
 *
 * 只测「寄存 / 取走」这一层：真正的飞行要 DOM 布局，放单测里只会测出假结果。
 * 但这层状态机容易写错（取走没清空 → 下次重复降落；寄存没取消旧的 → 残留克隆层），
 * 而且它的 bug 表现是「飞行动画偶尔不出现 / 偶尔留一条残影」，很难靠肉眼定位。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasPendingHero,
  holdHeroFlight,
  releaseHeroFlight,
  type HeroFlight,
} from "@/utils/heroTransition";

function fakeFlight(): HeroFlight & { cancelled: number } {
  return {
    cancelled: 0,
    land: vi.fn(() => true),
    cancel() {
      this.cancelled += 1;
    },
  };
}

afterEach(() => {
  // 每个用例结束后清干净，避免模块级状态串场
  releaseHeroFlight();
});

describe("hero 跨路由交接", () => {
  it("初始没有待降落飞行", () => {
    expect(hasPendingHero()).toBe(false);
    expect(releaseHeroFlight()).toBeNull();
  });

  it("寄存后可取走，且取走后清空", () => {
    const flight = fakeFlight();
    holdHeroFlight(flight);
    expect(hasPendingHero()).toBe(true);
    expect(releaseHeroFlight()).toBe(flight);
    // 关键：第二次必须取不到 —— 否则同一个飞行会被降落两次，第二次目标已隐藏
    expect(releaseHeroFlight()).toBeNull();
    expect(hasPendingHero()).toBe(false);
  });

  it("新的寄存会取消旧的，避免留下未降落的克隆层", () => {
    const first = fakeFlight();
    const second = fakeFlight();
    holdHeroFlight(first);
    holdHeroFlight(second);
    expect(first.cancelled).toBe(1);
    expect(second.cancelled).toBe(0);
    expect(releaseHeroFlight()).toBe(second);
  });
});
