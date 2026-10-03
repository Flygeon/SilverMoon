/**
 * 已读完歌词行的「失去焦点」过渡（对齐 AMLL 的 LyricLineGroup.setLineTransformations）。
 *
 * AMLL 的模型：布局层给每一行算出**目标** top 与 scale，再交给两个彼此独立的弹簧
 * 逐帧补间（LyricLineGroup 的 posY 与 LyricLineEl 的 lineTransforms.scale），
 * 而不是一次性跳变。具体到「读完」这一档：
 * - 非当前行在**播放中**时缩到 97%（SCALE_ASPECT = 97，单位是百分比）；暂停时回到 100%，
 *   因为暂停时不该继续「收」下去；
 * - 背景和声行更小，75%；
 * - 已读完的行 top 更靠上（由布局按行高累加得出，见 LyricsView 的 getLayout）。
 *
 * 这里只负责「目标值怎么取」这一层；补间由 LyricsView 的两个 Spring 完成。
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

/**
 * 已读完的行整体上移的比例（相对行高）。
 *
 * AMLL 里这一档是**布局层**完成的：左侧保留的那部分（行高 × 系数）由内容高度决定，
 * 所以这里取行高的一个比例作为额外上移量，参与 getLayout 的累加，
 * 于是它和普通行距一样会被 posY 弹簧平滑补间，不会跳变。
 *
 * 取 0.22：与「缩小 3%」的视觉收束量相称——太小看不出「翻过去了」，
 * 太大会让相邻行挤在一起。
 */
export const PASSED_LINE_RISE_RATIO = 0.22;
