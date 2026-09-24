/**
 * 应用窗口：统一句柄 + 创建 + 查询。
 *
 * 窗口实体全部由 Electron 主进程持有（`BrowserWindow`），这里只是按 label 定向的
 * 句柄，方法一律经 `window` 通道转发。三类用途合在一个模块里：
 *
 * | 用途 | 入口 |
 * |---|---|
 * | 操作当前窗口（最小化 / 最大化 / 关闭 / 位置尺寸 / 事件） | [`getCurrentWindow`] |
 * | 新建子窗口（桌面歌词、扩展共享窗…） | [`createWindow`] |
 * | 按 label 查窗口 | [`getWindowByLabel`] / [`getAllWindows`] |
 *
 * ## 坐标系
 *
 * `outerPosition()` / `outerSize()` 给的是**物理像素**，而渲染进程的
 * `PointerEvent.screenX` 是 CSS 像素。为了让自绘标题栏的拖拽逻辑保持正确，
 * 这里刻意统一按物理像素进出，由主进程按显示器缩放比换算。
 *
 * ## 关闭拦截
 *
 * 注册过 `onCloseRequested` 的窗口，其关闭请求会先问渲染进程：
 * 处理器里同步调用 `event.preventDefault()` 即保留窗口，否则稍后真正关闭。
 */
import { PhysicalPosition, PhysicalSize, toPositionLike, toSizeLike } from "./dpi";
import { listen, type Event, type UnlistenFn } from "./events";
import { hasBridge } from "./bridge";

/** 子窗口创建选项。未列出的字段会原样透传给主进程。 */
export interface WindowOptions {
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
  /** 是否显示系统标题栏（`false` 时由前端自绘） */
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

/** 关闭请求事件。调用 `preventDefault()` 可阻止本次关闭。 */
export interface CloseRequestedEvent {
  event: string;
  id: number;
  preventDefault(): void;
}

/** 内部标记：构造「已存在窗口」的句柄时跳过创建请求。 */
const ADOPT_FLAG = "__silvermoonAdopt";

function adoptOptions(): WindowOptions {
  return { [ADOPT_FLAG]: true };
}

function call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
  const bridge = window.__SILVERMOON__;
  if (!bridge) return Promise.reject(new Error("SilverMoon 桥不可用"));
  return bridge.call("window", { op, ...payload }).then((reply) => {
    if (!reply.ok) return Promise.reject(reply.error ?? `window.${op} 失败`);
    return reply.data as T;
  });
}

function currentLabel(): string {
  return window.__SILVERMOON__?.label ?? "main";
}

/** 窗口句柄。 */
export class AppWindow {
  readonly label: string;

  /** 创建请求（`createWindow` 时发起；包装已存在窗口时立即就绪）。 */
  private readonly ready: Promise<void>;

  constructor(label: string, options: WindowOptions = {}) {
    if (!hasBridge()) {
      throw new Error("SilverMoon 桥不可用：请在桌面应用中运行");
    }
    this.label = label;
    const adopt = options[ADOPT_FLAG] === true;
    const payload = { ...options };
    delete payload[ADOPT_FLAG];
    this.ready = adopt
      ? Promise.resolve()
      : call("create", { label, options: payload }).then(() => undefined);
    // 创建期的失败延后到具体方法上暴露，避免成为 unhandled rejection
    this.ready.catch(() => undefined);
  }

  private async run<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    return call<T>(op, { target: this.label, ...extra });
  }

  // ---- 状态 ----
  async isMaximized(): Promise<boolean> {
    return this.run<boolean>("isMaximized");
  }

  async isVisible(): Promise<boolean> {
    return this.run<boolean>("isVisible");
  }

  // ---- 控制 ----
  async minimize(): Promise<void> {
    await this.run("minimize");
  }

  async toggleMaximize(): Promise<void> {
    await this.run("toggleMaximize");
  }

  async close(): Promise<void> {
    await this.run("close");
  }

  /** 直接销毁，不触发关闭拦截 */
  async destroy(): Promise<void> {
    await this.run("destroy");
  }

  async hide(): Promise<void> {
    await this.run("hide");
  }

  async show(): Promise<void> {
    await this.run("show");
  }

  async setFocus(): Promise<void> {
    await this.run("focus");
  }

  async setTitle(title: string): Promise<void> {
    await this.run("setTitle", { title });
  }

  async setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
    await this.run("setAlwaysOnTop", { value: alwaysOnTop });
  }

  /** 鼠标穿透（桌面歌词用） */
  async setIgnoreCursorEvents(ignore: boolean): Promise<void> {
    await this.run("setIgnoreCursorEvents", { value: ignore });
  }

  // ---- 几何（物理像素）----
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

  // ---- 事件 ----
  async onResized(
    handler: (event: Event<{ width: number; height: number }>) => void,
  ): Promise<UnlistenFn> {
    return listen<{ width: number; height: number }>("window:resize", handler, {
      target: this.label,
    });
  }

  async onMoved(handler: (event: Event<{ x: number; y: number }>) => void): Promise<UnlistenFn> {
    return listen<{ x: number; y: number }>("window:move", handler, { target: this.label });
  }

  /**
   * 监听关闭请求。
   *
   * 首次注册时会告知主进程「该窗口已接管关闭」——否则主进程会直接关窗。
   */
  async onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    await this.run("watchClose");
    return listen<null>("window:close-requested", (event) => {
      const closeEvent: CloseRequestedEvent = {
        event: event.event,
        id: event.id,
        preventDefault: () => {
          // 同步发出，主进程据此取消关闭
          void call("preventClose", { target: this.label });
        },
      };
      void handler(closeEvent);
    });
  }

  /** 监听一次窗口事件（目前只用到 `"destroyed"`）。 */
  async once(event: "destroyed" | string, handler: () => void): Promise<UnlistenFn> {
    return listen<null>(`window:${event}`, () => handler(), { target: this.label });
  }
}

/** 取当前窗口。非 Electron 环境抛错（调用方用 try/catch 兜底）。 */
export function getCurrentWindow(): AppWindow {
  if (!hasBridge()) {
    throw new Error("SilverMoon 桥不可用：请在桌面应用中运行");
  }
  return new AppWindow(window.__SILVERMOON__!.label, adoptOptions());
}

/** 新建（或复用）一个子窗口。 */
export function createWindow(label: string, options: WindowOptions = {}): AppWindow {
  return new AppWindow(label, options);
}

/** 按 label 取窗口，不存在返回 `null`。 */
export async function getWindowByLabel(label: string): Promise<AppWindow | null> {
  if (!hasBridge()) return null;
  try {
    const exists = await call<boolean>("exists", { label });
    return exists ? new AppWindow(label, adoptOptions()) : null;
  } catch {
    return null;
  }
}

/** 取全部窗口句柄。 */
export async function getAllWindows(): Promise<AppWindow[]> {
  try {
    const labels = await call<string[]>("list", {});
    return labels.map((label) => new AppWindow(label, adoptOptions()));
  } catch {
    return [];
  }
}

/** 当前窗口 label（无需构造句柄时用它）。 */
export function currentWindowLabel(): string {
  return currentLabel();
}
