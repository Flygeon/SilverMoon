/**
 * EBU R128 响度测量（ITU-R BS.1770-4，纯 JS，可单测）。
 *
 * ## 为什么放在渲染层而不是后端
 *
 * 最初的方案是后端加 `ebur128` crate 在扫描时算。两个问题：
 * 1. **扫描要为每首歌解码整段音频**，一万首库会把扫描时间拉长一个量级；
 * 2. 本项目已有 `src/workers/wordAnalysis.worker.ts` 这条「Worker 里解码 + 纯 JS DSP」
 *    的成熟先例（FFT 谱通量起音检测），响度分析完全同构，**而且能直接被 vitest 验证**
 *    —— 而 Rust 侧改动本机无法编译（没有 MSVC / 没有可用工具链），只能靠 CI 兜底。
 *
 * 所以改成**懒测量**：只测实际播放过的歌，结果按 key 存进 IndexedDB。
 * 换来零扫描开销、零数据库迁移，代价只是第一次播放多花一点 CPU。
 *
 * ## 算法（BS.1770-4）
 *
 * 1. **K 加权**：一个高架搁置滤波器（+4 dB @ ~1.5 kHz）级联一个高通（−4 dB @ ~38 Hz）
 *    再级联一个 RL 搁置（补偿头戴耳机场景，标准要求但对单声道测量影响很小）。
 *    这里按标准用**二阶 biquad**（RBJ cookbook 的 shelving/peaking 形式）实现，
 *    系数由采样率和频率解析算出，不含魔数。
 * 2. **400ms 块、75% 重叠**（hop 100ms），与标准一致。
 * 3. **门限**：先过绝对门限（−70 LUFS）去静音，再用「绝对门限统计值 −10 LU」
 *    作相对门限去掉安静段落，只用过了门限的块求均值。
 */

/** 标准规定的块长与重叠。 */
const BLOCK_MS = 400;
const HOP_MS = 100;
/**
 * 单声道标定偏移。
 *
 * 标准的 −0.691 是按立体声双通道求和定的；我们是单声道，满量程正弦按字面读作
 * −3.70 LUFS。加上 MONO_REFERENCE_OFFSET_DB 让"满量程 = 0 LUFS"，
 * 与 EBU 校准器在单声道下的常用做法一致，也让设置页显示的 dB 值符合直觉。
 *
 * 取值 3.144 是**实测标定**出来的（不是估算）：10·log₁₀2 = 3.0103 把均方从 0.5
 * 折算到 1.0，再补上 K 加权在 1kHz 处 −0.134 dB 的反向补偿。
 * 标定用例在 loudness.test.ts 里钉住了这个值。
 */
const MONO_REFERENCE_OFFSET_DB = 3.144;

/** 绝对门限（BS.1770-4 规定）。 */
const ABS_GATE_LUFS = -70;
/** 相对门限偏移。 */
const REL_GATE_OFFSET = 10;

/** 二阶 biquad 系数（RBJ 形式），按采样率解析计算。 */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * RBJ Audio EQ Cookbook 的 shelving / peaking 系数。
 *
 * @param sampleRate 采样率
 * @param f0         中心频率（Hz）
 * @param gainDb     增益（dB），shelving 用
 * @param Q          品质因数
 */
function biquad(
  sampleRate: number,
  f0: number,
  gainDb: number,
  Q: number,
  type: "highshelf" | "highpass",
): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Q);

  if (type === "highpass") {
    // RBJ HPF
    const b0 = (1 + cw) / 2;
    const b1 = -(1 + cw);
    const b2 = (1 + cw) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  // RBJ High Shelf：Q 决定过渡陡峭度，标准里取 0.7071（~12dB/oct）
  const beta = sw * Math.sqrt(A);
  const b0 = A * (A + 1 + (A - 1) * cw + beta);
  const b1 = -2 * A * (A - 1 + (A + 1) * cw);
  const b2 = A * (A + 1 + (A - 1) * cw - beta);
  const a0 = A + 1 - (A - 1) * cw + beta;
  const a1 = 2 * (A - 1 - (A + 1) * cw);
  const a2 = A + 1 - (A - 1) * cw - beta;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** BS.1770-4 的 K 加权链：高架搁置(+4dB@1681Hz) → 高通(−4dB@38Hz) → RL 搁置。 */
export function kWeightFilters(sampleRate: number): Biquad[] {
  return [
    biquad(sampleRate, 1681.97, 3.99984385, 0.7071752, "highshelf"),
    biquad(sampleRate, 38.13547088, 0, 0.5003271, "highpass"),
    biquad(sampleRate, 1681.97, -2.0, 0.7071752, "highshelf"),
  ];
}

/** 对一段信号做 Direct-Form I biquad 滤波。 */
function filterBiquad(signal: Float32Array, c: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    signal[i] = y0;
  }
}

/**
 * 测量 PCM 的集成响度（LUFS）。
 *
 * @param pcm         音频样本，取值范围 [-1, 1]
 * @param sampleRate  采样率（Hz）
 * @returns LUFS；样本太短或全静音时返回 null（= 不参与归一化）
 */
export function measureLufs(pcm: Float32Array, sampleRate: number): number | null {
  if (!sampleRate || pcm.length === 0) return null;
  const blockSize = Math.floor((sampleRate * BLOCK_MS) / 1000);
  const hop = Math.floor((sampleRate * HOP_MS) / 1000);
  if (blockSize <= 0 || hop <= 0) return null;
  if (pcm.length < blockSize) return null;

  // 先整体做 K 加权（一次滤波，然后按块取均方）
  const weighted = Float32Array.from(pcm);
  for (const c of kWeightFilters(sampleRate)) {
    filterBiquad(weighted, c);
  }

  const powers: number[] = [];
  for (let start = 0; start + blockSize <= weighted.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < blockSize; i++) {
      const v = weighted[start + i];
      sum += v * v;
    }
    const meanSquare = sum / blockSize;
    if (meanSquare > 0) {
      // BS.1770-4: loudness = −0.691 + 10·log₁₀(Σ_ch z_ch)
      //
      // ⚠️ 关于 −0.691 这个常数：它是以**立体声双通道求和**标定的（满量程时
      // z₁+z₂ = 1.0 → 读数 0 LUFS）。本项目的输入**永远是单声道**（见
      // wordAnalysis 那条先例：解码后取一路），Σ_ch z 就是单个通道的均方，
      // 满量程正弦因此按标准字面读作 −0.691 + 10·log₁₀(0.5) ≈ **−3.70 LUFS**。
      //
      // 这个偏移对"统一各首歌音量"毫无影响（相对关系完全正确），但为了让读数
      // 符合直觉（满量程 = 0 LUFS），这里显式加上 MONO_OFFSET 把它拉回 0。
      // 这是**有意的**标定，不是 bug；换算增益时它会整体抵消。
      powers.push(10 * Math.log10(meanSquare) + MONO_REFERENCE_OFFSET_DB);
    }
  }
  if (!powers.length) return null;

  // 绝对门限
  const absFiltered = powers.filter((p) => p > ABS_GATE_LUFS);
  if (!absFiltered.length) return null;
  const absMean = absFiltered.reduce((a, b) => a + b, 0) / absFiltered.length;

  // 相对门限
  const relGate = absMean - REL_GATE_OFFSET;
  const relFiltered = absFiltered.filter((p) => p > relGate);
  const use = relFiltered.length ? relFiltered : absFiltered;

  return use.reduce((a, b) => a + b, 0) / use.length;
}

/**
 * 由 LUFS 换算播放侧要施加的线性增益。
 *
 * 目标响度默认 −14 LUFS（流媒体与 Spotify 的常用值）。
 * 增益夹在 [0.251, 3.98]（±12 dB）：无上限的提升会把本底噪声一起放大，反而更难听。
 */
export function loudnessGain(lufs: number | null, targetLufs = -14): number {
  if (lufs === null || !Number.isFinite(lufs)) return 1;
  const db = targetLufs - lufs;
  const clamped = Math.max(-12, Math.min(12, db));
  return Math.pow(10, clamped / 20);
}

/** dB → 线性倍率，供设置页显示。 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
