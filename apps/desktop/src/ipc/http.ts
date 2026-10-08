/**
 * 带 CORS 豁免的 `fetch`。
 *
 * 音乐平台等第三方接口不允许浏览器直连，这里改由 **Tauri 的 Rust 网络栈**发起
 * 请求（`@tauri-apps/plugin-http`，底层 reqwest），效果等价于桌面端原生请求。
 * 签名与全局 `fetch` 一致（第二个参数就是标准 `RequestInit`）。
 *
 * ## 与 Electron 版的差异（都在这一层吸收掉）
 *
 * Electron 版把响应手工拆成 `{status, headers, body}` 过桥，再在渲染进程侧重建
 * `Response`（主进程的 undici 响应无法直接过结构化克隆），并顺手剥掉
 * `content-encoding` / `content-length`。Tauri 的插件**直接返回标准 `Response`**，
 * 重建逻辑因此不再需要 —— 但**剥头这一步仍要保留**：Rust 侧 reqwest 已经把 body
 * 解压成明文，插件又把上游的 `content-length`（压缩后长度）原样透传，
 * 不剥掉会让调用方按错误长度截取（历史上逐字歌词就是这么全挂的）。
 *
 * 浏览器预览（无 Tauri）下退化为 `window.fetch`：会因 CORS 失败，
 * 但调用方（QQ / 酷狗歌词）本来就有优雅降级。
 */
import { hasBridge } from "./bridge";

/** 单次请求的默认超时（毫秒）。仅在调用方没给 signal 时兜底。 */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 这些响应头描述的是**上游的传输形态**，而 Rust 侧已经把 body 解压成明文再交过来，
 * 原样透传会让调用方误判（例如按 `content-length` 去截取），因此剥掉。
 */
const STRIPPED_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

function abortError(): Error {
  return typeof DOMException === "function"
    ? new DOMException("请求已中断", "AbortError")
    : Object.assign(new Error("请求已中断"), { name: "AbortError" });
}

/** 剥掉压缩相关的传输头；就地改写 response.headers。 */
function stripTransportHeaders(response: Response): Response {
  try {
    for (const name of STRIPPED_HEADERS) response.headers.delete(name);
  } catch {
    /* headers 只读时忽略：最坏情况是调用方多看到一个 content-length */
  }
  return response;
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

  // 已经中断就别再惊动宿主机了：白白发一次请求，还要等它跑完
  if (init.signal?.aborted) throw abortError();

  // 浏览器预览：没有 Rust 网络栈可用，退回原生 fetch（多半会 CORS 失败，由调用方降级）
  if (!hasBridge()) {
    return globalThis.fetch(input, init);
  }

  const patched = withTimeout(init);
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const response = await tauriFetch(url, patched);
    return stripTransportHeaders(response);
  } finally {
    clearTimer(patched);
  }
}

/**
 * 没有 signal 时套一个兜底超时，避免上游挂死把 UI 一起拖住。
 *
 * 插件的 `connectTimeout` 只管建连，读 body 阶段的挂起它管不到，所以要靠
 * `AbortController` 兜住整轮请求。
 */
function withTimeout(init: RequestInit): RequestInit {
  if (init.signal) return init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  (controller.signal as AbortSignal & { __timer?: unknown }).__timer = timer;
  return { ...init, signal: controller.signal };
}

function clearTimer(init: RequestInit): void {
  const signal = init.signal as
    (AbortSignal & { __timer?: ReturnType<typeof setTimeout> }) | undefined;
  if (signal?.__timer) clearTimeout(signal.__timer);
}

export { abortError };
