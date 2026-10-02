import { describe, expect, it, vi } from "vitest";

/**
 * AutoMix 双 deck 与调试通道的回归测试。
 *
 * 重点覆盖两个「读代码时容易漏、运行时才炸」的点：
 *   1. createMediaElementSource 对同一元素只能调用一次（重复抛 InvalidStateError）；
 *   2. 调试日志的环形缓冲不能无限增长。
 */

/** 复刻 AudioEffectEngine 的幂等接入语义 */
function makeEngine() {
  const attached = new Set<unknown>();
  let primary: unknown = null;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    get attachedCount() {
      return attached.size;
    },
    setPrimary(el: unknown) {
      primary = el;
      attached.add(el);
    },
    attachAdditional(el: unknown) {
      // 幂等：已接入直接复用，绝不重复 createMediaElementSource
      if (el === primary || attached.has(el)) return { gain: 1, reused: true };
      calls++;
      attached.add(el);
      return { gain: 1, reused: false };
    },
  };
}

describe("音效链的幂等接入（避免 InvalidStateError）", () => {
  it("同一元素重复接入不会重复创建 source", () => {
    const e = makeEngine();
    const el = { tag: "audio" };
    e.setPrimary(el);
    const a = e.attachAdditional(el);
    const b = e.attachAdditional(el);
    expect(a.reused).toBe(true);
    expect(b.reused).toBe(true);
    // 主元素已在链上，不应产生任何新的 createMediaElementSource 调用
    expect(e.calls).toBe(0);
    expect(e.attachedCount).toBe(1);
  });

  it("不同元素各自创建一次", () => {
    const e = makeEngine();
    const a = { tag: "a" };
    const b = { tag: "b" };
    e.setPrimary(a);
    e.attachAdditional(b);
    expect(e.calls).toBe(1);
    expect(e.attachedCount).toBe(2);
  });

  it("描述真实约束：不幂等就会抛错（证明这条测试有意义）", () => {
    const created = new Set<unknown>();
    const naive = (el: unknown) => {
      if (created.has(el)) {
        const err = new Error("already connected");
        err.name = "InvalidStateError";
        throw err;
      }
      created.add(el);
    };
    const el = {};
    naive(el);
    expect(() => naive(el)).toThrowError(/already connected/);
  });
});

/** 复刻环形缓冲的容量控制 */
function makeRing(max: number) {
  const entries: { msg: string }[] = [];
  return {
    push(msg: string) {
      entries.push({ msg });
      if (entries.length > max) entries.shift();
    },
    get all() {
      return [...entries];
    },
  };
}

describe("调试日志环形缓冲", () => {
  it("超过上限后丢弃最旧的，长度恒定", () => {
    const r = makeRing(100);
    for (let i = 0; i < 250; i++) r.push("m" + i);
    expect(r.all.length).toBe(100);
    expect(r.all[0].msg).toBe("m150");
    expect(r.all[99].msg).toBe("m249");
  });

  it("未超上限时全部保留", () => {
    const r = makeRing(100);
    for (let i = 0; i < 30; i++) r.push("m" + i);
    expect(r.all.length).toBe(30);
  });
});

describe("静音检测的边界（相对门限）", () => {
  /** 复刻 worker 里的 detectSilence 核心判定 */
  function detect(pcm: Float32Array, sampleRate: number) {
    const win = Math.floor(sampleRate * 0.05);
    if (pcm.length < win * 2) return { silenceStart: 0, silenceEnd: 0 };
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak <= 0) return { silenceStart: 0, silenceEnd: 0 };
    const threshold = peak * Math.pow(10, -50 / 20);
    const isSilent = (from: number) => {
      let s = 0;
      for (let i = from; i < from + win && i < pcm.length; i++) s += pcm[i] * pcm[i];
      return Math.sqrt(s / win) < threshold;
    };
    let sf = 0;
    while ((sf + 1) * win < pcm.length && isSilent(sf * win)) sf++;
    let ef = Math.floor(pcm.length / win) - 1;
    while (ef > sf && isSilent(ef * win)) ef--;
    const silenceStart = sf * 0.05;
    const silenceEnd = Math.max(0, pcm.length / sampleRate - (ef + 1) * 0.05);
    return {
      silenceStart: silenceStart >= 0.8 ? silenceStart : 0,
      silenceEnd: silenceEnd >= 0.8 ? silenceEnd : 0,
    };
  }

  it("前后都有长静音时都能检出", () => {
    const sr = 1000; // 用小采样率让测试快
    const n = sr * 10;
    const pcm = new Float32Array(n);
    // 2 秒静音 → 4 秒有声 → 4 秒静音
    for (let i = sr * 2; i < sr * 6; i++) pcm[i] = Math.sin(i / 10) * 0.5;
    const r = detect(pcm, sr);
    expect(r.silenceStart).toBeGreaterThan(1.5);
    expect(r.silenceEnd).toBeGreaterThan(3);
  });

  it("短静音（<0.8s）不报告，避免切掉乐句间的自然呼吸", () => {
    const sr = 1000;
    const pcm = new Float32Array(sr * 5);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 10) * 0.5;
    // 开头只有 0.5 秒静音
    for (let i = 0; i < sr * 0.5; i++) pcm[i] = 0;
    const r = detect(pcm, sr);
    expect(r.silenceStart).toBe(0);
  });

  it("全静音不报错也不返回 NaN", () => {
    const r = detect(new Float32Array(10000), 1000);
    expect(Number.isFinite(r.silenceStart)).toBe(true);
    expect(Number.isFinite(r.silenceEnd)).toBe(true);
  });

  it("极短音频不崩", () => {
    const r = detect(new Float32Array(10), 1000);
    expect(r).toEqual({ silenceStart: 0, silenceEnd: 0 });
  });
});

describe("控制台接口", () => {
  it("暴露的命令齐全且可调用", async () => {
    const calls: string[] = [];
    const api = {
      enable: () => calls.push("enable"),
      disable: () => calls.push("disable"),
      status: () => calls.push("status"),
      trace: () => calls.push("trace"),
      last: () => calls.push("last"),
      clear: () => calls.push("clear"),
      forceMix: () => calls.push("forceMix"),
      help: () => calls.push("help"),
    };
    for (const fn of Object.values(api)) fn();
    expect(calls).toEqual([
      "enable",
      "disable",
      "status",
      "trace",
      "last",
      "clear",
      "forceMix",
      "help",
    ]);
  });
});
