/**
 * 文件拖放。
 *
 * Tauri 原生提供 `onDragDropEvent`（`@tauri-apps/api/webviewWindow`），
 * 直接把磁盘路径与位置推给渲染进程 —— 不需要 Electron 那套
 * 「preload 里用 webUtils.getPathForFile 把 File 换成真实路径」的绕行。
 *
 * 事件名约定保持不变（`drop:enter` / `drop:over` / `drop:drop` / `drop:leave`），
 * 因此 `App.vue` 里的消费代码无需改动。
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "./dpi";
import type { Event, UnlistenFn } from "./events";

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

/**
 * 监听文件拖放。
 *
 * Tauri 的 `onDragDropEvent` 一次覆盖 enter / over / drop / leave 四种形态，
 * 这里按 `payload.type` 分派给同一个处理函数（与 Electron 版一致）。
 */
export async function onDragDropEvent(
  handler: (event: Event<DragDropEvent>) => void,
): Promise<UnlistenFn> {
  const webview = getCurrentWebviewWindow();
  let seq = 0;

  const off = await webview.onDragDropEvent((raw) => {
    const payload = raw.payload;
    let mapped: DragDropEvent | null = null;
    switch (payload.type) {
      case "enter":
      case "drop":
        mapped = {
          type: payload.type,
          paths: payload.paths,
          position: new PhysicalPosition(payload.position.x, payload.position.y),
        };
        break;
      case "over":
        // Tauri 的 over 事件不带 paths（只有 enter / drop 才有），用空列表占位
        mapped = {
          type: "over",
          paths: [],
          position: new PhysicalPosition(payload.position.x, payload.position.y),
        };
        break;
      case "leave":
        mapped = { type: "leave" };
        break;
      default:
        mapped = null;
    }
    if (!mapped) return;
    handler({ event: `drop:${mapped.type}`, id: ++seq, payload: mapped });
  });

  return () => off();
}
