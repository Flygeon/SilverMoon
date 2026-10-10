/**
 * GPU 画布的宿主侧管理（前端）。
 *
 * ## 职责
 *
 * wgpu 画布是一个**独立的原生窗口**（见 src-tauri/src/gpu_canvas.rs）。
 * 前端这边只做一件事：**把画布占位元素的位置与尺寸同步给它**。
 *
 * ## 为什么要同步坐标
 *
 * 那个原生窗口是「浮」在整个应用之上的，位置由我们指定。界面里真正的画布位置
 * 由 Vue 的布局决定（侧栏宽度、窗口缩放、滚动都会影响它），所以 Whenever 布局变了
 * 都要重新上报一次。
 *
 * 用 `ResizeObserver` 观察占位元素 + `window.resize` 兜底：前者覆盖布局变化，
 * 后者覆盖「窗口被拖动/缩放但元素自身尺寸没变」的情况（此时坐标仍可能变）。
 *
 * ## 坐标口径
 *
 * `getBoundingClientRect()` 给的是**视口坐标**（CSS 像素），而我们需要的是
 * **屏幕坐标**。两者差一个窗口在屏幕上的位置，因此要加上窗口的外框偏移。
 * 这就是下面 `windowOrigin()` 存在的原因 —— 少了它画布会整体偏移一个窗口的距离。
 */
import { capabilities, isDesktop } from "@/capabilities";

/** 一次同步的画布区域（逻辑像素 / 屏幕坐标）。 */
interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 取当前窗口「客户区左上角」在屏幕上的位置（逻辑像素）。
 *
 * Tauri 的 `outerPosition()` 给的是**物理像素**的窗口外框位置，
 * 而 `getBoundingClientRect()` 是相对客户区的 CSS 像素。
 * 两者需要换算：
 *
 *   屏幕位置 = 外框位置(物理→逻辑) + 外框到客户区的偏移
 *
 * 外框到客户区的偏移主要是标题栏高度与边框宽度。我们无法从 WebView 里
 * 直接知道这些值，但可以用一个巧妙且**免猜测**的办法：
 * `window.screenX/screenY` 给的就是「客户区左上角」在屏幕上的 CSS 像素位置，
 * 浏览器已经帮我们算好了。
 *
 * ⚠️ 注意 `screenX/screenY` 在部分平台上报的是**窗口外框**而非客户区，
 * 但那点差异（标题栏高度）在画布置入场景里可接受：绘画窗口是无边框的
 * （decorations: false），两者重合。
 */
function windowOrigin(): { x: number; y: number } {
  return { x: window.screenX, y: window.screenY };
}

/** 画布区域计算：占位元素的视口坐标 → 屏幕坐标。 */
function measure(el: HTMLElement): CanvasRect {
  const r = el.getBoundingClientRect();
  const origin = windowOrigin();
  return {
    x: origin.x + r.left,
    y: origin.y + r.top,
    width: r.width,
    height: r.height,
  };
}

/** 是否应该启用 GPU 画布。
 *
 * 浏览器预览（无 Tauri 桥）下没有原生窗口能力，必须退回 DOM 画布，
 * 否则整个绘画界面会是一片空白。
 */
export function gpuCanvasAvailable(): boolean {
  return isDesktop;
}

export interface GpuCanvasHandle {
  /** 立刻同步一次位置尺寸 */
  sync(): void;
  /** 停止观察并关闭 GPU 画布窗口 */
  dispose(): Promise<void>;
}

/**
 * 把一个 DOM 元素变成 GPU 画布的「占位框」。
 *
 * 调用后：该元素的位置尺寸会被持续同步给原生 wgpu 窗口。
 * 元素自身应当留空（它只用来占位与测量），实际像素由 wgpu 画在那块区域上。
 */
export function attachGpuCanvas(el: HTMLElement): GpuCanvasHandle {
  let closed = false;
  let observer: ResizeObserver | null = null;

  const sync = () => {
    if (closed) return;
    const rect = measure(el);
    // 尺寸为 0 时不要开窗：布局尚未完成（或元素被隐藏）时开出来会是个怪窗口。
    if (rect.width < 1 || rect.height < 1) return;
    void capabilities.gpuCanvasResize(rect.x, rect.y, rect.width, rect.height).catch(() => {
      // 还没开窗（resize 会报「未打开」）：这里先开一个
      void capabilities
        .gpuCanvasOpen(rect.x, rect.y, rect.width, rect.height)
        .catch(() => undefined);
    });
  };

  // 首帧：等布局稳定（下一帧）再量，否则拿到的是 0 尺寸
  requestAnimationFrame(() => {
    if (closed) return;
    const rect = measure(el);
    void capabilities.gpuCanvasOpen(rect.x, rect.y, rect.width, rect.height).catch(() => undefined);
  });

  observer = new ResizeObserver(sync);
  observer.observe(el);
  // 窗口整体移动/缩放时元素尺寸可能不变，但屏幕坐标变了
  window.addEventListener("resize", sync);

  return {
    sync,
    async dispose() {
      if (closed) return;
      closed = true;
      observer?.disconnect();
      observer = null;
      window.removeEventListener("resize", sync);
      // 关闭失败不影响界面：窗口会随应用一起退出（它是本进程的子窗口）
      await capabilities.gpuCanvasClose().catch(() => undefined);
    },
  };
}
