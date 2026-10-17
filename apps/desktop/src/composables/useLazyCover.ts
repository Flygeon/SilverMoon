/**
 * 封面「懒加载 + 预取两行」的通用逻辑。
 *
 * 为什么不用原生 `loading="lazy"`：
 * 原生懒加载的触发距离由浏览器决定（Chromium 约 1250px，且不可配置），
 * 在 16:9 卡片网格里相当于「提前 3~4 行」，滚动快时仍会看到成片骨架屏；
 * 而它又无法表达「只提前两行」这种产品诉求。这里用 IntersectionObserver 自己控。
 *
 * 用法：
 * ```ts
 * const { el, shouldLoad, loaded, failed, onLoad, onError } = useLazyCover();
 * ```
 * 把 `el` 绑到卡片根元素（或封面容器），`shouldLoad` 为真时才把 src 写进 <img>。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * 默认预取距离。
 *
 * 「视图外后两行」：B 站卡片是 16:9、网格最小列宽 250px，一行高度约 250*9/16 + 60
 * ≈ 200px；两行约 400px。用 px 而不是百分比，是因为 rootMargin 的百分比是相对
 * root 尺寸算的，在超宽屏上会变成「提前一屏」，与诉求相反。
 */
export const DEFAULT_COVER_ROOT_MARGIN = "0px 0px 400px 0px";

export interface LazyCoverOptions {
  /** IntersectionObserver 的 rootMargin，默认预取视图外约两行 */
  rootMargin?: string;
  /** 是否完全禁用懒加载（首屏关键图可直接设 true） */
  eager?: boolean;
}

export function useLazyCover(options: LazyCoverOptions = {}) {
  const { rootMargin = DEFAULT_COVER_ROOT_MARGIN, eager = false } = options;

  /** 绑到卡片根元素上的模板 ref */
  const el: Ref<HTMLElement | null> = ref(null);
  /** 是否已经进入「预取范围」——为真才写 <img src> */
  const shouldLoad = ref(eager);
  /** 图片是否已真正解码完成（用于收起骨架屏） */
  const loaded = ref(false);
  /** 加载失败（用于切占位图标） */
  const failed = ref(false);

  let observer: IntersectionObserver | null = null;

  function observe(): void {
    if (shouldLoad.value) return;
    if (!el.value || typeof IntersectionObserver === "undefined") {
      // 没有 IO（极老内核 / 测试环境）：退化成直接加载，宁可多下几张也不要空白
      shouldLoad.value = true;
      return;
    }
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          shouldLoad.value = true;
          // 一旦进入就不再需要观察：图片只加载一次
          observer?.disconnect();
          observer = null;
        }
      },
      { rootMargin },
    );
    observer.observe(el.value);
  }

  onMounted(observe);
  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  function onLoad(): void {
    loaded.value = true;
  }

  function onError(): void {
    failed.value = true;
    // 失败也算「不再等」，否则骨架屏会一直闪
    loaded.value = true;
  }

  return { el, shouldLoad, loaded, failed, onLoad, onError };
}
