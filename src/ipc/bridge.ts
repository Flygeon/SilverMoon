/**
 * 渲染进程 ↔ Electron 主进程的桥。
 *
 * 渲染进程对外只有这一个通道：`window.__SILVERMOON__.call(channel, payload)`，
 * 由 preload 通过 `contextBridge` 注入，主进程按 `channel` 白名单分发。
 * `src/ipc/` 下的各模块（invoke / window / fs / dialog / store …）都建立在它之上。
 *
 * 与主进程的约定：**业务错误不做成 rejected promise**，而是返回 `{ ok: false, error }`，
 * 由这里转成 `Promise.reject(error)`，保证 reject 值就是原始字符串
 * （例如 `[WENKU8_LOGIN_CANCELLED] ...` 这种靠字符串前缀判断的协议）。
 */
/** 主进程暴露的桥。未注入时说明不在 Electron 里跑。 */
export interface SilverMoonBridge {
  /** 当前窗口的 label（`main` / `desktop-lyrics` / `extension` / ...） */
  readonly label: string;
  /** 进程平台（`win32` / `darwin` / `linux`） */
  readonly platform: string;
  /** 调用 Rust 侧车命令 */
  invoke(cmd: string, args: unknown): Promise<BridgeReply>;
  /** 一次往返执行多条命令（逐条独立成败） */
  invokeBatch(calls: { cmd: string; args?: unknown }[]): Promise<BridgeReply>;
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
    throw new Error("SilverMoon 桥不可用：请通过桌面应用启动，而不是直接用浏览器打开");
  }
  return b;
}

/** 调用 Rust 侧车命令。失败时以**原始错误字符串**拒绝。 */
export async function invokeCommand<T>(cmd: string, args?: unknown): Promise<T> {
  const reply = await bridge().invoke(cmd, args ?? {});
  if (!reply.ok) {
    // 关键：reject 值必须是命令返回的原始字符串，不能包一层 Error
    return Promise.reject(reply.error ?? `命令 ${cmd} 失败`);
  }
  return reply.data as T;
}

/** 批量命令的单条结果。 */
export interface BatchItemResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 一次往返执行多条 Rust 命令。
 *
 * 与 `invokeCommand` 不同：**只有整条通道失败才 reject**；单条命令失败体现为
 * 该下标的 `{ ok: false, error }`，不影响其它条。调用方按需忽略失败项。
 */
export async function invokeBatchCommands<T = unknown>(
  calls: { cmd: string; args?: unknown }[],
): Promise<BatchItemResult<T>[]> {
  if (calls.length === 0) return [];
  const reply = await bridge().invokeBatch(calls);
  if (!reply.ok) {
    return Promise.reject(reply.error ?? "批量命令失败");
  }
  return (reply.data ?? []) as BatchItemResult<T>[];
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

/**
 * 收窄成以 `ArrayBuffer` 为底层的紧凑视图。
 *
 * `fetch` / `Response` 的 `BodyInit` 自 TS 5.7 起只接受 `Uint8Array<ArrayBuffer>`，
 * 而 `ArrayBuffer.isView` 只保证 `ArrayBufferLike`（可能是 SharedArrayBuffer）。
 * 过桥拿到的 TypedArray 一定是紧凑的 `ArrayBuffer` 视图，所以先直接复用；
 * 只有非常规的切片视图才复制一份，免得给「读大文件」白加一次内存拷贝。
 */
function asBytesView(view: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    view.buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  ) {
    return view as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(view);
}

/**
 * 把过桥拿到的二进制值统一成 `Uint8Array`。
 *
 * ⚠️ **不要**写 `new Uint8Array(value)` 当兜底：`value` 若是**原始字符串**，
 * 构造器会把它当成长度（`ToIndex("...")` → 0），静默返回**空数组**。
 * 宿主早期对文本响应传字符串、这里却按字节数组处理，导致所有走该通道的
 * JSON 接口都拿到空 body（`Unexpected end of JSON input`）——逐字歌词就是这样全挂的。
 * 因此这里把每种形态都显式列出来，字符串按 UTF-8 编码而不是丢成空。
 */
export function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return asBytesView(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return asBytesView(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}
