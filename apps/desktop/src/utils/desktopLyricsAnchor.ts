/**
 * 桌面歌词的**任务栏锚定**编排层。
 *
 * 分工：
 * - `taskbarAnchor.ts` 是纯几何（给显示器矩形，算出窗口该在哪）——可单测；
 * - 本模块负责「取显示器信息 → 调纯函数 → 真正移动窗口 → 监听变化」这些副作用。
 *
 * ## 为什么定位放在渲染进程而不是 Rust
 *
 * 窗口是 Electron 的 `BrowserWindow`，只有主进程能移动它；而「任务栏在哪」
 * 只需要显示器 `bounds` 与 `workArea` 的差集 —— Electron 原生就有，不必写
 * Win32 的 `MonitorFromPoint`/`GetMonitorInfo`，也就没有新依赖与 IPC 往返。
 * 真正的边界情况（任务栏自动隐藏、explorer 重启）见下方 `watchDisplay`。
 */
import { getCurrentWindow, type DisplayInfo } from "@/ipc/window";
import { listen } from "@/ipc/events";
import { LogicalPosition, LogicalSize } from "@/ipc/dpi";
import {
  computeAnchoredPosition,
  resolveTaskbarEdge,
  resolveTaskbarRect,
  type LyricsAnchorH,
} from "@/utils/taskbarAnchor";

export interface AnchorOptions {
  align: LyricsAnchorH;
  offsetX: number;
  offsetY: number;
}

/**
 * 把窗口贴到任务栏上。
 *
 * 返回是否真的完成了锚定：拿不到显示器信息、或该屏幕没有任务栏
 * （自动隐藏 / 全屏独占）时返回 false，调用方据此保留用户原位。
 */
export async function applyTaskbarAnchor(options: AnchorOptions): Promise<boolean> {
  const win = getCurrentWindow();
  let display: DisplayInfo;
  try {
    display = await win.displayInfo();
  } catch {
    return false;
  }

  // 无任务栏（workArea == bounds）时不强行移动：全屏游戏/自动隐藏场景下
  // 把窗口按「屏幕底部」贴上去反而会挡住用户想看的东西。
  const taskbar = resolveTaskbarRect(display);
  if (taskbar.width <= 0 || taskbar.height <= 0) return false;

  const size = await win.outerSize();
  // outerSize 按仓库约定输出**物理**像素（见 electron/ipc.ts），
  // 而 displayInfo 给的 bounds/workArea 是 **DIP** —— 这里换算成同一套单位。
  const scale = display.scaleFactor || 1;
  const logical = {
    width: Math.round(size.width / scale),
    height: Math.round(size.height / scale),
  };

  /**
   * 单位自检：**窗口不可能比整块屏幕还大**。
   *
   * 这是单位用错时最先出现的症状：曾经 displayInfo 多除了一次 scaleFactor，
   * 250% 缩放下屏幕矩形被缩成 410x256，而窗口仍是 420x120 —— 窗口比「屏幕」还宽，
   * 于是锚定把它夹进一个只有真实屏幕四分之一大的盒子里，
   * 表现为「吸到不知道哪去了」。
   *
   * 留 8px 容差：无边框窗口的尺寸偶尔会比屏幕多出一点亚像素/边框误差，
   * 那是正常的；超出更多就一定是两边的坐标系不一致。
   * 宁可不动，也不要把窗口扔到一个用户找不到的地方。
   */
  const TOLERANCE = 8;
  if (
    logical.width > display.bounds.width + TOLERANCE ||
    logical.height > display.bounds.height + TOLERANCE
  ) {
    return false;
  }

  const pos = computeAnchoredPosition({
    display,
    windowSize: logical,
    anchor: options.align,
    offsetX: options.offsetX,
    offsetY: options.offsetY,
  });

  await win.setPosition(new LogicalPosition(Math.round(pos.x), Math.round(pos.y)));
  return true;
}

/**
 * 把窗口尺寸设成锚定模式下合适的大小。
 *
 * 锚定时宽度取「任务栏可用宽度的 1/3」这类比例会让短歌词显得空，
 * 这里直接用用户已保存的宽度，只在它超出任务栏长度时才收窄 ——
 * 尊重用户调过的尺寸，但保证不会横穿整条任务栏。
 */
export async function applyAnchorSize(width: number, height: number): Promise<void> {
  const win = getCurrentWindow();
  let display: DisplayInfo;
  try {
    display = await win.displayInfo();
  } catch {
    return;
  }
  const taskbar = resolveTaskbarRect(display);
  const edge = resolveTaskbarEdge(display);
  // 任务栏横放时限制宽度，竖放时限制高度
  const horizontal = edge === "bottom" || edge === "top";
  const maxW = horizontal ? taskbar.width : display.bounds.width;
  const maxH = horizontal ? display.bounds.height : taskbar.height;
  const w = Math.max(160, Math.min(width, Math.round(maxW * 0.9)));
  const h = Math.max(48, Math.min(height, Math.round(maxH * 0.9)));
  await win.setSize(new LogicalSize(w, h));
}

/**
 * 显示器变化时重新锚定。
 *
 * 主进程监听 Electron 的 `display-metrics-changed` / `display-added` /
 * `display-removed`，广播 `display:changed` 事件（见 electron/main.ts）。
 * 这里只负责订阅。
 *
 * **不用定时轮询**：桌面歌词是常驻窗口，轮询会让它在完全空闲时也持续唤醒，
 * 而这类变化本来就是事件驱动的、有现成信号。
 *
 * 覆盖的失效场景：分辨率/缩放变化、插拔显示器、任务栏自动隐藏切换、
 * explorer 重启后工作区重算（后者也会触发 metrics-changed）。
 */
export function watchDisplay(onChange: () => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen<null>("display:changed", () => onChange()).then((un) => {
    // 订阅是异步的：如果期间已经销毁，立刻退订，避免泄漏
    if (disposed) un();
    else unlisten = un;
  });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
