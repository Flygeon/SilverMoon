/**
 * Electron < 25（Node < 18）缺失的 Web 标准全局。
 *
 * ## 为什么需要这一层
 *
 * Win7 兼容版必须停在 Electron 22 —— 那是**最后一个**支持 Win7/8/8.1 的大版本
 * （23 起移除）。Electron 22 内置 Node 16.17.1，而本项目的 Electron 44 版本默认
 * 了 Node 22 的 Web 标准全局：`fetch` / `Response` / `Request` / `Headers` /
 * `ReadableStream`。在 Electron 22 上这些**全部是 undefined**（已实测），
 * 于是 `electron/protocols.ts` 的 12 处 `new Response(...)` 与
 * `electron/sidecar.ts` 的 SSE 循环会直接抛错。
 *
 * 这里用 undici@5（engines `node >= 14`，实测在 Node 16.17.1 上
 * POST/SSE/Referer/Range/redirect/abort 全部可用）补齐缺口，
 * 并提供 `Readable.toWeb` 的降级实现。
 *
 * ## 关键性质
 *
 * - **现代分支零成本**：`require("undici")` 放在条件分支里，esbuild 打 CJS 时
 *   会把它内联成一个惰性模块工厂，Electron 44 上条件不成立 → 永不求值。
 * - **必须在任何 fetch/Response 调用之前调用**，见 `electron/main.ts` 顶部。
 */
import { Readable } from "node:stream";
import { ReadableStream as WebReadableStream } from "node:stream/web";

/** undici 的最小类型面（不引它的 .d.ts，避免多一个类型依赖）。 */
interface UndiciModule {
  fetch: typeof fetch;
  Response: typeof Response;
  Headers: typeof Headers;
  Request: typeof Request;
}

const g = globalThis as unknown as Record<string, unknown>;

/** 当前宿主是否缺少 Web 标准全局（即 Electron < 25）。 */
export function needsWebGlobals(): boolean {
  return typeof g.fetch !== "function" || typeof g.Response !== "function";
}

/**
 * 幂等安装。同步完成 —— 调用方不必 await，也就不存在「装好之前先被 fetch 用到」的竞态。
 */
export function installWebGlobals(): void {
  if (needsWebGlobals()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require("undici") as UndiciModule;
    if (typeof g.fetch !== "function") g.fetch = undici.fetch;
    if (typeof g.Response !== "function") g.Response = undici.Response;
    if (typeof g.Headers !== "function") g.Headers = undici.Headers;
    if (typeof g.Request !== "function") g.Request = undici.Request;
  }
  // Node 16 没有全局 ReadableStream（只有 stream/web 里的），协议处理器要用到
  if (typeof g.ReadableStream !== "function") g.ReadableStream = WebReadableStream;
}

/**
 * Node Readable → Web ReadableStream。
 *
 * Node 18+ 直接用 `Readable.toWeb`；Node 16 没有这个方法（已实测），
 * 退化成手写适配器。两者都返回 `stream/web` 的实例，undici 的 Response
 * 能直接消费（已实测）。
 */
export function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  const native = (Readable as unknown as { toWeb?: (s: Readable) => ReadableStream<Uint8Array> })
    .toWeb;
  if (typeof native === "function") return native(stream);

  // node:stream/web 的 ReadableStream 与 DOM lib 的声明略有差异（pipeThrough 的
  // 泛型不变性），运行时完全兼容；这里显式过一次 unknown，避免为类型体操引入依赖。
  return new WebReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
        );
      });
      stream.on("end", () => controller.close());
      stream.on("error", (error) => controller.error(error));
    },
    cancel() {
      stream.destroy();
    },
  }) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Web ReadableStream → Node Readable（Electron 22 的 `registerStreamProtocol`
 * 只吃 Node 流）。
 */
export function webToNodeStream(stream: ReadableStream<Uint8Array>): Readable {
  const reader = stream.getReader();
  return Readable.from(
    (async function* generate() {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value) yield Buffer.from(value);
      }
    })(),
  );
}

/**
 * 主进程取网络的统一入口。
 *
 * Electron 25+ 用 `net.fetch`（走 Chromium 网络栈，不受页面 CORS 约束，且能按域
 * 伪造 Referer/UA —— 在线封面防盗链正是靠它）；Electron 22 没有 `net.fetch`，
 * 退回全局 fetch（即上面装的 undici）。
 *
 * 用惰性 require 而不是顶层 import：本模块会被任何入口引入，
 * 顶层 require("electron") 会让「纯 Node 下跑单测」这件事变复杂。
 */
export async function netFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  const electronNet = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require("electron") as { net?: { fetch?: typeof fetch } };
      return electron.net;
    } catch {
      return undefined;
    }
  })();

  if (electronNet && typeof electronNet.fetch === "function") {
    return electronNet.fetch(url, init);
  }
  return fetch(url, init);
}
