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
import { mergeDuplicates, type ArtDanmu } from "@/utils/danmaku";
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
}

export interface BiliFormat {
  quality: number;
  label: string;
}

export interface BiliPlayUrl {
  quality: number;
  /** 可选清晰度（降序） */
  qualities: number[];
  formats: BiliFormat[];
  /** 整段 MP4（fnval=1 的 durl）；ArtPlayer 直接消费 */
  durl: string[];
  /** DASH 分流（仅在 durl 缺失时作为信息保留） */
  dashVideo: BiliStream[];
  dashAudio: BiliStream[];
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
async function biliFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await hostFetch(url, init);
  absorbCookies(res);
  return res;
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
): Promise<Record<string, unknown>> {
  const res = await biliFetch(url, { headers: { ...baseHeaders(), ...headers } });
  const text = await res.text();
  const json = decodeJson(text);
  if (!json || typeof json !== "object") throw new Error("B站返回了非对象 JSON");
  return json as Record<string, unknown>;
}

/** 业务错误统一在 `code`（0 成功 / -101 未登录 / -352 风控…）。 */
function assertOk(json: Record<string, unknown>, what: string): void {
  const code = num(json.code);
  if (code === 0) return;
  const msg = str(json.message, "未知错误");
  if (code === -101) throw new Error("需要先登录 B 站账号");
  throw new Error(`${what}失败：${msg}（code=${code}）`);
}

// ---- WBI 签名 ----

let mixinKey = "";
let mixinDay = -1;

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

async function ensureMixinKey(): Promise<string> {
  if (mixinKey && mixinDay === new Date().getDate()) return mixinKey;
  try {
    const json = await navRaw();
    const data = json.data as Record<string, unknown> | undefined;
    const img = data?.wbi_img as Record<string, unknown> | undefined;
    const orig = fileNameOf(str(img?.img_url)) + fileNameOf(str(img?.sub_url));
    if (orig.length >= 64) {
      mixinKey = MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join("");
      mixinDay = new Date().getDate();
    }
  } catch (e) {
    console.warn("[bilibili] WBI 密钥获取失败：", e);
  }
  return mixinKey;
}

/**
 * 生成 WBI 签名后的查询串（含 `wts` / `w_rid`）。
 * 返回值里的值**已经编码**，拼 URL 时不能再交给 URLSearchParams（会二次编码）。
 */
async function signedQuery(params: Record<string, string | number>): Promise<string> {
  const key = await ensureMixinKey();
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
): Promise<Record<string, unknown>> {
  const qs = await signedQuery(params);
  return getJson(`${API}${path}?${qs}`);
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
  // 顺手缓存 WBI 密钥，省一次 nav
  const img = data.wbi_img as Record<string, unknown> | undefined;
  if (img && !mixinKey) {
    const orig = fileNameOf(str(img.img_url)) + fileNameOf(str(img.sub_url));
    if (orig.length >= 64) {
      mixinKey = MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join("");
      mixinDay = new Date().getDate();
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
  const json = decodeJson(await res.text());
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
  const json = await getJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}`);
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
  return items
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map(videoFromFeed)
    .filter((v) => !!v.bvid);
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
 * 播放地址。
 *
 * `fnval=1` 请求**整段 MP4（durl）**：B 站会把音视频封装进一个渐进式文件，
 * `<video>` / ArtPlayer 无需任何 DASH 合流即可直接播放（参考项目用 media_kit
 * 的 `edl://` 合并 DASH，而浏览器做不到，故这里取 durl 路线）。
 * 未登录时最高 720P，登录后可达 1080P。
 */
export async function biliPlayUrl(bvid: string, cid: string, qn = 80): Promise<BiliPlayUrl> {
  await biliEnsureDevice();
  const json = await wbiGet("/x/player/wbi/playurl", {
    bvid,
    cid,
    qn,
    fnval: 1,
    fnver: 0,
    fourk: 1,
    high_quality: 1,
    platform: "pc",
  });
  assertOk(json, "解析播放地址");
  const d = json.data as Record<string, unknown> | undefined;
  if (!d) throw new Error("播放地址为空");

  const durl = ((d.durl as unknown[]) ?? [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => biliMediaUrl(str(x.url)))
    .filter(Boolean);

  const dash = d.dash as Record<string, unknown> | undefined;
  const pickStreams = (raw: unknown): BiliStream[] =>
    ((raw as unknown[]) ?? [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        id: num(x.id),
        url: biliMediaUrl(str(x.base_url ?? x.baseUrl)),
        backupUrls: (((x.backup_url ?? x.backupUrl) as unknown[] | undefined) ?? [])
          .map((u) => biliMediaUrl(str(u)))
          .filter(Boolean),
        codecs: str(x.codecs),
        width: num(x.width),
        height: num(x.height),
        bandwidth: num(x.bandwidth),
      }));

  const acceptQuality = ((d.accept_quality as unknown[]) ?? []).map((q) => num(q));
  const acceptDescription = ((d.accept_description as unknown[]) ?? []).map((s) => str(s));
  const formats: BiliFormat[] = acceptQuality.map((q, i) => ({
    quality: q,
    label: acceptDescription[i] || biliQualityLabel(q),
  }));
  const qualities = Array.from(new Set(acceptQuality)).sort((a, b) => b - a);
  if (!qualities.length && d.quality) qualities.push(num(d.quality));

  return {
    quality: num(d.quality),
    qualities,
    formats,
    durl,
    dashVideo: dash ? pickStreams(dash.video) : [],
    dashAudio: dash ? pickStreams(dash.audio) : [],
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
    const res = await biliFetch(`${API}/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`, {
      headers: { ...baseHeaders() },
    });
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
    // 与 utils/danmaku.ts 的 DanDanPlay 映射保持一致（4→1、5→2、其余→0）。
    let mode: 0 | 1 | 2;
    if (rawMode === 4) mode = 1;
    else if (rawMode === 5) mode = 2;
    else if (rawMode >= 1 && rawMode <= 3) mode = 0;
    else continue;
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
