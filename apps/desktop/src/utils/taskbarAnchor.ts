/**
 * 任务栏锚定几何：把桌面歌词窗口贴到任务栏上。
 *
 * 为什么单独抽成模块：主进程拿到的只有 Electron 的 Display 形状
 * （bounds + workArea），而「任务栏在哪条边、窗口该贴到哪」纯粹是几何问题。
 * 做成不 import Electron 的纯函数后，四边停靠、多屏负坐标、窗口比屏幕还大
 * 这些分支都能用单测钉死，不必真的去挪一次窗口。
 *
 * 坐标系与 Electron 的 screen API 完全一致：单位是 CSS 像素（DIP），
 * 原点在主显示器左上角，副屏坐标可以是负数。这里不做任何 DPI 换算 ——
 * display.scaleFactor 只是随对象透传，几何计算不使用它。
 */

/** 屏幕矩形（DIP 像素） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Electron Display 中本模块用到的字段；bounds 是整块屏幕，workArea 是扣掉任务栏后的可用区 */
export interface DisplayLike {
  bounds: Rect;
  workArea: Rect;
  /** 仅随 display 透传，几何计算不使用 */
  scaleFactor?: number;
}

/** 任务栏停靠边；Windows 的任务栏允许停靠上/下/左/右四边 */
export type TaskbarEdge = "bottom" | "top" | "left" | "right";

/** 沿任务栏长边的锚点：left/center/right */
export type LyricsAnchorH = "left" | "center" | "right";

/** workArea 相对 bounds 在四边各自被「吃掉」的厚度 */
interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 无任务栏时的哨兵值：零矩形。
 *
 * 这里刻意返回 {0,0,0,0} 而不是「贴在 bounds 某条边上的零厚度条」，
 * 是为了让调用方能用一个明确的判断走退化分支，不必再猜 bounds 的坐标。
 */
function zeroRect(): Rect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

/** 量出 workArea 在 bounds 四边各自内缩了多少；workArea 比 bounds 大（异常数据）时按 0 计 */
function measureInsets(display: DisplayLike): Insets {
  const { bounds, workArea } = display;
  return {
    left: Math.max(0, workArea.x - bounds.x),
    top: Math.max(0, workArea.y - bounds.y),
    right: Math.max(0, bounds.x + bounds.width - (workArea.x + workArea.width)),
    bottom: Math.max(0, bounds.y + bounds.height - (workArea.y + workArea.height)),
  };
}

/**
 * 判断任务栏停靠在哪条边：取 workArea 与 bounds 差值最大的那条边。
 *
 * 四边差值为 0（自动隐藏 / 根本没有任务栏）时返回 "bottom"：
 * Windows 默认底边，让同一份输入永远得到同一个结果。
 */
export function resolveTaskbarEdge(display: DisplayLike): TaskbarEdge {
  const insets = measureInsets(display);
  // 顺序即优先级：仅在「严格更大」时替换，因此平局时按下/上/左/右取先者。
  const candidates: Array<[TaskbarEdge, number]> = [
    ["bottom", insets.bottom],
    ["top", insets.top],
    ["left", insets.left],
    ["right", insets.right],
  ];
  let edge: TaskbarEdge = "bottom";
  let thickness = 0;
  for (const [candidate, value] of candidates) {
    if (value > thickness) {
      thickness = value;
      edge = candidate;
    }
  }
  return edge;
}

/**
 * 任务栏矩形 = bounds 减 workArea 落在停靠边上的那条。
 *
 * 厚度取该边的内缩量，长边方向铺满 bounds（真实任务栏就是一条贯穿屏幕的条）。
 * 没有任何内缩时返回零矩形，调用方据此走「无任务栏」退化分支。
 */
export function resolveTaskbarRect(display: DisplayLike): Rect {
  const { bounds } = display;
  const insets = measureInsets(display);
  const thickness = Math.max(insets.left, insets.top, insets.right, insets.bottom);
  if (thickness <= 0) return zeroRect();

  switch (resolveTaskbarEdge(display)) {
    case "top": {
      const height = Math.min(insets.top, bounds.height);
      return { x: bounds.x, y: bounds.y, width: bounds.width, height };
    }
    case "left": {
      const width = Math.min(insets.left, bounds.width);
      return { x: bounds.x, y: bounds.y, width, height: bounds.height };
    }
    case "right": {
      const width = Math.min(insets.right, bounds.width);
      return { x: bounds.x + bounds.width - width, y: bounds.y, width, height: bounds.height };
    }
    case "bottom":
    default: {
      const height = Math.min(insets.bottom, bounds.height);
      return { x: bounds.x, y: bounds.y + bounds.height - height, width: bounds.width, height };
    }
  }
}

/** 把窗口沿某条轴贴到 [start, start + length) 这段区间的左/中/右 */
function anchorAlong(
  anchor: LyricsAnchorH,
  start: number,
  length: number,
  windowLength: number,
): number {
  if (anchor === "left") return start;
  if (anchor === "right") return start + length - windowLength;
  return start + (length - windowLength) / 2;
}

/** 夹取到 [min, max]；窗口比屏幕还大时 max < min，此时返回 min（钉在左上角，保证窗口起始角落可见） */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export interface AnchorRequest {
  display: DisplayLike;
  windowSize: { width: number; height: number };
  anchor: LyricsAnchorH;
  offsetX: number;
  offsetY: number;
  /** 窗口与任务栏边缘的留白，默认 0 */
  margin?: number;
}

/**
 * 算出「贴着任务栏」的窗口左上角坐标。
 *
 * 任务栏在上/下边时窗口贴在长边外侧（下边贴上方、上边贴下方），anchor 沿 X 轴；
 * 在左/右边时同理贴在外侧，anchor 沿 Y 轴 —— 即 anchor 永远作用于任务栏的长边，
 * 这样四边停靠的观感一致，调用方不必按边切换参数含义。
 * margin 只作用于垂直于任务栏的那条轴（留白是「窗口与任务栏边缘」之间的）。
 *
 * 无任务栏时退化为贴 bounds 底部居中；偏移照旧叠加，最后统一夹回 bounds，
 * 保证窗口不会跑到屏幕外（任务栏被自动隐藏时用户仍能拖动微调）。
 */
export function computeAnchoredPosition(req: AnchorRequest): { x: number; y: number } {
  const { display, windowSize, anchor, offsetX, offsetY, margin = 0 } = req;
  const { bounds } = display;
  const taskbar = resolveTaskbarRect(display);

  let baseX: number;
  let baseY: number;

  if (taskbar.width <= 0 || taskbar.height <= 0) {
    // 没有可贴的边：固定为底部居中。此处刻意忽略 anchor —— 退化时给出唯一结果
    // 比按 anchor 变化更好预测（否则「没有任务栏」也会有两种行为）。
    baseX = bounds.x + (bounds.width - windowSize.width) / 2;
    baseY = bounds.y + bounds.height - windowSize.height - margin;
  } else if (resolveTaskbarEdge(display) === "bottom") {
    baseX = anchorAlong(anchor, taskbar.x, taskbar.width, windowSize.width);
    baseY = taskbar.y - windowSize.height - margin;
  } else if (resolveTaskbarEdge(display) === "top") {
    baseX = anchorAlong(anchor, taskbar.x, taskbar.width, windowSize.width);
    baseY = taskbar.y + taskbar.height + margin;
  } else if (resolveTaskbarEdge(display) === "left") {
    baseY = anchorAlong(anchor, taskbar.y, taskbar.height, windowSize.height);
    baseX = taskbar.x + taskbar.width + margin;
  } else {
    baseY = anchorAlong(anchor, taskbar.y, taskbar.height, windowSize.height);
    baseX = taskbar.x - windowSize.width - margin;
  }

  return {
    x: clamp(baseX + offsetX, bounds.x, bounds.x + bounds.width - windowSize.width),
    y: clamp(baseY + offsetY, bounds.y, bounds.y + bounds.height - windowSize.height),
  };
}
