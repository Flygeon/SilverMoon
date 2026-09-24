/**
 * `@tauri-apps/api/webview` 的替身。
 *
 * 业务代码只用到 `getCurrentWebview().onDragDropEvent(...)`（`App.vue` 拖入皮肤文件）。
 * 拖拽检测放在 preload 侧完成：DOM 的 `dragenter/dragover/dragleave/drop` 事件里
 * 用 `webUtils.getPathForFile()` 取到真实磁盘路径，再以 `tauri://drag-*` 事件名
 * 派发给渲染进程——与 Tauri 的事件名与载荷形状保持一致。
 */
import { listen, type Event, type UnlistenFn } from "./event";
import type { PhysicalPosition } from "./dpi";

/** 拖拽事件：进入 / 悬停 / 释放 / 离开 */
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

/** 窗口（webview）句柄。 */
export class Webview {
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /**
   * 监听文件拖放事件。
   *
   * 四个子事件都会被桥接到同一个处理函数，`payload.type` 用于区分——
   * 与 Tauri 的 `DragDropEvent` 判别联合一致。
   */
  async onDragDropEvent(handler: (event: Event<DragDropEvent>) => void): Promise<UnlistenFn> {
    const names = [
      "tauri://drag-enter",
      "tauri://drag-over",
      "tauri://drag-drop",
      "tauri://drag-leave",
    ];
    const unlisteners = await Promise.all(
      names.map((name) => listen<DragDropEvent>(name, handler, { target: this.label })),
    );
    return () => unlisteners.forEach((fn) => fn());
  }
}

/** 取当前 webview。 */
export function getCurrentWebview(): Webview {
  const bridge = window.__SILVERMOON__;
  if (!bridge) {
    throw new Error("SilverMoon 桥不可用：请在 Electron 中运行");
  }
  return new Webview(bridge.label);
}
