/**
 * 卡片 → 详情页的 hero 飞行过渡。
 *
 * 参考 Kazumi（Flutter）Hero 动画的实现语义：路由切换时在 overlay 层放一个
 * 源封面的克隆，把它从源位置/尺寸补间到目标位置/尺寸，飞行期间隐藏两端
 * 原元素防止重影。
 *
 * 上一版直接对详情页封面做 FLIP（在目标元素上 animate），受详情页入场
 * 动画（lm-rise）与挂载测量时序影响实际不生效；本版改为独立的 fixed
 * 克隆层，完全不依赖目标容器的布局与动画状态——只要能量到目标 rect
 * 就能飞，量不到就静默取消，绝不留残影。
 */

export interface HeroFlight {
  /** 降落到目标元素；目标不可测（未挂载/零尺寸）时自动取消并返回 false */
  land(destEl: HTMLElement | null | undefined): boolean;
  /** 主动取消飞行，恢复现场 */
  cancel(): void;
}

/** 飞行时长与缓动：对齐 MD3 emphasized decelerate（与页面入场动画同族） */
const HERO_DURATION_MS = 420;
const HERO_EASING = "cubic-bezier(0.05, 0.7, 0.1, 1)";

/**
 * 把元素自身及其祖先链上正在运行的 CSS 动画/过渡快进到终点帧。
 *
 * 用途：hero 降落前要量目标元素的**最终**位置，但目标页往往正在播入场动画
 * （如详情页 `.anime-info` 的 `lm-rise`：translateY + opacity）。若直接
 * `getBoundingClientRect()`，量到的是动画中途的偏移 → 克隆层落到错位置，动画结束后
 * 元素继续滑到终点 → 用户看到「先飞到 A，再突然跳到 B」。
 *
 * `getAnimations()` 默认只返回绑定在**该元素自身**上的动画（不含子树），所以这里手动
 * 沿祖先链逐级收敛；`fill: both` 的动画 `finish()` 后停在终点，因此量到的是最终布局位置。
 */
function settleEntryAnimations(el: HTMLElement): void {
  let node: HTMLElement | null = el;
  while (node && node !== document.body) {
    for (const a of node.getAnimations()) {
      try {
        a.finish();
      } catch {
        /* 无限循环 / 不可 finish 的动画会抛错，忽略 */
      }
    }
    node = node.parentElement;
  }
}

/**
 * 从源封面元素起飞：克隆一个 fixed 飞行层挂到 body 上并隐藏源元素。
 * 源元素不可用时返回 null（调用方按无动画处理）。
 */
export function startHeroFlight(srcEl: HTMLElement | null | undefined): HeroFlight | null {
  if (!srcEl?.isConnected) return null;
  const from = srcEl.getBoundingClientRect();
  if (!from.width || !from.height) return null;

  const clone = srcEl.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  // 克隆层：脱离文档流钉在源 rect 上；清掉继承的过渡/动画/变换，
  // 保证起点状态干净（卡片 hover 的 scale 等不会带进飞行层）
  clone.style.cssText += [
    "position:fixed",
    `left:${from.left}px`,
    `top:${from.top}px`,
    `width:${from.width}px`,
    `height:${from.height}px`,
    "margin:0",
    "z-index:4000",
    "pointer-events:none",
    "transition:none",
    "animation:none",
    "transform:none",
    "transform-origin:top left",
    "visibility:visible",
    "opacity:1",
    "box-shadow:var(--md-elevation-3), inset 0 0 0 1px var(--lm-hairline)",
  ].join(";");
  document.body.appendChild(clone);
  srcEl.style.visibility = "hidden";

  let settled = false;
  let destEl: HTMLElement | null = null;
  const restore = () => {
    if (settled) return;
    settled = true;
    clone.remove();
    srcEl.style.visibility = "";
    if (destEl) destEl.style.visibility = "";
  };

  return {
    land(dest) {
      if (settled) return false;
      if (!dest?.isConnected) {
        restore();
        return false;
      }
      // 目标页往往正在播入场动画（如详情页 .anime-info 的 lm-rise）：直接量会量到动画
      // 中间帧的偏移，克隆层便会「先飞到一个错位置，动画结束后再跳变」。先把目标元素
      // 祖先链上的在跑动画钉到终点帧，量到的即最终位置（一次落位到位、无跳变）。
      settleEntryAnimations(dest);
      const to = dest.getBoundingClientRect();
      if (!to.width || !to.height) {
        restore();
        return false;
      }
      destEl = dest;
      dest.style.visibility = "hidden";
      // transform 补间（合成层动画）：平移 + 按宽高比缩放。
      // 卡片与详情页封面同为 3:4，等比缩放不产生形变。
      const dx = to.left - from.left;
      const dy = to.top - from.top;
      const sx = to.width / from.width;
      const sy = to.height / from.height;
      const anim = clone.animate(
        [
          { transform: "translate(0px, 0px) scale(1, 1)" },
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        ],
        { duration: HERO_DURATION_MS, easing: HERO_EASING, fill: "forwards" },
      );
      anim.onfinish = restore;
      anim.oncancel = restore;
      return true;
    },
    cancel: restore,
  };
}

/**
 * 等详情页完成挂载与首帧布局后再降落。
 * nextTick 由调用方保证（视图已切换），这里再让出两帧：
 * 第一帧完成样式计算，第二帧拿到稳定 rect。
 */
export function landHeroFlight(
  flight: HeroFlight | null,
  getDest: () => HTMLElement | null | undefined,
): void {
  if (!flight) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!flight.land(getDest())) flight.cancel();
    }),
  );
}
