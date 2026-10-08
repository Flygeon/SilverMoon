/**
 * 渲染进程 ↔ 原生层的桥（Tauri 2 版）。
 *
 * 迁回 Tauri 后桥不再是 preload 注入的 `window.__SILVERMOON__`，而是
 * `@tauri-apps/api` 的 `invoke` / `Channel`。但**对外语义保持不变**：
 * 模块级导出（`hasBridge` / `platform` / `invokeCommand` / `invokeBatchCommands` /
 * `callBridge` / `toBytes` / `toAssetUrl` …）与 Electron 版逐一对应，
 * 因此 `src/capabilities/` 与业务代码一行都不用改。
 *
 * 与 Electron 版的差异（都在这一层吸收掉）：
 * 1. 结构化克隆 → JSON。serde 走 JSON，Vue 的响应式 Proxy 天然无碍；
 *    但 `undefined` 会丢、`Map`/`Set`/`Date` 需要显式转换，故仍统一过
 *    `toCloneablePayload()` 降级成纯 JSON 值。
 * 2. 二进制过桥：Tauri 2 的 invoke 直接支持 `Uint8Array`（经 `ArrayBuffer`），
 *    比 Electron 的 base64 回退路径更直接。
 * 3. 命令名不再分区（`fs` / `dialog` / `store` …），改为 Tauri 插件自己的命令名，
 *    由本层映射。
 *
 * ⚠️ 业务代码**不要**直接 `import { invoke } from "@tauri-apps/api/core"`，
 * 一律经 `@/ipc/`，否则浏览器预览（无 Tauri）下会直接抛错。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** 宿主回复格式（保持与 Electron 版一致的宽松形状）。 */
export interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * 桥接口。保留它是因为 `src/capabilities/mock.ts` 与若干单测会打桩
 * `window.__SILVERMOON__`；Tauri 下该对象不存在，`hasBridge()` 改判
 * `__TAURI_INTERNALS__`（见下），但类型仍导出以兼容旧引用。
 */
export interface SilverMoonBridge {
  readonly label: string;
  readonly platform: string;
  invoke(cmd: string, args: unknown): Promise<BridgeReply>;
  invokeBatch(calls: { cmd: string; args?: unknown }[]): Promise<BridgeReply>;
  call(channel: string, payload: unknown): Promise<BridgeReply>;
  emitTo(label: string, event: string, payload: unknown): Promise<void>;
  readonly assetBase?: string;
}

declare global {
  interface Window {
    /** 仅浏览器预览 / 单测打桩用；Tauri 环境下为 undefined。 */
    __SILVERMOON__?: SilverMoonBridge;
    __TAURI_INTERNALS__?: unknown;
  }
}

/**
 * 是否运行在桌面宿主里。
 *
 * Tauri 会注入 `window.__TAURI_INTERNALS__`；同时保留对打桩的
 * `window.__SILVERMOON__` 的识别，使既有单测无需改动。
 */
export function hasBridge(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.__TAURI_INTERNALS__ || !!window.__SILVERMOON__;
}

/**
 * 当前窗口 label。
 *
 * ⚠️ 不能用固定的 `"main"` 兜底：桌面歌词窗口（`desktop-lyrics`）加载的是同一个
 * Vue 应用、只是 hash 路由不同，一旦 label 判成 `main`，那个窗口里的
 * `getCurrentWindow()` 就会去操作**主窗口**（表现为桌面歌词无法移动/关闭）。
 *
 * Tauri 在 `window.__TAURI_INTERNALS__.metadata.currentWindow.label` 里同步提供了
 * 真实 label，因此这里直接取它；非 Tauri 环境（浏览器预览 / 单测）再退回到打桩桥
 * 与 URL 参数。
 */
export function currentLabel(): string {
  const injected = window.__SILVERMOON__?.label;
  if (injected) return injected;
  try {
    // 动态取：静态引入会在模块加载期读 __TAURI_INTERNALS__，浏览器预览下直接炸
    const internals = window.__TAURI_INTERNALS__ as
      { metadata?: { currentWindow?: { label?: string } } } | undefined;
    const label = internals?.metadata?.currentWindow?.label;
    if (label) return label;
  } catch {
    /* 非 Tauri 环境，走下面的兜底 */
  }
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("label");
    if (param) return param;
  }
  return "main";
}

/** 进程平台。Tauri 下由 `platform()` 异步获取，这里用 UA 同步近似。 */
export function platform(): string {
  const injected = window.__SILVERMOON__?.platform;
  if (injected) return injected;
  if (typeof navigator === "undefined") return "win32";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win32";
  if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
  return "linux";
}

function bridge(): SilverMoonBridge {
  const b = window.__SILVERMOON__;
  if (!b) {
    throw new Error("SilverMoon 桥不可用：请通过桌面应用启动，而不是直接用浏览器打开");
  }
  return b;
}

// ---------------------------------------------------------------------------
// 底层：一次 Tauri invoke
// ---------------------------------------------------------------------------

/**
 * 直接调用 Tauri 命令。失败时以**原始错误字符串**拒绝
 * （与 Electron 版一致：上层靠字符串前缀判定，例如 `[WENKU8_LOGIN_CANCELLED]`）。
 */
export async function invokeRaw<T>(cmd: string, args?: unknown): Promise<T> {
  // 打桩桥优先（单测 / 浏览器预览）
  if (window.__SILVERMOON__ && !window.__TAURI_INTERNALS__) {
    const reply = await window.__SILVERMOON__.invoke(cmd, toCloneablePayload(args ?? {}));
    if (!reply.ok) return Promise.reject(reply.error ?? `命令 ${cmd} 失败`);
    return reply.data as T;
  }
  try {
    return (await tauriInvoke<T>(
      cmd,
      (toCloneablePayload(args ?? {}) ?? {}) as Record<string, unknown>,
    )) as T;
  } catch (error) {
    // Tauri 把命令返回的 Err(String) 原样作为 reject 值抛出；
    // 只有非字符串（框架层错误）才包装，保证上层字符串前缀判定不失效。
    if (typeof error === "string") return Promise.reject(error);
    if (error instanceof Error) return Promise.reject(error.message);
    return Promise.reject(String(error));
  }
}

/** 调用 Rust 侧命令（保持 Electron 版签名）。 */
export async function invokeCommand<T>(cmd: string, args?: unknown): Promise<T> {
  return invokeRaw<T>(cmd, args);
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
 * Tauri 没有批量通道，这里改为在渲染进程侧并发发起（`Promise.all`）。
 * 语义与 Electron 版一致：**只有整条通道失败才 reject**，单条失败体现为
 * 该下标的 `{ ok: false, error }`。
 */
export async function invokeBatchCommands<T = unknown>(
  calls: { cmd: string; args?: unknown }[],
): Promise<BatchItemResult<T>[]> {
  if (calls.length === 0) return [];
  return Promise.all(
    calls.map(async (call) => {
      try {
        const data = await invokeRaw<T>(call.cmd, call.args);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: typeof error === "string" ? error : String(error) };
      }
    }),
  );
}

/**
 * 旧「宿主能力通道」的统一入口，保留给尚未迁移到 Tauri 插件命令的调用点
 * （目前只有 `musicTags` 一个）。Tauri 下映射到同名 Rust 命令。
 *
 * 参数形状保持 `{ channel, payload }` 不变，因此调用方（`src/ipc/*`、
 * `capabilities`）无需改动。
 */
export async function callBridge<T>(channel: string, payload?: unknown): Promise<T> {
  const clean = toCloneablePayload(payload ?? {}) as Record<string, unknown>;
  if (window.__SILVERMOON__ && !window.__TAURI_INTERNALS__) {
    const reply = await bridge().call(channel, clean);
    if (!reply.ok) return Promise.reject(reply.error ?? `${channel} 调用失败`);
    return reply.data as T;
  }
  return invokeRaw<T>(hostCommand(channel), hostArgs(channel, clean));
}

/**
 * 通道名 → Tauri 命令名。
 *
 * Electron 版每个通道在 `electron/ipc.ts` 里是一个 switch；Tauri 下按用途拆成
 * 三个 Rust 命令（见 `src-tauri/src/commands/host.rs` 与 `music_tags.rs`）：
 *
 * | 通道 | Rust 命令 | 说明 |
 * |---|---|---|
 * | `musicTags` | `music_tags_op` | op 分支多，单独一个命令 |
 * | `app` | `host_app` | 启动打点 / 内存诊断 / 自动更新 |
 * | `updater` | `host_updater` | 自动更新 |
 * | 其它 | `host_<channel>` | 路径 / 版本号 / 退出 / 清缓存 |
 */
function hostCommand(channel: string): string {
  switch (channel) {
    case "musicTags":
      return "music_tags_op";
    case "app":
      return "host_app";
    case "updater":
      return "host_updater";
    default:
      return `host_${channel}`;
  }
}

/**
 * 通道 payload → Rust 命令形参。
 *
 * `musicTags` 与 `app` 都是「op + 其余字段」的多路复用形态，Rust 侧统一收成
 * `(op, payload)` 两个形参；其余通道直接把 payload 当字段表传（字段名与 Rust
 * 形参一一对应）。
 */
function hostArgs(channel: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (channel === "musicTags" || channel === "app" || channel === "updater") {
    const { op, ...rest } = payload;
    return { op: op ?? "", payload: rest };
  }
  return payload;
}

/** 跨窗口派发事件。 */
export async function emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
  if (window.__SILVERMOON__ && !window.__TAURI_INTERNALS__) {
    await bridge().emitTo(label, event, toCloneablePayload(payload));
    return;
  }
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo(label, event, toCloneablePayload(payload));
}

/**
 * 把 payload 深度降级成「JSON 安全」的纯值。
 *
 * 渲染进程里的状态大多是 Vue 响应式 Proxy。Tauri 走 serde/JSON，
 * Proxy 本身无碍，但下面两类必须显式处理，否则**静默丢数据**：
 * - `undefined`：JSON 里不存在该键（Electron 的结构化克隆会保留）。
 *   命令形参多为 `Option<T>`，缺键与 `null` 等价，故仅需保证不炸。
 * - `Map` / `Set` / `Date`：JSON 会序列化成 `{}` / 时间串。
 *   本项目用到的 `Map`（musicTags 的 `overrides`）与 `Set` 一律展开成
 *   普通对象 / 数组，保持与 Electron 版一致的可读形态。
 *
 * 二进制（`Uint8Array` / `ArrayBuffer`）**原样透传**：Tauri 2 的 invoke
 * 原生支持它，转成 JSON 数组反而会膨胀数倍并拖慢大文件写入。
 */
export function toCloneablePayload<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value as object);
  if (cached !== undefined) return cached as T;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value as object, out);
    for (const item of value as unknown[]) out.push(toCloneablePayload(item, seen));
    return out as unknown as T;
  }

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    seen.set(value as object, out);
    for (const [k, v] of value as Map<unknown, unknown>) {
      out[String(k)] = toCloneablePayload(v, seen);
    }
    return out as unknown as T;
  }

  if (value instanceof Set) {
    const out: unknown[] = [];
    seen.set(value as object, out);
    for (const item of value as Set<unknown>) out.push(toCloneablePayload(item, seen));
    return out as unknown as T;
  }

  if (value instanceof Date) return value.toISOString() as unknown as T;

  const proto = Object.getPrototypeOf(value);
  // 只重建纯对象：RegExp / 其它类实例保持原样，避免破坏其语义
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const key of Object.keys(value)) {
    out[key] = toCloneablePayload((value as Record<string, unknown>)[key], seen);
  }
  return out as unknown as T;
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
 * 因此这里把每种形态都显式列出来，字符串按 UTF-8 编码而不是丢成空。
 */
export function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return asBytesView(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return asBytesView(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  return new Uint8Array(0);
}
