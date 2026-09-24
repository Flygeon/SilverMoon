/**
 * `@tauri-apps/api/window` 的替身。
 *
 * 只覆盖业务代码用到的窗口能力（见 `composables/useWindowDrag.ts`
 * 与 `composables/useDesktopChrome.ts`）：
 * `label` / `isMaximized` / `onResized` / `minimize` / `toggleMaximize` /
 * `close` / `outerPosition` / `setPosition` / `onCloseRequested` / `hide`。
 *
 * # 坐标系
 *
 * Tauri 的 `outerPosition()` 给的是**物理像素**，而渲染进程的
 * `PointerEvent.screenX` 是 CSS 像素。为了让拖拽逻辑保持与原实现一致，
 * 这里刻意沿用 Tauri 的约定：进出主进程的坐标一律按物理像素换算。
 */
import { PhysicalPosition, PhysicalSize, toPositionLike, toSizeLike } from "./dpi";
import { listen, type Event, type UnlistenFn } from "./event";
import { hasBridge } from "../bridge";

/** 窗口尺寸变化事件载荷 */
export interface WindowSize {
  type: string;
  payload: { width: number; height: number };
}

/** 窗口位置变化事件载荷 */
export interface WindowMove {
  type: string;
  payload: { x: number; y: number };
}

/** 窗口关闭请求事件。调用 `preventDefault()` 可阻止关闭。 */
export interface CloseRequestedEvent {
  event: string;
  id: number;
  preventDefault(): void;
}

/** 关闭/尺寸/位置之外的服务端错误 */
function bridgeCall<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  const bridge = window.__SILVERMOON__;
  if (!bridge) return Promise.reject(new Error("SilverMoon 桥不可用"));
  return bridge.call("window", { op, label: getCurrentLabel(), ...extra }).then((reply) => {
    if (!reply.ok) return Promise.reject(reply.error ?? `window.${op} 失败`);
    return reply.data as T;
  });
}

function getCurrentLabel(): string {
  return window.__SILVERMOON__?.label ?? "main";
}

/**
 * 窗口句柄。
 *
 * 与 Tauri 一致：`getCurrentWindow()` 在非 Tauri 环境下会抛错，
 * 调用方（`useWindowDrag`）用 try/catch 兜底。
 */
export class Window {
  readonly label: string;

  constructor(label?: string) {
    const bridge = window.__SILVERMOON__;
    if (!bridge) {
      throw new Error("SilverMoon 桥不可用：请在 Electron 中运行");
    }
    this.label = label ?? bridge.label;
  }

  /** 是否已最大化 */
  async isMaximized(): Promise<boolean> {
    return bridgeCall<boolean>("isMaximized", { target: this.label });
  }

  /** 最小化 */
  async minimize(): Promise<void> {
    await bridgeCall("minimize", { target: this.label });
  }

  /** 最大化 / 还原切换 */
  async toggleMaximize(): Promise<void> {
    await bridgeCall("toggleMaximize", { target: this.label });
  }

  /** 关闭 */
  async close(): Promise<void> {
    await bridgeCall("close", { target: this.label });
  }

  /** 销毁（不触发 close 拦截） */
  async destroy(): Promise<void> {
    await bridgeCall("destroy", { target: this.label });
  }

  /** 隐藏 */
  async hide(): Promise<void> {
    await bridgeCall("hide", { target: this.label });
  }

  /** 显示 */
  async show(): Promise<void> {
    await bridgeCall("show", { target: this.label });
  }

  /** 置前 */
  async setFocus(): Promise<void> {
    await bridgeCall("focus", { target: this.label });
  }

  /** 物理像素位置 */
  async outerPosition(): Promise<PhysicalPosition> {
    const pos = await bridgeCall<{ x: number; y: number }>("outerPosition", {
      target: this.label,
    });
    return new PhysicalPosition(pos.x, pos.y);
  }

  /** 物理像素尺寸 */
  async outerSize(): Promise<PhysicalSize> {
    const size = await bridgeCall<{ width: number; height: number }>("outerSize", {
      target: this.label,
    });
    return new PhysicalSize(size.width, size.height);
  }

  /** 设置位置（接受逻辑或物理坐标对象） */
  async setPosition(position: unknown): Promise<void> {
    const like = toPositionLike(position);
    if (!like) return;
    await bridgeCall("setPosition", { target: this.label, position: like });
  }

  /** 设置尺寸（接受逻辑或物理尺寸对象） */
  async setSize(size: unknown): Promise<void> {
    const like = toSizeLike(size);
    if (!like) return;
    await bridgeCall("setSize", { target: this.label, size: like });
  }

  /** 置顶 */
  async setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
    await bridgeCall("setAlwaysOnTop", { target: this.label, value: alwaysOnTop });
  }

  /** 鼠标穿透 */
  async setIgnoreCursorEvents(ignore: boolean): Promise<void> {
    await bridgeCall("setIgnoreCursorEvents", { target: this.label, value: ignore });
  }

  /** 设置标题 */
  async setTitle(title: string): Promise<void> {
    await bridgeCall("setTitle", { target: this.label, title });
  }

  /** 监听尺寸变化 */
  async onResized(
    handler: (event: Event<{ width: number; height: number }>) => void,
  ): Promise<UnlistenFn> {
    return listen<{ width: number; height: number }>("tauri://resize", handler, {
      target: this.label,
    });
  }

  /** 监听位置变化 */
  async onMoved(handler: (event: Event<{ x: number; y: number }>) => void): Promise<UnlistenFn> {
    return listen<{ x: number; y: number }>("tauri://move", handler, { target: this.label });
  }

  /**
   * 监听关闭请求。
   *
   * 首次注册时会告知主进程「该窗口已接管关闭」——否则主进程会直接关窗。
   * 处理器里同步调用 `event.preventDefault()` 即可阻止本次关闭。
   */
  async onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    await bridgeCall("watchClose", { target: this.label });
    return listen<null>("tauri://close-requested", (event) => {
      const closeEvent: CloseRequestedEvent = {
        event: event.event,
        id: event.id,
        preventDefault: () => {
          // 同步发出，主进程据此取消关闭
          void bridgeCall("preventClose", { target: this.label });
        },
      };
      void handler(closeEvent);
    });
  }
}

/** 取当前窗口。非 Electron 环境抛错（与原实现一致）。 */
export function getCurrentWindow(): Window {
  if (!hasBridge()) {
    throw new Error("SilverMoon 桥不可用：请在 Electron 中运行");
  }
  return new Window();
}

/** 取任意 label 的窗口句柄（不校验是否存在）。 */
export function getWindowByLabel(label: string): Window {
  return new Window(label);
}
