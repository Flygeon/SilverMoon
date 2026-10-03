/**
 * 歌词字体栈。
 *
 * 自研歌词视图与 AMLL 歌词视图共用同一份映射：字体是**用户预期一致**的设置项，
 * 两套引擎下若各自维护一份，切换引擎时字体会悄悄变掉。
 */
import type { LyricFontKey } from "@/stores/settings";

export const LYRIC_FONTS: Record<LyricFontKey, string> = {
  system:
    '"SarasaGothicSC-Regular","SFPro-Regular","Helvetica Neue","Microsoft YaHei",system-ui,sans-serif',
  sans: '"Helvetica Neue","Microsoft YaHei","Hiragino Sans GB",sans-serif',
  serif: 'Georgia,"Songti SC","SimSun",serif',
  kai: '"KaiTi","STKaiti","Kai",cursive',
  yuan: '"Yuanti SC","YouYuan","Microsoft JhengHei UI",sans-serif',
};

/** 取字体栈；未知值退回系统栈 */
export function lyricFontFamily(key: LyricFontKey): string {
  return LYRIC_FONTS[key] ?? LYRIC_FONTS.system;
}
