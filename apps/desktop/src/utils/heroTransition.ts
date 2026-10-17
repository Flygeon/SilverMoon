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
 *
 * ## 两种使用场景
 *
 * 1. **同组件内切 view**（AnimeOnlineView）：起飞与降落都在同一个组件里，
 *    直接用局部变量持有 flight 即可。
 * 2. **跨路由**（MiniPlayer → /music/player）：起飞的组件在导航后被 v-if
 *    销毁，降落的组件此时才挂载。中间必须寄存，见 holdHeroFlight /
 *    releaseHeroFlight —— 用模块级变量，因为这是同一渲染进程内的瞬时交接。
 *
 * 两个场景都遵守同一条顺序铁律：**先量 rect、起飞、寄存，再切路由**。
 * 反过来的话源元素已经脱离文档，rect 归零，动画起不来。
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
/**
 * 会影响 getBoundingClientRect() 的属性。
 *
 * 只有这些在跑时，量到的 rect 才是「中间态」，必须快进到终点。
 * 纯 opacity / filter / color 的动画不影响布局，**不能**碰 —— 快进它们等于
 * 把目标页的淡入直接掐掉，观感上变成「页面瞬间全亮、封面还在半空」。
 */
/*
 * ⚠️ 用**正则字面量**而不是字符串数组。
 *
 * 原因：`scripts/fetch-icon-font.mjs` 会把源码里所有「带引号的短小写字符串」
 * 当作候选图标名（图标名常以动态取值出现，它只能这样扫）。而 `transform` /
 * `width` / `height` / `margin` 恰好都是合法的 Material Symbols 图标名 ——
 * 写成字符串数组会让它白烘四个用不到的图标，并让 CI 的 `check:icon-font` 变红。
 * 正则里的这些词没有引号包裹，扫描器看不见。
 *
 * 匹配规则：keyframe 的键可能带浏览器前缀（-webkit-transform）或子属性
 * （margin-top / padding-inline），所以用「可选前缀 + 词根」的前缀匹配。
 */
const LAYOUT_PROP_RE =
  /^-?(?:webkit-|moz-|ms-)?(?:transform|translate|rotate|scale|left|top|right|bottom|width|height|margin|padding|inset|flex|grid|font|line-height|border-width)/;

/**
 * 该动画是否影响布局（判断不了就返回 true，宁可快进也不要量错位置）。
 *
 * KeyframeEffect.getKeyframes() 在 lib.dom 里挂在 KeyframeEffect 而不是
 * AnimationEffect 上，所以要先判类型 —— CSS 过渡/动画产生的都是 KeyframeEffect。
 */
function affectsLayout(a: Animation): boolean {
  try {
    const effect = a.effect;
    if (!effect || !("getKeyframes" in effect)) return true;
    const frames = (effect as KeyframeEffect).getKeyframes();
    for (const frame of frames) {
      for (const key of Object.keys(frame)) {
        const k = key.toLowerCase();
        if (LAYOUT_PROP_RE.test(k)) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function settleEntryAnimations(el: HTMLElement): void {
  let node: HTMLElement | null = el;
  while (node && node !== document.body) {
    for (const a of node.getAnimations()) {
      if (!affectsLayout(a)) continue;
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
/**
 * 飞行期间挂在 <html> 上的标记类。
 *
 * 让**页面级过渡**知道「现在有东西在飞，别再整页平移」——见 App.vue 里
 * html.lm-hero-flying 下的 .player-enter-from 规则。没有这个标记时，
 * 「整页从下滑上来」会和「封面从迷你条飞过去」叠成一条斜线。
 */
const FLYING_CLASS = "lm-hero-flying";

function markFlying(on: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(FLYING_CLASS, on);
}

export function startHeroFlight(srcEl: HTMLElement | null | undefined): HeroFlight | null {
  if (!srcEl?.isConnected) return null;
  const from = srcEl.getBoundingClientRect();
  if (!from.width || !from.height) return null;
  markFlying(true);

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
    markFlying(false);
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

// ---- 跨路由传递：起飞与降落不在同一个组件里时用这一对 ----

/**
 * 待降落的飞行。
 *
 * AnimeOnlineView 那种「同组件内切 view」的场景可以直接持有 flight 变量，
 * 但「迷你播放条 → 播放器路由」是**跨组件 + 跨路由**的：起飞的组件（MiniPlayer）
 * 在导航后被 v-if 销毁，降落的组件（PlayerView）此时才挂载。中间必须有个地方
 * 寄存它，否则飞行层要么永远停在半空，要么被 GC 前先留下残影。
 *
 * 用模块级变量而不是 sessionStorage/全局状态：这是**同一个渲染进程内的瞬时**
 * 交接，不需要持久化，也不需要跨窗口。
 */
let pendingFlight: HeroFlight | null = null;

/** 起飞后寄存，等目标组件挂载时取走 */
export function holdHeroFlight(flight: HeroFlight): void {
  // 上一次没被取走（目标路由没挂载就退出了）的飞行要先收掉，否则会留下克隆层
  pendingFlight?.cancel();
  pendingFlight = flight;
}

/** 取走并清空。没有待降落飞行时返回 null（调用方按无动画处理）。 */
export function releaseHeroFlight(): HeroFlight | null {
  const flight = pendingFlight;
  pendingFlight = null;
  return flight;
}

/**
 * 是否有待降落的飞行。
 *
 * 给「降落方要决定自己怎么出场」的场景用：迷你播放条在被 hero 降落时，
 * 自己的 slide-up 入场应当关掉（否则两条位移叠在一起）。
 */
export function hasPendingHero(): boolean {
  return pendingFlight !== null;
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
