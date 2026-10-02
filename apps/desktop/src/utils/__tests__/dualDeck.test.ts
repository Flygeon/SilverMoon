import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DualDeck } from "@/utils/dualDeck";

/**
 * DualDeck 类的行为测试。
 *
 * 之前只测了 equalPowerGains 这个纯函数，**类本身从未被执行过** ——
 * rAF 淡化循环、setGain 的路由分支、deckFor/adopt 的查找、crossfade 的收尾
 * 都只是"读起来对"。这里用假 Audio 与假引擎把它真正跑起来。
 */

/** 最小可用的假 audio 元素（只实现 DualDeck 会碰到的成员） */
class FakeAudio {
  src = "";
  volume = 1;
  preload = "";
  crossOrigin: string | null = null;
  paused = true;
  currentTime = 0;
  playbackRate = 1;
  pause() {
    this.paused = true;
  }
  load() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  removeAttribute() {}
}

/** 假音效引擎：模拟 attachAdditional 的幂等语义与 gain 节点 */
function makeEngine() {
  const attached = new Set<unknown>();
  const gains: { value: number }[] = [];
  let attachCalls = 0;
  let primary: unknown = null;
  return {
    get attachCalls() {
      return attachCalls;
    },
    get gains() {
      return gains;
    },
    setPrimary(el: unknown) {
      primary = el;
      attached.add(el);
    },
    get attached() {
      return true;
    },
    attachAdditional(el: unknown) {
      // 幂等：主元素与已接入元素都复用，绝不重复建 source
      if (el === primary || attached.has(el)) {
        return { gain: { value: 1 } };
      }
      attachCalls++;
      attached.add(el);
      const gain = { value: 1 };
      gains.push(gain);
      return { gain };
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio);
  // crossfade 用 rAF 逐帧推进；用 setTimeout 模拟即可
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 4),
  );
  vi.stubGlobal("performance", { now: () => Date.now() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DualDeck", () => {
  it("get 惰性创建 deck，重复 get 返回同一个", () => {
    const e = makeEngine();
    const d = new DualDeck(e as never);
    const a1 = d.get("a");
    const a2 = d.get("a");
    expect(a1).toBe(a2);
    expect(a1.id).toBe("a");
    expect(e.attachCalls).toBe(1);
  });

  it("other 返回另一个 deck，且各自独立", () => {
    const d = new DualDeck(makeEngine() as never);
    const a = d.get("a");
    const b = d.other("a");
    expect(b.id).toBe("b");
    expect(b.el).not.toBe(a.el);
    expect(d.other("b")).toBe(a);
  });

  it("deckFor 按元素反查（deck 提升的关键）", () => {
    const d = new DualDeck(makeEngine() as never);
    const a = d.get("a");
    const b = d.get("b");
    expect(d.deckFor(a.el)).toBe(a);
    expect(d.deckFor(b.el)).toBe(b);
    expect(d.deckFor(new FakeAudio() as never)).toBeNull();
  });

  it("adopt 把既有元素纳入管理，且对已存在的 deck 是空操作", () => {
    const e = makeEngine();
    const d = new DualDeck(e as never);
    const existing = new FakeAudio();
    const h = d.adopt("a", existing as never);
    expect(h.id).toBe("a");
    expect(h.el).toBe(existing);
    // 再次 adopt 同一 id 应返回既有 handle，不重复 attach
    const again = d.adopt("a", new FakeAudio() as never);
    expect(again).toBe(h);
  });

  it("setGain 未接 Web Audio 时退回 element.volume", () => {
    const d = new DualDeck(makeEngine() as never);
    const a = d.get("a");
    a.gain = null; // 模拟未接入
    d.setGain(a, 0.25);
    expect(a.el.volume).toBeCloseTo(0.25, 6);
  });

  it("setGain 已接入时写 gain，且钳到 [0,1]", () => {
    const d = new DualDeck(makeEngine() as never);
    const a = d.get("a");
    // GainNode 的形状是 { gain: { value } } —— gain 是 AudioParam
    const node = { gain: { value: 0 } };
    a.gain = node as never;
    d.setGain(a, 0.7);
    expect(node.gain.value).toBeCloseTo(0.7, 6);
    d.setGain(a, 5);
    expect(node.gain.value).toBe(1);
    d.setGain(a, -3);
    expect(node.gain.value).toBe(0);
    // 走 gain 时不应再动 element.volume
    expect(a.el.volume).toBe(1);
  });

  it("crossfade 从 (1,0) 走到 (0,1)，且中途符合等功率", async () => {
    const d = new DualDeck(makeEngine() as never);
    const from = d.get("a");
    const to = d.get("b");
    const gA = { gain: { value: 1 } };
    const gB = { gain: { value: 0 } };
    from.gain = gA as never;
    to.gain = gB as never;

    const ticks: number[] = [];
    await d.crossfade(from, to, 60, (t) => ticks.push(t));

    expect(gA.gain.value).toBe(0);
    expect(gB.gain.value).toBe(1);
    expect(ticks.length).toBeGreaterThan(1);
    // 进度单调不减，且落在 [0,1]
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it("crossfade 期间始终满足 gA^2 + gB^2 = 1（等功率）", async () => {
    const d = new DualDeck(makeEngine() as never);
    const from = d.get("a");
    const to = d.get("b");
    const gA = { gain: { value: 1 } };
    const gB = { gain: { value: 0 } };
    from.gain = gA as never;
    to.gain = gB as never;

    const sums: number[] = [];
    await d.crossfade(from, to, 60, () => {
      sums.push(gA.gain.value * gA.gain.value + gB.gain.value * gB.gain.value);
    });
    for (const s of sums) expect(s).toBeCloseTo(1, 3);
  });

  it("silence 把指定 deck 静音", () => {
    const d = new DualDeck(makeEngine() as never);
    const a = d.get("a");
    const node = { gain: { value: 1 } };
    a.gain = node as never;
    d.silence("a");
    expect(node.gain.value).toBe(0);
    // 不存在的 deck 不应抛错
    expect(() => d.silence("b")).not.toThrow();
  });

  it("dispose 停掉所有 deck 并清空", () => {
    const d = new DualDeck(makeEngine() as never);
    const a = d.get("a");
    const b = d.get("b");
    a.el.play();
    d.dispose();
    expect(a.el.paused).toBe(true);
    expect(b.el.paused).toBe(true);
    // 清空后再 get 会重新创建（新的元素）
    expect(d.get("a").el).not.toBe(a.el);
  });

  it("tryRoute 在引擎未就绪时返回 false 且不抛错", () => {
    const engine = {
      attached: false,
      hasSource: () => false,
      attachAdditional: () => null,
    };
    const d = new DualDeck(engine as never);
    const a = d.get("a");
    a.gain = null;
    expect(d.tryRoute(a)).toBe(false);
  });

  it("tryRoute 成功后写入 gain，重复调用是幂等的", () => {
    const e = makeEngine();
    const d = new DualDeck(e as never);
    const a = d.get("a");
    a.gain = null; // 假装当时引擎还没就绪
    expect(d.tryRoute(a)).toBe(true);
    const first = a.gain;
    expect(first).not.toBeNull();
    // 再次调用：已有 gain，直接返回 true，不再 attach
    const before = e.attachCalls;
    expect(d.tryRoute(a)).toBe(true);
    expect(e.attachCalls).toBe(before);
  });
});
