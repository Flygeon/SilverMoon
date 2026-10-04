/**
 * 「写音乐标签」取**逐字歌词**的编排（Lead 维护）。
 *
 * 背景：对话框原来只有一个「拉歌词」按钮（`fetchTagLyrics`），走的是各家最省事的
 * **逐行** LRC 接口，写进文件的就是普通 LRC。用户想写逐字歌词时无处可点，而项目里
 * 早就有「更精确的逐字歌词」那套能力（AMLL TTML / QQ QRC / 酷狗 KRC），只是它挂在
 * 播放链路上，没有暴露给写标签的对话框。
 *
 * 这个模块把两件事接起来：
 * 1. **复用 `preciseLyrics` 的取词服务**（AMLL → QQ → 酷狗 → Meting 回退链 + 时长匹配
 *    + 结果缓存），命中即拿到带 units 的 LyricLine[]；
 * 2. **补上 preciseLyrics 没有的按候选取词**：用户在对话框里选的是某个源的具体一条
 *    候选，而不是「拿歌名去猜」。QQ / 酷狗直接按该候选的 id+hash 调富接口；网易云新增
 *    `yrc` 逐字轨（比网易云的普通 LRC 多一档词级时间轴）。
 *
 * 两条入口的分工：
 * - `fetchWordLyricsForCandidate(result, meta)`：按候选取（对话框里点某条候选的「逐字」）；
 * - `fetchWordLyricsByMeta(meta)`：按歌名+时长走 preciseLyrics 回退链（对话框顶部按钮，
 *   不挑候选也能一键拿到**任意可用源**的逐字歌词）。
 *
 * 任何失败都**返回 null 而不是抛**：写标签是显式动作，拿不到逐字时应让调用方
 * 退回普通 LRC 并提示，绝不能把对话框卡住。
 */
import type { LyricLine, MusicTagSearchResult } from "@shared/types";
import { fetch as hostFetch } from "@/ipc/http";
import { qqFetchLyrics, qqFetchLyricsDetailed } from "@/utils/qqMusic";
import { kgFetchLyrics } from "@/utils/kgMusic";
import { hasWordLevel } from "@/utils/qrc";
import {
  fetchCloudLyrics,
  type LyricSource,
  type PreciseLyricsResult,
} from "@/utils/preciseLyrics";
import { filterInstrumentalPlaceholder, parseLrc } from "@/utils/lyricTimeline";
import { parseNeteaseYrc, serializeWordLevelLrc, stripWordUnits } from "@/utils/wordLevelLrc";

/** 逐字轨解析的实现在纯模块里（可单独打包验证）；这里再导出一次，保持调用方路径稳定 */
export { parseNeteaseYrc };

const REQUEST_TIMEOUT_MS = 12000;
/** 桌面 UA（网易云接口对 UA 有要求） */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 逐字歌词的命中来源（写标签对话框用来打标） */
export interface WordLyricsHit {
  /** 带词级时间轴的行（已过滤纯音乐占位） */
  lines: LyricLine[];
  /** 来源标识：preciseLyrics 的 LyricSource，或按候选取词时的音源名 */
  source: LyricSource | "netease-ylrc";
  /** 命中的候选标题（提示用） */
  songTitle: string;
}

async function getText(url: string, headers: Record<string, string>): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await hostFetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 网易云 yrc（逐字轨）
// ---------------------------------------------------------------------------

/**
 * 网易云：按歌曲 id 取 yrc 逐字轨。
 *
 * 返回 `wordLevel` 与行一起给出，而不是让调用方再用 `hasWordLevel` 猜：
 * 退回普通 LRC 时会带上**粗排** units（供渲染逐字填充用，每行都有），
 * `hasWordLevel` 会把它误判成逐字——那样写标签时会打出伪逐字标记。
 * 兜底分支用 `parseLrc(lrc, true, false)` 不留粗排，让「逐行就是逐行」在数据层面成立。
 */
async function neteaseWordLyrics(
  songId: string,
): Promise<{ lines: LyricLine[]; wordLevel: boolean } | null> {
  if (!songId) return null;
  try {
    const url = `https://music.163.com/api/song/lyric/v1?id=${encodeURIComponent(
      songId,
    )}&cp=false&lv=0&kv=0&tv=0&rv=0&yv=0&ytv=0&yrv=0`;
    const body = await getText(url, {
      "User-Agent": DESKTOP_UA,
      Referer: "https://music.163.com/",
    });
    const data = JSON.parse(body) as {
      yrc?: { lyric?: string };
      lrc?: { lyric?: string };
    };
    const yrc = data.yrc?.lyric ?? "";
    if (yrc.trim()) {
      const usable = filterInstrumentalPlaceholder(parseNeteaseYrc(yrc));
      if (usable && hasWordLevel(usable)) return { lines: usable, wordLevel: true };
    }
    // 没有逐字轨：退回普通 LRC，至少别让按钮白点（但不冒充逐字）
    const lrc = data.lrc?.lyric ?? "";
    if (!lrc.trim()) return null;
    // attachRoughUnits=false：不留粗排 units，「逐行就是逐行」在数据层面成立
    const plain = filterInstrumentalPlaceholder(parseLrc(lrc, true, false));
    if (!plain) return null;
    return { lines: plain, wordLevel: false };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 按候选取词
// ---------------------------------------------------------------------------

/**
 * 按对话框里选中的候选取**逐字**歌词。
 *
 * 各源能力不同，这里如实降级：
 * - qq：QRC 富接口（`qqFetchLyrics`），有逐字就用；
 * - kugou：KRC 富接口（`kgFetchLyrics`，需 hash），有逐字就用；
 * - netease：新增 yrc 逐字轨，没有则退普通 LRC；
 * - migu / kuwo：公开接口只有逐行时间轴，**返回逐行结果**（`wordLevel: false`），
 *   由调用方决定是否仍写普通 LRC。
 *
 * @returns 命中的行；取不到返回 null
 */
export async function fetchWordLyricsForCandidate(
  result: MusicTagSearchResult,
): Promise<{ lines: LyricLine[]; source: WordLyricsHit["source"]; wordLevel: boolean } | null> {
  try {
    switch (result.source) {
      case "qq": {
        const raw = (result.raw ?? {}) as { mid?: string; durationMs?: number };
        // 用 detailed 版：wordLevel 由 QQ 侧显式给出（QRC=逐字 / LRC 兜底=逐行），
        // 不能对返回的行调 hasWordLevel 反推——LRC 兜底轨也带粗排 units。
        const hit = await qqFetchLyricsDetailed({
          id: result.songId,
          mid: String(raw.mid ?? result.coverKey ?? ""),
          title: result.title,
          subtitle: "",
          artist: result.artist,
          album: result.album,
          durationMs: Number(raw.durationMs ?? 0),
        });
        const usable = hit?.lines.length ? filterInstrumentalPlaceholder(hit.lines) : null;
        if (!usable?.length) return null;
        return { lines: usable, source: "qq", wordLevel: hit!.wordLevel };
      }
      case "kugou": {
        const hash = String((result.raw as { hash?: string })?.hash ?? result.coverKey ?? "");
        if (!hash) return null;
        const lines = await kgFetchLyrics({
          id: String((result.raw as { albumAudioId?: string })?.albumAudioId ?? result.songId),
          hash,
          title: result.title,
          subtitle: "",
          artist: result.artist,
          album: result.album,
          durationMs: Number((result.raw as { durationMs?: number })?.durationMs ?? 0),
        });
        const usable = lines?.length ? filterInstrumentalPlaceholder(lines) : null;
        if (!usable?.length) return null;
        return { lines: usable, source: "kg", wordLevel: hasWordLevel(usable) };
      }
      case "netease": {
        const hit = await neteaseWordLyrics(result.songId);
        if (!hit?.lines.length) return null;
        return { lines: hit.lines, source: "netease-ylrc", wordLevel: hit.wordLevel };
      }
      default:
        // 咪咕 / 酷我：公开接口无逐字，交给调用方走 fetchTagLyrics 的逐行链路
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 按歌名 + 时长走 preciseLyrics 回退链
// ---------------------------------------------------------------------------

/** 取词上下文：歌名必填，时长参与 ±1s 匹配（缺了只能退纯搜索） */
export interface WordLyricsMeta {
  title: string;
  artist?: string;
  durationMs?: number;
}

/**
 * 复用「更精确的逐字歌词」服务：按标题/艺人/时长在 AMLL → QQ → 酷狗（→ Meting）
 * 回退链上找逐字歌词。
 *
 * 与原播放链路用的是同一个结果缓存，因此**刚在播放器里切过源的歌会秒回**。
 * 命中逐行结果时同样返回（`wordLevel: false`），由调用方决定要不要写普通 LRC。
 *
 * 时长缺失时 preciseLyrics 会直接 missing-info 短路——这里先退回普通搜索：
 * 只按标题走 QQ/酷狗搜索，取首个标题匹配的候选（写标签场景用户已选定歌曲，
 * 比播放链路更宽容）。
 */
export async function fetchWordLyricsByMeta(
  meta: WordLyricsMeta,
): Promise<{ hit: WordLyricsHit; wordLevel: boolean } | null> {
  const title = (meta.title ?? "").trim();
  if (!title) return null;

  if (!meta.durationMs || !Number.isFinite(meta.durationMs)) {
    return fallbackByTitle(title, meta.artist);
  }

  const result: PreciseLyricsResult = await fetchCloudLyrics({
    title,
    artist: meta.artist || undefined,
    durationMs: meta.durationMs,
  });
  if (!result.ok || !result.lines.length) return null;
  const usable = filterInstrumentalPlaceholder(result.lines);
  if (!usable?.length) return null;
  return {
    hit: { lines: usable, source: result.source, songTitle: result.songTitle },
    wordLevel: result.wordLevel,
  };
}

/** 无时长兜底：按标题搜 QQ/酷狗，取标题命中的首个候选的富歌词 */
async function fallbackByTitle(
  title: string,
  artist?: string,
): Promise<{ hit: WordLyricsHit; wordLevel: boolean } | null> {
  try {
    const { qqSearchSongs } = await import("@/utils/qqMusic");
    const songs = await qqSearchSongs(title);
    // 标题命中优先；标题并列时用艺人佐证（本地 tag 常带多位合作者，用包含判断）
    const byTitle = songs.filter((s) => s.title.includes(title) || title.includes(s.title));
    const pool = byTitle.length ? byTitle : songs;
    const artistHit = artist
      ? pool.find((s) => s.artist && (s.artist.includes(artist) || artist.includes(s.artist)))
      : undefined;
    const pick = artistHit ?? pool[0];
    if (!pick) return null;
    const detailed = await qqFetchLyricsDetailed(pick);
    const usable = detailed?.lines.length ? filterInstrumentalPlaceholder(detailed.lines) : null;
    if (!usable?.length) return null;
    return {
      hit: { lines: usable, source: "qq", songTitle: pick.title },
      wordLevel: detailed!.wordLevel,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 落盘文本
// ---------------------------------------------------------------------------

/**
 * 把取到的歌词转成**写进标签文件的文本**。
 *
 * `wordLevel` 是调用方对「这份歌词是否官方逐字」的**显式担保**，不能从 units 反推：
 * 渲染用的粗排 / FFT units 同样满足「≥2 个词元」，反推会把伪时间轴写成增强型 LRC
 * 固化进用户文件。Meting 回退链正是这种情形——preciseLyrics 返回的是**逐行**结果，
 * 但行上带着 parseLrc 给的粗排 units。
 *
 * - `wordLevel: true` → 输出增强型 LRC；
 * - 否则先剥掉 units，只写普通 LRC。
 */
export function toTagLyricsText(lines: LyricLine[], wordLevel: boolean): string {
  if (wordLevel) return serializeWordLevelLrc(lines);
  return serializeWordLevelLrc(stripWordUnits(lines));
}
