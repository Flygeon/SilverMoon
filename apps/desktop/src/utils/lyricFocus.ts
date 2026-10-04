/**
 * 已读完歌词行的「失去焦点」过渡（对齐 AMLL 的 LyricLineGroup / LyricLineEl）。
 *
 * AMLL 的真实模型（packages/core/src/lyric-player/base/*）：
 *
 * - **布局层只算一个统一的 viewportStartY**，每行纵坐标 = viewportStartY + 行高前缀和。
 *   焦点行前进一行时，整摞歌词**刚性上移**「上一行行高 + 行距」，没有任何「已读行
 *   额外再多上移一点」的项。观感里的「唱完往上走」就是这次刚性滚动本身。
 * - **缩放在 LyricLineEl**：非当前行在播放中缩到 97%（SCALE_ASPECT），和声行 75%；
 *   paused 时回到 100%。由 lineTransforms.scale 弹簧补间（mass 2 / damping 25 /
 *   stiffness 100）。
 * - **模糊在 LyricLineGroup 的 resolveBlurLevel**：按与焦点的行距分档，已读行比同
 *   距离的未读行再糊一档，封顶 5px；焦点行不糊。
 *
 * 这里只负责「目标值怎么取」这一层；补间由 LyricsView 的 Spring 逐帧完成。
 */

/** 当前行（焦点行）的缩放：满值 */
export const LYRIC_SCALE_FOCUS = 100;
/** 非当前行在播放中的缩放（AMLL 的 SCALE_ASPECT） */
export const LYRIC_SCALE_UNFOCUSED = 97;
/** 背景和声行在播放中的缩放（AMLL 的 bgScale） */
export const LYRIC_SCALE_BG_UNFOCUSED = 75;

/**
 * 某一行的目标缩放（百分比，100 = 原大小）。
 *
 * @param isActive 是否当前行
 * @param isPlaying 是否正在播放。暂停时不做「收起」——AMLL 同样只在播放中缩小，
 *   否则暂停后每行都会僵在一个变小的状态里。
 * @param isBg 是否背景和声子行
 */
export function lyricLineScale(isActive: boolean, isPlaying: boolean, isBg = false): number {
  if (isActive || !isPlaying) return LYRIC_SCALE_FOCUS;
  return isBg ? LYRIC_SCALE_BG_UNFOCUSED : LYRIC_SCALE_UNFOCUSED;
}

/** 缩放的弹簧参数（对齐 AMLL 的 scaleSpringParams：mass 2 / damping 25 / stiffness 100） */
export const SCALE_SPRING_PARAMS = { mass: 2, damping: 25, stiffness: 100 } as const;
/** 背景和声行缩放的弹簧参数（对齐 AMLL 的 scaleForBGSpringParams） */
export const SCALE_SPRING_PARAMS_BG = { mass: 1, damping: 20, stiffness: 50 } as const;

/** 模糊上限（px）：对齐 AMLL render 里的 min(5, blur)，避免远行拖垮 GPU */
export const LYRIC_MAX_BLUR = 5;

/**
 * 某一行的模糊档位（px）。
 *
 * 对齐 AMLL 的 resolveBlurLevel：
 * - 关闭模糊时 0；焦点行不糊（0）；
 * - 视口外的行直接给满档（AMLL 返回 5，不判断焦点——顺序上先判视口）；
 * - 其余按与焦点的行距分档：**已读行比同距离的未读行再糊一档**
 *   （AMLL：已读 1 + (距离 + 1) = 距离 + 2，未读 1 + 距离），所以唱过的行
 *   往后退得更快，层次是「越往前越清楚」；
 * - 档位封顶 LYRIC_MAX_BLUR。
 *
 * 档位是离散的，平滑交给 .lyric-item 上 filter 的 0.4s 过渡（与 AMLL 同）。
 */
export function lyricLineBlur(
  index: number,
  activeIdx: number,
  inViewport: boolean,
  enabled: boolean,
): number {
  if (!enabled) return 0;
  if (!inViewport) return LYRIC_MAX_BLUR;
  if (index === activeIdx) return 0;
  const distance = Math.abs(index - activeIdx);
  const level = index < activeIdx ? distance + 2 : distance + 1;
  return Math.min(LYRIC_MAX_BLUR, level);
}

/** 逐行级联的起步延迟（秒），对齐 AMLL 的 Duration.fromSecs(.05) */
export const CASCADE_BASE_DELAY_SEC = 0.05;
/** 每往下一行，延迟增量按此比例衰减（AMLL 的 1 / 1.05），使总延迟收敛 */
export const CASCADE_DECAY = 1 / 1.05;

/**
 * 第 distanceBelow 行（0 = 焦点行）的级联启动延迟（秒）。
 *
 * AMLL 是逐行把 baseDelay 累加进 delay，且每过一行就把 baseDelay 乘 1/1.05，
 * 因此远端行的延迟**单调递增但收敛**（上限约 1.05s），而不是无限增长，也绝不会
 * 在中途掉回 0。旧实现写的是「超过 10 行直接置 0」：那会让更靠下的行反而比近处
 * 的行先动，波浪散架，而且恰好在第 10 行边界上突兀。
 */
export function cascadeDelaySec(distanceBelow: number): number {
  if (distanceBelow <= 0) return 0;
  let delay = 0;
  let base = CASCADE_BASE_DELAY_SEC;
  for (let k = 0; k < distanceBelow; k++) {
    delay += base;
    base *= CASCADE_DECAY;
  }
  return delay;
}

/**
 * 第 index 行相对焦点行的纵坐标（px）。
 *
 * 与 AMLL 一致：位置 = 行高前缀和 + 停靠偏移，**不含任何「已读行额外上移」的项**。
 * 焦点行前进时，所有行的位移量完全相同（都等于 -(上一行行高 + 行距)），也就是
 * 整摞歌词刚性滚动。一旦给已读行加上额外的上移量，每切一行那一摞就会被多顶上去
 * 一截，且越靠上的已读行累计得越多——观感正是「突然往上一跳」。
 *
 * @param index 目标行下标
 * @param activeIdx 当前焦点行下标
 * @param heights 每行实测高度
 * @param lineGap 行间间距
 * @param offset 焦点行的停靠高度
 */
export function lineOffset(
  index: number,
  activeIdx: number,
  heights: readonly number[],
  lineGap: number,
  offset: number,
): number {
  let res = 0;
  if (index > activeIdx) {
    for (let i = activeIdx; i < index; i++) res += (heights[i] ?? 0) + lineGap;
  } else {
    for (let i = activeIdx; i > index; i--) res -= (heights[i - 1] ?? 0) + lineGap;
  }
  return res + offset;
}

// ---- 旧版换行动效（AMLL 改造之前的实现）----
//
// 2026-10 的 AMLL 改造之前，自研歌词视图的换行是这一套：布局层同样只算目标位移，
// 但补间交给每行自己的 CSS transition（`0.7s cubic-bezier(.19,.11,0,1)`），级联用
// setTimeout 错开。它被完整保留在 `lyricLineMotion === "legacy"` 分支里（见 LyricsView）。
//
// 与新版（弹簧）的**唯一**差别就是下面这两条取样规则——位移公式本身两版通用，
// 所以直接复用上面的 lineOffset：
//
// - 级联延迟：旧版是 `(n * 70 - n * 10) ms`（n = 与当前行的距离 + 1），且**超过 10 行
//   直接同步归位**。新版改成收敛级数（见 cascadeDelaySec），远端行不再突然抢先。
// - 模糊：旧版就是 `blur(距离)px`，不封顶、也不区分已读 / 未读。

/** 旧版级联的单行步进（ms）：每远一行多等的时间，旧实现里是 `n * 70` */
export const LEGACY_CASCADE_STEP_MS = 70;
/** 旧版级联的步进折扣（ms）：与上一条相抵后每行净增 60ms */
export const LEGACY_CASCADE_OFFSET_MS = 10;
/**
 * 超过这个行数就同步归位（不再错开）。
 *
 * 旧实现用 n = 距离 + 1 判断，因此实际是「距离 ≥ 10 的行」直接归位。保留这一条是
 * 为了旧版观感一致：远处行会在切行瞬间与近处行同时出发。
 */
export const LEGACY_CASCADE_SYNC_AFTER = 10;

/**
 * 旧实现的 `n = i - index + 1`：**当前行也会拿到 n = 1**，也就是连当前行都被延了 60ms。
 * 超过 10 行则归 0（同步归位）。
 */
function legacyCascadeN(distanceBelow: number): number {
  const n = distanceBelow + 1;
  return n > LEGACY_CASCADE_SYNC_AFTER ? 0 : n;
}

/**
 * 旧版的级联启动延迟（ms）：`n * 70 - n * 10`，n = 与当前行的行距 + 1。
 *
 * - 上方行（n ≤ 0）不延迟；
 * - **当前行会拿到 60ms**（旧实现如此，等于整摞晚 60ms 起步）；
 * - 距离 ≥ 10 的行归 0，与近处行同时出发（旧实现的长尾处理，新版已换成收敛级数）。
 *
 * @param distanceBelow 目标行相对当前行的行距（0 = 当前行，负数 = 上方行）
 */
export function legacyCascadeDelayMs(distanceBelow: number): number {
  const n = legacyCascadeN(distanceBelow);
  const ms = n * LEGACY_CASCADE_STEP_MS - n * LEGACY_CASCADE_OFFSET_MS;
  // 上方行（n ≤ 0）与远端行（n 被置 0）都不错开，与旧实现的 `delay <= 0` 分支一致
  return ms > 0 ? ms : 0;
}

/**
 * 旧版的行模糊档位（px）。
 *
 * 旧实现就是 `blur(距离)`：既不封顶（新版封顶 LYRIC_MAX_BLUR），也不区分已读 / 未读
 * （新版给已读行再加一档）。这里刻意保持原样——旧版的意义就是还原当年的观感。
 *
 * @param index 目标行下标
 * @param activeIdx 当前焦点行下标
 * @param enabled 是否开启「歌词模糊」设置
 */
export function legacyLineBlur(index: number, activeIdx: number, enabled: boolean): number {
  if (!enabled) return 0;
  return Math.abs(index - activeIdx);
}
