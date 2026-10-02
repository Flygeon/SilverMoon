/**
 * 双 deck 播放引擎与 AutoMix 的纯逻辑。
 *
 * ## 为什么必须两个 audio 元素
 *
 * 交叉混音要求「两首歌同时出声」。本项目原先全应用只有一个 audio 单例，
 * 切歌就是换 src 再 load —— 换源天然互斥，物理上不可能重叠。
 * 所以要引入 A/B 两个 deck，轮流扮演「当前曲」与「下一曲」。
 *
 * ## 增益的作用
 *
 * 每个 deck 有一个 GainNode 作为淡入淡出总闸。AutoMix 的交叉淡化就是对这两个
 * 增益做互补的等功率插值 —— 注意不是线性插值，线性在中点会掉到 -6dB，
 * 听感是「音量塌了一下」。
 *
 * 未接入 Web Audio 时（音效未开启）退回直接控制 element.volume，
 * 这样 AutoMix 在不开启音效的情况下也能工作。
 */

/** deck 标识 */
export type DeckId = "a" | "b";

/**
 * 等功率交叉淡化系数。
 *
 * `t` 从 0（全 A）到 1（全 B）。返回两个增益，满足 gA^2 + gB^2 = 1 ——
 * 这是功率守恒，人耳感知的响度在中点不会塌陷。
 * 线性插值在中点是 0.5/0.5，合成功率仅 0.5，听感就是过渡时音量掉一下。
 */
export function equalPowerGains(t: number): { a: number; b: number } {
  const x = Math.max(0, Math.min(1, t));
  return { a: Math.cos((x * Math.PI) / 2), b: Math.sin((x * Math.PI) / 2) };
}

/**
 * 时间拉伸比（把下一首的节拍对齐到当前曲）。
 *
 * Apple AutoMix 用 AI 时间拉伸做到宽范围不变调；这里用 playbackRate 近似。
 * 对拍只需要几 % 的速度差，此时音高偏移基本不可察，因此：
 * - 把比值夹在 [1-maxDev, 1+maxDev]（默认 ±6%）：超出说明两首 BPM 差太多，
 *   强行对齐会明显走音，不如放弃对拍、退回普通淡化；
 * - 返回 null 表示「不该对拍」。
 */
export function beatMatchRate(bpmCur: number, bpmNext: number, maxDeviation = 0.06): number | null {
  if (!(bpmCur > 0) || !(bpmNext > 0)) return null;
  // 允许「倍速关系」：检测器常把某些曲子的 BPM 算成一半或两倍
  const candidates = [bpmNext, bpmNext * 2, bpmNext / 2].filter((b) => b > 0);
  let best: number | null = null;
  for (const cand of candidates) {
    const rate = bpmCur / cand;
    if (rate < 1 - maxDeviation || rate > 1 + maxDeviation) continue;
    // 取最接近 1 的（改动最小、音高偏移最小）
    if (best === null || Math.abs(rate - 1) < Math.abs(best - 1)) best = rate;
  }
  return best;
}

/**
 * 在节拍网格上找离目标时间最近的拍点。
 *
 * 过渡要发生在拍点上，否则听感是「在半个拍子里切进去」。
 * 没有网格时返回目标时间本身，调用方据此降级为普通淡化。
 */
export function snapToBeat(beatGrid: number[], target: number): number {
  if (!beatGrid.length) return target;
  let best = beatGrid[0];
  let bestD = Math.abs(best - target);
  for (const b of beatGrid) {
    const d = Math.abs(b - target);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * 从拍点回退到所在小节的第一个拍。
 *
 * 过渡点通常选在小节（甚至 8 小节）边界而不是随便一个拍 —— 这是乐句感的来源。
 * beatsPerBar 默认 4（4/4 拍）。
 */
export function snapToBar(beatGrid: number[], target: number, beatsPerBar = 4): number {
  if (!beatGrid.length) return target;
  const snapped = snapToBeat(beatGrid, target);
  const idx = beatGrid.indexOf(snapped);
  if (idx < 0) return snapped;
  const barStart = Math.floor(idx / beatsPerBar) * beatsPerBar;
  return beatGrid[barStart] ?? snapped;
}
