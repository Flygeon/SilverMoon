/**
 * 带 CORS 豁免的 `fetch`。
 *
 * 音乐平台等第三方接口不允许浏览器直连，这里改由主进程的网络栈发起请求，
 * 效果等价于桌面端原生请求。签名与全局 `fetch` 一致（第二个参数就是标准 `RequestInit`）。
 */
import { callBridge, toBytes } from "./bridge";

/** 主进程返回的响应表示。 */
interface RawResponse {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  /** 响应体字节。主进程统一以 `Uint8Array` 过桥，不分文本 / 二进制。 */
  body: unknown;
}

/**
 * 这些响应头描述的是**上游的传输形态**，而主进程已经把 body 解压成明文再交过来，
 * 原样透传会让调用方误判（例如按 `content-length` 去截取），因此剥掉。
 * 它们不是 `Response` 的禁用头，构造不会报错，但语义已经是错的。
 */
const STRIPPED_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

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

function abortError(): Error {
  return typeof DOMException === "function"
    ? new DOMException("请求已中断", "AbortError")
    : Object.assign(new Error("请求已中断"), { name: "AbortError" });
}

/**
 * 让这次调用能被 `AbortSignal` 结束等待。
 *
 * 主进程那次请求无法真正取消（桥上没有请求 id 与取消通道），但现有调用方
 * （QQ / 酷狗歌词）只把 signal 当**超时**用：至少保证超时后立刻以 AbortError
 * 结束，而不是无声地挂到天荒地老。
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

  // 已经中断就别再惊动宿主了：白白发一次请求，还要等它跑完
  if (init.signal?.aborted) throw abortError();

  const call = callBridge<RawResponse>("http", {
    url,
    method: init.method ?? "GET",
    headers: normalizeHeaders(init.headers),
    body: normalizeBody(init.body),
  });

  const raw = init.signal ? await abortable(call, init.signal) : await call;

  const bytes = toBytes(raw.body);
  const headers = (raw.headers ?? []).filter(([key]) => !STRIPPED_HEADERS.has(key.toLowerCase()));

  // `Response` 只接受 200–599 的状态码，且 statusText 必须是 ByteString；
  // 上游若给出异常值，这里退化处理，避免整条通道因构造抛错而不可用。
  const status =
    Number.isInteger(raw.status) && raw.status >= 200 && raw.status <= 599 ? raw.status : 502;
  const statusText = String(raw.statusText ?? "").replace(/[^\x20-\x7e]/g, "");

  const response = new Response(bytes, { status, statusText, headers });

  // `Response.url` 是只读的，跨源场景下原生 fetch 也常为空；
  // 这里补一个与请求一致的地址，便于调用方按 host 分流。
  Object.defineProperty(response, "url", { value: raw.url || url, configurable: true });
  return response;
}
