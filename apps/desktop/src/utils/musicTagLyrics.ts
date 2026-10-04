/**
 * 在线歌曲的「写音乐标签」适配层（Lead 维护）。
 *
 * `src/stores/player.ts` 的 `loadOnlineSong` 在解析完平台歌词后调用这里，得到
 * 「用户写入的标签歌词」优先的最终结果；同时把平台本身的歌词存成 original，
 * 让「还原默认」能把歌词也退回去。
 *
 * 依赖 capabilities 的四个方法（见 doc/music-tags-feature.md）：
 *   readOnlineMusicTagOriginal / writeOnlineMusicTagLyrics / readOnlineMusicTagLyrics
 *   （onlineApply）
 */
import { capabilities } from "@/capabilities";
import { parseLrc } from "@/utils/lyricTimeline";
import { useSettingsStore } from "@/stores/settings";
import type { LyricLine, OnlineSong } from "@shared/types";

/** 在线歌曲的合并 key：与 musicTags store 的 keyOf 保持一致 */
export function onlineTagKey(song: Pick<OnlineSong, "id" | "server">): string {
  return `${song.server ?? "netease"}:${song.id}`;
}

/** 把歌词文本解析成行；无时间轴的纯文本按「单行整段」展示，避免整段文字挤在 0 秒处。 */
export function lyricsFromText(text: string): LyricLine[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!/\[\d{1,3}:\d{1,2}/.test(trimmed)) {
    return [{ time: 0, text: trimmed }];
  }
  try {
    return parseLrc(trimmed, useSettingsStore().detectInstrumental);
  } catch {
    return [{ time: 0, text: trimmed }];
  }
}

/** 读取该在线歌曲「写标签」时保存的歌词；无则 null。 */
export async function taggedLyricsForSong(
  song: Pick<OnlineSong, "id" | "server">,
): Promise<string | null> {
  try {
    const text = await capabilities.readOnlineMusicTagLyrics(onlineTagKey(song));
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * 写入/清空该在线歌曲的标签歌词旁路文件（空串 = 清空）。
 * 由 Dialog 的「应用 / 还原默认」在 `musicTags.apply/clear` 之后调用。
 */
export async function writeTaggedLyrics(
  song: Pick<OnlineSong, "id" | "server">,
  lyrics: string,
): Promise<void> {
  try {
    await capabilities.writeOnlineMusicTagLyrics(onlineTagKey(song), lyrics);
  } catch {
    /* 旁路歌词失败不影响标签本身 */
  }
}

/**
 * 平台歌词首次出现时存成「原始快照」，供「还原默认」回退。
 * 只在没有快照时写一次 —— 否则第二次播放会用「用户歌词」把自己覆盖掉。
 */
export async function cacheLyricsForSong(
  song: Pick<OnlineSong, "id" | "server">,
  text: string,
): Promise<void> {
  if (!text || !text.trim()) return;
  try {
    const existing = await capabilities.readOnlineMusicTagOriginal(onlineTagKey(song));
    if (existing) return;
    await capabilities.cacheOnlineMusicTagOriginal(onlineTagKey(song), {
      lyrics: text,
    });
  } catch {
    /* 快照失败只影响还原默认的歌词回退，不阻塞播放 */
  }
}

/** 计算最终歌词：有标签歌词用它（覆盖平台），否则用平台解析结果。 */
export async function applyTagLyrics(
  song: Pick<OnlineSong, "id" | "server">,
  platformText: string,
  platformLines: LyricLine[],
): Promise<{ lines: LyricLine[]; raw: string; fromTag: boolean }> {
  const tagged = await taggedLyricsForSong(song);
  if (tagged) {
    const lines = lyricsFromText(tagged);
    if (lines.length) return { lines, raw: tagged, fromTag: true };
  }
  return { lines: platformLines, raw: platformText, fromTag: false };
}
