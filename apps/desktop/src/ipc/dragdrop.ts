/**
 * 文件拖放。
 *
 * 拖拽检测放在 preload 里完成：DOM 的 `dragenter/dragover/dragleave/drop` 事件中
 * 用 `webUtils.getPathForFile()` 取到真实磁盘路径（新版 Electron 已不提供
 * `File.path`），再以 `drop:enter` / `drop:over` / `drop:drop` / `drop:leave`
 * 事件名派发给渲染进程。
 *
 * 这里把它收成一个函数——原先需要先拿一个 webview 句柄再调它的方法，
 * 而这个能力其实与「哪个 webview」无关。
 */
import { listen, type Event, type UnlistenFn } from "./events";
import type { PhysicalPosition } from "./dpi";

/** 拖放事件：进入 / 悬停 / 释放 / 离开 */
export type DragDropEvent =
  | {
      type: "enter" | "over";
      paths: string[];
      position: PhysicalPosition;
    }
  | {
      type: "drop";
      paths: string[];
      position: PhysicalPosition;
    }
  | {
      type: "leave";
    };

const EVENT_NAMES = ["drop:enter", "drop:over", "drop:drop", "drop:leave"] as const;

/**
 * 监听文件拖放。
 *
 * 四个子事件都会桥接到同一个处理函数，用 `payload.type` 区分。
 */
export async function onDragDropEvent(
  handler: (event: Event<DragDropEvent>) => void,
): Promise<UnlistenFn> {
  const label = window.__SILVERMOON__?.label ?? "main";
  const unlisteners = await Promise.all(
    EVENT_NAMES.map((name) => listen<DragDropEvent>(name, handler, { target: label })),
  );
  return () => unlisteners.forEach((fn) => fn());
}
