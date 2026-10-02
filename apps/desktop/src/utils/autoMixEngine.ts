/**
 * AutoMix 过渡执行器：从「还剩多久」到「怎么混」的决策与执行。
 *
 * 一次过渡的完整流程（每一步都可能降级，但**绝不会中断播放**）：
 *
 *   1. 距当前曲结束 T 秒 → 触发准备
 *   2. 分析当前曲与下一曲（查缓存 / 现算）
 *   3. 决定过渡点：有节拍网格就吸附到小节边界；有尾部静音就提前
 *   4. 决定是否对拍：两首 BPM 比值在允许范围内才做
 *   5. 预载下一曲到另一个 deck，跳过开头静音
 *   6. 执行等功率交叉淡化
 *
 * ## 为什么降级链这么重要
 *
 * 分析是尽力而为的：在线曲可能拉不到完整音频、纯人声曲可能测不出 BPM。
 * 任何一步失败都必须退回一个仍然比硬切好的行为。所以默认是淡入淡出，
 * 对拍与裁静音都是加分项而不是前提。
 */
import { beatMatchRate, snapToBar } from "./autoMix";
import type { TrackAnalysis } from "./autoMixAnalysis";

/** 过渡参数（来自设置） */
export interface AutoMixSettings {
  enabled: boolean;
  /** 过渡时长（秒） */
  durationSec: number;
  /** 是否尝试对拍 */
  beatMatch: boolean;
  /** 是否裁掉首尾静音 */
  trimSilence: boolean;
  /** 对拍允许的最大速度偏移（比例，如 0.06 = ±6%） */
  maxRateDeviation: number;
}

/** 一次过渡的决策结果（可观测，供调试面板展示） */
export interface MixPlan {
  /** 淡出起点的绝对时间（当前曲内，秒） */
  fadeOutAt: number;
  /** 下一曲的起播位置（秒，跳过开头静音后） */
  nextStartAt: number;
  /** 对拍速度比；null = 不对拍 */
  rate: number | null;
  /** 过渡时长（秒） */
  durationSec: number;
  /** 决策依据，逐条记录，便于在控制台核对「为什么这么混」 */
  reasons: string[];
}

/**
 * 决定怎么混。纯函数，方便单测 —— 所有输入都是显式参数。
 */
export function planMix(
  curDuration: number,
  cur: TrackAnalysis | null,
  next: TrackAnalysis | null,
  now: number,
  cfg: AutoMixSettings,
): MixPlan {
  const reasons: string[] = [];
  const dur = Math.max(1, cfg.durationSec);

  // ---- 淡出起点：默认「结束前 dur 秒」，最保守的兜底 ----
  let fadeOutAt = Math.max(0, curDuration - dur);
  reasons.push(
    `基准淡出点 = 时长 ${curDuration.toFixed(1)}s - 过渡 ${dur}s = ${fadeOutAt.toFixed(1)}s`,
  );

  if (cfg.trimSilence && cur && cur.silenceEnd > 0) {
    const contentEnd = curDuration - cur.silenceEnd;
    if (contentEnd < fadeOutAt + dur) {
      // 尾部有静音：让过渡**跨越**这段静音，而不是淡到寂静里再干等
      fadeOutAt = Math.max(0, contentEnd - dur / 2);
      reasons.push(
        `尾部检测到 ${cur.silenceEnd.toFixed(1)}s 静音，淡出点提前到 ${fadeOutAt.toFixed(1)}s`,
      );
    }
  }

  if (cur && cur.beatGrid.length > 0) {
    const targetEnd = Math.min(curDuration, fadeOutAt + dur);
    const snappedEnd = snapToBar(cur.beatGrid, targetEnd);
    // 只接受差值不超过 2 秒的吸附，否则离原意图太远
    if (Math.abs(snappedEnd - targetEnd) <= 2) {
      reasons.push(
        `过渡终点吸附到小节边界 ${snappedEnd.toFixed(2)}s（偏移 ${(snappedEnd - targetEnd).toFixed(2)}s）`,
      );
      fadeOutAt = Math.max(0, snappedEnd - dur);
    } else {
      reasons.push(`最近小节边界 ${snappedEnd.toFixed(2)}s 偏移过大（>2s），不做吸附`);
    }
  } else {
    reasons.push("无节拍网格，不做小节吸附");
  }

  if (fadeOutAt < now) {
    fadeOutAt = now;
    reasons.push("淡出点早于当前播放位置，钳到当前位置");
  }

  // ---- 下一曲起播位置 ----
  let nextStartAt = 0;
  if (cfg.trimSilence && next && next.silenceStart > 0.3) {
    nextStartAt = next.silenceStart;
    reasons.push(`下一曲开头有 ${next.silenceStart.toFixed(1)}s 静音，从其之后起播`);
  } else {
    reasons.push("下一曲从头起播");
  }

  // ---- 对拍 ----
  let rate: number | null = null;
  if (!cfg.beatMatch) {
    reasons.push("对拍已在设置中关闭");
  } else if (!cur || !next) {
    reasons.push("缺少分析结果，无法对拍");
  } else if (!(cur.bpm > 0) || !(next.bpm > 0)) {
    reasons.push(`BPM 不可用（当前 ${cur.bpm || "无"} / 下一曲 ${next.bpm || "无"}）`);
  } else {
    rate = beatMatchRate(cur.bpm, next.bpm, cfg.maxRateDeviation);
    if (rate === null) {
      const raw = cur.bpm / next.bpm;
      reasons.push(
        `BPM 差过大（${cur.bpm} vs ${next.bpm}，比值 ${raw.toFixed(3)}），放弃对拍以避免明显走音`,
      );
    } else {
      reasons.push(`对拍：${next.bpm} BPM -> ${cur.bpm} BPM，速度比 ${rate.toFixed(4)}`);
    }
  }

  return { fadeOutAt, nextStartAt, rate, durationSec: dur, reasons };
}
