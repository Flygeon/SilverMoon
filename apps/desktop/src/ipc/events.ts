/**
 * 应用事件。
 *
 * Tauri 版直接走 `@tauri-apps/api/event`：
 *
 * ```text
 * Rust 命令 --app.emit(...)--> Tauri 事件系统 --> 各渲染窗口
 * 渲染窗口 --emitTo--------> Tauri 事件系统 --> 目标渲染窗口
 * ```
 *
 * 与 Electron 版的差异（在本层吸收，业务代码无感）：
 * - Electron 走 preload 转 DOM `CustomEvent`，本模块监听它；
 *   Tauri 用 `listen()` 订阅原生事件，故这里改为惰性订阅 + 本地处理器表。
 * - 事件定向：Tauri 用 `emitTo(label, ...)`，Rust 侧已按 label 发送。
 *
 * 事件名约定（与 Rust 侧一致，未改动）：
 * - 后端事件：`scan:progress`、`smtc:command`、`app:player-command`、`ext:navigate`
 * - 窗口事件：`window:resize`、`window:move`、`window:close-requested`
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

/** 全局处理器表：事件名 → 监听器集合。 */
const handlers = new Map<string, Set<(e: Event<unknown>) => void>>();
/** 事件名 → Tauri 侧的取消函数（每个事件名只订阅一次）。 */
const subscriptions = new Map<string, Promise<UnlistenFn>>();
let seq = 0;

/**
 * 确保某个事件名已向 Tauri 订阅（惰性，每个事件名仅一次）。
 *
 * 这样业务侧可以随意 `listen` / `unlisten`，不会因为反复订阅把通道打爆。
 */
function ensureSubscribed(event: string): void {
  if (subscriptions.has(event)) return;
  const promise = (async (): Promise<UnlistenFn> => {
    const { listen: tauriListen } = await import("@tauri-apps/api/event");
    return tauriListen<unknown>(event, (raw) => {
      const set = handlers.get(event);
      if (!set) return;
      const evt: Event<unknown> = { event, id: ++seq, payload: raw.payload };
      // 复制一份再遍历：处理器里可能会 unlisten
      for (const handler of [...set]) {
        try {
          handler(evt);
        } catch (error) {
          console.error(`[silvermoon] 事件 ${event} 的处理器抛出异常`, error);
        }
      }
    });
  })();
  subscriptions.set(event, promise);
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
  const set = handlers.get(event) ?? new Set<(e: Event<unknown>) => void>();
  handlers.set(event, set);
  const cast = handler as (e: Event<unknown>) => void;
  set.add(cast);
  ensureSubscribed(event);
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

/** 向所有窗口广播。 */
export async function emit(event: string, payload?: unknown): Promise<void> {
  const { emit: tauriEmit } = await import("@tauri-apps/api/event");
  await tauriEmit(event, payload ?? null);
}

/** 定向派发给某个 label 的窗口。 */
export async function emitTo(label: string, event: string, payload?: unknown): Promise<void> {
  const { emitTo: tauriEmitTo } = await import("@tauri-apps/api/event");
  await tauriEmitTo(label, event, payload ?? null);
}
