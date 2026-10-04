/**
 * `protocol.handle`（Electron 25+）到 `protocol.registerStreamProtocol`（Electron 22）
 * 的适配层。
 *
 * ## 为什么必须适配
 *
 * `electron/protocols.ts` 用 `protocol.handle(scheme, async (request) => new Response(...))`
 * 注册 `app://` / `asset://` / `app-cover://` 三个协议。`protocol.handle` 是
 * Electron 25 引入的，**Electron 22 上是 undefined**（已实测）→ 三个协议全部注册失败
 * → 主窗口载入 `app://silvermoon/index.html` 时白屏，应用等同不可用。
 *
 * Electron 22 可用的是 `registerStreamProtocol`，签名完全不同（Node 流 + 回调）。
 * 这里把后者包成前者的形状，让 `protocols.ts` 只保留一套处理器代码。
 *
 * ## 已实测
 *
 * - 用本适配层重写 `app://` 后，真实 `dist/` 在 Electron 22 里完整渲染成功
 *   （`.app-shell` 存在、主 JS 200 / 1,256,242 字节）；
 * - `asset://` 的 Range 请求正确返回 **206** + `Content-Range: bytes 0-9/3223`。
 */
import { protocol } from "electron";

import { webToNodeStream } from "./web-globals";

/** 与 `protocol.handle` 一致的处理器签名。 */
export type ProtocolHandler = (request: Request) => Response | Promise<Response>;

/** 宿主是否原生支持 `protocol.handle`。 */
export function supportsProtocolHandle(): boolean {
  return typeof (protocol as unknown as { handle?: unknown }).handle === "function";
}

/** Electron 22 的 ProtocolRequest 形状（只取我们用到的字段）。 */
interface LegacyProtocolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** 把 Electron 22 的请求对象包装成标准 `Request` 的最小面。 */
function toRequestLike(req: LegacyProtocolRequest): Request {
  return {
    url: req.url,
    method: req.method,
    headers: new Headers(
      Object.entries(req.headers ?? {}).map(
        ([k, v]) => [k.toLowerCase(), String(v)] as [string, string],
      ),
    ),
  } as unknown as Request;
}

/** 把标准 `Response` 转换成 `registerStreamProtocol` 的回调载荷。 */
async function respond(
  response: Response,
  callback: (payload: {
    statusCode: number;
    headers?: Record<string, string>;
    data?: NodeJS.ReadableStream;
  }) => void,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  if (response.body) {
    callback({ statusCode: response.status, headers, data: webToNodeStream(response.body) });
  } else {
    callback({ statusCode: response.status, headers });
  }
}

/**
 * 注册协议处理器。
 *
 * Electron 25+ 走原生 `protocol.handle`（行为不变）；Electron 22 走
 * `registerStreamProtocol` 适配。
 */
export function registerProtocolHandler(scheme: string, handler: ProtocolHandler): void {
  const p = protocol as unknown as {
    handle?: (s: string, h: ProtocolHandler) => void;
    registerStreamProtocol: (
      s: string,
      h: (
        req: LegacyProtocolRequest,
        cb: (payload: {
          statusCode: number;
          headers?: Record<string, string>;
          data?: NodeJS.ReadableStream;
        }) => void,
      ) => void,
    ) => boolean;
  };

  if (typeof p.handle === "function") {
    p.handle(scheme, handler);
    return;
  }

  p.registerStreamProtocol(scheme, (req, callback) => {
    void (async () => {
      try {
        await respond(await handler(toRequestLike(req)), callback);
      } catch (error) {
        // 处理器内部一般已自行兜底；这里保证异常也能给出一个明确的响应，
        // 否则 Electron 会挂起请求，表现为页面永远加载不完。
        callback({
          statusCode: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
          data: webToNodeStream(
            new Response(String((error as Error)?.message ?? error))
              .body as ReadableStream<Uint8Array>,
          ),
        });
      }
    })();
  });
}
