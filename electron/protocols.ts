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
} from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { createHash } from "node:crypto";

import { net, protocol } from "electron";

import { APP_SCHEME, ASSET_SCHEME, COVER_SCHEME, projectRoot } from "./config";
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
      // 目录穿越保护
      if (!target.startsWith(root)) {
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
      return serveFile(target, request.headers.get("range"));
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

function coverCacheRead(url: string): CoverCacheHit | null {
  if (!coverCacheDir) return null;
  const { meta, blob } = coverPaths(url);
  try {
    const info = JSON.parse(readFileSync(meta, "utf8")) as { ct?: string };
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

/** 真正的取图（网络 + 缓存），供并发去重包装。 */
async function fetchCover(target: string): Promise<CoverCacheHit | null> {
  const cached = coverCacheRead(target);
  if (cached) return cached;

  const failedAt = coverFailedAt.get(target);
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
    return { ct, body: buf };
  } catch (error) {
    coverFailedAt.set(target, Date.now());
    log.warn(`封面取图失败 ${parsed.hostname}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** 注册 `app-cover://`。`cacheDir` 为封面磁盘缓存目录（建议 `<cacheDir>/covers`）。 */
export function handleCoverProtocol(cacheDir: string): void {
  coverCacheDir = cacheDir;
  mkdirSync(cacheDir, { recursive: true });

  protocol.handle(COVER_SCHEME, async (request) => {
    try {
      // URL 形如 `app-cover://img/<encodeURIComponent(原始URL)>`；host 段被
      // standard scheme 解析掉，编码后的原始 URL 落在 pathname 上。
      const raw = new URL(request.url);
      const target = decodeURIComponent(raw.pathname.replace(/^\/+/, ""));
      if (!/^https?:\/\//i.test(target)) {
        return new Response("invalid url", { status: 400 });
      }

      let inflight = coverInflight.get(target);
      if (!inflight) {
        inflight = fetchCover(target).finally(() => coverInflight.delete(target));
        coverInflight.set(target, inflight);
      }
      const hit = await inflight;
      if (!hit) return new Response("cover unavailable", { status: 502 });

      return new Response(hit.body, {
        status: 200,
        headers: {
          "Content-Type": hit.ct,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=604800",
        },
      });
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
function serveFile(file: string, rangeHeader: string | null): Response {
  const size = statSync(file).size;
  const type = mimeOf(file);

  const baseHeaders: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    // canvas 取主色需要可读像素
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };

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
