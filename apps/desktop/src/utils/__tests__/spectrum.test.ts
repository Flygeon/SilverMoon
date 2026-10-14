import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 频谱采集模块的测试。
 *
 * 这里不 mock `@/utils/audioEffects`，而是用假的 AudioContext / AnalyserNode
 * 驱动**真实的** AudioEffectEngine + 真实的 spectrum.ts —— 因为本模块最容易出错的
 * 地方恰恰是它与引擎的接线：分析器必须接在 limiter 之后、只做旁路 fan-out，
 * 且绝不能插进 limiter→destination 的串联路径。用 mock 引擎测不出这一点。
 *
 * 每个用例都通过 vi.resetModules() + 动态 import 拿一份全新的模块图，
 * 从而绕开 `audioEffectEngine` 是模块级单例带来的用例间耦合。
 */

/** 假 AudioParam：本模块只用到 value / setTargetAtTime */
function makeParam(value: number) {
  return { value, setTargetAtTime() {} };
}

/** 假 AudioNode：记录 connect 目标，便于断言接线拓扑 */
class FakeNode {
  readonly outputs: unknown[] = [];
  type = "";
  buffer: unknown = null;
  gain = makeParam(1);
  frequency = makeParam(0);
  Q = makeParam(0);
  threshold = makeParam(0);
  knee = makeParam(0);
  ratio = makeParam(0);
  attack = makeParam(0);
  release = makeParam(0);
  connect(dest: unknown) {
    this.outputs.push(dest);
    return dest;
  }
  disconnect() {}
}

/** 假 AnalyserNode：只实现频谱模块会碰到的成员 */
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  /** 测试指定的「当前频谱」，长度应与 frequencyBinCount 一致 */
  bins: number[] = [];
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getByteFrequencyData(array: Uint8Array) {
    for (let i = 0; i < array.length; i++) array[i] = this.bins[i] ?? 0;
  }
}

/** 假 AudioContext：够 attach() 把整条链搭起来即可 */
class FakeAudioContext {
  /** 本轮所有被 new 出来的 context（引擎只会建一个） */
  static created: FakeAudioContext[] = [];
  currentTime = 0;
  state = "running";
  /** 取小一点，makeImpulse 会按 sampleRate 建 1.8 秒缓冲 */
  sampleRate = 8000;
  destination = new FakeNode();
  nodes: FakeNode[] = [];
  analysers: FakeAnalyser[] = [];
  mediaElementSourceCalls = 0;

  constructor() {
    FakeAudioContext.created.push(this);
  }

  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  createMediaElementSource() {
    this.mediaElementSourceCalls++;
    return this.track(new FakeNode());
  }
  createGain() {
    return this.track(new FakeNode());
  }
  createBiquadFilter() {
    return this.track(new FakeNode());
  }
  createConvolver() {
    return this.track(new FakeNode());
  }
  createChannelSplitter() {
    return this.track(new FakeNode());
  }
  createChannelMerger() {
    return this.track(new FakeNode());
  }
  createDynamicsCompressor() {
    return this.track(new FakeNode());
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return this.track(a);
  }
  createBuffer(_channels: number, length: number) {
    return { length, getChannelData: () => new Float32Array(length) };
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

/** 假 <audio> 元素：createMediaElementSource 被替换掉了，只是个身份标记 */
function makeMedia(src: string) {
  return { src } as unknown as HTMLAudioElement;
}

/** 取一份全新的模块图（单例引擎也随之重建） */
async function fresh() {
  vi.resetModules();
  const engineMod = await import("@/utils/audioEffects");
  const spectrum = await import("@/utils/spectrum");
  return { engine: engineMod.audioEffectEngine, spectrum };
}

/** 找到 limiter：唯一一个把 destination 当作输出的节点 */
function findLimiter(ctx: FakeAudioContext) {
  return ctx.nodes.find((n) => n.outputs.includes(ctx.destination));
}

beforeEach(() => {
  FakeAudioContext.created = [];
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("频谱采集：未接入时", () => {
  it("readSpectrum() 返回 null（调用方据此退回静态画面）", async () => {
    const { spectrum } = await fresh();
    expect(spectrum.readSpectrum()).toBeNull();
  });

  it("getAnalyser() 返回 null，且不产生任何 AnalyserNode", async () => {
    const { engine } = await fresh();
    expect(engine.attached).toBe(false);
    expect(engine.getAnalyser()).toBeNull();
    expect(FakeAudioContext.created).toHaveLength(0);
  });

  it("SPECTRUM_BINS 是 64", async () => {
    const { spectrum } = await fresh();
    expect(spectrum.SPECTRUM_BINS).toBe(64);
  });
});

describe("频谱采集：接入后", () => {
  it("ensureSpectrum 返回 true，readSpectrum 给出长度 64、值域 0-255 的整数", async () => {
    const { engine, spectrum } = await fresh();
    const media = makeMedia("a.mp3");
    expect(spectrum.ensureSpectrum(media)).toBe(true);
    expect(engine.attached).toBe(true);

    const ctx = FakeAudioContext.created[0];
    const analyser = ctx.analysers[0];
    // 引擎侧的参数是冻结契约：256 点 FFT（→128 bin）+ 0.8 平滑
    expect(analyser.fftSize).toBe(256);
    expect(analyser.frequencyBinCount).toBe(128);
    expect(analyser.smoothingTimeConstant).toBeCloseTo(0.8, 6);

    analyser.bins = Array.from({ length: 128 }, (_, i) => (i * 7) % 256);
    const out = spectrum.readSpectrum();
    expect(out).not.toBeNull();
    expect(out).toHaveLength(spectrum.SPECTRUM_BINS);
    for (const v of out!) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it("下采样正确：相邻两个 bin 取平均后四舍五入（128 → 64）", async () => {
    const { spectrum } = await fresh();
    spectrum.ensureSpectrum(makeMedia("a.mp3"));
    const analyser = FakeAudioContext.created[0].analysers[0];

    // bins[i] = i → 相邻一对 (2k, 2k+1) 平均 = 2k + 0.5 → 四舍五入 = 2k + 1
    analyser.bins = Array.from({ length: 128 }, (_, i) => i);
    const out = spectrum.readSpectrum();
    const expected = Array.from({ length: 64 }, (_, k) => 2 * k + 1);
    expect(out).toEqual(expected);
    expect(out![0]).toBe(1);
    expect(out![63]).toBe(127);

    // 上取整边界：100/101 → 101
    analyser.bins = Array.from({ length: 128 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    expect(spectrum.readSpectrum()![0]).toBe(101);

    // 全 255 不应溢出
    analyser.bins = Array.from({ length: 128 }, () => 255);
    expect(spectrum.readSpectrum()!.every((v) => v === 255)).toBe(true);
  });

  it("每次返回独立数组（共享缓冲不会被下一帧覆写）", async () => {
    const { spectrum } = await fresh();
    spectrum.ensureSpectrum(makeMedia("a.mp3"));
    const analyser = FakeAudioContext.created[0].analysers[0];
    analyser.bins = Array.from({ length: 128 }, () => 200);

    const first = spectrum.readSpectrum()!;
    analyser.bins = Array.from({ length: 128 }, () => 10);
    const second = spectrum.readSpectrum()!;
    expect(first).not.toBe(second);
    expect(first[0]).toBe(200);
    expect(second[0]).toBe(10);
  });

  it("ensureSpectrum 幂等：重复调用不重复创建 AnalyserNode / MediaElementSource", async () => {
    const { spectrum } = await fresh();
    const media = makeMedia("a.mp3");
    expect(spectrum.ensureSpectrum(media)).toBe(true);
    expect(spectrum.ensureSpectrum(media)).toBe(true);
    expect(spectrum.ensureSpectrum(makeMedia("b.mp3"))).toBe(true);

    const ctx = FakeAudioContext.created[0];
    // 引擎只建一个 context，也只建一个分析器、一个 media source
    expect(FakeAudioContext.created).toHaveLength(1);
    expect(ctx.analysers).toHaveLength(1);
    expect(ctx.mediaElementSourceCalls).toBe(1);
  });

  it("getAnalyser 懒创建且幂等：不调用则不产生节点，重复调用返回同一个", async () => {
    const { engine } = await fresh();
    engine.attach(makeMedia("a.mp3"));
    const ctx = FakeAudioContext.created[0];
    // attach 本身不应创建分析器（懒创建）
    expect(ctx.analysers).toHaveLength(0);

    const a1 = engine.getAnalyser();
    const a2 = engine.getAnalyser();
    expect(a1).not.toBeNull();
    expect(a2).toBe(a1);
    expect(ctx.analysers).toHaveLength(1);
  });

  it("disposeSpectrum 只清本模块引用：readSpectrum 回到 null，引擎仍已接入", async () => {
    const { engine, spectrum } = await fresh();
    spectrum.ensureSpectrum(makeMedia("a.mp3"));
    expect(spectrum.readSpectrum()).not.toBeNull();

    spectrum.disposeSpectrum();
    expect(spectrum.readSpectrum()).toBeNull();
    expect(engine.attached).toBe(true);

    // 重新 ensure：复用引擎里既有的分析器，不再新建
    const ctx = FakeAudioContext.created[0];
    expect(spectrum.ensureSpectrum(makeMedia("a.mp3"))).toBe(true);
    expect(ctx.analysers).toHaveLength(1);
  });
});

describe("分析器是旁路 fan-out，不改动既有输出链路", () => {
  it("limiter→destination 原样保留，分析器挂在 limiter 上且不向下游连接", async () => {
    const { engine, spectrum } = await fresh();
    spectrum.ensureSpectrum(makeMedia("a.mp3"));
    const ctx = FakeAudioContext.created[0];
    const limiter = findLimiter(ctx);
    expect(limiter).toBeDefined();
    const analyser = ctx.analysers[0];

    // 1) 分析器是 limiter 的一个额外输出（fan-out）
    expect(limiter!.outputs).toContain(analyser);
    // 2) limiter→destination 仍在，且只有一条（没有变成串联）
    expect(limiter!.outputs.filter((o) => o === ctx.destination)).toHaveLength(1);
    // 3) 分析器是死端：不向任何节点输出，因此不可能插进串联路径
    expect(analyser.outputs).toHaveLength(0);

    // 4) 再调一次 getAnalyser 也不会新增任何连接
    const before = limiter!.outputs.length;
    engine.getAnalyser();
    expect(limiter!.outputs).toHaveLength(before);
  });

  it("attach 后未请求频谱时，limiter 只有 destination 一个输出", async () => {
    const { engine } = await fresh();
    engine.attach(makeMedia("a.mp3"));
    const ctx = FakeAudioContext.created[0];
    const limiter = findLimiter(ctx);
    expect(limiter!.outputs).toEqual([ctx.destination]);
  });
});
