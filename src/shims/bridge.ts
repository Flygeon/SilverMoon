/**
 * 渲染进程 ↔ Electron 主进程的桥。
 *
 * 这是整套「前端零改动」方案的关键：`@tauri-apps/*` 的每个模块都被本目录下的
 * 同名 shim 顶替（见 `vite.config.ts` 与 `tsconfig.json` 的 alias / paths），
 * 业务代码里的 `import { invoke } from "@tauri-apps/api/core"` 一行都不用改。
 *
 * 与主进程的约定：
 * - 渲染进程只调用 `window.__SILVERMOON__.call(channel, payload)`；
 * - 主进程按 `channel` 白名单分发；
 * - **业务错误不做成 rejected promise**，而是返回 `{ ok: false, error }`，
 *   由这里转成 `Promise.reject(error)`，保证 reject 值就是原生字符串
 *   （例如 `[WENKU8_LOGIN_CANCELLED] ...` 这种靠字符串前缀判断的协议）。
 */

/** 主进程暴露的桥。未注入时说明不在 Electron 里跑。 */
export interface SilverMoonBridge {
  /** 当前窗口的 label（`main` / `desktop-lyrics` / `extension` / ...） */
  readonly label: string;
  /** 进程平台（`win32` / `darwin` / `linux`） */
  readonly platform: string;
  /** 调用 Rust 侧车命令 */
  invoke(cmd: string, args: unknown): Promise<BridgeReply>;
  /** 通用能力调用（窗口 / 文件 / 对话框 / 存储 / ...） */
  call(channel: string, payload: unknown): Promise<BridgeReply>;
  /** 跨窗口派发事件 */
  emitTo(label: string, event: string, payload: unknown): Promise<void>;
}

/** 主进程统一回复格式。 */
export interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

declare global {
  interface Window {
    __SILVERMOON__?: SilverMoonBridge;
  }
}

/** 桥是否可用。 */
export function hasBridge(): boolean {
  return typeof window !== "undefined" && !!window.__SILVERMOON__;
}

/** 当前窗口 label；无桥时回退 `main`（纯浏览器调试用）。 */
export function currentLabel(): string {
  return window.__SILVERMOON__?.label ?? "main";
}

/** 进程平台。 */
export function platform(): string {
  return window.__SILVERMOON__?.platform ?? "win32";
}

function bridge(): SilverMoonBridge {
  const b = window.__SILVERMOON__;
  if (!b) {
    throw new Error("SilverMoon 桥不可用：请通过 Electron 启动，而不是直接用浏览器打开");
  }
  return b;
}

/** 调用 Rust 侧车命令。失败时以**原始错误字符串**拒绝。 */
export async function invokeCommand<T>(cmd: string, args?: unknown): Promise<T> {
  const reply = await bridge().invoke(cmd, args ?? {});
  if (!reply.ok) {
    // 保持与 Tauri 一致：reject 值就是命令返回的字符串
    return Promise.reject(reply.error ?? `命令 ${cmd} 失败`);
  }
  return reply.data as T;
}

/** 调用主进程能力。失败时以原始错误字符串拒绝。 */
export async function callBridge<T>(channel: string, payload?: unknown): Promise<T> {
  const reply = await bridge().call(channel, payload ?? {});
  if (!reply.ok) {
    return Promise.reject(reply.error ?? `${channel} 调用失败`);
  }
  return reply.data as T;
}

/** 跨窗口派发事件。 */
export async function emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
  await bridge().emitTo(label, event, payload);
}
