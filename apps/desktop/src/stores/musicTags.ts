/**
 * 在线歌曲的「写音乐标签」覆盖（内存 + 磁盘缓存）。
 *
 * 在线歌曲没有文件可写，标签覆盖分两层：
 * 1. 内存 Map —— 播放器每次切歌同步查询，不能再等一次 IPC；
 * 2. 主进程磁盘缓存 —— 重启后仍然生效，启动时 `hydrate()` 一次性灌回内存。
 *
 * key 统一是 `${server ?? "netease"}:${id}`（与 `src/utils/musicTagLyrics.ts` 的
 * `onlineTagKey` 保持一致），本地文件不走这里。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { capabilities } from "@/capabilities";
import { toAssetUrl } from "@/ipc/invoke";
import type {
  AppliedOnlineTags,
  MusicServer,
  MusicTagCover,
  MusicTagCoverMode,
  MusicTagFields,
} from "@shared/types";

/** 只需要 id / server 即可定位一首在线歌曲 */
type SongRef = { id: string; server?: MusicServer };

export const useMusicTagsStore = defineStore("musicTags", () => {
  /** key → 覆盖；整个 Map 替换以触发响应式 */
  const overrides = ref<Map<string, AppliedOnlineTags>>(new Map());
  /** 在途的磁盘读取（同一 key 并发 resolve 只发一次 IPC） */
  const pending = new Map<string, Promise<AppliedOnlineTags | undefined>>();

  /** key = `${server ?? "netease"}:${id}` */
  function keyOf(song: SongRef): string {
    return `${song.server ?? "netease"}:${song.id}`;
  }

  function put(entry: AppliedOnlineTags): void {
    overrides.value = new Map(overrides.value).set(entry.key, entry);
  }

  /** 同步取内存覆盖 */
  function get(song: SongRef): AppliedOnlineTags | undefined {
    return overrides.value.get(keyOf(song));
  }

  /** 内存没有时读磁盘缓存并写入内存（并发去重） */
  function resolve(song: SongRef): Promise<AppliedOnlineTags | undefined> {
    const key = keyOf(song);
    const hit = overrides.value.get(key);
    if (hit) return Promise.resolve(hit);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const task = capabilities
      .readOnlineMusicTags(key)
      .then((entry) => {
        if (entry) put(entry);
        return entry ?? undefined;
      })
      .catch(() => undefined)
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  /** 启动水合：listOnlineMusicTags() → 内存 */
  async function hydrate(): Promise<void> {
    try {
      const list = await capabilities.listOnlineMusicTags();
      const next = new Map(overrides.value);
      for (const entry of list) if (entry?.key) next.set(entry.key, entry);
      overrides.value = next;
    } catch {
      /* 水合失败不影响播放，后续 resolve 会按需再读 */
    }
  }

  /**
   * 应用覆盖：写内存 + 磁盘缓存。
   *
   * `original` 只在首次覆盖时确定，之后一律沿用已有值——否则第二次应用会把
   * 「上一次的覆盖」当成平台原值，「还原默认」就退不回真正的原始数据了。
   */
  async function apply(
    song: SongRef,
    fields: MusicTagFields,
    cover?: { mode: MusicTagCoverMode; image?: MusicTagCover },
  ): Promise<AppliedOnlineTags> {
    const key = keyOf(song);
    const existing = overrides.value.get(key) ?? (await capabilities.readOnlineMusicTags(key));
    const entry = await capabilities.cacheOnlineMusicTags(key, fields, cover);
    const merged: AppliedOnlineTags = {
      ...entry,
      key,
      fields,
      original: entry.original ?? existing?.original ?? null,
    };
    put(merged);
    return merged;
  }

  /** 还原默认：删磁盘缓存 + 内存（下次播放回到平台原始数据） */
  async function clear(song: SongRef): Promise<void> {
    const key = keyOf(song);
    try {
      await capabilities.removeOnlineMusicTags(key);
    } finally {
      const next = new Map(overrides.value);
      next.delete(key);
      overrides.value = next;
    }
  }

  /** 把覆盖转成播放器可直接用的形式（封面路径已在主进程落盘，这里只拼 asset://） */
  function playbackOverride(
    song: SongRef,
  ): { title: string; artist: string; album: string; coverUrl?: string } | undefined {
    const hit = overrides.value.get(keyOf(song));
    if (!hit) return undefined;
    return {
      title: hit.fields.title,
      artist: hit.fields.artist,
      album: hit.fields.album,
      coverUrl: hit.coverPath ? toAssetUrl(hit.coverPath) : undefined,
    };
  }

  return { overrides, keyOf, get, resolve, hydrate, apply, clear, playbackOverride };
});
