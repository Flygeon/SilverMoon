/**
 * 独立绘画窗口。
 *
 * ## 为什么单开窗口而不是在主窗口里切视图
 *
 * 绘画是**长时间、沉浸式、吃屏幕**的操作：工具栏、属性栏、画布、图层面板要同时
 * 铺开才顺手。塞在图片页签里时，画布只能占一个被压缩的方框（实测
 * `height: clamp(520px, 72vh, 900px)`，左右还被导航栏挤占），画细节时根本不够用。
 *
 * 因此改为：**主窗口隐藏 → 新开一个最大化的独立窗口** → 关闭时主窗口恢复。
 * 这与桌面歌词窗口走同一套机制（`createWindow` + 独立路由 + 独立 capability）。
 *
 * ## 为什么要隐藏主窗口而不是留着
 *
 * 留着会有两个窗口争任务栏、且用户容易误以为绘画没打开。隐藏后视觉上就是
 * 「切进了一个专业绘画应用」，关闭时再切回来——这也是用户明确要求的形态。
 *
 * ## 参数怎么传给新窗口
 *
 * 走 **URL query**（`#/drawing?id=xxx&w=1024&h=1024`）而不是事件或 store：
 * - 新窗口是独立的 webview，与主窗口**不共享内存中的 Pinia store**；
 * - query 在窗口创建那一刻就确定，不存在「窗口起来了但参数还没到」的竞态；
 * - 刷新窗口（F5）也能恢复，不需要重新从主窗口推一次。
 *
 * ## 关闭时要收尾
 *
 * 绘画窗口关闭后主窗口必须**显示回来**，否则用户会以为应用退出了。
 * 用户可能直接点窗口的 X，那条路径不经过我们的「返回」按钮，
 * 因此这里监听窗口的销毁事件来兜底。
 */
import { isDesktop } from "@/capabilities";
import { createWindow, getWindowByLabel, getCurrentWindow } from "@/ipc/window";

/** 绘画窗口的 label（与 capabilities/drawing.json 的 windows 一致）。 */
export const DRAWING_WINDOW_LABEL = "drawing";

/** 主窗口 label。 */
export const MAIN_LABEL = "main";

/** 打开绘画窗口的参数。 */
export interface OpenDrawingOptions {
  /** 已有画作的 id；新建时为 null */
  id: string | null;
  width: number;
  height: number;
}

/**
 * 主窗口：打开绘画窗口（已存在则复用并聚焦）。
 *
 * 主窗口会先隐藏 —— 用户看到的就是「切进绘画应用」而不是「多了一个窗口」。
 */
export async function openDrawingWindow(opts: OpenDrawingOptions): Promise<void> {
  if (!isDesktop) return;

  const existing = await getWindowByLabel(DRAWING_WINDOW_LABEL);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const base = window.location.href.split("#")[0];
  const q = new URLSearchParams({
    w: String(Math.round(opts.width)),
    h: String(Math.round(opts.height)),
  });
  if (opts.id) q.set("id", opts.id);

  createWindow(DRAWING_WINDOW_LABEL, {
    url: base + "#/drawing?" + q.toString(),
    title: "SilverMoon · 绘画",
    // 最大化：绘画要的就是屏幕
    maximized: true,
    decorations: true,
    resizable: true,
    minWidth: 900,
    minHeight: 600,
    visible: true,
  });

  // 先把主窗口藏起来：否则新窗口弹出时背后还露着主界面
  try {
    await getCurrentWindow().hide();
  } catch {
    /* 隐藏失败不影响绘画窗口可用 */
  }
}

/**
 * 绘画窗口：关闭自己并让主窗口回来。
 *
 * 由绘画界面主动调用（工具栏的「返回」按钮）。
 */
export async function closeDrawingWindow(): Promise<void> {
  if (!isDesktop) return;
  try {
    await getCurrentWindow().close();
  } catch {
    /* 忽略 */
  }
}

/**
 * 主窗口：监听绘画窗口关闭，**把主窗口显示回来**，然后通知调用方（用于刷新列表）。
 *
 * ## 为什么「显示回来」是这里的核心职责
 *
 * openDrawingWindow 会把主窗口 **hide** 掉（视觉上像切进了一个独立应用）。
 * 因此绘画窗口一旦关闭，**必须有东西把主窗口 show 回来** —— 否则用户看到的是
 * 「点了返回，然后应用整个消失了」，只能去任务栏找。这是最容易漏的一环。
 *
 * 关闭有两条路径，都要覆盖：
 * 1. 绘画界面里的「返回」按钮 → 主动 close（我们收得到 destroyed）；
 * 2. 用户直接点窗口的 X → 同样触发 destroyed。
 * 因此统一监听 destroyed，而不是依赖调用方在某个分支里记得 show。
 *
 * 返回一个取消监听的函数（调用方在卸载时用）。
 */
export function watchDrawingWindowClosed(onClosed: () => void): () => void {
  if (!isDesktop) return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;

  /** 主窗口重新显示 + 通知调用方。只应执行一次。 */
  let restored = false;
  const restore = () => {
    if (restored || disposed) return;
    restored = true;
    void (async () => {
      try {
        const main = await getWindowByLabel(MAIN_LABEL);
        if (main) {
          await main.show();
          await main.setFocus();
        }
      } catch {
        /* 显示失败时用户可从任务栏唤回，不阻断后续刷新 */
      }
      onClosed();
    })();
  };

  void (async () => {
    try {
      // 用 AppWindow.once("destroyed")：它内部就是 Tauri 的 `tauri://destroyed`，
      // 但已经处理了「先解析实体再订阅」的时序，比手写事件名可靠
      // （见 ipc/window.ts:273 与 useDesktopChrome 里踩过的同款坑）。
      const win = await getWindowByLabel(DRAWING_WINDOW_LABEL);
      if (!win) {
        // 窗口已经不存在了（极快关闭）：直接恢复，别让主窗口一直藏着
        restore();
        return;
      }
      const off = await win.once("destroyed", restore);
      if (disposed) off();
      else unlisten = off;
    } catch {
      /* 监听不上时最坏情况是主窗口保持隐藏，用户可从任务栏唤回 */
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/** 当前窗口是否是绘画窗口。 */
export function isDrawingWindow(): boolean {
  if (!isDesktop) return false;
  try {
    return getCurrentWindow().label === DRAWING_WINDOW_LABEL;
  } catch {
    return false;
  }
}
