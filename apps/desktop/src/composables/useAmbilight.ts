/**
 * 氛围光（Ambient light / Ambilight）。
 *
 * 参考实现：WesselKroos/youtube-ambilight（浏览器扩展）。它的做法可拆成三步，
 * 这里按桌面端范式（无扩展宿主、单播放器、尺寸由布局决定）做了简化：
 *
 * 1. **降采样**：把视频当前帧画进一张很小的 canvas。代价与视频分辨率无关，
 *    4K 与 480P 一样便宜。
 * 2. **模糊 + 调色**：不给每个像素做卷积，而是把模糊交给 CSS `filter: blur()`
 *    （合成器 / GPU 处理），同一张画布再叠 `saturate()` / `brightness()`。
 *    参考项目走的也是这条路线（filterElem.style.filter 里拼 blur/contrast/
 *    brightness/saturate）。
 * 3. **外扩**：把画布拉伸到「比播放器更大」的区域、置于播放器之下，
 *    模糊后的边缘自然溢出到四周形成光晕。
 *
 * 与参考项目的差异：它要处理 YouTube 的剧场/全屏/黑边检测、WebGL mipmap、
 * 多显示器等一堆情况；我们的播放器尺寸由布局决定，故不做黑边检测，只保留
 * 「模糊 / 外扩 / 透明度 / 饱和度 / 亮度」这几个真正影响观感的参数。
 */
import { onBeforeUnmount, watch, type Ref } from "vue";

export interface AmbilightOptions {
  enabled: Ref<boolean>;
  /** 模糊半径（px）：越大越弥散 */
  blur: Ref<number>;
  /** 外扩：相对播放器尺寸的百分比 */
  spread: Ref<number>;
  /** 不透明度 0-100 */
  opacity: Ref<number>;
  /** 饱和度 0-200（100 = 原样） */
  saturation: Ref<number>;
  /** 亮度 0-200（100 = 原样） */
  brightness: Ref<number>;
}

/**
 * 降采样目标宽度。
 *
 * 48 是刻意取的：模糊之后细节本就被抹平，再大只是白花 GPU；而画布太小又会在
 * 大面积纯色下出现色带。48 宽在 16:9 下约 27 行，是观感与成本的平衡点。
 */
const SAMPLE_WIDTH = 48;
/** 帧率上限：光晕变化慢，30fps 足够且省电 */
const MAX_FPS = 30;

export function useAmbilight(opts: AmbilightOptions, canvas: Ref<HTMLCanvasElement | null>) {
  /** 目标视频元素（由播放器注入） */
  let video: HTMLVideoElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let running = false;
  let rafId = 0;
  let rvfcId = 0;
  let lastDraw = 0;
  /** 上一次绘制对应的视频时间，用于跳过静止帧 */
  let lastMediaTime = -1;

  function drawable(): boolean {
    return !!video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }

  function drawOnce(): void {
    if (!ctx || !drawable()) return;
    try {
      ctx.drawImage(video as HTMLVideoElement, 0, 0, ctx.canvas.width, ctx.canvas.height);
    } catch {
      // 尚未解出帧 / 元素被替换：吞掉，下一帧再试
    }
  }

  /** 按视频纵横比准备画布尺寸（比例变化时才改，改尺寸会重置上下文）。 */
  function ensureCanvasSize(): void {
    const el = canvas.value;
    if (!el || !drawable() || !video) return;
    const h = Math.max(1, Math.round(SAMPLE_WIDTH * (video.videoHeight / video.videoWidth)));
    if (el.width !== SAMPLE_WIDTH || el.height !== h) {
      el.width = SAMPLE_WIDTH;
      el.height = h;
      ctx = el.getContext("2d");
    }
  }

  /** rAF 路径：受 MAX_FPS 限流，静止画面不重绘。 */
  function step(now: number): void {
    if (!running) return;
    ensureCanvasSize();
    const v = video;
    if (v && now - lastDraw >= 1000 / MAX_FPS) {
      // 暂停时也画最后一次，让光晕停在当前画面；之后 currentTime 不变就不再重绘
      const t = v.currentTime;
      if (t !== lastMediaTime || !v.paused) {
        drawOnce();
        lastMediaTime = t;
      }
      lastDraw = now;
    }
    rafId = requestAnimationFrame(step);
  }

  /** 优先用 requestVideoFrameCallback 跟随真实视频帧，缺失时回退 rAF。 */
  function schedule(): void {
    if (!running) return;
    const v = video as
      (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
    if (v?.requestVideoFrameCallback) {
      rvfcId = v.requestVideoFrameCallback(() => {
        if (!running) return;
        drawOnce();
        schedule();
      });
      return;
    }
    rafId = requestAnimationFrame(step);
  }

  function stop(): void {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    const v = video as
      (HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void }) | null;
    if (rvfcId && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(rvfcId);
    rvfcId = 0;
  }

  /** 播放器把 <video> 交进来；解绑传 null。 */
  function attach(el: HTMLVideoElement | null): void {
    stop();
    video = el;
    lastMediaTime = -1;
    if (el && canvas.value) {
      ctx = canvas.value.getContext("2d");
      ensureCanvasSize();
      drawOnce();
    }
    if (el && opts.enabled.value) start();
  }

  function start(): void {
    if (running || !video) return;
    running = true;
    lastDraw = 0;
    schedule();
  }

  /** 开关变化：开启则起循环，关闭则停掉并清空画布（避免残留一帧光晕）。 */
  function syncEnabled(): void {
    if (opts.enabled.value) {
      ensureCanvasSize();
      start();
    } else {
      stop();
      const el = canvas.value;
      if (el) el.getContext("2d")?.clearRect(0, 0, el.width, el.height);
    }
  }

  watch(() => opts.enabled.value, syncEnabled);
  onBeforeUnmount(stop);

  return { attach, start, stop, syncEnabled };
}
