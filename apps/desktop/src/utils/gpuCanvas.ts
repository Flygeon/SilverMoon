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

/**
 * 是否应该启用 GPU 画布。
 *
 * ⚠️ **默认关闭**，原因如下（务必读完再改）：
 *
 * GPU 画布目前只是**可行性验证**，它会在绘制区域上叠一个原生 wgpu 窗口。
 * 但 wgpu 的初始化在部分环境上会**原生崩溃**（不触发 Rust panic hook、无日志）：
 * 实测在「Intel HD 620 + 2020 年驱动 + GameViewer 虚拟显示适配器」上，
 * 打开绘画窗口后几秒进程直接消失。
 *
 * 由于绘画窗口打开时会先隐藏主窗口，这个崩溃会让**整个应用不可用** ——
 * 代价远大于验证收益。因此改为 opt-in。
 *
 * 开启方式（三选一）：
 *
 * 1. 浏览器地址栏（开发期）：在 URL 末尾加 `?gpuCanvas=1`（或 `#/drawing?...&gpuCanvas=1`）
 * 2. 构建期：构建时设 `VITE_GPU_CANVAS=1`
 * 3. 调试：在控制台执行 `localStorage.setItem("silvermoon:gpuCanvas", "1")` 后重开画布
 *
 * 三个条件满足**任意一个**即启用。这样你的绘画功能立刻恢复正常，
 * 同时我们仍能在确定支持的环境上单独验证 wgpu 链路。
 */
export function gpuCanvasAvailable(): boolean {
  // 浏览器预览没有原生窗口能力，一律关闭（否则界面空白）
  if (!isDesktop) return false;
  try {
    // 1) localStorage 开关（最方便，重开窗口即生效）
    if (localStorage.getItem("silvermoon:gpuCanvas") === "1") return true;
  } catch {
    /* 隐私模式等场景下 localStorage 可能不可用，忽略 */
  }
  // 2) URL 参数（开发期临时开启，不改任何持久状态）
  if (typeof window !== "undefined") {
    const sp = new URLSearchParams(window.location.search);
    const hashQ = window.location.hash.includes("?")
      ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf("?") + 1))
      : null;
    if (sp.get("gpuCanvas") === "1" || hashQ?.get("gpuCanvas") === "1") return true;
  }
  // 3) 构建期环境变量（给「确定要发布验证版」的构建用）
  if (import.meta.env.VITE_GPU_CANVAS === "1") return true;
  return false;
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

  /**
   * 记录一次失败。
   *
   * ⚠️ 这里原本是 `.catch(() => undefined)` —— **把错误全吞了**。
   * 结果是「画布没出现」时前端一声不吭，用户和开发者都无从判断是没调用、
   * 被拒绝、还是后端崩了。现在把错误写进宿主日志（与 Rust 侧同一个文件），
   * 排查时能看到完整因果。
   */
  const report = (where: string, e: unknown) => {
    capabilities.appLogBoot(`[gpu-canvas] ${where} 失败：${String(e)}`, 0);
    // 控制台也留一份：devtools 打开时能直接看到
    console.error(`[gpu-canvas] ${where}`, e);
  };

  const sync = () => {
    if (closed) return;
    const rect = measure(el);
    // 尺寸为 0 时不要开窗：布局尚未完成（或元素被隐藏）时开出来会是个怪窗口。
    if (rect.width < 1 || rect.height < 1) return;
    void capabilities.gpuCanvasResize(rect.x, rect.y, rect.width, rect.height).catch(() => {
      // 还没开窗（resize 会报「未打开」）：这里先开一个。
      // 这个 catch 是**预期路径**（首次必然走到这里），因此不报错。
      void capabilities
        .gpuCanvasOpen(rect.x, rect.y, rect.width, rect.height)
        .catch((e) => report("open", e));
    });
  };

  // 首帧：等布局稳定（下一帧）再量，否则拿到的是 0 尺寸
  requestAnimationFrame(() => {
    if (closed) return;
    const rect = measure(el);
    void capabilities
      .gpuCanvasOpen(rect.x, rect.y, rect.width, rect.height)
      .catch((e) => report("首帧 open", e));
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
      await capabilities.gpuCanvasClose().catch((e) => report("close", e));
    },
  };
}
