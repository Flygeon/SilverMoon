/**
 * 播放器频谱数据源（「无歌词时显示实时频谱」用）。
 *
 * 为什么必须复用 audioEffects 的 AudioContext：
 * `createMediaElementSource` 对**同一个** media element 只能调用一次，
 * 第二次会抛 InvalidStateError。所以频谱不能自建 AudioContext 另接一份 ——
 * 只能挂到音效引擎既有的分析器抽头上，而那个抽头接在 limiter 之后，
 * 因此读到的正是用户实际听到的信号（含 AutoMix 双 deck 的混音结果）。
 *
 * 本模块只做**读取**：不创建 AudioContext，不改动音效链的任何连接，
 * 也不向 destination 连任何节点。
 */
import { audioEffectEngine } from "./audioEffects";

/** 对外输出的频谱柱数量 */
export const SPECTRUM_BINS = 64;

/** 分析器抽头（惰性取得；未接入时为 null）。 */
let analyser: AnalyserNode | null = null;

/**
 * 复用的时域数据缓冲。
 *
 * 128 = fftSize 256 对应的 `frequencyBinCount`。每帧新建 Uint8Array 会在
 * 60fps 下持续制造垃圾（每秒几十 KB），所以整个模块共用一个缓冲，
 * 靠每次 getByteFrequencyData 覆盖写入来复用。
 */
let buf: Uint8Array<ArrayBuffer> | null = null;

/** 上一次降采样的输出，同样复用，避免每帧分配数组。 */
const output: number[] = new Array<number>(SPECTRUM_BINS).fill(0);

/**
 * 确保分析链已建立（幂等）。
 *
 * 幂等靠两层保证：本模块缓存了 analyser；引擎侧 getAnalyser() 自身也是
 * 懒创建 + 复用。未接入时用传入的 media 接入（ensureAttached 内部同样幂等，
 * 已 attach 时不会重复 createMediaElementSource）。
 *
 * @returns 是否可用（true 表示随后 readSpectrum() 能拿到数据）
 */
export function ensureSpectrum(media: HTMLAudioElement): boolean {
  if (analyser) return true;
  if (!audioEffectEngine.ensureAttached(media)) return false;
  analyser = audioEffectEngine.getAnalyser();
  return analyser !== null;
}

/**
 * 读取当前频谱。
 *
 * @returns 长度 SPECTRUM_BINS、取值 0-255 的整数数组；未就绪返回 null。
 */
export function readSpectrum(): number[] | null {
  if (!analyser) return null;
  const bins = analyser.frequencyBinCount;
  if (bins < SPECTRUM_BINS) return null;
  if (!buf || buf.length !== bins) buf = new Uint8Array(bins);
  analyser.getByteFrequencyData(buf);
  // 降采样：相邻两个 bin 取平均。
  //
  // 为什么选平均而不是对数频段聚合：本模块的输出直接驱动 64 根等宽的
  // 频谱柱，柱子只表达「这一段能量有多大」，不做音高分析；线性相邻合并
  // 既能让每根柱子的能量更稳（两个 bin 平均天然抑噪），映射也直观可验证。
  // 对数聚合会让低频柱过窄、高频柱过宽，只有在需要「按音高排列」时才值得，
  // 那是另一种可视化，不应强加给这里。
  //
  // bins 是 2 的幂（fftSize 256 → 128），因此一定整除 SPECTRUM_BINS。
  const step = bins / SPECTRUM_BINS;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const from = i * step;
    const to = from + step;
    let sum = 0;
    for (let j = from; j < to; j++) sum += buf[j];
    output[i] = Math.round(sum / step);
  }
  // 返回副本：调用方可能长期持有（缓存到下一帧），共享内部数组会被下一帧覆写。
  return output.slice();
}

/** 释放（不销毁引擎本身，只把本模块的引用清空）。 */
export function disposeSpectrum(): void {
  analyser = null;
  buf = null;
}
