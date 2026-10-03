/**
 * 「更精确的逐字歌词」匹配编排。
 *
 * 流程（回退链）：优先尝试用户偏好的来源，默认 **AMLL TTML DB** → QQ 音乐 → 酷狗音乐
 * → 已登录网易云时追加 Meting API → 全部云端失败则交由调用方回退本地歌词。
 * AMLL 那一源可以在设置里关掉（amllLyricsEnabled），关掉后自动跳过。
 * 每个来源：搜索歌曲名（忽略括号内信息）→ 过滤「同名 + 时长差 ≤ ±1 秒」→ 按时长差升序
 * 取前 N 个候选 → 逐个拉取逐字歌词：优先含逐字数据的候选；全无逐字则回退首个逐行结果。
 *
 * 返回结构化结果（PreciseLyricsResult），调用方据此展示来源徽标/回退提示并记录日志。
 * 结果进程内缓存：成功 1h / 失败 10min（键含来源顺序，手动切换后自动失效）。
 */
import { qqSearchSongs, qqFetchLyrics, type QqSongInfo } from "./qqMusic";
import { kgSearchSongs, kgFetchLyrics, type KgSongInfo } from "./kgMusic";
import { metingSearch } from "./meting";
import {
  amllSearchSongs,
  amllFetchLyricsDetailed,
  AMLL_DEFAULT_BASE,
  type AmllTtmlSong,
} from "./amllTtml";
import {
  artistSimilarity,
  bestTitleMatch,
  isSameSong,
  normalizeTitle,
  stripBrackets,
  TITLE_WEAK,
} from "./lyricMatch";
import { useSettingsStore } from "@/stores/settings";
import { lrcGet, lrcSet } from "./onlineCache";
import { parseLrc, filterInstrumentalPlaceholder } from "./lyricTimeline";
import { hasWordLevel } from "./qrc";
import { TtlCache } from "./ttlCache";
import type { LyricLine, OnlineSong } from "@shared/types";

/** 云端歌词来源 */
export type LyricSource = "amll" | "qq" | "kg" | "meting";
/** 歌词来源偏好（含本地） */
export type LyricSourcePref = LyricSource | "local";

/** 时长匹配容差：±1 秒 */
const DURATION_TOLERANCE_MS = 1000;
/** 最多尝试的候选数 */
const MAX_CANDIDATES = 5;

const OK_TTL = 60 * 60 * 1000;
/**
 * 「搜到了候选、但都不合适」的失败缓存：10 分钟。
 *
 * 这类失败是**确定性**的（曲库里有没有这首歌、艺人写得对不对），短时间内重试结果一样，
 * 缓起来能省掉反复的索引过滤与搜索请求。手动切换来源会带 force 绕过它。
 */
const FAIL_TTL = 10 * 60 * 1000;
/**
 * 「网络 / 服务端出错」的失败缓存：90 秒。
 *
 * 这类失败是**瞬时**的（CDN 抖动、镜像不稳、接口限流）。用和「确实没匹配上」一样的
 * 10 分钟去缓存它，会把一次抖动放大成「这首歌十分钟内再也匹配不上」——正是用户
 * 感知到的「匹配度低」。90 秒足够避免同一首歌切来切去时的风暴，又不会把故障钉住。
 */
const TRANSIENT_FAIL_TTL = 90 * 1000;
/** 条目上限（此前无上限，长听会一直堆） */
const RESULT_CACHE_MAX = 512;

/**
 * 结果缓存（键含来源顺序，手动切换后自动失效）。
 *
 * 三档 TTL：成功 1h / 瞬时失败 90s / 确定性失败 10min。`isOk` 只判定「成功」，
 * 所以瞬时失败需要单独在写入前改写（见 setFailedResult）。
 */
const resultCache = new TtlCache<PreciseLyricsResult>("precise-lyrics", {
  ttlMs: FAIL_TTL,
  okTtlMs: OK_TTL,
  isOk: (r) => r.ok,
  maxEntries: RESULT_CACHE_MAX,
});

/** 瞬时失败（网络 / 服务端错误）的结果缓存到期时间表：key → 更短的有效期终点 */
const transientFailures = new Map<string, number>();

/**
 * 写入失败结果。
 *
 * TtlCache 只有「成功 / 失败」两档，瞬时失败需要更短的 TTL，这里额外记一个到期时间，
 * 读缓存时越过它就当作已过期。之所以不干脆不缓存：那样同一首歌的重复播放会立刻
 * 重打一遍全链路的网络。
 *
 * `transient` 由调用方给出，判据是**所有**来源都报了网络 / 服务端错误；只要有任何
 * 一个来源给出了确定性答复（曲库里就是没有这首歌），就按确定性失败缓存较久。
 */
function cacheFailure(key: string, r: PreciseLyricsResult, transient: boolean): void {
  resultCache.set(key, r);
  if (transient) {
    transientFailures.set(key, Date.now() + TRANSIENT_FAIL_TTL);
  } else {
    transientFailures.delete(key);
  }
}

/** 清空结果缓存（测试与「强制重新匹配」用） */
export function preciseLyricsClearCache(): void {
  resultCache.clear();
  transientFailures.clear();
}

/** 回退原因（用于日志与界面提示） */
export type QqFallbackReason = "missing-info" | "search-failed" | "no-match" | "no-lyrics";

export type PreciseLyricsResult =
  | {
      ok: true;
      /** 命中来源 */
      source: LyricSource;
      lines: LyricLine[];
      /** 命中的云端歌曲 id（日志用） */
      songId: string;
      /** 命中的云端歌曲标题（日志用） */
      songTitle: string;
      /** 是否含官方逐字时间轴（否则仅为逐行） */
      wordLevel: boolean;
      /** 是否命中缓存 */
      fromCache: boolean;
    }
  | { ok: false; reason: QqFallbackReason; detail?: string };

const SOURCE_LABEL: Record<LyricSource, string> = {
  amll: "AMLL TTML DB",
  qq: "QQ 音乐",
  kg: "酷狗音乐",
  meting: "Meting API",
};

/**
 * 标题 / 艺人比对统一走 `lyricMatch`（原来只做 normalizeTitle 完全相等，写法差一个
 * 标点或译名就整首判死）。这里重新导出，保持既有调用点与测试的导入路径不变。
 */
export {
  stripBrackets,
  normalizeTitle,
  foldTitle,
  titleSimilarity,
  artistSimilarity,
  isSameSong,
  TITLE_STRONG,
  TITLE_WEAK,
} from "./lyricMatch";

export type { SameSongOptions } from "./lyricMatch";

interface TryContext {
  title: string;
  durationMs: number;
  artist?: string;
}

/**
 * AMLL TTML 与本地音频的时长容差。
 *
 * AMLL 的 TTML 是人工打轴的，`<body dur>` / 最后一个 `<p end>` 标的是「最后一个字
 * 唱完」而不是音频总长，因此这里给到 3 秒（QQ / 酷狗那边是精确的音频时长，只用 1 秒）。
 */
const AMLL_DURATION_TOLERANCE_MS = 3000;

/** 一个候选的「标题 + 艺人」评分结果 */
interface AmllCandidate {
  song: AmllTtmlSong;
  titleScore: number;
  artistScore: number;
  /** 是否达到「就是这一首」的强度（时长对不上时优先用它兜底） */
  strong: boolean;
}

/**
 * 给候选打分并排序（标题为主、艺人为辅，同分时新投稿优先）。
 *
 * 旧实现只保留 `normalizeTitle 完全相等` 的候选，且保持索引顺序（= 上传时间升序，
 * 最旧的排最前）。真实索引里 453 组同名条目、其中 38% 是不同艺人的不同歌，所以：
 * - 用 `titleSimilarity` 分出「同一首」与「相近但不是」；
 * - 用 `artistSimilarity` 把同名的不同歌压下去（本地有艺人 tag 时才生效）；
 * - 同样强度的候选里，新近投稿优先（旧版等于永远选最旧的那一版）。
 */
function scoreAmllCandidates(songs: AmllTtmlSong[], opts: TryContext): AmllCandidate[] {
  const out: AmllCandidate[] = [];
  // 本地没有艺人 tag 时不能拿艺人分否定标题（缺信息 != 不匹配）
  const artistUnknown = !opts.artist?.trim() || !songs.some((s) => s.artists.length);
  for (const song of songs) {
    const titles = song.titles.length ? song.titles : [song.title];
    // 一条索引可能有多个别名（译名 / Live 等），取最好的那个
    const { score: titleScore, exact } = bestTitleMatch(opts.title, titles);
    if (titleScore < TITLE_WEAK) continue;
    const artistScore = artistSimilarity(opts.artist, song.artists);
    const verdict = isSameSong(titleScore, artistScore, { exactTitle: exact, artistUnknown });
    if (!verdict.accept) continue;
    out.push({ song, titleScore, artistScore, strong: verdict.strong });
  }
  // 综合分：标题为主，艺人做加分项，新投稿做极小的次级权重
  const rank = (c: AmllCandidate) =>
    c.titleScore + c.artistScore * 0.15 + Math.min(c.song.uploadedAt, 4e12) / 1e14;
  out.sort((a, b) => rank(b) - rank(a));
  return out;
}

/**
 * 尝试 AMLL TTML DB 来源（社区维护的逐字歌词库，默认第一优先）。
 *
 * 与旧实现的关键区别：
 * 1. **搜索词同时试「原文」与「剥括注」两种**。旧版只用剥离后的关键词，歌名整体被括号
 *    包住的条目（索引里有）会剥成空串，一条都搜不到。
 * 2. **判等从「完全相等」换成打分 + 阈值**（titleSimilarity / artistSimilarity），
 *    写法差一个标点、一个没加括号的 feat.、一个译名都不再直接判死；艺人不同的同名歌
 *    （《怪物》= YOASOBI / MC HotDog）也能被艺人分区分开。
 * 3. **时长校验用真实曲长**。旧版拿「最后一个歌词行的开始时间 + 1s」当曲长，而真实
 *    TTML 里最后一行到曲末平均还差 3.6 秒、最长近 19 秒 —— 于是绝大多数正确的候选也
 *    会被判「时长差过大」而跳过。这里改用 amllTtmlDurationMs（body dur / 最大 p end）。
 * 4. **兜底选「最接近的那一个」而不是第一个下载成功的**，并且回去的 songId / songTitle
 *    与真正采用的歌词文件一致（旧版硬写 candidates[0]，第一个下载失败时日志会指错歌）。
 */
async function tryAmllSource(opts: TryContext, base?: string): Promise<PreciseLyricsResult> {
  let songs: AmllTtmlSong[];
  try {
    // 原文与剥括注都传：索引里两种写法都存在（含整名被括号包住的特例）
    songs = await amllSearchSongs([opts.title, stripBrackets(opts.title)], base);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "search-failed",
      detail: `${SOURCE_LABEL.amll} 搜索失败: ${msg}`,
    };
  }
  if (!songs.length) {
    return { ok: false, reason: "no-match", detail: `${SOURCE_LABEL.amll}：无搜索结果` };
  }

  const ranked = scoreAmllCandidates(songs, opts);
  if (!ranked.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL.amll}：搜索 ${songs.length} 条，标题/艺人相似的 0 条`,
    };
  }

  const candidates = ranked.slice(0, MAX_CANDIDATES);
  let tried = 0;
  let lastDetail = "";
  // 兜底：记下「时长最接近」的那一份，而不是第一个下载成功的
  let best: { lines: LyricLine[]; c: AmllCandidate; diff: number } | null = null;
  for (const cand of candidates) {
    tried++;
    let payload: Awaited<ReturnType<typeof amllFetchLyricsDetailed>>;
    try {
      payload = await amllFetchLyricsDetailed(cand.song, base);
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      continue;
    }
    const lines = payload.lines;
    if (!lines?.length) continue;
    const hit = (): PreciseLyricsResult => ({
      ok: true,
      source: "amll",
      lines,
      songId: cand.song.id,
      songTitle: cand.song.title,
      wordLevel: true,
      fromCache: false,
    });
    // 时长校验：TTML 估不出时长（0）时不做判断，直接接受
    const ttmlMs = payload.durationMs;
    if (!opts.durationMs || ttmlMs <= 0) return hit();
    const diff = Math.abs(ttmlMs - opts.durationMs);
    if (diff <= AMLL_DURATION_TOLERANCE_MS) return hit();
    // 标题极强（基本可以确定是同一首）时放宽到 3 倍容差：宁可时间轴略有出入，
    // 也比退化成 FFT 猜词强；观众对「差几秒的官方时间轴」的容忍度远高于「歌词乱跳」。
    if (cand.strong && diff <= AMLL_DURATION_TOLERANCE_MS * 3) return hit();
    lastDetail = `时长差 ${Math.round(diff / 1000)}s，跳过`;
    if (!best || diff < best.diff) best = { lines, c: cand, diff };
  }

  if (best) {
    // 所有候选时长都对不上：仍然接受**最接近**的一份（有歌词总比回退 FFT 强）。
    // 注意 songId / songTitle 取 best 对应的候选——旧版这里硬写 candidates[0]，
    // 若第一个候选下载失败，日志与来源徽标会指向一份根本没被采用的歌词。
    return {
      ok: true,
      source: "amll",
      lines: best.lines,
      songId: best.c.song.id,
      songTitle: best.c.song.title,
      wordLevel: true,
      fromCache: false,
    };
  }
  return {
    ok: false,
    reason: "no-lyrics",
    detail: `${SOURCE_LABEL.amll}：尝试 ${tried} 个候选均无可用歌词${lastDetail ? `（${lastDetail}）` : ""}`,
  };
}

/**
 * 尝试 Meting API 来源（网易云歌词回退）。
 * Meting 搜索结果不含时长字段，因此采用「归一化标题完全一致」优先，
 * 其次选择首个搜索结果；拉取 lrc 后解析为标准 LRC（含粗排逐字时间轴）。
 */
async function tryMetingSource(opts: TryContext): Promise<PreciseLyricsResult> {
  const keyword = stripBrackets(opts.title);
  let songs: OnlineSong[];
  try {
    songs = await metingSearch("netease", keyword);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "search-failed",
      detail: `${SOURCE_LABEL.meting} 搜索失败: ${msg}`,
    };
  }
  if (!songs.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL.meting}：无搜索结果`,
    };
  }

  // 与 AMLL / QQ / 酷狗同一套打分：标题相似度为主，艺人做佐证。
  // 旧实现要求归一化后**完全相等**，本地 tag 与平台曲库的写法差异（译名、feat. 写法、
  // 标点）会直接判死；而且最后无条件退回 songs[0]，可能拿一首完全不相干的歌。
  const artistUnknown = !opts.artist?.trim() || !songs.some((s) => s.artist);
  const scored = songs
    .map((s) => {
      const { score: titleScore, exact } = bestTitleMatch(opts.title, [s.name]);
      const artistScore = artistSimilarity(opts.artist, [s.artist]);
      return { s, titleScore, artistScore, exact };
    })
    .filter(
      (x) => isSameSong(x.titleScore, x.artistScore, { exactTitle: x.exact, artistUnknown }).accept,
    )
    .sort((a, b) => b.titleScore + b.artistScore * 0.15 - (a.titleScore + a.artistScore * 0.15));
  const pick = scored[0]?.s;
  if (!pick) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL.meting}：搜索 ${songs.length} 条，标题/艺人相似的 0 条`,
    };
  }
  if (!pick?.lrc) {
    return {
      ok: false,
      reason: "no-lyrics",
      detail: `${SOURCE_LABEL.meting}：候选 ${songs.length} 条，但无歌词地址`,
    };
  }

  try {
    const cacheKey = pick.id || pick.lrc;
    let text = "";
    let fromCache = false;
    if (pick.lrc.startsWith("http")) {
      const cached = await lrcGet(cacheKey);
      if (cached !== null) {
        text = cached;
        fromCache = true;
      } else {
        const res = await fetch(pick.lrc);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        text = text.trim();
        if (text) void lrcSet(cacheKey, text);
      }
    } else if (pick.lrc.includes("[")) {
      text = pick.lrc;
    }

    if (!text.trim()) {
      return {
        ok: false,
        reason: "no-lyrics",
        detail: `${SOURCE_LABEL.meting}：歌词内容为空`,
      };
    }
    const parsed = parseLrc(text, true);
    const lines = filterInstrumentalPlaceholder(parsed);
    if (!lines?.length) {
      return {
        ok: false,
        reason: "no-lyrics",
        detail: `${SOURCE_LABEL.meting}：歌词内容为空或为纯音乐占位文案`,
      };
    }
    return {
      ok: true,
      source: "meting",
      lines,
      songId: pick.id,
      songTitle: pick.name,
      wordLevel: false,
      fromCache,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "no-lyrics",
      detail: `${SOURCE_LABEL.meting} 获取歌词失败: ${msg}`,
    };
  }
}

/** 尝试单个来源：搜索 → 同名+时长匹配 → 逐字优先取词 */
async function trySource(
  source: LyricSource,
  opts: TryContext,
  amllBase?: string,
): Promise<PreciseLyricsResult> {
  if (source === "amll") return tryAmllSource(opts, amllBase);
  if (source === "meting") return tryMetingSource(opts);
  const keyword = stripBrackets(opts.title); // 搜索词同样忽略括号内信息
  let candidates: (QqSongInfo | KgSongInfo)[];
  try {
    candidates = source === "qq" ? await qqSearchSongs(keyword) : await kgSearchSongs(keyword);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "search-failed",
      detail: `${SOURCE_LABEL[source]} 搜索失败: ${msg}`,
    };
  }
  if (!candidates.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL[source]}：无搜索结果`,
    };
  }

  // 标题 / 艺人打分（与 AMLL、Meting 同一套）：旧实现要求归一化后完全相等，
  // 本地 tag 与平台曲库的写法差异（译名、feat. 位置、标点）会直接把正确的候选筛掉。
  const artistUnknown = !opts.artist?.trim() || !candidates.some((c) => c.artist);
  const sameName = candidates
    .map((c) => {
      const { score: titleScore, exact } = bestTitleMatch(opts.title, [c.title]);
      const artistScore = artistSimilarity(opts.artist, [c.artist]);
      return {
        c,
        titleScore,
        artistScore,
        verdict: isSameSong(titleScore, artistScore, { exactTitle: exact, artistUnknown }),
      };
    })
    .filter((x) => x.verdict.accept);
  if (!sameName.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL[source]}：搜索 ${candidates.length} 条，标题/艺人相似的 0 条`,
    };
  }

  /** 时长可以精确比对的候选：±1 秒内，差得越少越优先 */
  const withinDuration = sameName.filter(
    (x) => Math.abs((x.c.durationMs || 0) - opts.durationMs) <= DURATION_TOLERANCE_MS,
  );
  // 标题已经很强（基本确定同一首）时，时长放宽到 5 秒：平台曲库的 durationMs 偶有
  // 与本地压片不一致（Remaster / 不同切点），±1 秒会让正确的歌整首拿不到逐字歌词。
  const strongTitle = sameName.filter((x) => x.verdict.strong);
  const relaxed = sameName.filter(
    (x) => x.verdict.strong && Math.abs((x.c.durationMs || 0) - opts.durationMs) <= 5000,
  );
  const pool = (withinDuration.length ? withinDuration : relaxed.length ? relaxed : strongTitle)
    .sort((a, b) => {
      const da = Math.abs((a.c.durationMs || 0) - opts.durationMs);
      const db = Math.abs((b.c.durationMs || 0) - opts.durationMs);
      // 标题强的优先，其次时长最接近；再其次艺人分高的
      return (
        Number(b.verdict.strong) - Number(a.verdict.strong) ||
        da - db ||
        b.artistScore - a.artistScore
      );
    })
    .slice(0, MAX_CANDIDATES);
  if (!pool.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL[source]}：搜索 ${candidates.length} 条，标题/艺人相似 ${sameName.length} 条，时长差 ≤1s 0 条`,
    };
  }
  const matched = pool.map((x) => x.c);

  let firstLineLevel: LyricLine[] | null = null;
  let tried = 0;
  for (const c of matched) {
    tried++;
    let lines: LyricLine[] | null = null;
    try {
      lines =
        source === "qq"
          ? await qqFetchLyrics(c as QqSongInfo)
          : await kgFetchLyrics(c as KgSongInfo);
    } catch {
      continue; // 单候选失败不影响其它候选
    }
    if (!lines?.length) continue;
    if (hasWordLevel(lines)) {
      return {
        ok: true,
        source,
        lines,
        songId: c.id,
        songTitle: c.title,
        wordLevel: true,
        fromCache: false,
      };
    }
    firstLineLevel ??= lines;
  }
  if (firstLineLevel) {
    return {
      ok: true,
      source,
      lines: firstLineLevel,
      songId: matched[0].id,
      songTitle: matched[0].title,
      wordLevel: false,
      fromCache: false,
    };
  }
  return {
    ok: false,
    reason: "no-lyrics",
    detail: `${SOURCE_LABEL[source]}：尝试 ${tried} 个候选均无可用歌词`,
  };
}

export interface PreciseLyricsOptions {
  /** 播放歌曲标题（必填；缺失直接跳过） */
  title: string;
  /** 播放歌曲时长（毫秒；缺失直接跳过，时长匹配依赖它） */
  durationMs?: number;
  artist?: string;
  /** 用户上次手动选择的来源：优先尝试；缺省按 QQ → 酷狗 */
  preferredSource?: LyricSource;
  /** 手动切换时强制忽略结果缓存 */
  force?: boolean;
  /** 已登录网易云账号：QQ/酷狗均失败后追加 Meting API 歌词回退 */
  fallbackToMeting?: boolean;
  /**
   * AMLL TTML DB 的基地址（来自设置项 amllLyricBase）。
   *
   * 允许用户换成社区镜像 / 自建：jsDelivr 在国内偶发不可达，换镜像比等 CDN 恢复现实。
   */
  amllBase?: string;
  /**
   * 是否启用 AMLL 源。缺省读设置（amllLyricsEnabled）。
   *
   * 显式传入只是为了**测试**可以绕开 store：store 在单测环境里没有 Pinia 实例，
   * 直接读会抛错；生产路径一律传 undefined，让这里读设置。
   */
  amllEnabled?: boolean;
}

/**
 * 按回退链从云端取逐字歌词（偏好来源 → 另一来源；登录网易云后追加 Meting）。
 * 成功返回歌词（含来源信息），失败返回原因；调用方据此回退本地歌词并提示。
 */
export async function fetchCloudLyrics(opts: PreciseLyricsOptions): Promise<PreciseLyricsResult> {
  const title = (opts.title ?? "").trim();
  if (!title || !opts.durationMs || !Number.isFinite(opts.durationMs)) {
    return { ok: false, reason: "missing-info" };
  }
  // AMLL 是否启用：设置项是唯一真源，测试可以显式覆盖。store 未就绪（例如纯函数单测）
  // 时退化为「启用」，与设置默认值一致，不会因为拿不到 store 就悄悄关掉一个默认功能。
  let amllEnabled = opts.amllEnabled;
  if (amllEnabled === undefined) {
    try {
      amllEnabled = useSettingsStore().amllLyricsEnabled !== false;
    } catch {
      amllEnabled = true;
    }
  }
  const amllBase =
    opts.amllBase ??
    (() => {
      try {
        return useSettingsStore().amllLyricBase || AMLL_DEFAULT_BASE;
      } catch {
        return AMLL_DEFAULT_BASE;
      }
    })();
  const key = `${normalizeTitle(title)}|${Math.round(opts.durationMs)}|${opts.preferredSource ?? "auto"}|${opts.fallbackToMeting ? "meting" : "no-meting"}|${amllEnabled ? amllBase : "no-amll"}`;
  const cached = resultCache.get(key);
  // 瞬时失败（网络 / 服务端错误）只缓存 90 秒：过期后即便 TtlCache 仍认为有效也要重试，
  // 否则一次 CDN 抖动会让这首歌在 10 分钟内一直「匹配不上」。
  const transientUntil = transientFailures.get(key);
  const cacheExpired = !!transientUntil && Date.now() >= transientUntil;
  if (cacheExpired) resultCache.delete(key);
  if (cached && !opts.force && !cacheExpired) {
    if (!cached.ok) {
      console.info(
        `[逐字歌词] 命中失败缓存（${transientUntil ? "网络错误，90 秒" : "确定性失败，10 分钟"}内），跳过重试:`,
        title,
      );
    }
    return cached.ok ? { ...cached, fromCache: true } : cached;
  }

  // 回退顺序：AMLL → QQ → 酷狗 →（登录网易云时）Meting。
  // 用户手动选过的来源排最前（preferredSource），其余按默认顺序补齐。
  //
  // 开关（amllLyricsEnabled）是**唯一真源**，关掉就必须一个 AMLL 请求都不发：用户手动
  // 选过 AMLL 时偏好会被记忆下来（settings.lyricSourcePrefs），如果这里只拦默认链，
  // 那条记忆会让「关了开关」形同虚设。
  const preferAmll = opts.preferredSource === "amll" && amllEnabled;
  const order: LyricSource[] = [];
  if (opts.preferredSource && (opts.preferredSource !== "amll" || preferAmll)) {
    order.push(opts.preferredSource);
  }
  if (amllEnabled && !order.includes("amll")) order.push("amll");
  if (!order.includes("qq")) order.push("qq");
  if (!order.includes("kg")) order.push("kg");
  if (opts.fallbackToMeting && !order.includes("meting")) order.push("meting");

  let lastFailure: PreciseLyricsResult | null = null;
  /**
   * 是否**所有**失败都是网络 / 服务端错误。
   *
   * 只看最后一个来源是不够的：回退链是 AMLL → QQ → 酷狗 → Meting，最后一个来源
   * （常见是酷狗）返回 no-match 时，前面 AMLL 的网络超时就被掩盖成「确定性失败」，
   * 于是这次抖动被缓存 10 分钟。
   */
  let allTransient = true;
  for (const source of order) {
    const r = await trySource(
      source,
      {
        title,
        durationMs: opts.durationMs,
        artist: opts.artist,
      },
      amllBase,
    );
    if (r.ok) {
      resultCache.set(key, r);
      transientFailures.delete(key);
      return r;
    }
    if (r.reason !== "search-failed") allTransient = false;
    lastFailure = r;
    console.warn(`[逐字歌词] ${r.detail ?? r.reason}`);
  }
  const result: PreciseLyricsResult = {
    ok: false,
    reason: lastFailure?.reason ?? "no-lyrics",
    detail: lastFailure?.detail,
  };
  // 搜索引擎本身都没答上来（全链路网络故障）时才用更短的 TTL 快速重试
  cacheFailure(key, result, allTransient);
  return result;
}
