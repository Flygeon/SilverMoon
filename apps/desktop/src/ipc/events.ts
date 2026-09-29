/**
 * 应用事件。
 *
 * 事件通道分两段：
 *
 * ```text
 * 后端进程 --SSE /events--> Electron 主进程 --webContents.send--> 各渲染窗口
 * 渲染窗口 --emitTo--------> Electron 主进程 --webContents.send--> 目标渲染窗口
 * ```
 *
 * 主进程派发到渲染进程时走 `ipcRenderer` → preload 转成 DOM
 * `CustomEvent("silvermoon:event")`；本模块只监听这个 DOM 事件，
 * 因此不必为每次 `listen` 建立一条 IPC 通道。
 *
 * 事件名约定：
 * - 后端事件：`scan:progress`、`smtc:command`、`app:player-command`、`ext:navigate`
 * - 窗口事件：`window:resize`、`window:move`、`window:close-requested`、`window:destroyed`
 * - 拖放事件：`drop:enter`、`drop:over`、`drop:drop`、`drop:leave`
 * - 扩展自定义：`ext://<id>/<event>`（事件名只当字符串键用，支持动态拼接）
 */

/** 事件对象。 */
export interface Event<T> {
  /** 事件名 */
  event: string;
  /** 本地自增序号，仅用于调试 */
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

/** 全局处理器表：事件名 → 监听器集合。 */
const handlers = new Map<string, Set<(e: Event<unknown>) => void>>();

let seq = 0;
let attached = false;

function myLabel(): string {
  return window.__SILVERMOON__?.label ?? "main";
}

function attachOnce(): void {
  if (attached || typeof window === "undefined") return;
  attached = true;
  window.addEventListener(DOM_EVENT, (raw) => {
    const frame = (raw as CustomEvent<EventFrame>).detail;
    if (!frame) return;
    // 定向事件只投给目标窗口
    if (frame.target !== null && frame.target !== myLabel()) return;

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
  _options?: { target?: string },
): Promise<UnlistenFn> {
  attachOnce();
  // 用 const 保存引用：闭包里访问 `let` 变量会丢失 TS 的收窄结果
  const set = handlers.get(event) ?? new Set<(e: Event<unknown>) => void>();
  handlers.set(event, set);
  const cast = handler as (e: Event<unknown>) => void;
  set.add(cast);
  return () => {
    set.delete(cast);
    if (set.size === 0) handlers.delete(event);
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

/** 向所有窗口广播（仅前端之间；后端事件走后端的 SSE）。 */
export async function emit(event: string, payload?: unknown): Promise<void> {
  const bridge = window.__SILVERMOON__;
  if (!bridge) return;
  await bridge.call("emit", { target: null, event, payload: payload ?? null });
}

/** 定向派发给某个 label 的窗口。 */
export async function emitTo(target: string, event: string, payload?: unknown): Promise<void> {
  const bridge = window.__SILVERMOON__;
  if (!bridge) return;
  await bridge.emitTo(target, event, payload ?? null);
}
