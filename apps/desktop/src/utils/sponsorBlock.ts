/**
 * 空降助手（SponsorBlock / 跳过广告段）。
 *
 * 参考实现：
 * - hanydd/BilibiliSponsorBlock（浏览器扩展，本功能的原始出处）
 * - PiliPlus `lib/http/sponsor_block.dart`（Flutter 端移植，本文件主要对照它）
 *
 * ## 为什么要用 query 形式而不是扩展的 hash 前缀
 *
 * 扩展走 `/api/skipSegments/<sha256(bvid) 前4位>`：一次拿回整个前缀桶里**所有**视频的
 * 片段，再在本地按 videoID 匹配。它这么做是因为浏览器无法按 bvid 直接查（服务端只提供
 * 前缀索引 + 客户端匹配）。
 *
 * 而 PiliPlus 用的是 `/api/skipSegments?videoID=<bvid>&cid=<cid>`：直接按视频查，
 * 返回的就是该视频的片段数组。对我们更好：
 *   - 不需要实现 sha256 分桶与本地匹配；
 *   - 不需要缓存整个前缀桶（那个桶会随社区提交越来越大）；
 *   - cid 由服务端过滤，多分 P 视频天然只拿当前分 P 的片段。
 * 两条都实测可用（2026-10，见提交说明）。
 *
 * ## 服务端
 * 默认 `https://www.bsbsb.top`（BilibiliSponsorBlock 官方实例）。设置里可改，
 * 便于用户切到自建/镜像实例。
 */
import { isDesktop } from "@/capabilities";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 默认服务端（与扩展的 config.json 一致）。 */
export const SB_DEFAULT_SERVER = "https://www.bsbsb.top";

/** 片段动作类型（与上游 `actionType` 一致）。 */
export type SbActionType = "skip" | "mute" | "full" | "poi";

/** 片段分类。 */
export type SbCategory =
  | "sponsor"
  | "selfpromo"
  | "exclusive_access"
  | "interaction"
  | "poi_highlight"
  | "intro"
  | "outro"
  | "preview"
  | "filler"
  | "music_offtopic"
  | "padding";

/**
 * 分类元数据。
 *
 * `color` 取自 PiliPlus `segment_type.dart`，用于在进度条上标出片段位置；
 * 与官方扩展的配色保持一致，用户从浏览器扩展迁移过来不会觉得突兀。
 */
export interface SbCategoryMeta {
  key: SbCategory;
  /** 中文名（长，用于设置页说明） */
  label: string;
  /** 短名（用于进度条 tooltip） */
  short: string;
  color: string;
  /** 该分类支持的动作；`full` 表示「整片标记」，不参与进度条区段 */
  actions: SbActionType[];
}

export const SB_CATEGORIES: SbCategoryMeta[] = [
  {
    key: "sponsor",
    label: "赞助/恰饭",
    short: "赞助",
    color: "#00d400",
    actions: ["skip", "mute", "full"],
  },
  {
    key: "selfpromo",
    label: "无偿/自我推广",
    short: "推广",
    color: "#ffff00",
    actions: ["skip", "mute", "full"],
  },
  {
    key: "exclusive_access",
    label: "独家访问/抢先体验",
    short: "品牌合作",
    color: "#008a5c",
    actions: ["full"],
  },
  {
    key: "interaction",
    label: "三连/互动提醒",
    short: "三连提醒",
    color: "#cc00ff",
    actions: ["skip", "mute"],
  },
  {
    key: "poi_highlight",
    label: "精彩时刻/重点",
    short: "精彩时刻",
    color: "#ff1684",
    actions: ["poi"],
  },
  {
    key: "intro",
    label: "过场/开场动画",
    short: "开场动画",
    color: "#00ffff",
    actions: ["skip", "mute"],
  },
  {
    key: "outro",
    label: "鸣谢/结束画面",
    short: "片尾",
    color: "#0202ed",
    actions: ["skip", "mute"],
  },
  {
    key: "preview",
    label: "回顾/概要",
    short: "预览",
    color: "#008fd6",
    actions: ["skip", "mute"],
  },
  { key: "filler", label: "离题/玩笑", short: "离题", color: "#7300FF", actions: ["skip", "mute"] },
  {
    key: "music_offtopic",
    label: "音乐/非音乐",
    short: "非音乐",
    color: "#FF9900",
    actions: ["skip"],
  },
  {
    key: "padding",
    label: "填充内容/前黑/后黑",
    short: "填充内容",
    color: "#222222",
    actions: ["skip"],
  },
];

export const SB_CATEGORY_MAP: Record<string, SbCategoryMeta> = Object.fromEntries(
  SB_CATEGORIES.map((c) => [c.key, c]),
);

/** 一条片段（归一化后）。 */
export interface SbSegment {
  /** 起止秒；`full` 类整片标记时是 [0,0] */
  start: number;
  end: number;
  category: SbCategory;
  action: SbActionType;
  uuid: string;
  /** 所属分 P */
  cid: string;
  /** 视频总时长（秒），上游给出，用于兜底 */
  videoDuration: number;
}

export type SbStatus = "idle" | "loading" | "ready" | "error";

export interface SbResult {
  segments: SbSegment[];
  status: SbStatus;
  error: string;
}

/**
 * 拉取某分 P 的片段。
 *
 * 走宿主通道（`@/ipc/http`）而不是渲染进程 fetch：第三方域名不一定允许跨源，
 * 宿主通道与 B 站接口用的是同一套，最稳。
 *
 * 404 = 这个视频没人提交过片段，属于正常结果，不当作错误。
 */
export async function fetchSegments(
  bvid: string,
  cid: string,
  server = SB_DEFAULT_SERVER,
): Promise<SbResult> {
  const base = (server || SB_DEFAULT_SERVER).replace(/\/+$/, "");
  const url = `${base}/api/skipSegments?videoID=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
  try {
    const res = isDesktop
      ? await (await import("@/ipc/http")).fetch(url, { headers: { "User-Agent": UA } })
      : await fetch(url, { headers: { "User-Agent": UA } });
    // 404 = 该视频暂无片段；对用户来说就是「没有可跳过的内容」
    if (res.status === 404) return { segments: [], status: "ready", error: "" };
    if (!res.ok) {
      return { segments: [], status: "error", error: `空降助手服务返回 HTTP ${res.status}` };
    }
    const text = await res.text();
    const json: unknown = JSON.parse(text);
    if (!Array.isArray(json)) {
      return { segments: [], status: "ready", error: "" };
    }
    return { segments: normalizeSegments(json, cid), status: "ready", error: "" };
  } catch (e) {
    return {
      segments: [],
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 上游原始片段 → 归一化（脏数据一律丢掉，不要让界面崩）。 */
export function normalizeSegments(raw: unknown[], cid: string): SbSegment[] {
  const out: SbSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const seg = m.segment;
    if (!Array.isArray(seg) || seg.length === 0) continue;
    const start = Number(seg[0]);
    // 单元素数组表示「到片尾」；`full` 类整片标记是 [0,0]
    const end = seg.length > 1 ? Number(seg[1]) : Number(m.videoDuration ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const category = String(m.category ?? "") as SbCategory;
    const action = String(m.actionType ?? "skip") as SbActionType;
    out.push({
      start: Math.max(0, start),
      end: Math.max(start, end),
      category,
      action,
      uuid: String(m.UUID ?? ""),
      cid: String(m.cid ?? cid),
      videoDuration: Number(m.videoDuration ?? 0) || 0,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 按用户配置筛出「真正要跳」的片段。
 *
 * 三个条件都要满足：
 * 1. 分类在用户启用的集合里；
 * 2. 动作是 `skip`（`mute` 是静音不是跳过，`full` 是整片标记不该跳，`poi` 是精彩时刻）；
 * 3. 有实际时长（start < end）—— `full` 那类给的是 [0,0]，跳了等于从头开始。
 */
export function skipTargets(segments: SbSegment[], enabled: Record<string, boolean>): SbSegment[] {
  return segments.filter(
    // 用 `=== true` 而不是 `!== false`：默认必须保守。上游随时可能新增分类，
    // 若把「配置里没有」当成「开」，用户没勾过的内容会被悄悄跳掉 ——
    // 对一个跳过工具来说，这比漏跳更糟。
    (s) => s.action === "skip" && enabled[s.category] === true && s.end > s.start,
  );
}

/**
 * 判断当前播放位置是否落在某个待跳片段里。
 *
 * `threshold` 是容差（秒）：播放位置刷新有间隔，片段起点不一定正好被采到。
 * 只处理「刚进入片段」的情形 —— 用户手动拖回片段内时不强跳，否则会来回弹。
 */
export function findActiveSkip(
  targets: SbSegment[],
  currentTime: number,
  threshold = 0.35,
): SbSegment | null {
  for (const s of targets) {
    if (currentTime >= s.start - threshold && currentTime < s.end) return s;
  }
  return null;
}

/** 「已跳过」的记忆：同一条片段在一个视频里只自动跳一次。 */
export function skippedKey(s: SbSegment): string {
  return s.uuid || `${s.start}-${s.end}`;
}
