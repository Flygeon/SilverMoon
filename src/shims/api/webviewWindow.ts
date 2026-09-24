/**
 * `@tauri-apps/api/webviewWindow` 的替身。
 *
 * 覆盖「子窗口」的完整生命周期：静态 `getCurrent` / `getByLabel`，
 * 构造 `new WebviewWindow(label, options)`，以及实例上的
 * show / hide / close / destroy / setAlwaysOnTop / setIgnoreCursorEvents /
 * onMoved / onResized / once("destroyed")。
 *
 * Tauri 的构造函数是「发起创建、不等待」的语义，这里保持一致：构造时立刻发出
 * 创建请求并把 Promise 存下来，后续每个实例方法先 await 该 Promise 再执行，
 * 因此调用方无需关心创建是否已完成。
 */
import { PhysicalPosition, PhysicalSize, toPositionLike, toSizeLike } from "./dpi";
import { listen, type Event, type UnlistenFn } from "./event";
import { hasBridge } from "../bridge";

/** 新建窗口的选项（只列业务代码用到的字段，其余原样透传给主进程）。 */
export interface WebviewWindowOptions {
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  x?: number;
  y?: number;
  center?: boolean;
  resizable?: boolean;
  decorations?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  shadow?: boolean;
  visible?: boolean;
  focus?: boolean;
  maximizable?: boolean;
  minimizable?: boolean;
  closable?: boolean;
  [key: string]: unknown;
}

function bridgeCall<T>(op: string, payload: Record<string, unknown>): Promise<T> {
  const bridge = window.__SILVERMOON__;
  if (!bridge) return Promise.reject(new Error("SilverMoon 桥不可用"));
  return bridge.call("window", { op, ...payload }).then((reply) => {
    if (!reply.ok) return Promise.reject(reply.error ?? `window.${op} 失败`);
    return reply.data as T;
  });
}

/**
 * 内部标记：用于构造「已存在窗口」的句柄而不重复创建。
 *
 * 放在 options 里而不是加第二个构造参数，是为了让 `new WebviewWindow(label, opts)`
 * 的公开签名与 Tauri 完全一致（业务代码是直接 `new` 的）。
 */
const ADOPT_FLAG = "__silvermoonAdopt";

function adoptOptions(): WebviewWindowOptions {
  return { [ADOPT_FLAG]: true };
}

/** 子窗口句柄。 */
export class WebviewWindow {
  readonly label: string;

  /** 创建请求（构造时发起；`adopt` 出来的句柄则是已就绪）。 */
  private readonly ready: Promise<void>;

  constructor(label: string, options: WebviewWindowOptions = {}) {
    const bridge = window.__SILVERMOON__;
    if (!bridge) {
      throw new Error("SilverMoon 桥不可用：请在 Electron 中运行");
    }
    this.label = label;
    // 包装「已存在的窗口」时只取句柄，不能重复发起创建
    const adopt = options[ADOPT_FLAG] === true;
    const payload = { ...options };
    delete payload[ADOPT_FLAG];
    this.ready = adopt
      ? Promise.resolve()
      : bridgeCall("create", { label, options: payload }).then(() => undefined);
    // 构造期间的失败延后到具体方法上暴露，避免成为 unhandled rejection
    this.ready.catch(() => undefined);
  }

  /** 当前窗口 */
  static getCurrent(): WebviewWindow {
    if (!hasBridge()) {
      throw new Error("SilverMoon 桥不可用：请在 Electron 中运行");
    }
    return new WebviewWindow(window.__SILVERMOON__!.label, adoptOptions());
  }

  /** 按 label 取窗口，不存在返回 null */
  static async getByLabel(label: string): Promise<WebviewWindow | null> {
    if (!hasBridge()) return null;
    try {
      const exists = await bridgeCall<boolean>("exists", { label });
      return exists ? new WebviewWindow(label, adoptOptions()) : null;
    } catch {
      return null;
    }
  }

  /** 取全部窗口 */
  static async getAll(): Promise<WebviewWindow[]> {
    try {
      const labels = await bridgeCall<string[]>("list", {});
      return labels.map((label) => new WebviewWindow(label, adoptOptions()));
    } catch {
      return [];
    }
  }

  private async run<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    return bridgeCall<T>(op, { target: this.label, ...extra });
  }

  async show(): Promise<void> {
    await this.run("show");
  }

  async hide(): Promise<void> {
    await this.run("hide");
  }

  async close(): Promise<void> {
    await this.run("close");
  }

  async destroy(): Promise<void> {
    await this.run("destroy");
  }

  async setFocus(): Promise<void> {
    await this.run("focus");
  }

  async setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
    await this.run("setAlwaysOnTop", { value: alwaysOnTop });
  }

  async setIgnoreCursorEvents(ignore: boolean): Promise<void> {
    await this.run("setIgnoreCursorEvents", { value: ignore });
  }

  async setTitle(title: string): Promise<void> {
    await this.run("setTitle", { title });
  }

  async isVisible(): Promise<boolean> {
    return this.run<boolean>("isVisible");
  }

  async isMaximized(): Promise<boolean> {
    return this.run<boolean>("isMaximized");
  }

  async minimize(): Promise<void> {
    await this.run("minimize");
  }

  async toggleMaximize(): Promise<void> {
    await this.run("toggleMaximize");
  }

  async outerPosition(): Promise<PhysicalPosition> {
    const pos = await this.run<{ x: number; y: number }>("outerPosition");
    return new PhysicalPosition(pos.x, pos.y);
  }

  async outerSize(): Promise<PhysicalSize> {
    const size = await this.run<{ width: number; height: number }>("outerSize");
    return new PhysicalSize(size.width, size.height);
  }

  async setPosition(position: unknown): Promise<void> {
    const like = toPositionLike(position);
    if (!like) return;
    await this.run("setPosition", { position: like });
  }

  async setSize(size: unknown): Promise<void> {
    const like = toSizeLike(size);
    if (!like) return;
    await this.run("setSize", { size: like });
  }

  async onResized(
    handler: (event: Event<{ width: number; height: number }>) => void,
  ): Promise<UnlistenFn> {
    return listen<{ width: number; height: number }>("tauri://resize", handler, {
      target: this.label,
    });
  }

  async onMoved(handler: (event: Event<{ x: number; y: number }>) => void): Promise<UnlistenFn> {
    return listen<{ x: number; y: number }>("tauri://move", handler, { target: this.label });
  }

  async onCloseRequested(
    handler: (event: { preventDefault(): void }) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    await this.run("watchClose");
    return listen<null>("tauri://close-requested", (event) => {
      void handler({
        preventDefault: () => {
          void bridgeCall("preventClose", { target: this.label });
        },
      });
      void event;
    });
  }

  /** 监听一次子窗口事件。目前只用到 `"destroyed"`。 */
  async once(event: "destroyed" | string, handler: () => void): Promise<UnlistenFn> {
    const name = event === "destroyed" ? "tauri://destroyed" : event;
    return listen<null>(name, () => handler(), { target: this.label });
  }
}

/** 取当前窗口（与 `WebviewWindow.getCurrent()` 等价）。 */
export function getCurrentWebviewWindow(): WebviewWindow {
  return WebviewWindow.getCurrent();
}
