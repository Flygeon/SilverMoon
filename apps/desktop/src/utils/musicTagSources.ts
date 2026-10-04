/**
 * 「写音乐标签」的**本地智能匹配**数据源。
 *
 * 直接在本机并发搜五个平台，再把候选按标题 / 艺术家 / 专辑相似度打分排序
 * （打分规则移植自 xhongc/music-tag-web 的 `match_score` / `match_artist`，
 * 见 doc/music-tags-feature.md 的「追加契约 v2」§11）。
 *
 * 这样「写音乐标签」不再依赖任何外部自建服务：装好应用即用。
 *
 * 设计要点：
 * - **复用已有客户端**：QQ 走 `utils/qqMusic.ts`（含会话初始化），酷狗走 Rust 侧
 *   `capabilities.kugouSearch`（签名在 Rust 里），不重复实现签名逻辑。
 * - **单源失败不拖垮整体**：`searchAllMusicTagSources` 把每个源的错误收进 outcome，
 *   只有全部失败时调用方才需要报错。
 * - 网络请求一律走 `@/ipc/http` 的主进程网络栈（绕开 CORS 与防盗链）。
 * - 所有平台接口都是**逆向**的，随时可能失效；因此每个源的解析都写得尽量宽松
 *   （字段名多种候选、缺失即降级），失败只影响该源。
 */
import type { MusicTagCover, MusicTagSearchResult, MusicTagSource } from "@shared/types";
import { fetch as hostFetch } from "@/ipc/http";
import { kugouToOnlineSongs } from "@/utils/kugou";
import { qqFetchLyrics, qqSearchSongs } from "@/utils/qqMusic";
import { toSimplified } from "@shared/zhSimplified";

/** 智能匹配 + 单源的联合模式 */
export type MusicTagSearchMode = "smart" | MusicTagSource;

/** 一次源搜索的结果（含失败原因，供 UI 提示「部分源失败」） */
export interface MusicTagSourceOutcome {
  source: MusicTagSource;
  results: MusicTagSearchResult[];
  error?: string;
}

/** 全部可选源（UI 下拉顺序即此顺序） */
export const MUSIC_TAG_SOURCES: MusicTagSource[] = ["qq", "netease", "kugou", "migu", "kuwo"];

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 12000;
/** 每个源取多少条候选 */
const PER_SOURCE_LIMIT = 10;

/** 浏览器预览用的 UA（部分平台对 UA 有要求） */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/** 咪咕 App 接口只认手机 UA */
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
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

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const text = await getText(url, headers);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("返回了非 JSON 响应");
  }
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("/");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return text(o.name ?? o.title ?? o.songName ?? o.singerName ?? "");
  }
  return String(value).trim();
}

/** 剥离高亮标签（酷狗/部分源会返回 `<em>标题</em>`）并做实体反转义。 */
function sanitize(value: string): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** 年份取 4 位数字 */
function year4(value: unknown): string {
  const matched = String(value ?? "").match(/\d{4}/);
  return matched ? matched[0] : "";
}

// ---------------------------------------------------------------------------
// QQ 音乐（复用 utils/qqMusic.ts）
// ---------------------------------------------------------------------------

async function searchQq(keyword: string): Promise<MusicTagSearchResult[]> {
  const songs = await qqSearchSongs(keyword);
  return songs.slice(0, PER_SOURCE_LIMIT).map((song) => ({
    source: "qq" as const,
    songId: song.id,
    title: sanitize(song.title) || sanitize(song.subtitle),
    artist: sanitize(song.artist),
    album: sanitize(song.album),
    year: "",
    // 专辑封面依赖 album mid；搜索接口没直接返回，按 mid 拼前缀由 Dialog 侧兜底
    coverUrl: "",
    coverKey: song.mid,
    raw: { mid: song.mid, durationMs: song.durationMs },
  }));
}

// ---------------------------------------------------------------------------
// 网易云（公开 search 接口，无需登录）
// ---------------------------------------------------------------------------

interface NeteaseSearchResponse {
  result?: {
    songs?: Array<{
      id?: number;
      name?: string;
      publishTime?: number;
      ar?: Array<{ name?: string }>;
      artists?: Array<{ name?: string }>;
      al?: { name?: string; picUrl?: string };
      album?: { name?: string; picUrl?: string };
    }>;
  };
}

async function searchNetease(keyword: string): Promise<MusicTagSearchResult[]> {
  const url =
    "https://music.163.com/api/cloudsearch/pc?s=" +
    encodeURIComponent(keyword) +
    `&type=1&offset=0&limit=${PER_SOURCE_LIMIT}`;
  const data = await getJson<NeteaseSearchResponse>(url, {
    "User-Agent": DESKTOP_UA,
    Referer: "https://music.163.com/",
  });
  const songs = data.result?.songs ?? [];
  return songs.map((song) => {
    const artists = (song.ar ?? song.artists ?? []).map((a) => text(a?.name)).filter(Boolean);
    const album = song.al ?? song.album ?? {};
    return {
      source: "netease" as const,
      songId: String(song.id ?? ""),
      title: sanitize(text(song.name)),
      artist: sanitize(artists.join("/")),
      album: sanitize(text(album.name)),
      year: song.publishTime ? year4(new Date(song.publishTime).getFullYear()) : "",
      coverUrl: text(album.picUrl),
      raw: song as unknown as Record<string, unknown>,
    };
  });
}

// ---------------------------------------------------------------------------
// 酷狗（复用 Rust 侧已带签名的搜索命令）
// ---------------------------------------------------------------------------

async function searchKugou(keyword: string): Promise<MusicTagSearchResult[]> {
  const raw = await capabilities_kugouSearch(keyword);
  return kugouToOnlineSongs(raw)
    .slice(0, PER_SOURCE_LIMIT)
    .map((song) => ({
      source: "kugou" as const,
      // 酷狗取歌词按 FileHash
      songId: song.hash ?? song.id,
      title: sanitize(song.name),
      artist: sanitize(song.artist),
      album: sanitize(song.album ?? ""),
      year: "",
      coverUrl: song.pic,
      raw: { hash: song.hash, albumId: song.albumId, durationMs: song.durationMs },
    }));
}

/**
 * 延迟引入 capabilities，避免 `musicTagSources ↔ capabilities` 的循环依赖
 * （capabilities 里没有反向引用本模块，但 mock 会；这里再兜一层更稳）。
 */
async function capabilities_kugouSearch(keyword: string): Promise<unknown> {
  const { capabilities } = await import("@/capabilities");
  return capabilities.kugouSearch(keyword);
}

// ---------------------------------------------------------------------------
// 咪咕（App 接口，实测可用）
// ---------------------------------------------------------------------------

interface MiguSearchResponse {
  songResultData?: {
    result?: Array<{
      name?: string;
      copyrightId?: string;
      lyricUrl?: string;
      singers?: Array<{ name?: string }>;
      albums?: Array<{ name?: string }>;
      imgItems?: Array<{ img?: string }>;
    }>;
  };
}

async function searchMigu(keyword: string): Promise<MusicTagSearchResult[]> {
  const switchParam = encodeURIComponent(JSON.stringify({ song: 1 }));
  const url =
    "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?text=" +
    encodeURIComponent(keyword) +
    `&pageNo=1&pageSize=${PER_SOURCE_LIMIT}&isCopyright=1&sort=1&searchSwitch=${switchParam}`;
  const data = await getJson<MiguSearchResponse>(url, { "User-Agent": MOBILE_UA });
  const songs = data.songResultData?.result ?? [];
  return songs.map((song) => {
    const cover = list(song.imgItems)
      .map((item) => text(obj(item)?.img))
      .find(Boolean);
    return {
      source: "migu" as const,
      songId: sanitize(text(song.copyrightId)) || sanitize(text(song.name)),
      title: sanitize(text(song.name)),
      artist: sanitize(
        list(song.singers)
          .map((s) => text(obj(s)?.name))
          .join("/"),
      ),
      album: sanitize(
        list(song.albums)
          .map((a) => text(obj(a)?.name))
          .join("/"),
      ),
      year: "",
      coverUrl: cover ?? "",
      // 咪咕的结果里直接带歌词地址，取词时优先用它
      lyricsUrl: text(song.lyricUrl),
      raw: song as unknown as Record<string, unknown>,
    };
  });
}

// ---------------------------------------------------------------------------
// 酷我（search.kuwo.cn 老接口；实测必须带 uid/ver 才是新字段格式）
// ---------------------------------------------------------------------------

/**
 * 酷我返回的是**单引号 JSON**（Python 风格的 `{'a':'b'}`），不是合法 JSON。
 * 这里做一次宽松修补：给未加引号的 key 补双引号，再把单引号换成双引号。
 * 失败则用正则逐条抠字段兜底。
 */
function parseKuwoPayload(raw: string): Record<string, unknown>[] {
  const arrayStart = raw.indexOf("'abslist':[");
  if (arrayStart < 0) return [];
  const body = raw.slice(arrayStart + "'abslist':[".length);
  const records: Record<string, unknown>[] = [];
  for (const chunk of body.split(/\},\{/)) {
    const rec: Record<string, unknown> = {};
    for (const match of chunk.matchAll(/'([A-Za-z_]+)':'([^']*)'/g)) {
      rec[match[1]] = match[2];
    }
    if (Object.keys(rec).length) records.push(rec);
    if (records.length >= PER_SOURCE_LIMIT) break;
  }
  return records;
}

async function searchKuwo(keyword: string): Promise<MusicTagSearchResult[]> {
  const url =
    "https://search.kuwo.cn/r.s?client=kt&all=" +
    encodeURIComponent(keyword) +
    `&pn=0&rn=${PER_SOURCE_LIMIT}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1` +
    "&ft=music&encoding=utf8&rformat=json";
  const raw = await getText(url, { "User-Agent": DESKTOP_UA });
  return parseKuwoPayload(raw).map((rec) => {
    // 该字段**本身已带 `120/` 前缀**（如 "120/s4s11/89/774616642.jpg"），
    // 早先又拼了一次 120/ → 变成 …/albumcover/120/120/… 实测 404；
    // 这里做一次归一化：有前缀就用原值，没有才补默认尺寸。
    const picShort = text(rec.web_albumpic_short);
    const picPath = picShort ? (/^\d+\//.test(picShort) ? picShort : `120/${picShort}`) : "";
    return {
      source: "kuwo" as const,
      // 取歌词用 `musicId`（DC_TARGETID）
      songId: text(rec.DC_TARGETID) || text(rec.MUSICRID).replace(/^MUSIC_/, ""),
      title: sanitize(text(rec.NAME)),
      artist: sanitize(text(rec.ARTIST)),
      album: sanitize(text(rec.ALBUM)),
      year: "",
      coverUrl: picPath ? `https://img1.kuwo.cn/star/albumcover/${picPath}` : "",
      coverKey: picPath,
      raw: rec,
    };
  });
}

// ---------------------------------------------------------------------------
// 对外：单源 / 全源搜索
// ---------------------------------------------------------------------------

const SEARCHERS: Record<MusicTagSource, (keyword: string) => Promise<MusicTagSearchResult[]>> = {
  qq: searchQq,
  netease: searchNetease,
  kugou: searchKugou,
  migu: searchMigu,
  kuwo: searchKuwo,
};

/** 单源搜索；失败抛错（由调用方决定怎么呈现）。 */
export async function searchMusicTagSource(
  source: MusicTagSource,
  keyword: string,
): Promise<MusicTagSearchResult[]> {
  const query = (keyword ?? "").trim();
  if (!query) return [];
  const searcher = SEARCHERS[source];
  if (!searcher) throw new Error(`未知数据源：${source}`);
  const results = await searcher(query);
  return results.filter((r) => r.title);
}

/** 并发搜全部源；单源失败不影响其它源，失败原因收进 `outcome.error`。 */
export async function searchAllMusicTagSources(keyword: string): Promise<MusicTagSourceOutcome[]> {
  const query = (keyword ?? "").trim();
  if (!query) return [];
  const settled = await Promise.all(
    MUSIC_TAG_SOURCES.map(async (source): Promise<MusicTagSourceOutcome> => {
      try {
        return { source, results: await searchMusicTagSource(source, query) };
      } catch (error) {
        return {
          source,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return settled;
}

// ---------------------------------------------------------------------------
// 智能打分（移植 music-tag-web 的 match_score / match_artist）
// ---------------------------------------------------------------------------

/** 归一化：小写、去空格、繁转简，便于跨源比较。 */
function normalize(value: string): string {
  return toSimplified(sanitize(value).toLowerCase().replace(/\s+/g, ""));
}

/**
 * 单字段相似度：0 不相关 / 1 包含 / 2 完全相等。
 *
 * 与参考实现一致：先做繁简与空白归一化，再做相等 → 包含的两级判断。
 */
export function matchScore(mine: string, theirs: string): number {
  const a = normalize(mine);
  const b = normalize(theirs);
  if (!a || !b) return 0;
  if (a === b) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

/** 艺术家相似度：候选可能是「甲,乙」多歌手，逐段比再相加。 */
export function matchArtist(mine: string, theirs: string): number {
  const parts = theirs
    .split(/[,/、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return matchScore(mine, theirs);
  return parts.reduce((sum, part) => sum + matchScore(mine, part), 0);
}

/**
 * 智能排序：按「标题 + 艺术家 + 专辑」总分降序，同分保持原顺序（稳定）。
 *
 * 打分规则与参考实现对齐：
 * - 种子没有艺术家时用标题当艺术家来比；
 * - 种子有艺术家、候选艺术家完全不匹配 → 记 -2（明显不是同一首）；
 * - 种子没填艺术家但候选艺术家与标题命中 → 视为「标题里带艺术家」，加分。
 */
export function smartTagRank(
  seed: { title: string; artist: string; album: string },
  results: MusicTagSearchResult[],
): MusicTagSearchResult[] {
  const title = seed.title?.trim() ?? "";
  const artist = seed.artist?.trim() ?? "";
  const album = seed.album?.trim() ?? "";
  const scored = results.map((result, index) => {
    const titleScore = matchScore(title, result.title);
    let artistScore = matchArtist(artist || title, result.artist);
    const albumScore = matchScore(album || title, result.album);
    if (artist && artistScore === 0) artistScore = -2;
    if (!artist && artistScore >= 1 && titleScore >= 1) {
      // 种子没写艺术家，候选把艺术家拼进了标题：说明标题匹配更可信
      return { result, score: 2 + artistScore + albumScore, index };
    }
    return { result, score: titleScore + artistScore + albumScore, index };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.result);
}

// ---------------------------------------------------------------------------
// 歌词
// ---------------------------------------------------------------------------

function lrcLine(seconds: number, content: string): string {
  const total = Math.max(0, seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(Math.floor(total % 60)).padStart(2, "0");
  const xx = String(Math.round((total % 1) * 100)).padStart(2, "0");
  return `[${mm}:${ss}.${xx}]${content}`;
}

/** 酷我：`songinfoandlrc` 返回结构化行，自己拼 LRC */
async function lyricsKuwo(songId: string): Promise<string> {
  if (!songId) return "";
  const url = `http://kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(songId)}`;
  const data = await getJson<{ data?: { lrclist?: Array<{ time?: string; lineLyric?: string }> } }>(
    url,
    { "User-Agent": DESKTOP_UA, Referer: "http://kuwo.cn/" },
  );
  const lines = data.data?.lrclist ?? [];
  return lines
    .map((line) => lrcLine(Number(line.time ?? 0), sanitize(text(line.lineLyric))))
    .join("\n");
}

/** 网易云：公开 lyric 接口 */
async function lyricsNetease(songId: string): Promise<string> {
  if (!songId) return "";
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(songId)}&lv=-1&kv=-1&tv=-1`;
  const data = await getJson<{ lrc?: { lyric?: string } }>(url, {
    "User-Agent": DESKTOP_UA,
    Referer: "https://music.163.com/",
  });
  return data.lrc?.lyric ?? "";
}

/** 咪咕：搜索结果里就带 lyricUrl，直接拉文本 */
async function lyricsMigu(lyricsUrl: string): Promise<string> {
  if (!lyricsUrl) return "";
  return getText(lyricsUrl, { "User-Agent": MOBILE_UA });
}

/** 酷狗：`app/i/krc.php` 按 FileHash 取词（best-effort，实测部分 hash 会返回空） */
async function lyricsKugou(hash: string): Promise<string> {
  if (!hash) return "";
  const url = `http://m.kugou.com/app/i/krc.php?cmd=100&timelength=999999&hash=${encodeURIComponent(hash)}`;
  return getText(url, { "User-Agent": DESKTOP_UA });
}

/** QQ：复用已有 QRC 解析，再把行拼回 LRC 文本（标签写的是纯文本歌词，LRC 足够） */
async function lyricsQq(result: MusicTagSearchResult): Promise<string> {
  const raw = (result.raw ?? {}) as { mid?: string; durationMs?: number };
  const lines = await qqFetchLyrics({
    id: result.songId,
    mid: String(raw.mid ?? result.coverKey ?? ""),
    title: result.title,
    subtitle: "",
    artist: result.artist,
    album: result.album,
    durationMs: Number(raw.durationMs ?? 0),
  });
  if (!lines?.length) return "";
  return lines.map((line) => lrcLine(line.time, line.text)).join("\n");
}

/**
 * 取候选的歌词全文（LRC 文本）。
 *
 * 每个源都有失效风险，因此**任何失败都返回空串**，由调用方提示「未找到歌词」；
 * 这里不抛错，避免一次取词失败把整个对话框卡住。
 */
export async function fetchTagLyrics(result: MusicTagSearchResult): Promise<string> {
  try {
    switch (result.source) {
      case "qq":
        return await lyricsQq(result);
      case "netease":
        return await lyricsNetease(result.songId);
      case "kugou":
        return await lyricsKugou(String((result.raw as { hash?: string })?.hash ?? result.songId));
      case "migu":
        return await lyricsMigu(result.lyricsUrl ?? "");
      case "kuwo":
        return await lyricsKuwo(result.songId);
      default:
        return "";
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 封面
// ---------------------------------------------------------------------------

/** 从字节里猜图片 MIME（部分图床的 content-type 不可信） */
function sniffImageMime(bytes: Uint8Array, header: string | null): string {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) {
    return "image/webp";
  }
  return "image/jpeg";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // 浏览器预览没有 Buffer
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

/**
 * 下载封面并转成 base64（给「应用」时写进音频文件用）。
 *
 * 走主进程网络栈，规避图床的 CORS / 防盗链；任何失败都返回 `null`，
 * 由调用方决定是否继续（用户仍可手动选图）。
 */
export async function fetchCoverAsBase64(url: string): Promise<MusicTagCover | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await hostFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return null;
    return {
      base64: bytesToBase64(bytes),
      mimeType: sniffImageMime(bytes, res.headers.get("content-type")),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 源 → i18n 键名（Dialog 用来显示来源标签）。 */
export function musicTagSourceLabelKey(source: MusicTagSource): string {
  switch (source) {
    case "qq":
      return "musicTag.sourceQq";
    case "netease":
      return "musicTag.sourceNetease";
    case "kugou":
      return "musicTag.sourceKugou";
    case "migu":
      return "musicTag.sourceMigu";
    case "kuwo":
      return "musicTag.sourceKuwo";
    default:
      return "musicTag.sourceSmart";
  }
}
