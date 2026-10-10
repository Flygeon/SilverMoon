/**
 * 应用窗口：统一句柄 + 创建 + 查询。
 *
 * Tauri 版直接走 `@tauri-apps/api/webviewWindow` 与 `@tauri-apps/api/window`。
 * 对外 API（`AppWindow` 类的方法名、`createWindow` / `getWindowByLabel` /
 * `getAllWindows` / `getCurrentWindow`）与 Electron 版逐一对应，业务代码无需改动。
 *
 * ## 坐标系
 *
 * `outerPosition()` / `outerSize()` 给的是**物理像素**，与 Electron 版口径一致
 * （Tauri 的 `PhysicalPosition` 同样是物理像素）。渲染进程的
 * `PointerEvent.screenX` 是 CSS 像素，两者**不同口径**，混算前须自行按缩放比换算。
 *
 * ## 关闭拦截
 *
 * Tauri 的关闭拦截比 Electron 更直接：用 `onCloseRequested` 拿到的事件对象
 * 自带 `preventDefault()`，同步调用即可取消本次关闭，不需要「先问渲染进程、
 * 再回一个 preventClose 命令」那套往返。因此这里直接映射。
 */
import type { UnlistenFn as TauriUnlisten } from "@tauri-apps/api/event";
import { getAllWindows as tauriGetAllWindows } from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  LogicalPosition,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
  toPositionLike,
  toSizeLike,
} from "./dpi";
import { listen, type Event, type UnlistenFn } from "./events";
import { currentLabel, hasBridge } from "./bridge";

/** 子窗口创建选项。未列出的字段会原样透传给宿主。 */
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
  /** 创建时就最大化 */
  maximized?: boolean;
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

/**
 * 窗口句柄。
 *
 * 与 Electron 版的差别：实体是 Tauri 的 `WebviewWindow`，方法一对一映射；
 * 创建请求改为在 `createWindow` 时同步发起（Tauri 的 `new WebviewWindow`
 * 构造函数即创建，没有「先返回句柄、后台再创建」的分离）。
 */
export class AppWindow {
  readonly label: string;
  /** 底层实体；adopt 场景下可能尚未就绪 */
  private entity: WebviewWindow | null = null;

  constructor(label: string, options: WindowOptions = {}) {
    if (!hasBridge()) {
      throw new Error("SilverMoon 桥不可用：请在桌面应用中运行");
    }
    this.label = label;
    const adopt = options[ADOPT_FLAG] === true;
    const payload = { ...options };
    delete payload[ADOPT_FLAG];
    if (adopt) {
      // 采纳已存在的窗口：延迟到首次操作时解析实体
      this.entity = null;
    } else {
      this.entity = new WebviewWindow(label, {
        url: typeof payload.url === "string" ? payload.url : "index.html",
        title: payload.title,
        width: payload.width,
        height: payload.height,
        minWidth: payload.minWidth,
        minHeight: payload.minHeight,
        x: payload.x,
        y: payload.y,
        center: payload.center,
        resizable: payload.resizable,
        decorations: payload.decorations,
        transparent: payload.transparent,
        alwaysOnTop: payload.alwaysOnTop,
        skipTaskbar: payload.skipTaskbar,
        visible: payload.visible,
        focus: payload.focus,
        maximizable: payload.maximizable,
        minimizable: payload.minimizable,
        closable: payload.closable,
        // ⚠️ 这两个原先漏了：构造是**逐字段白名单**，没列出的会被静默丢弃。
        // maximized 用于绘画窗口（一开就是最大化）；
        // shadow 是桌面歌词窗口在用的（无边框窗口不要阴影）。
        maximized: payload.maximized,
        shadow: payload.shadow,
      });
    }
  }

  /**
   * 解析底层实体。
   *
   * - 自建窗口：构造时已拿到；
   * - 采纳窗口：用 `getAllWebviewWindows()` 按 label 找。
   */
  private async resolve(): Promise<WebviewWindow> {
    if (this.entity) return this.entity;
    const all = await getAllWebviewWindows();
    const hit = all.find((w) => w.label === this.label);
    if (!hit) throw new Error(`窗口 ${this.label} 不存在`);
    this.entity = hit;
    return hit;
  }

  // ---- 状态 ----
  async isMaximized(): Promise<boolean> {
    return (await this.resolve()).isMaximized();
  }

  async isVisible(): Promise<boolean> {
    return (await this.resolve()).isVisible();
  }

  // ---- 操作 ----
  async minimize(): Promise<void> {
    await (await this.resolve()).minimize();
  }

  async toggleMaximize(): Promise<void> {
    await (await this.resolve()).toggleMaximize();
  }

  async close(): Promise<void> {
    await (await this.resolve()).close();
  }

  /** 直接销毁，不触发关闭拦截 */
  async destroy(): Promise<void> {
    await (await this.resolve()).destroy();
  }

  async hide(): Promise<void> {
    await (await this.resolve()).hide();
  }

  async show(): Promise<void> {
    await (await this.resolve()).show();
  }

  async setFocus(): Promise<void> {
    await (await this.resolve()).setFocus();
  }

  async setTitle(title: string): Promise<void> {
    await (await this.resolve()).setTitle(title);
  }

  async setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
    await (await this.resolve()).setAlwaysOnTop(alwaysOnTop);
  }

  /** 鼠标穿透（桌面歌词用） */
  async setIgnoreCursorEvents(ignore: boolean): Promise<void> {
    await (await this.resolve()).setIgnoreCursorEvents(ignore);
  }

  // ---- 几何（物理像素）----
  async outerPosition(): Promise<PhysicalPosition> {
    const pos = await (await this.resolve()).outerPosition();
    return new PhysicalPosition(pos.x, pos.y);
  }

  async outerSize(): Promise<PhysicalSize> {
    const size = await (await this.resolve()).outerSize();
    return new PhysicalSize(size.width, size.height);
  }

  async setPosition(position: unknown): Promise<void> {
    const like = toPositionLike(position);
    if (!like) return;
    const win = await this.resolve();
    await win.setPosition(
      like.kind === "physical"
        ? new PhysicalPosition(like.x, like.y)
        : new LogicalPosition(like.x, like.y),
    );
  }

  async setSize(size: unknown): Promise<void> {
    const like = toSizeLike(size);
    if (!like) return;
    const win = await this.resolve();
    await win.setSize(
      like.kind === "physical"
        ? new PhysicalSize(like.width, like.height)
        : new LogicalSize(like.width, like.height),
    );
  }

  // ---- 事件 ----
  /**
   * 尺寸变化。
   *
   * 直接订阅 Tauri 的原生窗口事件（比 Electron 版经宿主转发更短），
   * 但仍按 label 过滤，语义与原来一致。
   */
  async onResized(
    handler: (event: Event<{ width: number; height: number }>) => void,
  ): Promise<UnlistenFn> {
    const win = await this.resolve();
    const off: TauriUnlisten = await win.onResized(({ payload }) => {
      handler({
        event: "window:resize",
        id: 0,
        payload: { width: payload.width, height: payload.height },
      });
    });
    return () => off();
  }

  async onMoved(handler: (event: Event<{ x: number; y: number }>) => void): Promise<UnlistenFn> {
    const win = await this.resolve();
    const off: TauriUnlisten = await win.onMoved(({ payload }) => {
      handler({ event: "window:move", id: 0, payload: { x: payload.x, y: payload.y } });
    });
    return () => off();
  }

  /**
   * 监听关闭请求。
   *
   * Tauri 的事件对象自带 `preventDefault()`，无需像 Electron 版那样
   * 再发一条 `preventClose` 命令回主进程。
   */
  async onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    const win = await this.resolve();
    const off: TauriUnlisten = await win.onCloseRequested((tauriEvent) => {
      const closeEvent: CloseRequestedEvent = {
        event: "window:close-requested",
        id: 0,
        preventDefault: () => tauriEvent.preventDefault(),
      };
      void handler(closeEvent);
    });
    return () => off();
  }

  /** 监听一次窗口事件（目前只用到 `"destroyed"`）。 */
  async once(event: "destroyed" | string, handler: () => void): Promise<UnlistenFn> {
    if (event === "destroyed") {
      const win = await this.resolve();
      const off: TauriUnlisten = await win.once("tauri://destroyed", () => handler());
      return () => off();
    }
    return listen<null>(`window:${event}`, () => handler(), { target: this.label });
  }
}

/** 取当前窗口。非桌面环境抛错（调用方用 try/catch 兜底）。 */
export function getCurrentWindow(): AppWindow {
  if (!hasBridge()) {
    throw new Error("SilverMoon 桥不可用：请在桌面应用中运行");
  }
  // 用 Tauri 的当前窗口 label 而非 URL 猜测：多窗口场景下才准确。
  // 同步 API 拿不到 label，故先用 URL 上的 label 或 "main"，
  // 真正的实体在首次操作时由 resolve() 按 label 解析。
  return new AppWindow(currentWindowLabel(), adoptOptions());
}

/** 新建一个子窗口。 */
export function createWindow(label: string, options: WindowOptions = {}): AppWindow {
  return new AppWindow(label, options);
}

/** 按 label 取窗口，不存在返回 `null`。 */
export async function getWindowByLabel(label: string): Promise<AppWindow | null> {
  if (!hasBridge()) return null;
  try {
    const all = await getAllWebviewWindows();
    return all.some((w) => w.label === label) ? new AppWindow(label, adoptOptions()) : null;
  } catch {
    return null;
  }
}

/** 取全部窗口句柄。 */
export async function getAllWindows(): Promise<AppWindow[]> {
  try {
    const all = await tauriGetAllWindows();
    return all.map((w) => new AppWindow(w.label, adoptOptions()));
  } catch {
    return [];
  }
}

/** 当前窗口 label（无需构造句柄时用它）。 */
export function currentWindowLabel(): string {
  return currentLabel();
}
