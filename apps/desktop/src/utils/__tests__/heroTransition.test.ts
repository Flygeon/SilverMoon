// @vitest-environment jsdom
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
  recordHeroSource,
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

  it("超时未降落会自动取消（点了歌但播放失败、路由没跳的情况）", () => {
    vi.useFakeTimers();
    try {
      const flight = fakeFlight();
      holdHeroFlight(flight);
      expect(flight.cancelled).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(flight.cancelled).toBe(1);
      expect(hasPendingHero()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("及时取走则超时不会再取消一次", () => {
    vi.useFakeTimers();
    try {
      const flight = fakeFlight();
      holdHeroFlight(flight);
      expect(releaseHeroFlight()).toBe(flight);
      vi.advanceTimersByTime(1000);
      expect(flight.cancelled).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("声明式起飞标记", () => {
  /** 造一个最小 DOM：卡片里嵌封面 + 一个操作按钮 */
  function buildCard() {
    const card = document.createElement("div");
    card.setAttribute("data-hero-source", "");
    const cover = document.createElement("div");
    cover.setAttribute("data-hero-cover", "");
    card.appendChild(cover);
    const action = document.createElement("button");
    action.setAttribute("data-hero-skip", "");
    card.appendChild(action);
    document.body.appendChild(card);
    return { card, cover, action };
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("点在卡片空白处：命中并返回封面元素", () => {
    const { card, cover } = buildCard();
    expect(recordHeroSource({ target: card } as unknown as Event)).toBe(cover);
  });

  it("点在嵌套操作按钮上：被 data-hero-skip 挡下", () => {
    const { action } = buildCard();
    expect(recordHeroSource({ target: action } as unknown as Event)).toBeNull();
  });

  it("点在没有 data-hero-source 的普通元素上：返回 null", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(recordHeroSource({ target: plain } as unknown as Event)).toBeNull();
  });

  it("卡片里没有封面时返回 null（不让「点文字也起飞」）", () => {
    const card = document.createElement("div");
    card.setAttribute("data-hero-source", "");
    document.body.appendChild(card);
    expect(recordHeroSource({ target: card } as unknown as Event)).toBeNull();
  });
});
