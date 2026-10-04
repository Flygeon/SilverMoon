/**
 * 「写音乐标签」对话框的草稿与归一化（纯函数，无副作用）。
 *
 * 打开 Dialog 时把「当前这首歌的已知信息」摊平成一份 {@link MusicTagFields} 表单值；
 * 之后所有编辑都在这份草稿上进行，应用时整份写盘 / 写缓存。
 *
 * 约定：
 * - 全部字段都是 string，空串表示「不写入 / 清空」；
 * - 平台与库里的元数据可能缺字段（null/undefined），一律兜底成空串，
 *   否则 v-model 绑到 null 上会让输入框变成非受控。
 */
import type { MediaEntry, MusicTagFields, MusicTagSearchResult, OnlineSong } from "@shared/types";

/** 一份全空的标签草稿。 */
export function emptyMusicTagFields(): MusicTagFields {
  return {
    title: "",
    artist: "",
    album: "",
    albumArtist: "",
    year: "",
    trackNo: "",
    discNo: "",
    genre: "",
    comment: "",
    lyrics: "",
  };
}

/** 任意值 → 去掉首尾空白的字符串（null/undefined → ""）。 */
function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * 本地曲目的初始草稿：库内列表项 + 可选歌词。
 *
 * `MediaEntry` 只带列表级字段（title/artist/album），albumArtist / trackNo 等
 * 拿不到，留给用户在 Dialog 里手动补。
 */
export function fieldsFromMediaEntry(entry: MediaEntry, lyrics?: string | null): MusicTagFields {
  return {
    ...emptyMusicTagFields(),
    title: str(entry.title) || str(entry.name),
    artist: str(entry.artist),
    album: str(entry.album),
    lyrics: str(lyrics),
  };
}

/**
 * 在线歌曲的初始草稿。
 *
 * `OnlineSong` 没有年份 / 音轨号等字段，只有基础四项；其余靠 API 搜索填充。
 */
export function fieldsFromOnlineSong(song: OnlineSong, lyrics?: string | null): MusicTagFields {
  return {
    ...emptyMusicTagFields(),
    title: str(song.name),
    artist: str(song.artist),
    album: str(song.album),
    lyrics: str(lyrics),
  };
}

/** API 搜索候选 → 草稿（候选字段不全时保留自身的空串语义）。 */
export function fieldsFromSearchResult(result: MusicTagSearchResult): MusicTagFields {
  return {
    ...emptyMusicTagFields(),
    title: str(result.title),
    artist: str(result.artist),
    album: str(result.album),
    year: str(result.year),
  };
}

/** 两份草稿是否有差异（应用前判断是否需要写盘 / 提示）。 */
export function fieldsDirty(a: MusicTagFields, b: MusicTagFields): boolean {
  const keys = Object.keys(emptyMusicTagFields()) as (keyof MusicTagFields)[];
  return keys.some((key) => str(a[key]) !== str(b[key]));
}
