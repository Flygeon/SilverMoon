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
import { biliLog, cookieDigest, cookieFingerprint, cookieNames } from "@/utils/biliLog";
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

/** url 的 host（日志用；非法 url 不抛） */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "（非法 url）";
  }
}

/** 打日志用：只看鉴权相关的几个 cookie 的指纹（值一律脱敏） */
function authCookieDigest(): string {
  const keys = ["SESSDATA", "bili_jct", "DedeUserID"].filter((k) => cookies[k]);
  return cookieDigest(keys.map((k) => [k, cookies[k]] as [string, string]));
}

/** 匿名会话也要有 `buvid3`，否则推荐/取流会回 -352 风控。 */
export async function biliEnsureDevice(): Promise<void> {
  await ensureCookies();
  if (cookies.buvid3) return;
  biliLog("设备指纹：本地无 buvid3，向 finger/spi 申请");
  try {
    const json = await getJson(`${API}/x/frontend/finger/spi`);
    const data = json.data as Record<string, unknown> | undefined;
    const b3 = str(data?.b_3);
    const b4 = str(data?.b_4);
    if (b3) cookies.buvid3 = b3;
    if (b4) cookies.buvid4 = b4;
    await persistCookies();
    biliLog(`设备指纹：buvid3=${b3 ? "有" : "无"} buvid4=${b4 ? "有" : "无"}`);
  } catch (e) {
    biliLog(`设备指纹：申请失败 ${e instanceof Error ? e.message : String(e)}`);
    console.warn("[bilibili] buvid 初始化失败：", e);
  }
}

// ------------------------------------------------------------------ 账号

export async function biliNav(): Promise<BiliAccount> {
  await biliEnsureDevice();
  biliLog(`nav 请求：Cookie 名字=${cookieNames(cookies)}；鉴权凭据 ${authCookieDigest()}`);
  const json = await navRaw();
  const data = json.data as Record<string, unknown> | undefined;
  // `data` 缺失只出现在业务失败时（-101 未登录 / -352 风控…）。把上游原话抛出去，
  // 否则界面只能笼统报「账号信息获取失败」，无法区分是凭据没生效还是被风控拦了。
  if (!data) {
    biliLog(`nav 失败：code=${num(json.code)} message=${str(json.message, "（无）")}`);
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
  biliLog(
    `nav 返回：isLogin=${account.isLogin} code=${num(json.code)} mid=${account.mid} uname=${
      account.name || "（空）"
    }`,
  );
  return account;
}

// ------------------------------------------------------------------ 扫码登录

export async function biliQrGenerate(): Promise<{ key: string; url: string }> {
  await ensureCookies();
  biliLog("申请二维码：GET /x/passport-login/web/qrcode/generate");
  const json = await getJson(`${PASSPORT}/x/passport-login/web/qrcode/generate`);
  assertOk(json, "获取二维码");
  const data = json.data as Record<string, unknown> | undefined;
  const key = str(data?.qrcode_key);
  const url = str(data?.url);
  if (!key || !url) {
    biliLog("申请二维码：上游未返回 qrcode_key / url");
    throw new Error("上游未返回二维码");
  }
  // 二维码内容本身不是凭据（就是个未确认的登录链接），记 host 足够定位问题
  biliLog(`申请二维码：成功 key=${cookieFingerprint(key)} 扫码跳转 host=${hostOf(url)}`);
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
  biliLog(`轮询：HTTP=${res.status} code=${code} message=${message || "（无）"}`);
  if (code === 0 && data) {
    // 兜底：跳转链里也带着同一批凭据，值是 urlencoded 形态，先按 cookie 形态落罐
    // （见 cookieValueFromLoginUrl）；原始形态一并返回，验不过时换它再试。
    const pairs = Object.entries(parseRawQuery(str(data.url))).filter(([k]) =>
      URL_COOKIE_NAMES.has(k),
    );
    // 两条来源各自的形态都记下来：这是「服务端到底认哪种形态」唯一的现场证据
    biliLog(`轮询·凭据来源①响应头：名字=${cookieNames(headerPairs)}`);
    if (headerPairs.length) biliLog(`轮询·凭据来源①响应头：${cookieDigest(headerPairs)}`);
    biliLog(`轮询·凭据来源②跳转链：host=${hostOf(str(data.url))} 名字=${cookieNames(pairs)}`);
    if (pairs.length) biliLog(`轮询·凭据来源②跳转链原值：${cookieDigest(pairs)}`);
    const written: [string, string][] = [];
    for (const [k, v] of pairs) {
      if (fromHeader.has(k)) continue;
      cookies[k] = cookieValueFromLoginUrl(v);
      written.push([k, cookies[k]]);
    }
    await persistCookies();
    biliLog(
      `轮询·落罐（cookie 形态）：${
        written.length ? cookieDigest(written) : "未改动（全部取自响应头）"
      }`,
    );
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
  const applied: [string, string][] = [];
  for (const [name, value] of Object.entries(pairs)) {
    if (value) {
      cookies[name] = value;
      applied.push([name, value]);
    }
  }
  await persistCookies();
  biliLog(`换上备选形态落罐：${cookieDigest(applied)}`);
}

export async function biliLogout(): Promise<void> {
  biliLog("登出：请求 /login/exit/v2 并清空本地凭据");
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
    biliLog(`登出：请求失败（本地凭据照样清空）${e instanceof Error ? e.message : String(e)}`);
    console.warn("[bilibili] 登出请求失败：", e);
  }
  cookies = {};
  await persistCookies();
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
    aid: str(m.id),
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
