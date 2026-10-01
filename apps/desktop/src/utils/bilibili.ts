/**
 * B 站（Bilibili）网页端接口客户端。
 *
 * 移植自参考项目 PiliPlus（`lib/http/*` + `lib/utils/wbi_sign.dart`），
 * 但按桌面端的既有范式重写：
 * - 全部请求走宿主 CORS 豁免通道 `@/ipc/http`（浏览器预览退回原生 fetch），
 *   与 `utils/qqMusic.ts` / `utils/kgMusic.ts` 同款；API 端点不需要 Referer，
 *   因此不设置该头（undici 对 Referer/Origin 这类禁止头的行为不确定）。
 * - 视频 CDN（upos/bilivideo）**必须带 Referer**，而 `<video>` 元素无法自带头，
 *   改由主进程 `webRequest.onBeforeSendHeaders` 统一补（见 electron/main.ts）。
 * - 登录凭据（SESSDATA / bili_jct / DedeUserID…）落 `bilibili.json`（JSON 存储），
 *   与 Bangumi token 同款本地保存策略。
 *
 * 选择**网页端**而非 App 端的原因：App 端所有接口都要 `appkey/appsec` 签名，
 * 而网页端扫码登录（passport web qrcode）与 WBI 签名都不需要内置密钥，
 * PC 端 playurl 也能直接给出 `<video>` 可播的整段 MP4（durl）。
 */
import { isDesktop } from "@/capabilities";
import { JsonStore } from "@/ipc/store";
import { mapDanmakuMode, mergeDuplicates, type ArtDanmu } from "@/utils/danmaku";
import { md5 } from "@/utils/md5";

// ------------------------------------------------------------------ 常量

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const API = "https://api.bilibili.com";
const PASSPORT = "https://passport.bilibili.com";

/** WBI 混淆表（标准 64 项的前 32 位，见 PiliPlus wbi_sign.dart:19）。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13,
];

/** WBI 签名前要从参数值里剔除的字符。 */
const CHR_FILTER = /[!'()*]/g;

// ------------------------------------------------------------------ 类型

export interface BiliAccount {
  isLogin: boolean;
  mid: number;
  name: string;
  face: string;
  coins: number;
  level: number;
  vip: boolean;
}

export const BILI_ANONYMOUS: BiliAccount = {
  isLogin: false,
  mid: 0,
  name: "",
  face: "",
  coins: 0,
  level: 0,
  vip: false,
};

/** 推荐流 / 搜索结果归一化后的条目。 */
export interface BiliVideo {
  aid: string;
  bvid: string;
  cid: string;
  title: string;
  cover: string;
  /** 秒 */
  duration: number;
  ownerName: string;
  ownerFace: string;
  ownerMid: number;
  view: number;
  danmaku: number;
  like: number;
  pubdate: number;
  /** 推荐理由 */
  reason: string;
  goto: string;
}

export interface BiliPart {
  page: number;
  cid: string;
  part: string;
  duration: number;
}

export interface BiliOwner {
  mid: number;
  name: string;
  face: string;
}

export interface BiliStat {
  view: number;
  danmaku: number;
  reply: number;
  like: number;
  coin: number;
  favorite: number;
  share: number;
}

export interface BiliDetail {
  bvid: string;
  aid: string;
  cid: string;
  title: string;
  desc: string;
  cover: string;
  duration: number;
  pubdate: number;
  owner: BiliOwner;
  stat: BiliStat;
  parts: BiliPart[];
  width: number;
  height: number;
}

export interface BiliStream {
  id: number;
  url: string;
  backupUrls: string[];
  codecs: string;
  width: number;
  height: number;
  bandwidth: number;
  /** DASH SegmentBase 初始化段（字节区间 `start-end`），MSE 首个 append 必需 */
  initRange: string;
  /** DASH SegmentBase 索引段（sidx），用来枚举分片；为空时退回 HTTP Range 直读 */
  indexRange: string;
  /** MIME（`video/mp4` / `audio/mp4`），直接作为 MSE 的 `SourceBuffer` 类型 */
  mimeType: string;
}

export interface BiliFormat {
  quality: number;
  label: string;
}

export interface BiliPlayUrl {
  quality: number;
  /** 音频清晰度码（DASH 下由上游单独给出，如 30232） */
  audioQuality: number;
  /** 可选清晰度（降序） */
  qualities: number[];
  formats: BiliFormat[];
  /**
   * 整段 MP4（`fnval=1` 的 durl）。
   *
   * **注意**：上游只在「渐进式 MP4」通道下返回 durl，该通道最高只给到 720P
   * （实测 1080P 及以上的 durl 一律被服务端钳回 64）。1080P+ 只能走 DASH。
   */
  durl: string[];
  /** DASH 视频分流（按码率降序，同清晰度可能含 avc/hevc/av1 多种编码） */
  dashVideo: BiliStream[];
  /** DASH 音频分流（按码率降序） */
  dashAudio: BiliStream[];
  /** 本次取流是否走了「未登录预览高清」（`try_look=1`） */
  tryLook: boolean;
}

export interface BiliQrStatus {
  /** 0 成功 / 86038 过期 / 86090 已扫码待确认 / 86101 未扫码 */
  code: number;
  message: string;
  /**
   * 扫码成功时，跳转链给出的同一批凭据的**另一种形态**（urlencoded 原值）。
   *
   * `crossDomain` 的 query 与 cookie 对逗号的表示不同（`,` vs `%2C`），到底哪种
   * 服务端才认，只有 `nav` 能回答。主形态验不过时由 store 拿这份再试一次。
   */
  alt?: Record<string, string>;
}

// ------------------------------------------------------------------ 工具

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function str(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  const s = String(v);
  return s.length ? s : fallback;
}

/** 去掉搜索接口的 `<em class="keyword">` 高亮与常见实体。 */
export function biliStripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 封面地址归一化，并统一升级为 https。 */
export function biliImage(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("http://")) return "https://" + s.slice(7);
  return s;
}

/** 视频流地址：强制 https（主进程补 Referer 时明文 http 会被 Chromium 拦掉）。 */
export function biliMediaUrl(url: string): string {
  return url.startsWith("http://") ? "https://" + url.slice(7) : url;
}

/** 秒 → `mm:ss` / `h:mm:ss`。 */
export function biliDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** 播放量 / 弹幕数：`1.2万`、`3.4亿`。 */
export function biliCount(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/** Unix 秒 → 相对时间。 */
export function biliPubdate(seconds: number): string {
  if (!seconds) return "";
  const t = new Date(seconds * 1000);
  const diff = Date.now() - t.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}天前`;
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${mm}-${dd}`;
}

/** 画质码 → 中文标签（取不到支持列表时兜底）。 */
export function biliQualityLabel(qn: number): string {
  const table: Record<number, string> = {
    6: "240P 流畅",
    16: "360P 清晰",
    32: "480P 标清",
    64: "720P 高清",
    74: "720P60",
    80: "1080P 高清",
    100: "智能修复",
    112: "1080P+ 高码率",
    116: "1080P60",
    120: "4K 超清",
    125: "HDR 真彩",
    126: "杜比视界",
    127: "8K 超高清",
    129: "HDR Vivid",
  };
  return table[qn] ?? `未知(${qn})`;
}

// ------------------------------------------------------------------ 凭据

type CookieMap = Record<string, string>;

const credentialStore = new JsonStore("bilibili.json");

let cookies: CookieMap = {};
let cookiesLoaded = false;

async function ensureCookies(): Promise<void> {
  if (cookiesLoaded) return;
  cookiesLoaded = true;
  try {
    cookies = (await credentialStore.get<CookieMap>("cookies")) ?? {};
  } catch {
    cookies = {};
  }
}

async function persistCookies(): Promise<void> {
  try {
    await credentialStore.set("cookies", cookies);
    await credentialStore.save();
  } catch {
    // 浏览器预览 / 存储不可用时静默：本次会话仍可用
  }
}

function cookieHeader(): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function biliIsLoggedIn(): boolean {
  return !!cookies.SESSDATA;
}

export function biliCsrf(): string {
  return cookies.bili_jct ?? "";
}

// ------------------------------------------------------------------ 请求

async function hostFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (isDesktop) {
    const mod = await import("@/ipc/http");
    return mod.fetch(url, init);
  }
  return fetch(url, init);
}

/**
 * 带凭据收集的请求。
 *
 * 宿主通道读得到响应的 `Set-Cookie`（已实测：undici 不会像浏览器那样把它从
 * headers 里过滤掉），所以每次请求都顺手并入 cookie 罐——这是最可靠的来源，
 * 因为它的值是**原样**的。
 */
/**
 * 单个请求的超时。
 *
 * 宿主通道（主进程 undici）**没有**默认超时，TCP 半开时 Promise 会一直挂着，
 * 界面就永远停在 loading 且没有重试入口。这里统一兜住。
 * 弹幕 XML 可能有几 MB，给宽一点；接口都是小 JSON。
 */
const REQUEST_TIMEOUT_MS = 15000;
const MEDIA_TIMEOUT_MS = 30000;

async function biliFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await hostFetch(url, { ...init, signal: ac.signal });
    absorbCookies(res);
    return res;
  } catch (e) {
    // AbortError 的原始信息是 "This operation was aborted"，对用户毫无意义
    if (ac.signal.aborted) throw new Error("请求超时，请检查网络后重试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Set-Cookie 的属性名，不能当成 cookie 收进来。 */
const SET_COOKIE_ATTRS = new Set([
  "expires",
  "path",
  "domain",
  "max-age",
  "secure",
  "httponly",
  "samesite",
  "version",
  "comment",
]);

/** 取出响应里的原始 Set-Cookie 串（宿主通道会挂回 `getSetCookie`，见 `@/ipc/http`）。 */
function rawSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    const list = headers.getSetCookie();
    if (list.length) return list;
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/** 解析一条 Set-Cookie 的键值对（值逐字保留，不解码）。 */
function parseSetCookie(raw: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([A-Za-z0-9_-]+)=([^;,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    const value = m[2].trim();
    if (!name || !value || SET_COOKIE_ATTRS.has(name.toLowerCase())) continue;
    out.push([name, value]);
  }
  return out;
}

/** 把响应的 Set-Cookie 并入 cookie 罐（值保持原样，不做解码）。 */
function absorbCookies(res: Response): void {
  let changed = false;
  for (const [name, value] of rawSetCookies(res).flatMap(parseSetCookie)) {
    if (cookies[name] !== value) {
      cookies[name] = value;
      changed = true;
    }
  }
  if (changed) void persistCookies();
}

/** 从 `k=v&...` 取**原始**（不解码）键值对。 */
function parseRawQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const query = url.split("?")[1];
  if (!query) return out;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * 把登录跳转链里的值还原成 **cookie 形态**。
 *
 * 服务端拼 `crossDomain?...` 用的是 urlencoded 规则：`,` 与 `*` 原样留着，只有
 * `: /` 之类才转义（实测形如
 * `SESSDATA=35f5d9fc,1667303493,e6e01*51&gourl=https%3A%2F%2Fwww.bilibili.com`）。
 * 而 cookie 值按 RFC 6265 不允许出现逗号 —— 浏览器真正存下来、之后每次请求发出去的
 * 都是 `35f5d9fc%2C1667303493%2Ce6e01*51`。所以这里先解回原值、再按 cookie 规则编回去；
 * 直接把 query 里的逗号形态当 cookie 发，服务端一律按未登录处理（界面表现就是
 * 「已授权，但账号信息获取失败」）。
 */
function cookieValueFromLoginUrl(raw: string): string {
  try {
    // `+` 按 urlencoded 语义是空格；`*` `!` `'` `(` `)` 这几个 encodeURIComponent
    // 不转义，正好也都是合法 cookie-octet，所以编出来即为合法 cookie 值。
    return encodeURIComponent(decodeURIComponent(raw.replace(/\+/g, " ")));
  } catch {
    return encodeURIComponent(raw);
  }
}

/** 登录跳转链里这几个才是鉴权 cookie，其余（gourl / Expires / Sign…）不是。 */
const URL_COOKIE_NAMES = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "sid",
  "buvid3",
  "buvid4",
  "b_nut",
]);

function baseHeaders(): Record<string, string> {
  const ck = cookieHeader();
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    ...(ck ? { Cookie: ck } : {}),
  };
}

/**
 * 带 Referer / Origin 的请求头。
 *
 * 个人空间类接口（x/space/*、历史、收藏夹）有 **Referer 白名单校验**：缺 Referer
 * 时上游直接回 -352（风控校验失败）或 -799（请求过于频繁），而这两个码看起来都像
 * 「被限流」，极易误判成需要重试 —— 实测补上 Referer 后立即 200（见 utils 顶部说明）。
 *
 * 注意 Origin 也要一起给：x/space/wbi/acc/info 只认 Origin=space.bilibili.com，
 * Referer 单独给仍会 -352。
 */
function spaceHeaders(mid: number | string = ""): Record<string, string> {
  const origin = "https://space.bilibili.com";
  return {
    Referer: mid ? origin + "/" + String(mid) : origin + "/",
    Origin: origin,
  };
}

/** 视频站（历史 / 收藏 / 点赞）用的 Referer，与个人空间不同。 */
const VIDEO_REFERER = "https://www.bilibili.com";

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("B站返回了非 JSON 内容");
  }
}

async function getJson(
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const res = await biliFetch(url, { headers: { ...baseHeaders(), ...headers } }, timeoutMs);
  const text = await res.text();
  // 原来完全不看 HTTP 状态：上游 5xx / 412 挑战页 / 网关 HTML 一律被 decodeJson
  // 说成「B站返回了非 JSON 内容」，无法区分「网络坏 / 被风控 / 接口变了」。
  if (!res.ok) {
    throw new Error(`请求失败：HTTP ${res.status}（${text.slice(0, 80) || "无响应体"}）`);
  }
  const json = decodeJson(text);
  if (!json || typeof json !== "object") throw new Error("B站返回了非对象 JSON");
  return json as Record<string, unknown>;
}

/** 业务错误统一在 `code`（0 成功 / -101 未登录 / -352 风控…）。 */
function assertOk(json: Record<string, unknown>, what: string): void {
  const code = num(json.code);
  if (code === 0) return;
  const msg = str(json.message, "未知错误");
  if (code === -101) {
    // 服务端明确说未登录 —— 本地凭据已经失效了，必须清掉。
    // 否则 biliIsLoggedIn() 永远返回 true，后续请求还会继续发、继续失败，
    // 界面显示「已登录」却处处报「需要先登录」，自相矛盾。
    if (cookies.SESSDATA) {
      delete cookies.SESSDATA;
      delete cookies.bili_jct;
      delete cookies.DedeUserID;
      delete cookies.DedeUserID__ckMd5;
      void persistCookies();
    }
    throw new Error("登录已过期，请重新扫码登录");
  }
  // 这三个码看起来都像「数据出错」，实际都是触发了风控 / 频控。
  // 把它们讲成人话，否则用户只会看到「失败：风控校验失败」，无从下手。
  if (code === -412) {
    throw new Error(`${what}失败：B 站风控拦截了这次请求，请稍后再试`);
  }
  if (code === -352) {
    throw new Error(`${what}失败：B 站风控校验失败，请稍后再试（或重新登录）`);
  }
  if (code === -799) {
    throw new Error(`${what}失败：请求过于频繁，请稍后再试`);
  }
  // 这几个是「有明确含义、且用户能采取行动」的业务码（参考 PiliPlus video.dart 的映射）
  const known: Record<number, string> = {
    "-403": "没有访问权限",
    "-404": "内容不存在或已被删除",
    "-509": "请求过于频繁，请稍后再试",
    62002: "该内容不可见",
    87008: "该视频为充电专属，需要先充电才能观看",
  };
  const hint = known[code];
  if (hint) throw new Error(`${what}失败：${hint}（code=${code}）`);
  throw new Error(`${what}失败：${msg}（code=${code}）`);
}

// ---- WBI 签名 ----

let mixinKey = "";
/**
 * 密钥签发时间（毫秒）。
 *
 * 原来用的是「当月第几天」比较：桌面端进程可以连续运行好几天，跨天后
 * `getDate()` 变了但缓存还在，于是**继续用旧密钥签名**，所有 WBI 接口
 * （推荐 / 搜索 / 详情 / 空间投稿）全部回 -352，而界面只会说「风控校验失败」，
 * 排查方向被完全带偏。改为按时间戳算 TTL，顺便避开跨月 / 时区问题。
 */
let mixinIssuedAt = 0;
/** WBI 密钥有效期：上游每天轮换，取 6 小时足够保守 */
const MIXIN_TTL_MS = 6 * 60 * 60 * 1000;
/** 并发去重：多个请求同时发现密钥过期时只打一次 nav */
let mixinInflight: Promise<string> | null = null;

function fileNameOf(url: string): string {
  const noQuery = url.split("?")[0];
  const slash = noQuery.lastIndexOf("/");
  const name = slash >= 0 ? noQuery.slice(slash + 1) : noQuery;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** `/x/web-interface/nav`：既是账号信息，也是 WBI 密钥来源（无需登录）。 */
async function navRaw(): Promise<Record<string, unknown>> {
  return getJson(`${API}/x/web-interface/nav`);
}

function mixinFromNav(json: Record<string, unknown>): string {
  const data = json.data as Record<string, unknown> | undefined;
  const img = data?.wbi_img as Record<string, unknown> | undefined;
  const orig = fileNameOf(str(img?.img_url)) + fileNameOf(str(img?.sub_url));
  if (orig.length < 64) return "";
  return MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join("");
}

async function ensureMixinKey(): Promise<string> {
  if (mixinKey && Date.now() - mixinIssuedAt < MIXIN_TTL_MS) return mixinKey;
  if (mixinInflight) return mixinInflight;
  mixinInflight = (async () => {
    try {
      const key = mixinFromNav(await navRaw());
      if (key) {
        mixinKey = key;
        mixinIssuedAt = Date.now();
      }
    } catch (e) {
      console.warn("[bilibili] WBI 密钥获取失败：", e);
    } finally {
      mixinInflight = null;
    }
    return mixinKey;
  })();
  return mixinInflight;
}

/**
 * 生成 WBI 签名后的查询串（含 `wts` / `w_rid`）。
 * 返回值里的值**已经编码**，拼 URL 时不能再交给 URLSearchParams（会二次编码）。
 */
async function signedQuery(params: Record<string, string | number>): Promise<string> {
  const key = await ensureMixinKey();
  // 拿空 key 去签，w_rid 一定是错的，上游只会回 -352「风控校验失败」——
  // 那会把「密钥没取到」误报成风控。这里显式抛，指向真正的原因。
  if (!key) throw new Error("WBI 密钥获取失败，无法签名请求（可能被风控或网络异常）");
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) all[k] = String(v);
  all.wts = String(Math.floor(Date.now() / 1000));
  const keys = Object.keys(all).sort();
  const enc = (s: string) => encodeURIComponent(s.replace(CHR_FILTER, ""));
  const query = keys.map((k) => `${enc(k)}=${enc(all[k])}`).join("&");
  const rid = md5(query + key);
  return `${query}&w_rid=${rid}`;
}

async function wbiGet(
  path: string,
  params: Record<string, string | number>,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = await signedQuery(params);
  return getJson(`${API}${path}?${qs}`, headers);
}

/** 匿名会话也要有 `buvid3`，否则推荐/取流会回 -352 风控。 */
export async function biliEnsureDevice(): Promise<void> {
  await ensureCookies();
  if (cookies.buvid3) return;
  try {
    const json = await getJson(`${API}/x/frontend/finger/spi`);
    const data = json.data as Record<string, unknown> | undefined;
    const b3 = str(data?.b_3);
    const b4 = str(data?.b_4);
    if (b3) cookies.buvid3 = b3;
    if (b4) cookies.buvid4 = b4;
    await persistCookies();
  } catch (e) {
    console.warn("[bilibili] buvid 初始化失败：", e);
  }
}

// ------------------------------------------------------------------ 账号

export async function biliNav(): Promise<BiliAccount> {
  await biliEnsureDevice();
  const json = await navRaw();
  const data = json.data as Record<string, unknown> | undefined;
  // `data` 缺失只出现在业务失败时（-101 未登录 / -352 风控…）。把上游原话抛出去，
  // 否则界面只能笼统报「账号信息获取失败」，无法区分是凭据没生效还是被风控拦了。
  if (!data) {
    throw new Error(
      `账号信息查询失败：${str(json.message, "上游未返回数据")}（code=${num(json.code)}）`,
    );
  }
  // 顺手缓存 WBI 密钥，省一次 nav。判据与 ensureMixinKey 保持一致（TTL），
  // 原来的 `!mixinKey` 守卫会让过期密钥永远不被这次 nav 刷新。
  if (!mixinKey || Date.now() - mixinIssuedAt >= MIXIN_TTL_MS) {
    const key = mixinFromNav(json);
    if (key) {
      mixinKey = key;
      mixinIssuedAt = Date.now();
    }
  }
  const level = data.level_info as Record<string, unknown> | undefined;
  const account: BiliAccount = {
    isLogin: data.isLogin === true,
    mid: num(data.mid),
    name: str(data.uname),
    face: biliImage(data.face),
    coins: num(data.money),
    level: num(level?.current_level),
    vip: num(data.vipStatus) === 1,
  };
  return account;
}

// ------------------------------------------------------------------ 扫码登录

export async function biliQrGenerate(): Promise<{ key: string; url: string }> {
  await ensureCookies();
  const json = await getJson(`${PASSPORT}/x/passport-login/web/qrcode/generate`);
  assertOk(json, "获取二维码");
  const data = json.data as Record<string, unknown> | undefined;
  const key = str(data?.qrcode_key);
  const url = str(data?.url);
  if (!key || !url) throw new Error("上游未返回二维码");
  return { key, url };
}

export async function biliQrPoll(key: string): Promise<BiliQrStatus> {
  await ensureCookies();
  let alt: Record<string, string> | undefined;
  const res = await biliFetch(
    `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    { headers: baseHeaders() },
  );
  // biliFetch 已就地把这次的 Set-Cookie 按原值吸收 —— 这是最权威的来源（服务端下发什么、
  // 浏览器就存什么）。这里只记下「哪些名字来自响应头」，好让下面的 url 兜底不去覆盖它们。
  const headerPairs = rawSetCookies(res).flatMap(parseSetCookie);
  const fromHeader = new Set(headerPairs.map(([name]) => name));
  const json = decodeJson(await res.text()) as Record<string, unknown>;
  const data = json.data as Record<string, unknown> | undefined;
  // 扫码状态码在 data.code，外层 code 恒为 0
  const code = data ? num(data.code, 86101) : 86101;
  const message = data ? str(data.message) : str(json.message);
  if (code === 0 && data) {
    // 兜底：跳转链里也带着同一批凭据，值是 urlencoded 形态，先按 cookie 形态落罐
    // （见 cookieValueFromLoginUrl）；原始形态一并返回，验不过时换它再试。
    const pairs = Object.entries(parseRawQuery(str(data.url))).filter(([k]) =>
      URL_COOKIE_NAMES.has(k),
    );
    for (const [k, v] of pairs) {
      if (fromHeader.has(k)) continue;
      cookies[k] = cookieValueFromLoginUrl(v);
    }
    await persistCookies();
    if (pairs.length) alt = Object.fromEntries(pairs);
  }
  return { code, message, alt };
}

/**
 * 直接写入一批 cookie（值**原样**，不再做编码转换）。
 *
 * 登录兜底用：跳转链 query 的 `,` 形态与 cookie 的 `%2C` 形态只能二选一，而哪个
 * 才是服务端认的形态，只有 `nav` 能回答 —— `biliQrPoll` 返回的 `alt` 就是这个
 * 「另一种形态」，验不过时由 store 换上再验一次。
 */
export async function biliApplyCookies(pairs: Record<string, string>): Promise<void> {
  await ensureCookies();
  for (const [name, value] of Object.entries(pairs)) {
    if (value) cookies[name] = value;
  }
  await persistCookies();
}

export async function biliLogout(): Promise<void> {
  try {
    const csrf = biliCsrf();
    if (csrf) {
      await biliFetch(`${PASSPORT}/login/exit/v2`, {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `biliCSRF=${encodeURIComponent(csrf)}`,
      });
    }
  } catch (e) {
    console.warn("[bilibili] 登出请求失败：", e);
  }
  cookies = {};
  await persistCookies();
}

// ------------------------------------------------------------------ 评论

export interface BiliReplyAuthor {
  mid: number;
  name: string;
  avatar: string;
  level: number;
  vip: boolean;
}

export interface BiliReply {
  rpid: string;
  author: BiliReplyAuthor;
  message: string;
  like: number;
  /** 上游给好的中文相对时间（如「7小时前发布」），省一层格式化 */
  timeDesc: string;
  location: string;
  /** 直接子回复数（楼中楼） */
  replyCount: number;
  /** UP 主点过赞 */
  upLiked: boolean;
  /** 当前登录用户是否已给这条评论点赞（上游顶层字段 `action`：0 未赞 / 1 已赞） */
  liked: boolean;
  /** 是否 UP 主本人发的 */
  isUp: boolean;
  /** 置顶（整体置顶 / UP 置顶） */
  isTop: boolean;
  /** 楼中楼预览（上游一般给 3 条） */
  replies: BiliReply[];
}

export interface BiliReplyPage {
  replies: BiliReply[];
  /** 置顶评论（可能同时存在整体置顶与 UP 置顶，已按 rpid 去重） */
  top: BiliReply[];
  total: number;
  isEnd: boolean;
  /** 下一页游标；已到底时为空串 */
  nextOffset: string;
}

/** 评论排序，取值与上游 `mode` 一致：2 按时间 / 3 按热度 */
export type BiliReplySort = 2 | 3;

export const BILI_REPLY_HOT: BiliReplySort = 3;
export const BILI_REPLY_TIME: BiliReplySort = 2;

function replyAuthor(m: Record<string, unknown> | undefined): BiliReplyAuthor {
  if (!m) return { mid: 0, name: "", avatar: "", level: 0, vip: false };
  const level = m.level_info as Record<string, unknown> | undefined;
  const vip = m.vip as Record<string, unknown> | undefined;
  return {
    mid: num(m.mid),
    name: str(m.uname),
    avatar: biliImage(m.avatar),
    level: num(level?.current_level),
    vip: num(vip?.vipStatus) === 1,
  };
}

/** 单条评论归一化（一级与楼中楼同构）。`upMid` 用来标「UP 主本人」。 */
function replyFromJson(raw: Record<string, unknown>, upMid: number): BiliReply {
  const control = raw.reply_control as Record<string, unknown> | undefined;
  const content = raw.content as Record<string, unknown> | undefined;
  const upAction = raw.up_action as Record<string, unknown> | undefined;
  const subs = (raw.replies as unknown[]) ?? [];
  return {
    rpid: str(raw.rpid),
    author: replyAuthor(raw.member as Record<string, unknown> | undefined),
    message: str(content?.message),
    like: num(raw.like),
    timeDesc: str(control?.time_desc),
    location: str(control?.location),
    // 一级评论的「回复数」在 rcount，count 是含楼中楼的总数
    replyCount: num(raw.rcount ?? raw.count),
    upLiked: upAction?.like === true,
    // 别用 reply_control.action —— 实测常为 undefined；顶层 action 才是权威
    liked: num(raw.action) === 1,
    isUp: upMid > 0 && num(raw.mid) === upMid,
    isTop: false,
    replies: subs
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => replyFromJson(x, upMid)),
  };
}

function replyList(raw: unknown, upMid: number): BiliReply[] {
  return ((raw as unknown[]) ?? [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => replyFromJson(x, upMid));
}

/** 置顶评论：整体置顶 `top` 与 UP 置顶 `upper` 可能都存在，按 rpid 去重。 */
function pinnedReplyList(data: Record<string, unknown> | undefined, upMid: number): BiliReply[] {
  const out: BiliReply[] = [];
  for (const key of ["top", "upper"]) {
    const raw = data?.[key] as Record<string, unknown> | undefined;
    if (!raw || !raw.rpid) continue;
    const item = replyFromJson(raw, upMid);
    if (!out.some((x) => x.rpid === item.rpid)) out.push({ ...item, isTop: true });
  }
  return out;
}

/**
 * 拉一页评论。
 *
 * 用 `/x/v2/reply/main`（游标分页）：实测**无需 WBI、无需登录**即可返回，且只有它
 * 给得出「总数 + 是否到底」——`/x/v2/reply` 的 `page` 字段全是 0，根本翻不了页。
 */
export async function biliReplies(
  aid: string,
  sort: BiliReplySort,
  offset = "",
  upMid = 0,
): Promise<BiliReplyPage> {
  await biliEnsureDevice();
  const qs = new URLSearchParams({
    oid: aid,
    type: "1",
    mode: String(sort),
    plat: "1",
    // 上游要求 JSON 串，空 offset 表示第一页
    pagination_str: JSON.stringify({ offset }),
  });
  const json = await getJson(`${API}/x/v2/reply/main?${qs.toString()}`);
  assertOk(json, "加载评论");
  const data = json.data as Record<string, unknown> | undefined;
  const cursor = data?.cursor as Record<string, unknown> | undefined;
  const pagination = cursor?.pagination_reply as Record<string, unknown> | undefined;
  const isEnd = cursor?.is_end === true;
  const top = pinnedReplyList(data, upMid);
  const topIds = new Set(top.map((x) => x.rpid));
  return {
    top,
    // 置顶也会出现在正常列表里，去重避免屏幕上出现两条一样的
    replies: replyList(data?.replies, upMid).filter((x) => !topIds.has(x.rpid)),
    total: num(cursor?.all_count),
    isEnd,
    nextOffset: isEnd ? "" : str(pagination?.next_offset),
  };
}

/** 楼中楼：某条评论下的子回复（页码分页，`page.num * page.size >= count` 即到底）。 */
export async function biliReplyReplies(
  aid: string,
  root: string,
  page = 1,
  upMid = 0,
): Promise<{ replies: BiliReply[]; total: number; isEnd: boolean }> {
  await biliEnsureDevice();
  const qs = new URLSearchParams({
    oid: aid,
    type: "1",
    root,
    pn: String(page),
    ps: "20",
    sort: "1",
  });
  const json = await getJson(`${API}/x/v2/reply/reply?${qs.toString()}`);
  assertOk(json, "加载回复");
  const data = json.data as Record<string, unknown> | undefined;
  const info = data?.page as Record<string, unknown> | undefined;
  const count = num(info?.count);
  const size = num(info?.size, 20);
  const current = num(info?.num, page);
  return {
    replies: replyList(data?.replies, upMid),
    total: count,
    isEnd: current * size >= count,
  };
}

// ------------------------------------------------------------------ 相关推荐

/** 详情页右侧「相关推荐」：`data` 直接是数组，字段与推荐流同构（故复用同一个归一化）。 */
export async function biliRelated(bvid: string): Promise<BiliVideo[]> {
  await biliEnsureDevice();
  const json = await getJson(
    `${API}/x/web-interface/archive/related?bvid=${encodeURIComponent(bvid)}`,
  );
  assertOk(json, "加载相关视频");
  const data = json.data as unknown;
  if (!Array.isArray(data)) return [];
  return data
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map(videoFromFeed)
    .filter((v) => !!v.bvid);
}

// ------------------------------------------------------------------ 互动（三连 / 关注）

export interface BiliRelation {
  liked: boolean;
  disliked: boolean;
  /** 已投币枚数 0/1/2 */
  coin: number;
  favored: boolean;
  /** 已关注该 UP 主 */
  followed: boolean;
}

export const BILI_RELATION_NONE: BiliRelation = {
  liked: false,
  disliked: false,
  coin: 0,
  favored: false,
  followed: false,
};

/** 上游把布尔值给成 0/1 或 true/false 两种形态，统一成布尔。 */
function flag(v: unknown): boolean {
  return v === true || num(v) === 1;
}

/**
 * 带 csrf 的表单 POST。
 *
 * 互动类写接口（点赞 / 投币 / 收藏 / 关注）全部是这一套：`application/x-www-form-urlencoded`
 * 表单体 + `csrf`（就是 cookie 里的 `bili_jct`）。未登录时 csrf 为空，上游回 -101，
 * `assertOk` 会翻成「需要先登录 B 站账号」。
 */
async function biliPost(
  path: string,
  params: Record<string, string>,
  what: string,
): Promise<Record<string, unknown>> {
  await ensureCookies();
  const body = new URLSearchParams({ ...params, csrf: biliCsrf() }).toString();
  const res = await biliFetch(`${API}${path}`, {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${what}失败：HTTP ${res.status}（${text.slice(0, 80) || "无响应体"}）`);
  }
  const json = decodeJson(text);
  if (!json || typeof json !== "object") throw new Error(`${what}失败：上游返回非对象 JSON`);
  assertOk(json as Record<string, unknown>, what);
  return json as Record<string, unknown>;
}

/** 当前账号与该视频的互动状态（已赞 / 已投币数 / 已收藏 / 已关注）。需要登录。 */
export async function biliRelation(aid: string): Promise<BiliRelation> {
  await ensureCookies();
  const json = await getJson(`${API}/x/web-interface/archive/relation?aid=${aid}`);
  assertOk(json, "查询互动状态");
  const d = json.data as Record<string, unknown> | undefined;
  return {
    liked: flag(d?.like),
    disliked: flag(d?.dislike),
    coin: num(d?.coin),
    favored: flag(d?.favorite),
    followed: flag(d?.attention),
  };
}

/** 点赞 / 取消点赞（上游 `like=1` 点赞、`like=0` 取消，参数用 aid）。 */
export async function biliLike(aid: string, like: boolean): Promise<void> {
  await biliPost("/x/web-interface/archive/like", { aid, like: like ? "1" : "0" }, "点赞");
}

/** 投币（`multiply` 枚数 1/2；`select_like=0` 表示不强制同时点赞）。 */
export async function biliCoin(aid: string, multiply = 1): Promise<void> {
  await biliPost(
    "/x/web-interface/coin/add",
    { aid, multiply: String(multiply), select_like: "0" },
    "投币",
  );
}

/** 我的收藏夹（`/x/v3/fav/folder/created/list-all`，默认收藏夹排在第一位）。 */
export async function biliFavFolders(mid: number): Promise<{ id: string; title: string }[]> {
  await ensureCookies();
  // 必须带 spaceHeaders：个人空间类接口有 Referer/Origin 白名单，缺了回 -352
  const json = await getJson(
    `${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
    spaceHeaders(mid),
  );
  assertOk(json, "获取收藏夹");
  const d = json.data as Record<string, unknown> | undefined;
  const list = (d?.list as unknown[]) ?? [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ id: str(x.id), title: str(x.title) }))
    .filter((x) => !!x.id);
}

/** 收藏 / 取消收藏：`rid` 是 aid、`type=2` 是视频，收藏夹 id 分别走 add / del。 */
export async function biliFavorite(
  aid: string,
  folderId: string,
  favorite: boolean,
): Promise<void> {
  await biliPost(
    "/x/v3/fav/resource/deal",
    {
      rid: aid,
      type: "2",
      ...(favorite ? { add_media_ids: folderId } : { del_media_ids: folderId }),
    },
    favorite ? "收藏" : "取消收藏",
  );
}

/**
 * 当前账号与某个 UP 主的关注关系（`/x/relation?fid=`）。
 *
 * 与 `biliRelation` 不同：后者按 **aid** 查视频互动，只有打开视频详情时才知道有没有
 * 关注；UP 主主页需要按 **mid** 单独问一次，否则关注按钮会一直显示「关注」。
 * `attribute`：0 未关注 / 2 已关注 / 6 互相关注 / 128 已拉黑。
 */
export async function biliUserRelation(mid: number): Promise<boolean> {
  if (!biliIsLoggedIn()) return false;
  const json = await getJson(`${API}/x/relation?fid=${mid}`, spaceHeaders(mid));
  assertOk(json, "查询关注状态");
  const d = json.data as Record<string, unknown> | undefined;
  const attribute = num(d?.attribute);
  return attribute === 2 || attribute === 6;
}

/** 关注 / 取关 UP 主（`act` 1 关注、2 取关）。 */
export async function biliFollow(mid: number, follow: boolean): Promise<void> {
  await biliPost(
    "/x/relation/modify",
    { fid: String(mid), act: follow ? "1" : "2", re_src: "11" },
    follow ? "关注" : "取消关注",
  );
}

// ------------------------------------------------------------------ 推荐 / 搜索

export async function biliRecommend(freshIdx = 0, ps = 20): Promise<BiliVideo[]> {
  await biliEnsureDevice();
  const json = await wbiGet("/x/web-interface/wbi/index/top/feed/rcmd", {
    version: 1,
    feed_version: "V8",
    homepage_ver: 1,
    ps,
    fresh_idx: freshIdx,
    brush: freshIdx,
    fresh_type: 4,
  });
  assertOk(json, "加载推荐");
  const data = json.data as Record<string, unknown> | undefined;
  const items = (data?.item as unknown[]) ?? [];
  return (
    items
      .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
      // 推荐流会混入广告（带 ad_info）、直播、番剧卡片；它们也可能带 bvid，
      // 不过滤就会在视频网格里点开一个播不了的东西（参考 PiliPlus 只收 goto=='av'）。
      .filter((it) => !it.ad_info)
      .filter((it) => str(it.goto, "av") === "av")
      .map(videoFromFeed)
      .filter((v) => !!v.bvid)
  );
}

export async function biliSearch(keyword: string, page = 1, pageSize = 20): Promise<BiliVideo[]> {
  await biliEnsureDevice();
  const json = await wbiGet("/x/web-interface/wbi/search/type", {
    search_type: "video",
    keyword,
    page,
    page_size: pageSize,
    order: "totalrank",
  });
  assertOk(json, "搜索");
  const data = json.data as Record<string, unknown> | undefined;
  const result = data?.result as unknown[];
  if (!Array.isArray(result)) return [];
  return result
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map(videoFromSearch)
    .filter((v) => !!v.bvid);
}

function videoFromFeed(m: Record<string, unknown>): BiliVideo {
  const owner = m.owner as Record<string, unknown> | undefined;
  const stat = m.stat as Record<string, unknown> | undefined;
  const reason = m.rcmd_reason as Record<string, unknown> | undefined;
  return {
    // 推荐流给的是 `id`，相关推荐给的是 `aid`，两者同义
    aid: str(m.aid ?? m.id),
    bvid: str(m.bvid),
    cid: str(m.cid),
    title: biliStripHtml(str(m.title)),
    cover: biliImage(m.pic),
    duration: num(m.duration),
    ownerName: str(owner?.name),
    ownerFace: biliImage(owner?.face),
    ownerMid: num(owner?.mid),
    view: num(stat?.view),
    danmaku: num(stat?.danmaku),
    like: num(stat?.like),
    pubdate: num(m.pubdate),
    reason: str(reason?.content),
    goto: str(m.goto, "av"),
  };
}

function videoFromSearch(m: Record<string, unknown>): BiliVideo {
  return {
    aid: str(m.id),
    bvid: str(m.bvid),
    cid: "",
    title: biliStripHtml(str(m.title)),
    cover: biliImage(m.pic),
    duration: parseClock(str(m.duration)),
    ownerName: str(m.author),
    ownerFace: "",
    ownerMid: num(m.mid),
    view: num(m.play),
    danmaku: num(m.video_review ?? m.danmaku),
    like: num(m.like),
    pubdate: num(m.senddate),
    reason: "",
    goto: "av",
  };
}

/**
 * 造一段随机 base64（长度约 `n` 字节）。
 *
 * 用于 playurl 的 dm_img_str / dm_cover_img_str 指纹字段：上游期望「一个看起来
 * 像图片 base64 的随机串」，值本身无意义，但不能每次完全相同。
 */
function randomB64(n: number): string {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : bin;
}

/** 上游时长字段既有数字（秒）也有 `"12:34"` 字符串，统一成秒。 */
function clockOrNum(v: unknown): number {
  if (typeof v === "string" && v.includes(":")) return parseClock(v);
  return num(v);
}

/** `"12:34"` / `"1:02:03"` → 秒。 */
function parseClock(s: string): number {
  if (!s) return 0;
  return s.split(":").reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
}

// ------------------------------------------------------------------ 详情 / 取流

export async function biliVideoDetail(bvid: string): Promise<BiliDetail> {
  await biliEnsureDevice();
  const json = await wbiGet("/x/web-interface/wbi/view", { bvid });
  assertOk(json, "获取视频详情");
  const d = json.data as Record<string, unknown> | undefined;
  if (!d) throw new Error("视频详情为空");
  const dimension = d.dimension as Record<string, unknown> | undefined;
  const owner = d.owner as Record<string, unknown> | undefined;
  const stat = d.stat as Record<string, unknown> | undefined;
  const pages = (d.pages as unknown[]) ?? [];
  return {
    bvid: str(d.bvid),
    aid: str(d.aid),
    cid: str(d.cid),
    title: str(d.title),
    desc: str(d.desc),
    cover: biliImage(d.pic),
    duration: num(d.duration),
    pubdate: num(d.pubdate),
    owner: { mid: num(owner?.mid), name: str(owner?.name), face: biliImage(owner?.face) },
    stat: {
      view: num(stat?.view),
      danmaku: num(stat?.danmaku),
      reply: num(stat?.reply),
      like: num(stat?.like),
      coin: num(stat?.coin),
      favorite: num(stat?.favorite),
      share: num(stat?.share),
    },
    parts: pages
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        page: num(p.page),
        cid: str(p.cid),
        part: str(p.part),
        duration: num(p.duration),
      })),
    width: num(dimension?.width),
    height: num(dimension?.height),
  };
}

/**
 * 播放地址（**DASH 通道**）。
 *
 * ## 为什么必须用 fnval=4048 而不是 fnval=1
 *
 * `fnval=1` 只要「渐进式 MP4」（durl），对 `<video src>` 最省事，但上游在这条
 * 通道上**只肯给到 720P**：请求 `qn=80/112/116` 一律被钳回 `quality=64`，且
 * `accept_quality` 只剩 `[64,16]` —— 界面表现就是「登录后也只有 720P 和 480P
 * 两个选项」。实测同样参数换成 `fnval=16/4048` 后 `accept_quality` 立刻变成
 * `[112,80,64,32,16]`，服务端也真的返回对应码率的 DASH 分片。故 1080P+ 只能走
 * DASH（本项目用 MSE 在渲染端自行合流，见 `utils/biliDash.ts`）。
 *
 * ## try_look
 *
 * `try_look=1` 是 web 端的「未登录预览」开关：即便 `SESSDATA` 缺失，1080P 也会
 * 随 DASH 一起下发（720P 及以上需要登录的常规限制因此被绕过）。是否真的拿到仍以
 * 返回的 `accept_quality` 为准，不额外假设。
 *
 * `4048 = 16(DASH) | 64(HDR) | 128(4K) | 256(杜比) | 512(8K) | 1024(AV1) | 2048(?)…`
 */
export async function biliPlayUrl(bvid: string, cid: string, qn = 80): Promise<BiliPlayUrl> {
  await biliEnsureDevice();
  // 刻意用 **非 WBI** 的 playurl：实测 WBI 变体（/x/player/wbi/playurl）即便
  // accept_quality 声明了 [112,80,64,32,16]，返回的 dash.video 也只有 32/16
  // 两档，等于把清晰度又钳回 480P；同参数的普通 playurl 才给全量轨道。
  const qs = new URLSearchParams({
    bvid,
    cid,
    qn: String(qn),
    fnval: "4048",
    fnver: "0",
    fourk: "1",
    high_quality: "1",
    platform: "pc",
    try_look: "1",
    // 下面这组是 PC 网页端的风控指纹字段（参考 PiliPlus video.dart 的 makSign 参数）。
    // 缺了它们更容易被回 -352，或返回缺 default 标记的高码率轨道。
    gaia_source: "pre-load",
    isGaiaAvoided: "true",
    web_location: "1315873",
    dm_img_list: "[]",
    dm_img_str: randomB64(16),
    dm_cover_img_str: randomB64(32),
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  });
  const json = await getJson(`${API}/x/player/playurl?${qs.toString()}`, {
    Referer: `${VIDEO_REFERER}/video/${bvid}`,
  });
  assertOk(json, "解析播放地址");
  const d = json.data as Record<string, unknown> | undefined;
  if (!d) throw new Error("播放地址为空");

  const durl = ((d.durl as unknown[]) ?? [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => biliMediaUrl(str(x.url)))
    .filter(Boolean);

  const dash = d.dash as Record<string, unknown> | undefined;

  /**
   * 归一化一路 DASH 流。
   *
   * 上游的 SegmentBase 字段名有 `segment_base` / `SegmentBase` 与
   * `initialization`/`Initialization` 两套大小写（不同端点、不同时间点上不一致），
   * 两套都读一遍，避免只有某一种 CDN 上能播。
   */
  const pickStreams = (raw: unknown, fallbackMime: string): BiliStream[] =>
    ((raw as unknown[]) ?? [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => {
        const seg = (x.segment_base ?? x.segmentBase ?? x.SegmentBase) as
          Record<string, unknown> | undefined;
        return {
          id: num(x.id),
          url: biliMediaUrl(str(x.base_url ?? x.baseUrl ?? x.baseUrl)),
          backupUrls: (((x.backup_url ?? x.backupUrl) as unknown[] | undefined) ?? [])
            .map((u) => biliMediaUrl(str(u)))
            .filter(Boolean),
          codecs: str(x.codecs),
          width: num(x.width),
          height: num(x.height),
          bandwidth: num(x.bandwidth),
          initRange: str(seg?.initialization ?? seg?.Initialization),
          indexRange: str(seg?.index_range ?? seg?.indexRange ?? seg?.IndexRange),
          // 兜底必须按轨道类型给：音频一旦兜成 video/mp4，MSE 拼出的
          // `video/mp4; codecs="mp4a.40.2"` 会 isTypeSupported=false，
          // canPlay 直接判否 → 静默退回 720P durl，表现为「1080P 打不开」。
          mimeType: str(x.mime_type ?? x.mimeType, fallbackMime),
        };
      })
      .filter((s) => !!s.url);

  // 同清晰度可能同时有 avc1 / hev1 / av01 三份。MSE 里优先 avc1（Chromium 兼容性
  // 最好，硬解最稳），把其它编码排到后面而不是丢掉 —— 某些 4K/8K 稿件只有 hev1/av01。
  const codecRank = (codecs: string): number => {
    if (codecs.startsWith("avc1")) return 0;
    if (codecs.startsWith("hev1") || codecs.startsWith("hvc1")) return 1;
    if (codecs.startsWith("av01")) return 2;
    return 3;
  };
  const dashVideo = pickStreams(dash?.video, "video/mp4").sort(
    (a, b) => b.id - a.id || b.bandwidth - a.bandwidth || codecRank(a.codecs) - codecRank(b.codecs),
  );
  const dashAudio = pickStreams(dash?.audio, "audio/mp4").sort((a, b) => b.bandwidth - a.bandwidth);

  const acceptQuality = ((d.accept_quality as unknown[]) ?? []).map((q) => num(q));
  const acceptDescription = ((d.accept_description as unknown[]) ?? []).map((s) => str(s));
  const formats: BiliFormat[] = acceptQuality.map((q, i) => ({
    quality: q,
    label: acceptDescription[i] || biliQualityLabel(q),
  }));
  // accept_quality 偶发缺失（例如只回 DASH 的少数稿件），此时用实际拿到的视频轨道兜底
  for (const s of dashVideo) {
    if (!formats.some((f) => f.quality === s.id)) {
      formats.push({ quality: s.id, label: biliQualityLabel(s.id) });
    }
  }
  const qualities = Array.from(new Set(formats.map((f) => f.quality))).sort((a, b) => b - a);
  if (!qualities.length && d.quality) qualities.push(num(d.quality));

  return {
    quality: num(d.quality),
    audioQuality: dashAudio.length ? dashAudio[0].id : 0,
    qualities,
    formats,
    durl,
    dashVideo,
    dashAudio,
    // 只要拿到 DASH 视频轨就说明预览通道生效（未登录也能播高清）
    tryLook: dashVideo.length > 0,
  };
}

export function biliFormatLabel(play: BiliPlayUrl, qn: number): string {
  return play.formats.find((f) => f.quality === qn)?.label ?? biliQualityLabel(qn);
}

// ------------------------------------------------------------------ 弹幕

/**
 * 拉取某一分 P 的弹幕（XML → ArtPlayer 弹幕格式）。
 *
 * B 站的 `list.so` 是 deflate 压缩的 XML：宿主通道（undici）通常已按
 * `content-encoding` 解压，个别情况会原样交出压缩字节，这里用 pako 兜底。
 * 模式映射与颜色转换沿用 `utils/danmaku.ts` 的既有约定（与番剧同源）。
 */
export async function biliDanmaku(cid: string): Promise<ArtDanmu[]> {
  if (!cid) return [];
  try {
    const res = await biliFetch(
      `${API}/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`,
      { headers: { ...baseHeaders() } },
      MEDIA_TIMEOUT_MS,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    let text = new TextDecoder("utf-8").decode(bytes);
    if (!text.includes("<d ") && !text.includes("<?xml")) {
      const pako = await import("pako").catch(() => null);
      if (pako) {
        try {
          text = pako.inflateRaw(bytes, { to: "string" }) as string;
        } catch {
          try {
            text = pako.inflate(bytes, { to: "string" }) as string;
          } catch {
            return [];
          }
        }
      }
    }
    return mergeDuplicates(parseDanmakuXml(text), 5);
  } catch (e) {
    console.warn("[bilibili] 弹幕拉取失败：", e);
    return [];
  }
}

function parseDanmakuXml(xml: string): ArtDanmu[] {
  const out: ArtDanmu[] = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1].split(",");
    const time = Number(attrs[0]) || 0;
    const rawMode = Number(attrs[1]) || 0;
    const colorInt = Number(attrs[3]) || 0xffffff;
    const text = decodeXmlEntities(match[2]).trim();
    if (!text) continue;
    // B 站：1/2/3 滚动、4 底部、5 顶部、6 逆向、7 高级、8 代码。
    // 6/7/8 插件没有对应形态（逆向 / 高级 / 代码弹幕），跳过。
    if (rawMode < 1 || rawMode > 5) continue;
    // 走共享映射：两条链路各写一份必然再写反一次（见 utils/danmaku.ts mapDanmakuMode）
    const mode = mapDanmakuMode(rawMode);
    out.push({
      text,
      time,
      mode,
      color: `#${(colorInt & 0xffffff).toString(16).padStart(6, "0")}`,
      border: true,
    });
    // 超长弹幕列表对渲染无意义，截断避免卡顿
    if (out.length >= 8000) break;
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ------------------------------------------------------------------ 用户空间

/** UP 主名片（`x/web-interface/card`：无需 WBI、无需登录，最稳的一条）。 */
export interface BiliUserCard {
  mid: number;
  name: string;
  face: string;
  sign: string;
  level: number;
  /** 粉丝数 */
  fans: number;
  /** 关注数 */
  attention: number;
  /** 投稿数 */
  archives: number;
  likes: number;
  vip: boolean;
  official: string;
}

export async function biliUserCard(mid: number): Promise<BiliUserCard> {
  await biliEnsureDevice();
  const json = await getJson(
    `${API}/x/web-interface/card?mid=${mid}&photo=false`,
    spaceHeaders(mid),
  );
  assertOk(json, "获取 UP 主信息");
  const d = json.data as Record<string, unknown> | undefined;
  const card = d?.card as Record<string, unknown> | undefined;
  const level = card?.level_info as Record<string, unknown> | undefined;
  const vip = card?.vip as Record<string, unknown> | undefined;
  const official = card?.Official as Record<string, unknown> | undefined;
  if (!card) throw new Error("UP 主信息为空");
  return {
    mid: num(card.mid),
    name: str(card.name),
    face: biliImage(card.face),
    sign: str(card.sign),
    level: num(level?.current_level),
    // 粉丝数在 card 与 follower 两处，取非空的那个
    fans: num(card.fans) || num(d?.follower),
    attention: num(card.attention),
    archives: num(card.archive_count),
    likes: num(card.like_num),
    vip: num(vip?.vipStatus) === 1,
    official: str(official?.title),
  };
}

/** UP 主投稿列表（`x/space/wbi/arc/search`）。 */
export async function biliUserVideos(
  mid: number,
  page = 1,
  pageSize = 30,
): Promise<{ videos: BiliVideo[]; total: number; isEnd: boolean }> {
  await biliEnsureDevice();
  const json = await wbiGet(
    "/x/space/wbi/arc/search",
    {
      mid,
      ps: pageSize,
      tid: 0,
      pn: page,
      keyword: "",
      order: "pubdate",
      platform: "web",
      web_location: 1550101,
      order_avoided: "true",
    },
    spaceHeaders(mid),
  );
  assertOk(json, "加载 UP 主投稿");
  const d = json.data as Record<string, unknown> | undefined;
  const list = d?.list as Record<string, unknown> | undefined;
  const vlist = (list?.vlist as unknown[]) ?? [];
  const pageInfo = d?.page as Record<string, unknown> | undefined;
  const total = num(pageInfo?.count);
  const videos = vlist
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => {
      // 投稿列表的字段名与 feed 不同：pic 可能是 pic 或 cover，stat 在 stat 里
      const stat = x.stat as Record<string, unknown> | undefined;
      return {
        aid: str(x.aid),
        bvid: str(x.bvid),
        cid: str(x.cid),
        title: biliStripHtml(str(x.title)),
        cover: biliImage(x.pic ?? x.cover),
        // space/wbi/arc/search 的 length 是 "mm:ss" 字符串（PiliPlus 的 item.dart 也
        // 声明为 String?），直接 num() 会得到 0，卡片上时长永远显示 00:00
        duration: clockOrNum(x.length ?? x.duration),
        ownerName: str(x.author),
        ownerFace: "",
        ownerMid: num(x.mid) || mid,
        view: num(stat?.view ?? x.play),
        danmaku: num(stat?.danmaku ?? x.video_review),
        like: num(stat?.like),
        pubdate: num(x.created ?? x.pubdate),
        reason: "",
        goto: "av",
      } satisfies BiliVideo;
    })
    .filter((v) => !!v.bvid);
  return {
    videos,
    total: total || videos.length,
    isEnd: page * pageSize >= (total || videos.length),
  };
}

// ------------------------------------------------------------------ 历史 / 收藏

/**
 * 观看历史（`x/web-interface/history/cursor`，游标分页：`max` + `view_at`）。
 *
 * 必须带视频站 Referer + 登录凭据；未登录回 -101，由 `assertOk` 翻成明确提示。
 */
export async function biliHistory(
  ps = 20,
  max = 0,
  viewAt = 0,
): Promise<{ videos: BiliVideo[]; cursor: { max: number; viewAt: number }; isEnd: boolean }> {
  await biliEnsureDevice();
  const qs = new URLSearchParams({
    ps: String(ps),
    max: String(max),
    view_at: String(viewAt),
    business: "",
  });
  const json = await getJson(`${API}/x/web-interface/history/cursor?${qs.toString()}`, {
    Referer: `${VIDEO_REFERER}/account/history`,
  });
  assertOk(json, "加载观看历史");
  const d = json.data as Record<string, unknown> | undefined;
  const list = (d?.list as unknown[]) ?? [];
  const videos = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => {
      // 历史条目可能是视频 / 直播 / 专栏：只有带 history.bvid 的才是可播视频
      const history = x.history as Record<string, unknown> | undefined;
      const stat = x.stat as Record<string, unknown> | undefined;
      const author = x.author_name as string | undefined;
      return {
        aid: str(history?.oid ?? x.aid),
        bvid: str(history?.bvid ?? x.bvid),
        cid: str(history?.cid ?? x.cid),
        title: biliStripHtml(str(x.title)),
        cover: biliImage(x.cover),
        duration: num(x.duration),
        ownerName: str(author),
        ownerFace: "",
        ownerMid: num(x.author_mid),
        view: num(stat?.view),
        danmaku: num(stat?.danmaku),
        like: num(stat?.like),
        pubdate: num(x.view_at),
        reason: "",
        goto: "av",
      } satisfies BiliVideo;
    })
    // 直播 / 专栏 / 番剧没有 bvid，混进视频网格会点开即失败，直接滤掉
    .filter((v) => !!v.bvid);
  const cursor = d?.cursor as Record<string, unknown> | undefined;
  const nextMax = num(cursor?.max);
  const nextViewAt = num(cursor?.view_at);
  return {
    videos,
    cursor: { max: nextMax, viewAt: nextViewAt },
    // max 归零即到底（上游用 max=0 表示没有更早的了）
    isEnd: !nextMax,
  };
}

/** 我的收藏夹（含默认收藏夹与「全部」聚合视图）。 */
export async function biliFavFoldersAll(
  mid: number,
): Promise<{ id: number; title: string; mediaCount: number }[]> {
  await biliEnsureDevice();
  const json = await getJson(
    `${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
    spaceHeaders(mid),
  );
  assertOk(json, "获取收藏夹");
  const d = json.data as Record<string, unknown> | undefined;
  const list = (d?.list as unknown[]) ?? [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      id: num(x.id),
      title: str(x.title),
      mediaCount: num(x.media_count),
    }))
    .filter((x) => x.id > 0);
}

/**
 * 收藏夹内容（`x/v3/fav/resource/list`）。
 *
 * `mediaId=0` 无意义；「全部收藏」要用默认收藏夹 id 且 `type=1`（聚合），
 * 这里把 type 暴露出去由调用方决定。
 */
export async function biliFavResources(
  mediaId: number,
  page = 1,
  pageSize = 20,
  mid = 0,
): Promise<{ videos: BiliVideo[]; total: number; isEnd: boolean }> {
  await biliEnsureDevice();
  const qs = new URLSearchParams({
    media_id: String(mediaId),
    pn: String(page),
    ps: String(pageSize),
    keyword: "",
    order: "mtime",
    type: "0",
    tid: "0",
    platform: "web",
  });
  const json = await getJson(`${API}/x/v3/fav/resource/list?${qs.toString()}`, spaceHeaders(mid));
  assertOk(json, "加载收藏");
  const d = json.data as Record<string, unknown> | undefined;
  const medias = (d?.medias as unknown[]) ?? [];
  const videos = medias
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    // 失效稿件（title 为「已失效」且 attr 标记）没有可用地址，跳过
    .filter((x) => num(x.attr) === 0 || num(x.attr) === 4)
    .map((x) => {
      const upper = x.upper as Record<string, unknown> | undefined;
      const cnt = x.cnt_info as Record<string, unknown> | undefined;
      return {
        aid: str(x.id),
        bvid: str(x.bvid),
        cid: str(x.cid),
        title: biliStripHtml(str(x.title)),
        cover: biliImage(x.cover),
        duration: num(x.duration),
        ownerName: str(upper?.name),
        ownerFace: biliImage(upper?.face),
        ownerMid: num(upper?.mid),
        view: num(cnt?.play),
        danmaku: num(cnt?.danmaku),
        like: num(cnt?.thumb_up),
        pubdate: num(x.pubtime),
        reason: "",
        goto: "av",
      } satisfies BiliVideo;
    })
    .filter((v) => !!v.bvid);
  const info = d?.info as Record<string, unknown> | undefined;
  const total = num(info?.media_count);
  return {
    videos,
    total: total || videos.length,
    isEnd: page * pageSize >= (total || videos.length),
  };
}

// ------------------------------------------------------------------ 发表评论

/**
 * 发表评论 / 回复。
 *
 * - 一级评论：只给 `oid` + `message`；
 * - 回复某条评论：`root` 是所在楼的一级 rpid，`parent` 是被回复的 rpid
 *   （回复一级评论时两者相同）。
 *
 * 返回新评论的 rpid，调用方用它做本地插入，避免整页重拉。
 */
export async function biliAddReply(
  aid: string,
  message: string,
  root = "",
  parent = "",
): Promise<string> {
  const text = message.trim();
  if (!text) throw new Error("评论内容不能为空");
  const json = await biliPost(
    "/x/v2/reply/add",
    {
      type: "1",
      oid: aid,
      message: text,
      ...(root && root !== "0" ? { root } : {}),
      ...(parent && parent !== "0" ? { parent } : {}),
      plat: "1",
    },
    "发表评论",
  );
  const d = json.data as Record<string, unknown> | undefined;
  const reply = d?.reply as Record<string, unknown> | undefined;
  return str(reply?.rpid);
}

// ------------------------------------------------------------------ 观看进度

/**
 * 上报播放进度（`/x/click-interface/web/heartbeat`）。
 *
 * 这是 web 端「看到哪儿了」的权威来源：上报后 B 站网页 / App 的观看历史会同步，
 * 本项目的 `biliHistory()` 也能读到，进而支持跨设备续播。
 *
 * 实测匿名也会回 code 0（只回一个 `{}`），但游客的进度不会出现在任何地方，
 * 故仍只在登录时调用。`type=3` 是 UGC 视频（番剧 4 / 课程 10，见 PiliPlus
 * `models/common/video/video_type.dart`）。
 */
export async function biliHeartbeat(bvid: string, cid: string, playedTime: number): Promise<void> {
  if (!biliIsLoggedIn() || !bvid || !cid) return;
  await biliPost(
    "/x/click-interface/web/heartbeat",
    {
      bvid,
      cid,
      played_time: String(Math.max(0, Math.floor(playedTime))),
      type: "3",
      sub_type: "0",
    },
    "上报播放进度",
  );
}

/**
 * 该视频的「上次看到」（秒）+ 上次看到的分 P cid。
 *
 * 走 `/x/player/v2`：它同时给出 `last_play_time` / `last_play_cid`，比历史列表
 * 更精确 —— 历史列表只有整条记录，拿不到「上次看到哪一分 P」。未登录或没看过时
 * 返回 0。
 */

// ------------------------------------------------------------------ 评论互动

/**
 * 给评论点赞 / 取消点赞（`/x/v2/reply/action`）。
 *
 * `action`：1 = 点赞，0 = 取消（上游语义与「是否已赞」相反，别搞混）。
 * 按 rpid 定位评论，但 `oid`（视频 aid）仍要带。
 */
export async function biliLikeReply(aid: string, rpid: string, like: boolean): Promise<void> {
  await biliPost(
    "/x/v2/reply/action",
    { type: "1", oid: aid, rpid, action: like ? "1" : "0" },
    like ? "点赞评论" : "取消点赞评论",
  );
}

/**
 * 删除自己发的评论（`/x/v2/reply/del`）。只能删自己的，删别人的回 -403。
 */
export async function biliDeleteReply(aid: string, rpid: string): Promise<void> {
  await biliPost("/x/v2/reply/del", { type: "1", oid: aid, rpid }, "删除评论");
}

// ------------------------------------------------------------------ 搜索联想

/**
 * 搜索联想词（`/x/web-interface/suggest`，需 WBI 签名）。
 *
 * 优先取 `value`（可直接拿去搜的干净词）；`term` 可能带 `<em>` 高亮，统一洗一遍。
 */
export async function biliSuggest(term: string): Promise<string[]> {
  const word = term.trim();
  if (!word) return [];
  const json = await wbiGet("/x/web-interface/suggest", { term: word, highlight: 0 });
  assertOk(json, "获取搜索建议");
  const data = json.data as Record<string, unknown> | undefined;
  const list = (data?.tag as unknown[]) ?? [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => biliStripHtml(str(x.value ?? x.term ?? x.name)))
    .filter(Boolean)
    .slice(0, 10);
}

export async function biliLastPlay(
  bvid: string,
  cid: string,
): Promise<{ seconds: number; cid: string }> {
  if (!biliIsLoggedIn()) return { seconds: 0, cid: "" };
  // 走 WBI 变体：本文件其余带风控的接口都走它，普通 /x/player/v2 在未登录或
  // 风控下常回 -352/-101，会让续播静默失效（参考 PiliPlus 用 player/wbi/v2）。
  const json = await wbiGet("/x/player/wbi/v2", { bvid, cid });
  assertOk(json, "读取播放进度");
  const d = json.data as Record<string, unknown> | undefined;
  return {
    // 上游单位是毫秒
    seconds: num(d?.last_play_time) / 1000,
    cid: str(d?.last_play_cid),
  };
}
