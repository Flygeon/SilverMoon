/**
 * 取流前端侧：播放页 HTML → 真实视频 URL 的静态快速路径。
 *
 * 顺序（命中即停）：
 * 1. 规则声明的 streamRegex（正则，取首个捕获组或全匹配）
 * 2. 规则声明的 streamJsonPath（页面内嵌 JSON 里指向播放地址的字段）
 * 3. 播放器配置定向提取（苹果CMS 系 `player_aaaa.url` / `src`）
 * 4. JS 里的 base64 地址（`atob("...")`）
 * 5. URL 编码地址（`?url=https%3A%2F%2F...`）
 * 6. 通用 m3u8 直链正则
 * 7. 通用 mp4/flv 直链正则
 *
 * 未命中时调用方走 Rust `anime_webview_resolve` 兜底；若播放器藏在 iframe 里，
 * 调用方可用 `extractStaticStreamDeep` 跟着 iframe 再提取一层。
 *
 * 关于 JSON 转义：苹果CMS 系站点把播放地址放在内嵌 JSON 里，其中的 `/` 会被
 * 写成 `\/`（`https:\/\/cdn.xxx\/a\/index.m3u8`）。旧版正则的字符集排除了 `\`，
 * 且要求 `https:` 后紧跟 `//`，两头都不满足 → 整类站点静态提取全部落空，
 * 只得掉进不可靠的隐藏 webview。这里统一先做一份「反转义副本」再匹配。
 */
import type { AnimeRule } from "@shared/types";
import { readFirstJsonPath, validateJsonPath } from "./animeJsonPath";

export type StaticStreamMethod =
  "regex" | "jsonpath" | "player-config" | "base64" | "urlencoded" | "generic-m3u8" | "generic-mp4";

export interface StaticStreamHit {
  url: string;
  method: StaticStreamMethod;
}

// 允许 `\/`（JSON 转义的斜杠）出现在 URL 里；命中后再统一反转义
const M3U8_RE = /(?:https?:)?\\?\/\\?\/[^"'\s<>]+?\.m3u8[^"'\s<>]*/g;
const MP4_RE = /(?:https?:)?\\?\/\\?\/[^"'\s<>]+?\.(?:mp4|flv)[^"'\s<>]*/gi;

/** 播放地址的样子（用于区分真地址与「云解析」token，如 gugu3 的 vwnet-xxxx） */
const MEDIA_LIKE_RE = /\.(m3u8|mp4|flv)(\?|#|$)/i;

/** JSON 字符串里的 `\/` / `\u002F` 还原成 `/`（无可还原内容时直接返回原串，省一次拷贝） */
function unescapeSlashes(s: string): string {
  let out = s;
  if (out.includes("\\/")) out = out.split("\\/").join("/");
  // JSON 也允许用 `\u002F` 转义斜杠；少数 CMS 模板会这么输出播放地址
  if (/\\u002f/i.test(out)) out = out.replace(/\\u002f/gi, "/");
  return out;
}

/** 常见 HTML 实体（属性值/内嵌 JSON 里的 `&` 会写成 `&amp;`） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * 还原 URL 里的 HTML 实体。
 * 不还原的话 `?token=1&amp;expires=2` 会原样进代理请求，服务端校验签名失败——
 * 页面里明明有地址，播放器却一直 403/403.1。只在提取出的 URL 上做，不改整页 HTML。
 */
function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 解码后确实是 http(s) 媒体地址才接受，避免把普通 base64 文本当播放地址 */
function isAbsoluteMediaUrl(s: string): boolean {
  return /^(?:https?:)?\/\//i.test(s) && MEDIA_LIKE_RE.test(s);
}

function tryPercentDecode(s: string): string {
  if (!/%[0-9a-f]{2}/i.test(s)) return s;
  try {
    const decoded = decodeURIComponent(s);
    return isAbsoluteMediaUrl(decoded) ? decoded : s;
  } catch {
    return s;
  }
}

/**
 * 播放器配置里的地址可能是「伪地址」：URL 编码或 base64。
 * 只有解码结果确实是 http(s) 媒体地址才采用，否则原样返回交给后续路径判断。
 */
function decodeEmbeddedUrl(raw: string): string {
  const s = decodeHtmlEntities(raw).trim();
  if (!s) return "";
  const percent = tryPercentDecode(s);
  if (percent !== s) return percent;
  // 纯 base64（兼容 URL-safe），长度下限避免把普通短串误当编码
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(s)) {
    try {
      const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
      const candidate = tryPercentDecode(atob(normalized).trim());
      if (isAbsoluteMediaUrl(candidate)) return candidate;
    } catch {
      /* 不是合法 base64，保持原值 */
    }
  }
  return s;
}

function resolveMediaUrl(raw: string, baseUrl: string): string {
  const trimmed = decodeHtmlEntities(raw).trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed, baseUrl);
    return url.href;
  } catch {
    return trimmed;
  }
}

function firstGroupOrMatch(match: RegExpExecArray): string {
  for (let i = 1; i < match.length; i++) {
    if (match[i]) return match[i];
  }
  return match[0];
}

/** 从页面 HTML 里抠内嵌 JSON（整页 JSON 或 <script> 内容） */
function extractEmbeddedJson(html: string): unknown {
  try {
    return JSON.parse(html);
  } catch {
    /* 整页不是 JSON，继续 */
  }
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      /* 不是 JSON，继续下一个 script */
    }
  }
  return null;
}

/**
 * 从 `start` 处（应指向 `{`）按括号配对读出完整 JSON 对象。
 * 不能用 `\{[\s\S]*?\}\s*<\/script>` 这类非贪婪正则：配置里普遍有嵌套对象
 * （`{"vod_data":{...},"url":"..."}`），非贪婪会在第一个 `}` 处截断 → 解析失败。
 */
function readBalancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 苹果CMS 系播放页内嵌的播放器配置变量名（按常见度排序） */
const PLAYER_CONFIG_VARS = ["player_aaaa", "player_data", "mac_player"];

/** 播放器配置里可能放地址的字段（`url` 最常见，部分模板用 `src` / `playUrl`） */
const PLAYER_CONFIG_URL_FIELDS = ["url", "src", "playUrl", "play_url", "video"];

/**
 * 从配置字段里取出第一个候选地址：
 * - 字段可能是数组（多线路）
 * - 可能是苹果CMS 的多线路串：`第1集$地址$$$第2集$地址`
 */
function firstUrlFromField(value: unknown): string {
  const raw = Array.isArray(value)
    ? String(value[0] ?? "")
    : typeof value === "string"
      ? value
      : "";
  let s = raw.trim();
  if (!s) return "";
  // 多线路用 $$$ 分隔，取第一条；`名称$地址` 形式则丢掉名称前缀
  s = s.split("$$$")[0].trim();
  const dollar = s.indexOf("$");
  if (dollar >= 0) s = s.slice(dollar + 1).trim();
  return s.split("#")[0].trim();
}

/**
 * 定向提取播放器配置里的 `url` 字段。
 * 只在它长得像播放地址时才认——gugu3 这类「云解析」站把 token（vwnet-xxxx）
 * 放在同一字段，真实地址要跑 JS 换，误取会让播放器拿到一个无效 URL，
 * 不如放行给 webview 兜底。
 */
function extractPlayerConfigUrl(flat: string): string | null {
  for (const name of PLAYER_CONFIG_VARS) {
    // 不能再用 `name=` 字面量：模板常写成 `var player_aaaa = {`（等号前有空格）、
    // `window.player_aaaa={}`。这里允许空白，并排除 `player_aaaa2` 这类更长变量名。
    const assignRe = new RegExp(`(?:^|[^\\w$])${name}\\s*=\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = assignRe.exec(flat)) !== null) {
      const brace = m.index + m[0].length - 1;
      const raw = readBalancedObject(flat, brace);
      if (!raw) continue;
      try {
        const cfg = JSON.parse(raw) as Record<string, unknown>;
        for (const field of PLAYER_CONFIG_URL_FIELDS) {
          const candidate = decodeEmbeddedUrl(firstUrlFromField(cfg[field]));
          if (candidate && MEDIA_LIKE_RE.test(candidate)) return candidate;
        }
      } catch {
        /* 不是合法 JSON，试下一个 */
      }
    }
  }
  return null;
}

/** JS 里 `atob("base64")` / `Base64.decode("base64")` 形式的地址 */
function extractBase64Literal(flat: string): string | null {
  const re = /(?:atob|Base64\.decode)\s*\(\s*["']([A-Za-z0-9+/_=-]{16,})["']\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const decoded = decodeEmbeddedUrl(m[1]);
    if (MEDIA_LIKE_RE.test(decoded)) return decoded;
  }
  return null;
}

/** 形如 `?url=https%3A%2F%2Fcdn...%2Findex.m3u8` 的 URL 编码地址 */
function extractUrlencoded(flat: string): string | null {
  // 原始 `&` 是外层查询串分隔符（地址内部的 & 会被编码成 %26），必须在此截断
  const re = /(?:https?%3A%2F%2F|%2F%2F)[^"'\s<>&\\]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const decoded = tryPercentDecode(m[0]);
    if (MEDIA_LIKE_RE.test(decoded)) return decoded;
  }
  return null;
}

export function extractStaticStream(
  html: string,
  rule: AnimeRule,
  baseUrl: string,
): StaticStreamHit | null {
  // 反转义副本：`\/` → `/`。未转义的 URL 不受影响，所以它是原文的超集。
  const flat = unescapeSlashes(html);

  // 1. 规则正则（先原文再反转义副本：规则作者可能按任一种写法给出）
  if (rule.streamRegex) {
    for (const src of [html, flat]) {
      try {
        const re = new RegExp(rule.streamRegex, "g");
        const m = re.exec(src);
        if (m) {
          const url = resolveMediaUrl(firstGroupOrMatch(m), baseUrl);
          if (url) return { url, method: "regex" };
        }
      } catch {
        /* 非法正则，落到后续路径 */
      }
    }
  }
  // 2. 规则 JSONPath（用反转义副本，JSON 里的地址已还原）
  if (rule.streamJsonPath) {
    try {
      validateJsonPath(rule.streamJsonPath);
      const doc = extractEmbeddedJson(flat);
      if (doc !== null) {
        const value = readFirstJsonPath(doc, rule.streamJsonPath);
        if (value !== null && value !== undefined) {
          const url = resolveMediaUrl(String(value), baseUrl);
          if (url) return { url, method: "jsonpath" };
        }
      }
    } catch {
      /* 忽略，走后续路径 */
    }
  }
  // 3. 播放器配置定向提取（比通用正则准，且能区分真地址与云解析 token）
  const cfgUrl = extractPlayerConfigUrl(flat);
  if (cfgUrl) {
    const url = resolveMediaUrl(cfgUrl, baseUrl);
    if (url) return { url, method: "player-config" };
  }
  // 4. JS 里 base64 包裹的地址
  const b64Url = extractBase64Literal(flat);
  if (b64Url) {
    const url = resolveMediaUrl(b64Url, baseUrl);
    if (url) return { url, method: "base64" };
  }
  // 5. URL 编码包裹的地址（代理播放器常见：?url=https%3A%2F%2F...）
  const encodedUrl = extractUrlencoded(flat);
  if (encodedUrl) {
    const url = resolveMediaUrl(encodedUrl, baseUrl);
    if (url) return { url, method: "urlencoded" };
  }
  // 6. 通用 m3u8（用 String.match 而非 exec：模块级 /g 正则的 lastIndex 在多次
  //    exec 间不重置，跨调用会跳过命中，match 则每次自动清零）
  const m3u8 = flat.match(M3U8_RE);
  if (m3u8 && m3u8.length) {
    const url = resolveMediaUrl(m3u8[0], baseUrl);
    if (url) return { url, method: "generic-m3u8" };
  }
  // 7. 通用 mp4/flv
  const mp4 = flat.match(MP4_RE);
  if (mp4 && mp4.length) {
    const url = resolveMediaUrl(mp4[0], baseUrl);
    if (url) return { url, method: "generic-mp4" };
  }
  return null;
}

/**
 * 从页面里取 iframe 播放器地址（`src` 或懒加载的 `data-src`），已转成绝对 URL。
 * 只返回 http(s) 地址；`about:blank` / `javascript:` 之类直接丢弃。
 */
export function extractIframeUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const tagRe = /<iframe\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const attr = /\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
    if (!attr) continue;
    const url = resolveMediaUrl(attr[1], baseUrl);
    if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * iframe 优先级：播放器/播放页候选优先；明显的广告 iframe 降级并跳过。
 * 壳页里的广告 iframe 常带 `<video src="...mp4">`，不排序就可能把广告当正片。
 */
function iframeScore(url: string): number {
  const s = url.toLowerCase();
  let score = 0;
  if (/(?:player|play|vod|embed|video|iframe|m3u8)/.test(s)) score += 2;
  if (
    /(?:doubleclick|googlesyndication|googleadservices|adservice|\/ads?\/|banner|popads)/.test(s)
  ) {
    score -= 4;
  }
  return score;
}

/**
 * 静态提取的「深度」版本：外层壳页常把播放器放在 `<iframe src="...">` 里，
 * 真正的播放地址在内层页面。这里先按当前页提取，未命中再跟 iframe 抓一层。
 *
 * 纯函数：网络抓取由调用方以 `fetchPage` 注入，方便单测；为避免把取流拖成
 * 「抓一堆广告 iframe 再进 webview」，每层最多 2 个候选，默认最多 2 层、
 * 总共最多抓 2 个 iframe（调用方超时 8s 时最坏也只多花 16s）。
 */
export async function extractStaticStreamDeep(
  html: string,
  rule: AnimeRule,
  baseUrl: string,
  fetchPage: (url: string) => Promise<string | null>,
  maxDepth = 2,
  maxFetches = 2,
): Promise<StaticStreamHit | null> {
  let remaining = maxFetches;

  async function walk(
    pageHtml: string,
    pageUrl: string,
    depth: number,
  ): Promise<StaticStreamHit | null> {
    const hit = extractStaticStream(pageHtml, rule, pageUrl);
    if (hit) return hit;
    if (depth <= 0 || remaining <= 0) return null;
    // 播放器路径优先；一眼是广告域名的 iframe 直接跳过（不要为它浪费抓取预算）
    const candidates = extractIframeUrls(pageHtml, pageUrl)
      .sort((a, b) => iframeScore(b) - iframeScore(a))
      .slice(0, 2);
    for (const iframeUrl of candidates) {
      if (iframeScore(iframeUrl) <= -4) continue;
      if (remaining <= 0) break;
      remaining -= 1;
      let child: string | null = null;
      try {
        child = await fetchPage(iframeUrl);
      } catch {
        /* 单个 iframe 抓取失败不影响其它候选 */
        continue;
      }
      if (!child) continue;
      const childHit = await walk(child, iframeUrl, depth - 1);
      if (childHit) return childHit;
    }
    return null;
  }

  return walk(html, baseUrl, maxDepth);
}

/** 挑选流：优先 m3u8（能带动画字幕/进度），其次 mp4；URL 去重保持顺序 */
export function pickStream(urls: string[]): string | null {
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    const k = u.split("#")[0];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const m3u8 = unique.find((u) => u.includes(".m3u8"));
  if (m3u8) return m3u8;
  return unique[0] ?? null;
}
