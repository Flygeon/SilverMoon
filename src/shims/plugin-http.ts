/**
 * `@tauri-apps/plugin-http` 的替身。
 *
 * 业务代码（`utils/qqMusic.ts` / `utils/kgMusic.ts`）在 `isTauri` 为真时用它对
 * 音乐平台接口发请求——原本走 Rust 的 reqwest 以绕开 CORS。这里改为交给主进程的
 * 网络栈执行，效果等价：不受渲染进程同源策略限制。
 *
 * 签名与全局 `fetch` 保持一致（第二个参数就是标准的 `RequestInit`），
 * 这样调用点可以原样传入自己构造的 init 对象。
 */
import { callBridge } from "./bridge";

/** 主进程返回的响应表示。 */
interface RawResponse {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  body: number[] | string;
  bodyIsBase64: boolean;
}

/** 把 `HeadersInit` 的三种形态统一成可结构化克隆的键值对数组。 */
function normalizeHeaders(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map(([key, value]) => [String(key), String(value)]);
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return [...headers.entries()];
  }
  return Object.entries(headers as Record<string, string>).map(([key, value]) => [
    key,
    String(value),
  ]);
}

/** 只接受可安全过桥的字符串型 body；其余形态（流、FormData）此处用不到。 */
function normalizeBody(body: BodyInit | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

/**
 * 带 CORS 豁免的 `fetch`。
 *
 * 返回标准 `Response`，因此调用方（`await res.json()` / `.text()`）无需改动。
 */
export async function fetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  const raw = await callBridge<RawResponse>("http", {
    url,
    method: init.method ?? "GET",
    headers: normalizeHeaders(init.headers),
    body: normalizeBody(init.body),
  });

  // 二进制响应以 base64 过桥，这里还原成字节
  const bytes = raw.bodyIsBase64
    ? Uint8Array.from(atob(String(raw.body)), (c) => c.charCodeAt(0))
    : new Uint8Array(raw.body as number[]);

  const response = new Response(bytes, {
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
  });

  // `Response.url` 是只读的，跨源场景下原生 fetch 也常为空；
  // 这里补一个与请求一致的地址，便于调用方按 host 分流。
  Object.defineProperty(response, "url", { value: raw.url || url, configurable: true });
  return response;
}
