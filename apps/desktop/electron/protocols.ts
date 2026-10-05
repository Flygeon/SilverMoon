/**
 * 自定义协议：`app://` 与 `asset://`。
 *
 * ## 为什么需要 `app://`
 *
 * 打包后如果用 `file://` 载入 `dist/index.html`，页面会落到 **opaque origin**，
 * 而 Chromium 在 `file://` 下会禁用 IndexedDB —— 本项目用 IndexedDB 存了
 * 本地词库（`lumiluna`）、在线缓存（`lumiluna-online`）与 WebDAV 凭据
 * （`lumiluna-webdav`），一旦禁用就等于数据全丢。
 *
 * 注册一个 standard + secure 的 `app://` 方案即可拿到正常 origin，
 * 同时 `base: "/"` 的绝对资源路径（`/assets/xxx.js`）也能正确解析。
 *
 * ## 为什么需要 `asset://`
 *
 * 渲染进程用 `toAssetUrl()` 生成 `asset://` URL，由这里映射到磁盘上的
 * 本地媒体文件暴露成 `<img>` / `<video>` / `<iframe>` / CSS `url()` 可直接
 * 消费的 URL。必须支持 Range 请求，否则音视频拖不动进度条。
 */
import {
  createReadStream,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { createHash } from "node:crypto";

import { net, protocol } from "electron";

import {
  APP_ORIGIN,
  APP_SCHEME,
  ASSET_SCHEME,
  COVER_SCHEME,
  DEV_SERVER_URL,
  projectRoot,
} from "./config";
import { log } from "./log";

/** 必须在 `app.whenReady()` **之前**调用。 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 封面取主色要读 canvas 像素，必须允许跨源
        corsEnabled: true,
        bypassCSP: true,
      },
    },
    {
      scheme: COVER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 封面可能被 canvas 取主色，同样放行跨源读像素
        corsEnabled: true,
        bypassCSP: true,
      },
    },
  ]);
}

/**
 * 允许跨源读取本应用资源的来源：打包态 `app://silvermoon`、开发态 Vite。
 *
 * 之所以要白名单而不是回 `*`：`asset://` 会**服务磁盘上的任意文件**（媒体库需要
 * 播放任意扫描路径），配上 `Access-Control-Allow-Origin: *` 之后，任何来源——
 * 包括被注入了脚本的远程页——都能用 `fetch("asset:///C:/...")` 把本机文件读出来。
 * 改成只回显受信任来源后，自家前端照旧能读像素取主色，其它来源被 CORS 挡死。
 */
/** 归一化来源：去空白、去尾斜杠、转小写（Chromium 对自定义协议的序列化不完全一致）。 */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

const TRUSTED_ORIGINS = new Set<string>([
  normalizeOrigin(APP_ORIGIN),
  normalizeOrigin(DEV_SERVER_URL),
  "http://127.0.0.1:1420",
]);

/** 计算应答的 `Access-Control-Allow-Origin`；不受信任（缺 Origin / `null`）时返回 null。 */
function corsAllowOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const normalized = normalizeOrigin(origin);
  // 沙箱 iframe / file 上下文会发字面量 "null"，一律视为不可信
  if (normalized === "null") return null;
  return TRUSTED_ORIGINS.has(normalized) ? origin : null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4v": "video/x-m4v",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** 注册 `app://` —— 只服务 `dist/` 目录。 */
export function handleAppProtocol(): void {
  const root = path.join(projectRoot, "dist");

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/" || rel === "") rel = "/index.html";

      const target = path.normalize(path.join(root, rel));
      // 目录穿越保护。
      //
      // 必须把分隔符一起比：只写 `startsWith(root)` 时，兄弟目录 `<…>/dist-evil/…`
      // 同样满足前缀，等于把校验绕过去了。
      if (target !== root && !target.startsWith(root + path.sep)) {
        return new Response("forbidden", { status: 403 });
      }

      // vue-router 用的是 hash 模式，正常不会走到这里；仅作为兜底：
      // 无扩展名的未知路径回退到 index.html。
      if (!existsSync(target) && !path.extname(rel)) {
        return serveFile(path.join(root, "index.html"), null);
      }
      return serveFile(target, request.headers.get("range"));
    } catch (error) {
      log.error("app:// 处理失败：", error);
      return new Response("internal error", { status: 500 });
    }
  });
}

/** 注册 `asset://` —— 服务任意本地文件（媒体库需要播放任意扫描到的路径）。 */
export function handleAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // `asset://localhost/<encoded path>`；host 段在 standard scheme 里被解析掉，
      // 因此绝对路径实际落在 pathname 上（如 `/C%3A/Users/.../a.mp3`）。
      const decoded = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const target = path.normalize(decoded);

      if (!path.isAbsolute(target)) {
        return new Response("invalid path", { status: 400 });
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return new Response("not found", { status: 404 });
      }
      return serveFile(target, request.headers.get("range"), corsAllowOrigin(request));
    } catch (error) {
      log.error("asset:// 处理失败：", error);
      return new Response("internal error", { status: 500 });
    }
  });
}

// ---------------------------------------------------------------------------
// `app-cover://` —— 在线封面代理
//
// 渲染进程直连在线图床有两个绕不开的坑：fetch 受 CORS 约束、`<img>` 直连又被
// 防盗链（Referer 校验）拦。主进程用 net.fetch 统一取图（可按域伪造 Referer/UA，
// 走 Chromium 网络栈、不受页面 CORS 约束），配磁盘缓存 + 并发去重 + 负缓存。
// ---------------------------------------------------------------------------

/** 单张封面体积上限（防止异常 URL 把磁盘/内存写爆）。 */
const COVER_MAX_BYTES = 20 * 1024 * 1024;
/** 负缓存 TTL：取图失败的 URL 在此时间内直接返回失败，不再打网络。 */
const COVER_NEGATIVE_TTL = 60 * 60 * 1000;

const coverRefererRules: Array<{ pattern: RegExp; referer: string }> = [
  { pattern: /(^|\.)126\.net$/i, referer: "https://music.163.com/" },
  { pattern: /(^|\.)kugou\.(com|cn)$/i, referer: "https://www.kugou.com/" },
  { pattern: /(^|\.)(kgimg|kglink)\.com$/i, referer: "https://www.kugou.com/" },
  { pattern: /(^|\.)qq\.com$/i, referer: "https://y.qq.com/" },
];

function coverRefererFor(hostname: string): string | undefined {
  return coverRefererRules.find((r) => r.pattern.test(hostname))?.referer;
}

const COVER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

/** 磁盘缓存根目录（main.ts 注入）。 */
let coverCacheDir: string | null = null;
/** 同 URL 的并发去重：只允许一次网络请求在途。 */
const coverInflight = new Map<string, Promise<{ ct: string; body: ArrayBuffer } | null>>();
/** 负缓存：url → 首次失败时间戳。 */
const coverFailedAt = new Map<string, number>();

interface CoverCacheHit {
  ct: string;
  body: ArrayBuffer;
}

function coverPaths(url: string): { meta: string; blob: string } {
  const hash = createHash("sha256").update(url).digest("hex");
  const dir = path.join(coverCacheDir ?? "", hash.slice(0, 2));
  return { meta: path.join(dir, `${hash}.json`), blob: path.join(dir, `${hash}.img`) };
}

/** meta 文件结构：命中记 ct/ts，失败记 fail（负缓存，落盘后重启仍生效）。 */
interface CoverMeta {
  ct?: string;
  ts?: number;
  /** 取图失败的时间戳；处于负缓存窗口内不再打网络 */
  fail?: number;
}

function coverMetaRead(url: string): CoverMeta | null {
  if (!coverCacheDir) return null;
  try {
    return JSON.parse(readFileSync(coverPaths(url).meta, "utf8")) as CoverMeta;
  } catch {
    return null;
  }
}

function coverCacheRead(url: string): CoverCacheHit | null {
  if (!coverCacheDir) return null;
  const { meta, blob } = coverPaths(url);
  try {
    const info = JSON.parse(readFileSync(meta, "utf8")) as CoverMeta;
    // 记录过失败且仍在窗口内 → 负缓存命中（M7：落盘，重启后仍生效）
    if (info.fail && Date.now() - info.fail < COVER_NEGATIVE_TTL) return null;
    if (!existsSync(blob)) return null;
    const buf = readFileSync(blob);
    // Buffer → ArrayBuffer 拷贝，保证 Response 的 BodyInit 类型匹配
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { ct: info.ct ?? "image/jpeg", body: ab };
  } catch {
    return null;
  }
}

function coverCacheWrite(url: string, ct: string, body: ArrayBuffer): void {
  if (!coverCacheDir) return;
  const { meta, blob } = coverPaths(url);
  try {
    mkdirSync(path.dirname(meta), { recursive: true });
    writeFileSync(blob, Buffer.from(body));
    writeFileSync(meta, JSON.stringify({ ct, ts: Date.now() }));
  } catch (error) {
    log.warn("封面缓存写入失败：", error);
  }
}

/** 写入负缓存标记（只落 meta，无图体）。 */
function coverCacheWriteFail(url: string): void {
  if (!coverCacheDir) return;
  const { meta } = coverPaths(url);
  try {
    mkdirSync(path.dirname(meta), { recursive: true });
    writeFileSync(meta, JSON.stringify({ fail: Date.now() } satisfies CoverMeta));
  } catch (error) {
    log.warn("封面负缓存写入失败：", error);
  }
}

// ---------------------------------------------------------------------------
// M6：封面磁盘缓存的容量上限与清理
//
// 此前 covers/ 只写不删，且设置页“清理缓存”只清 thumbs/ 不动这里，长期听歌会静默
// 堆积。这里给上限 + 惰性淘汰（按 meta 里的 ts/fail 升序，最久未用的先删），
// 并暴露 clearCoverCache() 供设置页“清理缓存”复用。
// ---------------------------------------------------------------------------

/** 封面缓存容量上限。 */
const COVER_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** 淘汰到的水位（滞回，避免频繁触发）。 */
const COVER_CACHE_TARGET_BYTES = 200 * 1024 * 1024;
/** 淘汰节流：距上次不足该时长就跳过。 */
const COVER_CACHE_SWEEP_INTERVAL_MS = 60_000;

let coverLastSweep = 0;

interface CoverCacheItem {
  meta: string;
  blob: string;
  at: number;
  len: number;
}

/** 扫描缓存目录：返回 (占用字节, 按时间升序的条目)。 */
function coverCacheScan(): { total: number; items: CoverCacheItem[] } {
  const items: CoverCacheItem[] = [];
  if (!coverCacheDir) return { total: 0, items };
  let walk: string[];
  try {
    walk = readdirSync(coverCacheDir);
  } catch {
    return { total: 0, items };
  }
  for (const shard of walk) {
    const dir = path.join(coverCacheDir, shard);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const meta = path.join(dir, f);
      const blob = path.join(dir, f.replace(/\.json$/, ".img"));
      let at = 0;
      try {
        const info = JSON.parse(readFileSync(meta, "utf8")) as CoverMeta;
        at = info.ts ?? info.fail ?? 0;
      } catch {
        at = 0;
      }
      let len = 0;
      try {
        len = statSync(meta).size;
        if (existsSync(blob)) len += statSync(blob).size;
      } catch {
        /* 忽略个别坏文件 */
      }
      items.push({ meta, blob, at, len });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return { total: items.reduce((s, i) => s + i.len, 0), items };
}

/** 超限则按最久未用淘汰到目标水位。带 60s 节流，避免每次取图都扫目录。 */
function enforceCoverCacheLimit(): void {
  const now = Date.now();
  if (coverLastSweep && now - coverLastSweep < COVER_CACHE_SWEEP_INTERVAL_MS) return;
  coverLastSweep = now;

  const { total, items } = coverCacheScan();
  if (total <= COVER_CACHE_MAX_BYTES) return;
  let cur = total;
  let freed = 0;
  for (const it of items) {
    if (cur <= COVER_CACHE_TARGET_BYTES) break;
    try {
      if (existsSync(it.blob)) unlinkSync(it.blob);
      unlinkSync(it.meta);
      cur -= it.len;
      freed += it.len;
    } catch {
      /* 个别文件删除失败不阻塞 */
    }
  }
  if (freed > 0) {
    log.info(
      "封面缓存超限，按 LRU 淘汰 " +
        (freed / 1024 / 1024).toFixed(1) +
        "MB（剩约 " +
        (cur / 1024 / 1024).toFixed(1) +
        "MB）",
    );
  }
}

/** 清空封面磁盘缓存，返回释放的字节数（供设置页“清理缓存”复用）。 */
export function clearCoverCache(): number {
  coverLastSweep = 0;
  coverFailedAt.clear();
  const { items } = coverCacheScan();
  let freed = 0;
  for (const it of items) {
    try {
      if (existsSync(it.blob)) {
        freed += statSync(it.blob).size;
        unlinkSync(it.blob);
      }
      freed += statSync(it.meta).size;
      unlinkSync(it.meta);
    } catch {
      /* 忽略个别文件 */
    }
  }
  if (freed > 0) {
    log.info("封面缓存已清空，释放 " + (freed / 1024 / 1024).toFixed(1) + "MB");
  }
  return freed;
}

/** 真正的取图（网络 + 缓存），供并发去重包装。 */
async function fetchCover(target: string): Promise<CoverCacheHit | null> {
  const cached = coverCacheRead(target);
  if (cached) return cached;

  // 负缓存：内存优先，其次磁盘（重启后仍生效，见 CoverMeta.fail）
  const failedAt = coverFailedAt.get(target) ?? coverMetaRead(target)?.fail;
  if (failedAt !== undefined && Date.now() - failedAt < COVER_NEGATIVE_TTL) {
    return null;
  }

  const parsed = new URL(target);
  const headers: Record<string, string> = { "User-Agent": COVER_UA };
  const referer = coverRefererFor(parsed.hostname);
  if (referer) headers.Referer = referer;

  try {
    const res = await net.fetch(target, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > COVER_MAX_BYTES) throw new Error("响应体异常");

    const ct = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!ct.startsWith("image/")) throw new Error(`非图片响应: ${ct}`);

    coverCacheWrite(target, ct, buf);
    coverFailedAt.delete(target);
    enforceCoverCacheLimit();
    return { ct, body: buf };
  } catch (error) {
    coverFailedAt.set(target, Date.now());
    // 顺手写一份 meta，让负缓存跨重启生效
    coverCacheWriteFail(target);
    log.warn(
      "封面取图失败 " + parsed.hostname + ": " + (error instanceof Error ? error.message : error),
    );
    return null;
  }
}

/** 注册 `app-cover://`。`cacheDir` 为封面磁盘缓存目录（建议 `<cacheDir>/covers`）。 */
export function handleCoverProtocol(cacheDir: string): void {
  coverCacheDir = cacheDir;
  mkdirSync(cacheDir, { recursive: true });
  // 启动时扫一次，把上次运行留下的超额部分淘汰掉
  enforceCoverCacheLimit();

  protocol.handle(COVER_SCHEME, async (request) => {
    try {
      // URL 形如 `app-cover://img/<encodeURIComponent(原始URL)>`；host 段被
      // standard scheme 解析掉，编码后的原始 URL 落在 pathname 上。
      const raw = new URL(request.url);
      let target = decodeURIComponent(raw.pathname.replace(/^\/+/, ""));
      // Chromium 网络栈拒绝在明文 http 请求上手动设置 Referer（实测
      // net::ERR_BLOCKED_BY_CLIENT），而 http/https 在这些图床完全等价，
      // 故统一升级为 https —— 防盗链 Referer 比协议本身重要得多。
      target = target.replace(/^http:\/\//i, "https://");
      if (!/^https:\/\//i.test(target)) {
        return new Response("invalid url", { status: 400 });
      }

      let inflight = coverInflight.get(target);
      if (!inflight) {
        inflight = fetchCover(target).finally(() => coverInflight.delete(target));
        coverInflight.set(target, inflight);
      }
      const hit = await inflight;
      if (!hit) return new Response("cover unavailable", { status: 502 });

      const headers: Record<string, string> = {
        "Content-Type": hit.ct,
        "Cache-Control": "public, max-age=604800",
      };
      const corsOrigin = corsAllowOrigin(request);
      if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;

      return new Response(hit.body, { status: 200, headers });
    } catch (error) {
      log.error("app-cover:// 处理失败：", error);
      return new Response("internal error", { status: 500 });
    }
  });
}

/**
 * 读取文件（支持 Range）。
 *
 * 大体积媒体走流式响应，避免把整个视频读进内存。
 */
function serveFile(
  file: string,
  rangeHeader: string | null,
  corsOrigin: string | null = null,
): Response {
  const size = statSync(file).size;
  const type = mimeOf(file);

  const baseHeaders: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  // canvas 取主色 / Web Audio 处理跨源媒体都需要可读，但**只对自家前端**放行
  if (corsOrigin) baseHeaders["Access-Control-Allow-Origin"] = corsOrigin;

  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === "invalid") {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (range) {
    const stream = Readable.toWeb(
      createReadStream(file, { start: range.start, end: range.end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "invalid" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === "") {
    // 后缀范围：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}
