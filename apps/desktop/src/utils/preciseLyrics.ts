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
import { amllSearchSongs, amllFetchLyrics, AMLL_DEFAULT_BASE, type AmllTtmlSong } from "./amllTtml";
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
const FAIL_TTL = 10 * 60 * 1000;
/** 条目上限（此前无上限，长听会一直堆） */
const RESULT_CACHE_MAX = 512;

/**
 * 结果缓存：成功 1h / 失败 10min（键含来源顺序，手动切换后自动失效）。
 * 复用统一实现：失败条目用 `ttlMs`，成功条目用 `okTtlMs`。
 */
const resultCache = new TtlCache<PreciseLyricsResult>("precise-lyrics", {
  ttlMs: FAIL_TTL,
  okTtlMs: OK_TTL,
  isOk: (r) => r.ok,
  maxEntries: RESULT_CACHE_MAX,
});

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

/** 括号内容（半角/全角） */
const BRACKET_RE = /[（(][^（）()]*[）)]/g;

/** 去掉括号内的附加信息（如「夜曲 (Live)」→「夜曲」），用于搜索词与匹配比较 */
export function stripBrackets(t: string): string {
  return t.replace(BRACKET_RE, " ").replace(/\s+/g, " ").trim();
}

/** 标题归一化：去括号 + trim + 小写 + 全角→半角 + 空白折叠 */
export function normalizeTitle(t: string): string {
  return stripBrackets(t)
    .toLowerCase()
    .replace(/\u3000/g, " ")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, " ");
}

interface TryContext {
  title: string;
  durationMs: number;
  artist?: string;
}

/**
 * 尝试 AMLL TTML DB 来源（社区维护的逐字歌词库，默认第一优先）。
 *
 * 与 QQ / 酷狗的区别：TTML 文件本身没有「时长」字段，索引里也没有，所以无法像那两家
 * 一样先按时长筛候选。这里改成「先按标题挑候选 → 下第一份 → 用 TTML 里估出的曲长
 * 与本地音频比对」。差太多（超过 3 秒）才继续试下一个候选，避免同名不同版本（翻唱 /
 * Live）拿错歌词 —— 那比拿不到歌词更让人困惑。
 *
 * 只有 1 秒容差的那两家不一样：AMLL 的 TTML 是人工打轴的，`<body dur>` 常常是
 * 「最后一个字唱完」的时间而不是音频总长，用它跟音频时长严格比对会大面积误杀。
 */
const AMLL_DURATION_TOLERANCE_MS = 3000;

async function tryAmllSource(opts: TryContext, base?: string): Promise<PreciseLyricsResult> {
  const keyword = stripBrackets(opts.title);
  let songs: AmllTtmlSong[];
  try {
    songs = await amllSearchSongs(keyword, base);
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

  const titleNorm = normalizeTitle(opts.title);
  // 索引里同一条歌词会给出多个别名（含 (Live) / 日文译名等），任一命中即可
  const sameName = songs.filter((s) =>
    (s.titles.length ? s.titles : [s.title]).some((t) => normalizeTitle(t) === titleNorm),
  );
  if (!sameName.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL.amll}：搜索 ${songs.length} 条，同名 0 条`,
    };
  }

  // 同名时长度相同性未知，按索引顺序试前几个；命中时长接近的就直接用
  const candidates = sameName.slice(0, MAX_CANDIDATES);
  let tried = 0;
  let lastDetail = "";
  let firstOk: LyricLine[] | null = null;
  for (const song of candidates) {
    tried++;
    let lines: LyricLine[] | null = null;
    try {
      lines = await amllFetchLyrics(song, base);
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (!lines?.length) continue;
    // 时长校验：TTML 估不出时长（0）时不做判断，直接接受
    const ttmlMs = lines[lines.length - 1].time * 1000 + 1000;
    const diff = Math.abs(ttmlMs - opts.durationMs);
    if (!opts.durationMs || ttmlMs <= 0 || diff <= AMLL_DURATION_TOLERANCE_MS) {
      return {
        ok: true,
        source: "amll",
        lines,
        songId: song.id,
        songTitle: song.title,
        wordLevel: true,
        fromCache: false,
      };
    }
    lastDetail = `时长差 ${Math.round(diff / 1000)}s，跳过`;
    firstOk ??= lines;
  }

  if (firstOk) {
    // 全部候选都因为时长差被跳过时，仍然接受第一个：有歌词总比回退 FFT 强
    return {
      ok: true,
      source: "amll",
      lines: firstOk,
      songId: candidates[0].id,
      songTitle: candidates[0].title,
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

  const titleNorm = normalizeTitle(opts.title);
  const titleMatched = songs.filter((s) => normalizeTitle(s.name) === titleNorm);
  const artistNorm = opts.artist ? normalizeTitle(opts.artist) : "";
  const pick =
    titleMatched.find(
      (s) =>
        artistNorm &&
        (normalizeTitle(s.artist).includes(artistNorm) ||
          artistNorm.includes(normalizeTitle(s.artist))),
    ) ||
    titleMatched[0] ||
    songs[0];
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

  const titleNorm = normalizeTitle(opts.title);
  const sameName = candidates.filter((c) => normalizeTitle(c.title) === titleNorm);
  const matched = sameName
    .filter((c) => Math.abs((c.durationMs || 0) - opts.durationMs) <= DURATION_TOLERANCE_MS)
    .sort(
      (a, b) =>
        Math.abs((a.durationMs || 0) - opts.durationMs) -
        Math.abs((b.durationMs || 0) - opts.durationMs),
    )
    .slice(0, MAX_CANDIDATES);
  if (!matched.length) {
    return {
      ok: false,
      reason: "no-match",
      detail: `${SOURCE_LABEL[source]}：搜索 ${candidates.length} 条，同名 ${sameName.length} 条，时长差 ≤1s 0 条`,
    };
  }

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
  if (cached && !opts.force) {
    if (!cached.ok) {
      console.info("[逐字歌词] 命中失败缓存（10 分钟内），跳过重试:", title);
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
      return r;
    }
    lastFailure = r;
    console.warn(`[逐字歌词] ${r.detail ?? r.reason}`);
  }
  const result: PreciseLyricsResult = {
    ok: false,
    reason: lastFailure?.reason ?? "no-lyrics",
    detail: lastFailure?.detail,
  };
  resultCache.set(key, result);
  return result;
}
