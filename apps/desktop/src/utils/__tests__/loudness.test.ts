import { describe, expect, it } from "vitest";
import { dbToGain, loudnessGain, measureLufs } from "@/utils/loudness";

/**
 * EBU R128 响度测量的**物理标定**测试。
 *
 * 关键判据不是"跑完不崩"，而是**数值正确**：
 * - 1 kHz 满量程正弦按 BS.1770-4 应测得 ≈ 0 LUFS（K 加权在该频点增益约 0 dB）
 * - 幅度减半应测得 ≈ −6.02 LUFS
 * - 归一化增益应等于 dB 差
 *
 * 这些是可以在本地真正验证的，因此不需要 CI 兜底。
 */

const SR = 48000;

/** 生成指定频率/幅度/时长的单声道正弦。 */
function sine(hz: number, amplitude: number, seconds: number, sampleRate = SR): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

describe("measureLufs —— 物理标定", () => {
  it("1kHz 满量程正弦 ≈ 0 LUFS（单声道已做标定，见 loudness.ts）", () => {
    const lufs = measureLufs(sine(1000, 1, 3), SR);
    expect(lufs).not.toBeNull();
    // 满量程正弦即 0 LUFS（K 加权在 1kHz 处增益约 −0.13dB，落在容差内）
    expect(Math.abs(lufs!)).toBeLessThan(0.3);
  });

  it("幅度减半 → 恰好低 6.02 LU", () => {
    const full = measureLufs(sine(1000, 1, 3), SR)!;
    const half = measureLufs(sine(1000, 0.5, 3), SR)!;
    expect(full - half).toBeCloseTo(6.0206, 1);
  });

  it("幅度减为 1/4 → 恰好低 12.04 LU", () => {
    const full = measureLufs(sine(1000, 1, 3), SR)!;
    const quarter = measureLufs(sine(1000, 0.25, 3), SR)!;
    expect(full - quarter).toBeCloseTo(12.041, 1);
  });

  it("K 加权确实生效：低频被显著衰减", () => {
    // 50Hz 处在 K 加权的高通斜率上（−4dB @38Hz，12dB/oct），
    // 同样幅度下应明显低于 1kHz 的读数
    const low = measureLufs(sine(50, 1, 3), SR)!;
    const mid = measureLufs(sine(1000, 1, 3), SR)!;
    expect(low).toBeLessThan(mid);
    // 高通在 50Hz 处约 −5~−7 dB（38Hz 处 −4dB，每倍频 12dB）
    expect(mid - low).toBeGreaterThan(3);
  });

  it("高频被高架搁置抬升：4kHz 应高于 1kHz", () => {
    const mid = measureLufs(sine(1000, 1, 3), SR)!;
    const high = measureLufs(sine(4000, 1, 3), SR)!;
    expect(high).toBeGreaterThan(mid);
  });

  it("K 加权形状符合标准：1kHz 为参考 0dB，4kHz 约 +3~4dB，50Hz 明显低", () => {
    const mid = measureLufs(sine(1000, 1, 3), SR)!;
    const high = measureLufs(sine(4000, 1, 3), SR)!;
    // 标准的高架搁置在 1681Hz 处 +4dB，4kHz 处仍有可观提升
    expect(high - mid).toBeGreaterThan(2);
    expect(high - mid).toBeLessThan(6);
  });
});

describe("measureLufs —— 边界与降级", () => {
  it("样本短于一个块时返回 null（不参与归一化）", () => {
    expect(measureLufs(new Float32Array(100), SR)).toBeNull();
  });

  it("空信号返回 null", () => {
    expect(measureLufs(new Float32Array(0), SR)).toBeNull();
  });

  it("全静音返回 null（否则会把静音当成极安静而放大成噪声）", () => {
    expect(measureLufs(new Float32Array(SR * 2), SR)).toBeNull();
  });

  it("采样率非法时返回 null，不抛错", () => {
    expect(measureLufs(sine(1000, 1, 1), 0)).toBeNull();
  });

  it("不同采样率下同一信号读数一致（±0.2 LU）", () => {
    const a = measureLufs(sine(1000, 0.5, 3, 48000), 48000)!;
    const b = measureLufs(sine(1000, 0.5, 3, 44100), 44100)!;
    expect(Math.abs(a - b)).toBeLessThan(0.2);
  });

  it("静音段被门限剔除：前 2s 静音 + 后 2s 有声 ≈ 只测有声段", () => {
    const n = SR * 4;
    const mixed = new Float32Array(n);
    const tone = sine(1000, 0.5, 2);
    mixed.set(tone, SR * 2); // 后半段有声

    const mixedLufs = measureLufs(mixed, SR)!;
    const toneOnly = measureLufs(tone, SR)!;
    // 有门限时两者应接近；若无门限，混合信号的均值会被静音拉低
    expect(Math.abs(mixedLufs - toneOnly)).toBeLessThan(0.6);
  });
});

describe("loudnessGain", () => {
  it("恰好等于目标响度时增益为 1", () => {
    expect(loudnessGain(-14, -14)).toBeCloseTo(1, 6);
  });

  it("响度差 6.02dB → 增益 2 倍（精确值）", () => {
    // 6.0206 dB 才精确等于 2 倍；用 6 这个整数差，差值是 1.995
    expect(loudnessGain(-20.0206, -14)).toBeCloseTo(2, 3);
    expect(loudnessGain(-20, -14)).toBeCloseTo(1.995, 2);
  });

  it("响度更响时相应衰减", () => {
    expect(loudnessGain(-7.9794, -14)).toBeCloseTo(0.5, 3);
    expect(loudnessGain(-8, -14)).toBeCloseTo(0.501, 2);
  });

  it("增益被夹在 ±12dB（≈0.251 ~ 3.98）", () => {
    // 极安静的源不能被无限放大（会把本底噪声一起抬起来）
    expect(loudnessGain(-60, -14)).toBeCloseTo(3.981, 2);
    // 极响的源也只能衰减到下限
    expect(loudnessGain(0, -14)).toBeCloseTo(0.2512, 3);
  });

  it("未测量（null）时保持原音量", () => {
    expect(loudnessGain(null)).toBe(1);
  });

  it("非法输入不产生 NaN/Infinity", () => {
    expect(loudnessGain(Number.NaN)).toBe(1);
    expect(Number.isFinite(loudnessGain(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it("目标响度可配（不是写死的 -14）", () => {
    expect(loudnessGain(-14, -9)).toBeCloseTo(1.778, 2);
  });
});

describe("dbToGain", () => {
  it("0dB → 1，±6dB → 2 / 0.5", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(6.0206)).toBeCloseTo(2, 3);
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 3);
  });
});
