/**
 * 让组件吃满滚动容器剩下的高度。
 *
 * 不去猜「页头 + 分段条 + 内边距」一共多少像素：.main-content 的内边距是可换肤的
 * 令牌 --lm-content-pad（0~64px），底部还可能多出一条迷你播放条，写死偏移量迟早错位。
 * 所以直接量：组件顶边到滚动容器内容区底部的距离。
 *
 * 用「内容坐标」（减掉 scrollTop）而不是视口坐标——否则页面一旦出现滚动，
 * 量出来的值会随滚动变化，形成「越滚越高」的正反馈。
 *
 * 量不到滚动容器（组件被用在别处）时清空内联高度，退回 CSS 兜底值。
 */
import { nextTick, onActivated, onBeforeUnmount, onMounted, type Ref } from "vue";

export function useFillHeight(root: Ref<HTMLElement | null>, minHeight = 360) {
  let observer: ResizeObserver | null = null;

  function fit() {
    const el = root.value;
    if (!el) return;
    const scroller = el.closest(".main-content") as HTMLElement | null;
    if (!scroller) {
      el.style.height = "";
      return;
    }
    const cs = getComputedStyle(scroller);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const offsetInContent =
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      padTop +
      scroller.scrollTop;
    const available = scroller.clientHeight - padTop - padBottom - offsetInContent;
    el.style.height = Math.max(minHeight, Math.round(available)) + "px";
  }

  onMounted(() => {
    fit();
    window.addEventListener("resize", fit);
    const scroller = root.value?.closest(".main-content");
    if (scroller && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(fit);
      observer.observe(scroller);
    }
  });

  // keep-alive 复活时容器尺寸可能已经变了，补量一次
  onActivated(() => {
    void nextTick(fit);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", fit);
    observer?.disconnect();
    observer = null;
  });

  return { fit };
}
