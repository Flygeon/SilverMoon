/**
 * `@tauri-apps/api/event` 的替身。
 *
 * 事件通道分两段：
 *
 * ```
 * Rust (tauri 兼容层) --SSE--> Electron 主进程 --webContents.send--> 各渲染窗口
 * 渲染窗口 --emitTo--> Electron 主进程 --webContents.send--> 目标渲染窗口
 * ```
 *
 * Electron 主进程把帧派发到渲染进程时走 `ipcRenderer` → preload 转成 DOM
 * `CustomEvent("silvermoon:event")`；本模块只监听这个 DOM 事件即可，
 * 无需为每次 `listen` 建立 IPC 通道。
 */

/** 事件对象。与 Tauri 的 `Event<T>` 同形。 */
export interface Event<T> {
  /** 事件名 */
  event: string;
  /** 事件 id（本地自增，仅用于调试） */
  id: number;
  /** 载荷 */
  payload: T;
}

/** 取消监听。 */
export type UnlistenFn = () => void;

/** 主进程派发到渲染进程的帧结构。 */
interface EventFrame {
  event: string;
  /** `null` 表示广播；否则只应投递给该 label 的窗口 */
  target: string | null;
  payload: unknown;
}

const DOM_EVENT = "silvermoon:event";

let seq = 0;

/** 当前窗口 label（由 preload 注入）。 */
function myLabel(): string {
  return window.__SILVERMOON__?.label ?? "main";
}

function dispatchFrame(
  frame: EventFrame,
  handlers: Map<string, Set<(e: Event<unknown>) => void>>,
): void {
  const set = handlers.get(frame.event);
  if (!set) return;
  const evt: Event<unknown> = { event: frame.event, id: ++seq, payload: frame.payload };
  // 复制一份再遍历：处理器里可能会 unlisten
  for (const handler of [...set]) {
    try {
      handler(evt);
    } catch (error) {
      console.error(`[silvermoon] 事件 ${frame.event} 的处理器抛出异常`, error);
    }
  }
}

/** 全局处理器表：事件名 → 监听器集合。 */
const handlers = new Map<string, Set<(e: Event<unknown>) => void>>();

let attached = false;

function attachOnce(): void {
  if (attached || typeof window === "undefined") return;
  attached = true;
  window.addEventListener(DOM_EVENT, (raw) => {
    const frame = (raw as CustomEvent<EventFrame>).detail;
    if (!frame) return;
    // 定向事件只投给目标窗口
    if (frame.target !== null && frame.target !== myLabel()) return;
    dispatchFrame(frame, handlers);
  });
}

/**
 * 监听事件。返回取消函数。
 *
 * 支持动态事件名（例如 `ext://<id>/<event>`）——事件名只作为字符串键使用。
 */
export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void,
  _options?: { target?: string | { kind: string; label: string } },
): Promise<UnlistenFn> {
  attachOnce();
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const cast = handler as (e: Event<unknown>) => void;
  set.add(cast);
  return () => {
    set!.delete(cast);
    if (set!.size === 0) handlers.delete(event);
  };
}

/** 只监听一次。 */
export async function once<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (e) => {
    unlisten();
    handler(e);
  });
  return unlisten;
}

/** 向所有窗口广播（仅前端之间；Rust 侧事件走 SSE）。 */
export async function emit(event: string, payload?: unknown): Promise<void> {
  const bridge = window.__SILVERMOON__;
  if (!bridge) return;
  await bridge.call("emit", { target: null, event, payload: payload ?? null });
}

/** 定向派发给某个 label 的窗口。 */
export async function emitTo(
  target: string | { kind: string; label: string },
  event: string,
  payload?: unknown,
): Promise<void> {
  const label = typeof target === "string" ? target : target.label;
  const bridge = window.__SILVERMOON__;
  if (!bridge) return;
  await bridge.emitTo(label, event, payload ?? null);
}

/** Tauri 的 `TauriEvent` 常量（业务代码未使用，仅为类型完整保留）。 */
export const TauriEvent = {
  WINDOW_RESIZED: "tauri://resize",
  WINDOW_MOVED: "tauri://move",
  WINDOW_CLOSE_REQUESTED: "tauri://close-requested",
  WINDOW_DESTROYED: "tauri://destroyed",
  WINDOW_FOCUS: "tauri://focus",
  WINDOW_BLUR: "tauri://blur",
  DRAG_ENTER: "tauri://drag-enter",
  DRAG_OVER: "tauri://drag-over",
  DRAG_DROP: "tauri://drag-drop",
  DRAG_LEAVE: "tauri://drag-leave",
} as const;
