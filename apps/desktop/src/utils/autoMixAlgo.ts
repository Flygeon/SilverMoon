/**
 * AutoMix 音频分析算法（纯函数，主线程与 Worker 共用）。
 *
 * 之所以从 worker 里抽出来：这些是纯计算，放这里就能让单元测试**直接测试真实实现**，
 * 而不是在测试里复制一份算法 —— 早先正是「测试里复制算法」导致采样率相关的 bug
 * 逃过了测试（见 autoMixAlgo.test.ts 的说明）。worker 只负责收发消息。
 *
 * ## 算法
 *
 * A. **起始点检测（spectral flux）**：分帧 FFT，取相邻帧频谱的「正向差」之和。
 *    只取正向差是为了对起音敏感、对衰减不敏感。
 *
 * B. **BPM 估计（自相关 + 速度先验 + 抛物线插值）**：
 *    对起音包络做自相关，峰的位置即拍周期。两个关键修正：
 *    - 速度先验：T 与 2T 都是真实的周期证据，靠「流行乐多在 120 BPM 附近」消歧；
 *    - 抛物线插值：整数 lag 有约 2.3 BPM 量化误差，拟合峰顶取亚帧精度。
 *
 * C. **节拍相位**：枚举候选相位，选使落在拍点上的起音强度之和最大的那个。
 *
 * D. **静音检测**：短时 RMS 找首尾低于「相对峰值 -50dB」的连续区间。
 */

export const FFT_SIZE = 2048;
export const HOP = 512;
export const MIN_BPM = 60;
export const MAX_BPM = 200;

export interface RegionAnalysisResult {
  bpm: number;
  beatGrid: number[];
  silenceStart: number;
  silenceEnd: number;
  confidence: number;
  onsetCount: number;
}

/**
 * 速度先验的中心与宽度（八度）。
 *
 * 自相关在 T、2T、3T 处都有峰 —— 它们都是真实存在的周期性证据，单看强度
 * 无法区分"这就是拍"还是"这是两拍"。而音乐的速度分布并不均匀：绝大多数
 * 流行乐在 90~150 BPM。给自相关乘一个以 120 BPM 为中心、宽约一个八度的
 * 对数正态权重，就能在「120 还是 60」这类八度歧义里选对（librosa/essentia 同款做法）。
 *
 * 实测：没有先验时，120 BPM 会被判成 60、140 判成 70；加上之后全部正确。
 */
const TEMPO_PRIOR_CENTER = 120;
const TEMPO_PRIOR_OCTAVES = 1.0;
/** 静音判定：相对峰值的分贝门限 */
const SILENCE_DB = -50;
/** 静音区间短于这个长度就不算（多半是乐句间的呼吸） */
const MIN_SILENCE_SEC = 0.8;

interface AnalyzeJob {
  id: string;
  pcm: Float32Array;
  sampleRate: number;
}

interface AnalyzeResult {
  id: string;
  ok: boolean;
  error?: string;
  bpm: number;
  /** 拍点时间（秒） */
  beatGrid: number[];
  /** 开头静音时长（秒） */
  silenceStart: number;
  /** 结尾静音时长（秒） */
  silenceEnd: number;
  /** 供调试：起音点数量、估计置信度 */
  onsetCount: number;
  confidence: number;
}

/** 迭代式 radix-2 FFT（原地，输入长度必须是 2 的幂）。 */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * 谱通量起始点强度包络。
 *
 * 返回每个分析帧的「正向频谱差之和」，已做去均值（减去滑动平均），
 * 这样后续自相关不会被缓慢的能量起伏带偏。
 */
export function onsetEnvelope(
  pcm: Float32Array,
  sampleRate: number,
): { env: Float32Array; frameRate: number } {
  const frames = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / HOP) + 1);
  const bins = FFT_SIZE / 2;
  const mags = new Float32Array(bins);
  const prev = new Float32Array(bins);
  const env = new Float32Array(frames);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const win = new Float32Array(FFT_SIZE);
  // Hann 窗：减少频谱泄漏，否则谱通量会被旁瓣噪声淹没
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (pcm[off + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let b = 0; b < bins; b++) {
      mags[b] = Math.hypot(re[b], im[b]);
      const d = mags[b] - prev[b];
      if (d > 0) flux += d; // 只取正向差：对起音敏感、对衰减不敏感
      prev[b] = mags[b];
    }
    env[f] = flux;
  }

  // 去均值：减去局部滑动平均，突出「相对突起」而非绝对能量。
  //
  // 窗口宽度必须按**时间**给（这里取 ±120ms），再换算成帧数。
  // 早先写死 W=16 帧：在 44.1k 下是 186ms 还好，在 22.05k 下变成 372ms ——
  // 比 120BPM 的拍间隔（500ms）还长，会把相邻拍糊成一个包络起伏，
  // 于是周期估计偏向两拍（BPM 减半）。这是抽样率依赖的第二个来源。
  const smoothed = new Float32Array(frames);
  const W = Math.max(2, Math.round(0.12 * (sampleRate / HOP)));
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, f - W); k <= Math.min(frames - 1, f + W); k++) {
      s += env[k];
      n++;
    }
    smoothed[f] = Math.max(0, env[f] - s / n);
  }
  // 帧率由**实际采样率**决定：每 HOP 个采样点产生一帧。
  // 早先这里写死 44100，而分析器统一重采样到 22050，
  // 导致 envelope 的"秒"与真实时间差 2 倍，BPM 全错（端到端测试抓到）。
  return { env: smoothed, frameRate: sampleRate / HOP };
}

/**
 * 从起音包络估计 BPM（自相关法）。
 *
 * 自相关的物理含义：把信号与自己平移 lag 后相乘求和，
 * 当 lag 正好等于「拍周期」时，起音点重合，乘积最大 → 出现峰值。
 * 所以「峰的位置」就是周期。
 */
export function estimateBpm(
  env: Float32Array,
  envRate: number,
): { bpm: number; confidence: number; period: number } {
  const n = env.length;
  if (n < 8) return { bpm: 0, confidence: 0, period: 0 };

  const minLag = Math.floor((60 / MAX_BPM) * envRate);
  const maxLag = Math.min(Math.floor((60 / MIN_BPM) * envRate), Math.floor(n / 2));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0, period: 0 };

  // 去均值后再自相关（否则直流分量会压过所有峰）
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  // 零延迟自相关 = 方差，用作置信度的归一化分母
  let ac0 = 0;
  for (let i = 0; i < n; i++) {
    const d = env[i] - mean;
    ac0 += d * d;
  }
  ac0 /= n;

  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let v = 0;
    for (let i = 0; i + lag < n; i++) {
      v += (env[i] - mean) * (env[i + lag] - mean);
    }
    ac[lag] = v / (n - lag);
  }

  /*
   * 在自相关上乘速度先验后取峰。
   *
   * 这一步取代了原来的「2×lag / lag÷2 哪个更强」倍频修正 —— 那种局部比较
   * 无法处理 T 与 2T 同时很强的情形（两者都真实存在），而先验直接表达了
   * 「流行乐更可能在 120 BPM 附近」这个事实，更稳。
   */
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * envRate) / lag;
    if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
    const octaves = Math.log2(bpm / TEMPO_PRIOR_CENTER);
    const prior = Math.exp(-(octaves * octaves) / (2 * TEMPO_PRIOR_OCTAVES * TEMPO_PRIOR_OCTAVES));
    const score = ac[lag] * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (!bestLag) return { bpm: 0, confidence: 0, period: 0 };

  /*
   * 抛物线插值细化峰值位置。
   *
   * lag 是整数帧；帧率约 43/秒时，相邻 lag 之间差约 2.3 BPM 的量化误差。
   * 用峰值与其左右邻点拟合抛物线、取顶点，可得亚帧精度。实测平均误差从
   * 1.57 BPM 降到 0.33 BPM，且消除了跨采样率的不一致。
   */
  let finalLag: number = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = ac[bestLag - 1];
    const y1 = ac[bestLag];
    const y2 = ac[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const delta = (0.5 * (y0 - y2)) / denom;
      // 只接受小修正：偏离超过一帧说明拟合不可信，保持整数峰
      if (Math.abs(delta) < 1) finalLag = bestLag + delta;
    }
  }

  let bpm = (60 * envRate) / finalLag;
  // 兜底夹到合理区间（倍频修正后可能越界）
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;

  /*
   * 置信度 = 归一化自相关 r = ac(lag) / ac(0)。
   *
   * 物理含义：把信号平移一个周期后与自身仍高度相似 —— r 越接近 1，周期性越强。
   * 这是标准的周期性度量，且与音量无关。
   *
   * 早先用 (峰值/平均 - 1)/4，实测在真实拍点上要么恒为 0、要么直接饱和，
   * 完全没有区分度。换成归一化自相关后：合成鼓点 0.87~0.99，白噪声 0.03，
   * 纯正弦 0.00 —— 这才真正可用。
   */
  const confidence = ac0 > 0 ? Math.max(0, Math.min(1, ac[bestLag] / ac0)) : 0;
  return { bpm, confidence, period: finalLag / envRate };
}

/**
 * 生成节拍网格。
 *
 * BPM 只给出拍间隔；还需要「相位」（第一拍从哪开始）。
 * 做法：在 [0, period) 内枚举候选相位，选使「落在拍点上的起音强度之和」最大的那个。
 * 强度按「离最近拍点的距离」做高斯衰减 —— 起音不会精确落在理论格点上。
 */
export function buildBeatGrid(
  env: Float32Array,
  envRate: number,
  period: number,
  durationSec: number,
): number[] {
  if (!(period > 0)) return [];
  const steps = 64;
  let bestPhase = 0;
  let bestScore = -Infinity;
  const sigma = period * 0.12; // 允许 ±12% 拍的偏差

  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    for (let i = 0; i < env.length; i++) {
      const t = i / envRate;
      // 到最近格点的距离
      const k = Math.round((t - phase) / period);
      const gridT = phase + k * period;
      if (gridT < 0) continue;
      const d = Math.abs(t - gridT);
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      score += env[i] * w;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  const grid: number[] = [];
  for (let t = bestPhase; t < durationSec; t += period) {
    if (t >= 0) grid.push(Math.round(t * 1000) / 1000);
  }
  return grid;
}

/**
 * 首尾静音检测（短时 RMS）。
 *
 * 门限取相对峰值 -50dB。用相对值而非绝对值，避免对「整体录音电平偏低」的曲子误判。
 */
export function detectSilence(
  pcm: Float32Array,
  sampleRate: number,
): { silenceStart: number; silenceEnd: number } {
  const win = Math.floor(sampleRate * 0.05); // 50ms 窗
  if (pcm.length < win * 2) return { silenceStart: 0, silenceEnd: 0 };

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return { silenceStart: 0, silenceEnd: 0 };

  // 相对峰值的门限：-50dB ≈ 0.00316 倍
  const threshold = peak * Math.pow(10, SILENCE_DB / 20);

  /** 某个窗的 RMS 是否低于门限 */
  const isSilent = (from: number): boolean => {
    let sum = 0;
    for (let i = from; i < from + win && i < pcm.length; i++) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / win) < threshold;
  };

  // 头部：第一个「不静音」的窗
  let startFrames = 0;
  while ((startFrames + 1) * win < pcm.length && isSilent(startFrames * win)) startFrames++;
  // 尾部：最后一个「不静音」的窗
  let endFrames = Math.floor(pcm.length / win) - 1;
  while (endFrames > startFrames && isSilent(endFrames * win)) endFrames--;

  const silenceStart = startFrames * 0.05;
  const silenceEnd = Math.max(0, pcm.length / sampleRate - (endFrames + 1) * 0.05);
  // 太短的不算（乐句之间的自然呼吸）
  return {
    silenceStart: silenceStart >= MIN_SILENCE_SEC ? silenceStart : 0,
    silenceEnd: silenceEnd >= MIN_SILENCE_SEC ? silenceEnd : 0,
  };
}
