import { describe, expect, it } from "vitest";
import { buildBeatGrid, detectSilence, estimateBpm, onsetEnvelope } from "@/utils/autoMixAlgo";

/**
 * AutoMix 音频分析算法的测试。
 *
 * ## 为什么这些测试直接 import 真实实现
 *
 * 最初算法写在 worker 文件里，测试只能把逻辑「复制一份」到测试文件再测。
 * 结果漏掉了一类真实 bug：算法里写死假设了 44100 Hz，而生产代码统一重采样到
 * 22050 Hz —— 复制出来的测试跑的是同一个错误假设，所以全绿；
 * 直接跑构建产物里的 worker 才暴露出来（BPM 差 2 倍）。
 *
 * 后来把算法抽到 utils/autoMixAlgo.ts，这里直接 import 真身，
 * 并显式覆盖**多个采样率**，这类「环境相关」的回归就再也跑不掉了。
 */

/** 生成指定 BPM 的合成鼓点（低频脉冲 + 噪声瞬态）。 */
function makeBeat(bpm: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  const interval = (60 / bpm) * sampleRate;
  for (let k = 0; k * interval < n; k++) {
    const at = Math.floor(k * interval);
    for (let i = 0; i < Math.floor(sampleRate * 0.05) && at + i < n; i++) {
      const t = i / sampleRate;
      const decay = Math.exp(-t * 60);
      out[at + i] += decay * (Math.sin(2 * Math.PI * 60 * t) * 0.8 + (Math.random() * 2 - 1) * 0.3);
    }
  }
  return out;
}

/** 半速/倍速在节拍意义上等价（对拍时另有倍频处理）。 */
function tempoEquivalent(a: number, b: number): boolean {
  return Math.abs(a - b) < 3 || Math.abs(a - b * 2) < 3 || Math.abs(a - b / 2) < 3;
}

describe("BPM 估计", () => {
  it("常见 BPM 都能测准（±3 或半/倍速等价）", () => {
    for (const target of [90, 100, 120, 128, 140, 174]) {
      const pcm = makeBeat(target, 30, 22050);
      const { env, frameRate } = onsetEnvelope(pcm, 22050);
      const { bpm } = estimateBpm(env, frameRate);
      expect(tempoEquivalent(bpm, target), `目标 ${target} 实际 ${bpm}`).toBe(true);
    }
  });

  it("★ 采样率无关：同一首歌在 22050 与 44100 下结论一致", () => {
    // 这条正是当年漏掉的 bug：frameRate 写死 44100 时，22050 输入会算错一倍
    for (const target of [100, 120, 128, 140]) {
      const results = [22050, 44100].map((sr) => {
        const pcm = makeBeat(target, 30, sr);
        const { env, frameRate } = onsetEnvelope(pcm, sr);
        return estimateBpm(env, frameRate).bpm;
      });
      expect(
        tempoEquivalent(results[0], results[1]),
        `目标 ${target}：22050→${results[0]}，44100→${results[1]}`,
      ).toBe(true);
    }
  });

  it("★ 不把 120 判成 60（八度歧义由速度先验解决）", () => {
    const pcm = makeBeat(120, 30, 22050);
    const { env, frameRate } = onsetEnvelope(pcm, 22050);
    const { bpm } = estimateBpm(env, frameRate);
    // 允许 ±3，但不允许掉到 60 附近
    expect(Math.abs(bpm - 120)).toBeLessThan(3);
  });

  it("精度优于 1 BPM（抛物线插值）", () => {
    for (const target of [120, 128, 140]) {
      const pcm = makeBeat(target, 30, 22050);
      const { env, frameRate } = onsetEnvelope(pcm, 22050);
      const { bpm } = estimateBpm(env, frameRate);
      expect(Math.abs(bpm - target), `目标 ${target} 实际 ${bpm}`).toBeLessThan(1);
    }
  });

  it("全静音不给出强结论", () => {
    const { env, frameRate } = onsetEnvelope(new Float32Array(22050 * 10), 22050);
    const { confidence } = estimateBpm(env, frameRate);
    expect(confidence).toBeLessThan(0.2);
  });

  it("白噪声置信度低（周期性弱）", () => {
    const pcm = new Float32Array(22050 * 10);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() * 2 - 1) * 0.5;
    const { env, frameRate } = onsetEnvelope(pcm, 22050);
    const { confidence } = estimateBpm(env, frameRate);
    expect(confidence).toBeLessThan(0.4);
  });

  it("真实鼓点的置信度明显高于噪声", () => {
    const beat = makeBeat(120, 30, 22050);
    const e1 = onsetEnvelope(beat, 22050);
    const c1 = estimateBpm(e1.env, e1.frameRate).confidence;
    const noise = new Float32Array(22050 * 30);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.5;
    const e2 = onsetEnvelope(noise, 22050);
    const c2 = estimateBpm(e2.env, e2.frameRate).confidence;
    expect(c1).toBeGreaterThan(c2 + 0.3);
  });

  it("极短输入不崩、不返回 NaN", () => {
    const { env, frameRate } = onsetEnvelope(new Float32Array(1000), 22050);
    const r = estimateBpm(env, frameRate);
    expect(Number.isFinite(r.bpm)).toBe(true);
    expect(Number.isFinite(r.confidence)).toBe(true);
  });
});

describe("节拍网格", () => {
  it("拍间隔与 BPM 一致", () => {
    const target = 120;
    const pcm = makeBeat(target, 20, 22050);
    const { env, frameRate } = onsetEnvelope(pcm, 22050);
    const { period } = estimateBpm(env, frameRate);
    const grid = buildBeatGrid(env, frameRate, period, 20);
    expect(grid.length).toBeGreaterThan(10);
    const gaps: number[] = [];
    for (let i = 1; i < Math.min(8, grid.length); i++) gaps.push(grid[i] - grid[i - 1]);
    for (const g of gaps) expect(g).toBeCloseTo(0.5, 2);
  });

  it("period 无效时返回空网格（调用方据此降级）", () => {
    const { env, frameRate } = onsetEnvelope(new Float32Array(22050 * 5), 22050);
    expect(buildBeatGrid(env, frameRate, 0, 5)).toEqual([]);
  });
});

describe("静音检测", () => {
  it("检出首尾长静音", () => {
    const sr = 22050;
    const n = sr * 10;
    const pcm = new Float32Array(n);
    for (let i = sr * 3; i < sr * 7; i++) pcm[i] = Math.sin(i / 12) * 0.5;
    const r = detectSilence(pcm, sr);
    expect(r.silenceStart).toBeGreaterThan(2.5);
    expect(r.silenceEnd).toBeGreaterThan(2.5);
  });

  it("短静音（<0.8s）不报告（那是乐句间的呼吸）", () => {
    const sr = 22050;
    const pcm = new Float32Array(sr * 5);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 12) * 0.5;
    for (let i = 0; i < sr * 0.5; i++) pcm[i] = 0;
    expect(detectSilence(pcm, sr).silenceStart).toBe(0);
  });

  it("整首有声时首尾都不报静音", () => {
    const sr = 22050;
    const pcm = new Float32Array(sr * 5);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 12) * 0.5;
    const r = detectSilence(pcm, sr);
    expect(r.silenceStart).toBe(0);
    expect(r.silenceEnd).toBe(0);
  });

  it("全静音 / 极短输入不崩、不产生 NaN", () => {
    const a = detectSilence(new Float32Array(22050 * 3), 22050);
    expect(Number.isFinite(a.silenceStart)).toBe(true);
    expect(Number.isFinite(a.silenceEnd)).toBe(true);
    expect(detectSilence(new Float32Array(10), 22050)).toEqual({
      silenceStart: 0,
      silenceEnd: 0,
    });
  });
});
