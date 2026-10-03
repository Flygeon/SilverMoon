/**
 * 逐词上浮（对齐 AMLL 的 createFloatAnimation）。
 *
 * AMLL 的做法（packages/core/src/lyric-player/dom/animation/float/index.ts）：
 *   delay    = word.startTime - lineStartTime   → 词一开始就起浮
 *   duration = max(1000ms, 词时长)
 *   up       = 0.05em（背景和声行 ×2）
 *   easing   = ease-out
 *   fill     = both                            → 结束时停在最大上浮
 *
 * 它是把这套时序交给 Web Animations 调度；我们走「rAF 逐帧写 CSS 变量」的路线，
 * 所以得自己算同一条曲线，才能还原同样的观感。
 */
import type { WordUnit } from "@shared/types";

/** 主词上浮幅度（em）。AMLL 用 0.05em，字号变化时幅度同比缩放。 */
export const WORD_FLOAT_EM = 0.05;

/**
 * CSS `ease-out` = `cubic-bezier(0, 0, 0.58, 1)`。
 *
 * 三次贝塞尔是参数曲线 (x(t), y(t))，要按 x 求 y 得先反解参数 t。
 * 这里的控制点 x 分量都落在 [0,1] 且单调，二分 14 次足够精确（误差 < 1e-4）。
 */
export function cubicBezierEaseOut(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const x1 = 0;
  const y1 = 0;
  const x2 = 0.58;
  const y2 = 1;
  const bez = (a: number, b: number, t: number): number =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return bez(y1, y2, t);
}

/**
 * 某个词在 `now` 时刻的上浮进度（0 = 未起步，1 = 浮满）。
 *
 * 时长不足 1s 的词按 1s 计（AMLL 的 `Math.max(1000, ...)`）——否则短促的字会
 * 在一瞬间弹起，看起来像卡了一下而不是「浮」。
 */
export function floatProgress(unit: WordUnit, now: number): number {
  const duration = Math.max(1, unit.end - unit.start);
  const elapsed = now - unit.start;
  if (elapsed <= 0) return 0;
  if (elapsed >= duration) return 1;
  return cubicBezierEaseOut(elapsed / duration);
}

/**
 * 某个词在 `now` 时刻的位移（em，负值向上）。
 *
 * @param isBg 背景和声行：幅度是主行的两倍（AMLL 的 `if (isBG) up *= 2`）
 */
export function wordFloatOffsetEm(unit: WordUnit, now: number, isBg = false): number {
  const amp = isBg ? WORD_FLOAT_EM * 2 : WORD_FLOAT_EM;
  const offset = -amp * floatProgress(unit, now);
  // 归一到 +0：-0 与 0 在 === 下相等但 String(-0) 是 "0" 之外还可能是 "-0"，
  // 会让上层「值没变就别写样式」的比较多做一次无意义写入
  return offset === 0 ? 0 : offset;
}

/** 判断某行是否属于「当前正在唱」的区间，供外部决定要不要驱动上浮 */
export function isUnitActive(unit: WordUnit, now: number): boolean {
  return now >= unit.start && now < unit.end;
}
