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
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

import { protocol } from "electron";

import { APP_SCHEME, ASSET_SCHEME, projectRoot } from "./config";
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
