/**
 * 逐词上浮（对齐 AMLL 的 createFloatAnimation）。
 *
 * AMLL 的做法（packages/core/src/lyric-player/dom/animation/float/index.ts）：
 *   delay     = word.startTime - lineStartTime   → 词一开始就起浮
 *   duration  = max(1000ms, 词时长)
 *   up        = 0.05em（背景和声行 ×2）
 *   easing    = ease-out
 *   fill      = both                             → 结束时停在最大上浮
 *   composite = add                              → 叠加在词自身的 transform 上
 *
 * 关键点：这套时序**交给 Web Animations API 调度**，而不是自己按播放位置逐帧插值。
 *
 * 逐帧插值那条路（旧实现读 audioEl.currentTime 算 ease-out 再写 CSS 变量）有两个
 * 硬伤，都会表现为「字、词上浮有顿感」：
 * 1. audioEl.currentTime 的推进粒度并不等于帧率，逐帧读到的值会先原地不动再跳一段，
 *    上浮于是走成台阶；
 * 2. 每帧写一个参与 transform 的 CSS 变量要走主线程样式重算，主线程一忙就掉帧。
 *
 * 交给 WAAPI 后由浏览器按动画时间轴逐帧采样（transform 动画还能上合成器），位移连续，
 * 且不再占用主线程逐帧写样式。
 */
import type { WordUnit } from "@shared/types";

/** 主词上浮幅度（em）。AMLL 用 0.05em，字号变化时幅度同比缩放。 */
export const WORD_FLOAT_EM = 0.05;

/** 一条上浮动画的时序，直接喂给 Web Animations API */
export interface FloatTiming {
  /** 相对**歌词行**起点的延迟（ms），即「这个词什么时候开始浮」 */
  delayMs: number;
  /** 动画时长（ms）；不足 1s 按 1s 计，否则短促的字会弹一下而不是「浮」 */
  durationMs: number;
  /** 终态位移（em，负值向上） */
  offsetEm: number;
  /** delayMs + durationMs：越过它这个词就浮满了，不必再 play */
  endMs: number;
}

/**
 * 某个词的上浮时序。
 *
 * @param lineStartSec 该行起点（秒）。AMLL 的 delay 是相对**行**的：整行一起创建动画时，
 *   每个词用「自己相对行首的偏移」起步，而不是相对整首歌。
 * @param isBg 背景和声行：幅度是主行的两倍（AMLL 的 if (isBG) up *= 2）
 */
export function floatTiming(unit: WordUnit, lineStartSec: number, isBg = false): FloatTiming {
  // 与 AMLL 同口径：delay 允许为负（词起点早于行首时，动画开局就已在进行中），
  // 非有限值才归零；时长取 max(1s, 词时长)。
  const rawDelay = (unit.start - lineStartSec) * 1000;
  const rawDuration = Math.max(1000, (unit.end - unit.start) * 1000);
  const delayMs = Number.isFinite(rawDelay) ? rawDelay : 0;
  const durationMs = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;
  const amp = isBg ? WORD_FLOAT_EM * 2 : WORD_FLOAT_EM;
  return { delayMs, durationMs, offsetEm: -amp, endMs: delayMs + durationMs };
}

/** 一条上浮动画的完整参数（关键帧 + WAAPI 选项） */
export interface FloatAnimationSpec {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  timing: FloatTiming;
}

/**
 * 构造上浮的 WAAPI 关键帧与选项（纯函数，便于测试与复用）。
 *
 * 单独抽出来是因为 LyricsView 里既要用它创建动画，也要在测试中断言这套参数；
 * 把「时序怎么算」与「DOM 怎么用」分开，前者可测，后者只剩调用。
 */
export function floatAnimationSpec(
  unit: WordUnit,
  lineStartSec: number,
  isBg = false,
): FloatAnimationSpec {
  const timing = floatTiming(unit, lineStartSec, isBg);
  const from = "translateY(0em)";
  const to = "translateY(" + timing.offsetEm + "em)";
  return {
    keyframes: [{ transform: from }, { transform: to }],
    options: {
      duration: timing.durationMs,
      delay: timing.delayMs,
      // ease-out：与 AMLL 一致。曲线由浏览器实现，不再自己二分求值。
      easing: "ease-out",
      // both：delay 期间保持在起点，结束后停在最大上浮
      fill: "both",
      // add：叠加在词自身已有的 transform 上（例如间奏三点自己带着 scale）
      composite: "add",
      id: "float-word",
    },
    timing,
  };
}
