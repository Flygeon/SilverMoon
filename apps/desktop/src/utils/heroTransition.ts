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

/**
 * 克隆层的自毁上限（ms）。
 *
 * 比 holdHeroFlight 的 900ms 更宽：正常流程是「起飞 → 路由确认 → 目标挂载 →
 * 降落动画 420ms」，全链路约 900–1200ms。留到 2000ms 是为了不在正常路径上误杀，
 * 同时保证异常路径下克隆层不会永久残留。
 */
const SELF_DESTRUCT_MS = 2000;
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

/** 兜底看门狗：飞行标记最多存活这么久，超时无条件摘掉 */
const FLYING_CLASS_TIMEOUT_MS = 1500;
let flyingWatchdog: ReturnType<typeof setTimeout> | null = null;

function markFlying(on: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(FLYING_CLASS, on);
  if (flyingWatchdog !== null) {
    clearTimeout(flyingWatchdog);
    flyingWatchdog = null;
  }
  /*
   * 看门狗存在的理由：`lm-hero-flying` 会把路由过渡压成 0 时长。
   * 一旦因为异常路径（land 抛错 / 目标组件没挂载 / 页面被卸载）导致它没被摘掉，
   * **之后所有的路由切换都会失去过渡**，而且很难联想到这里 —— 用户只会说「动画没了」。
   * 所以无论发生什么，1.5s 后必须摘掉。
   */
  if (on) {
    flyingWatchdog = setTimeout(() => {
      flyingWatchdog = null;
      document.documentElement.classList.remove(FLYING_CLASS);
    }, FLYING_CLASS_TIMEOUT_MS);
  }
}

/**
 * 读取元素**左上角**的圆角半径（px）。
 *
 * getComputedStyle().borderRadius 在四角不同时会返回 "8px 8px 0px 0px" 这种缩写，
 * 直接 parseFloat 会拿到 8 —— 对本项目够用（封面四角一致），但要在解析前把多值
 * 拆开取第一个，避免以后有人给封面加「上圆下方」时静默取错。
 */
function radiusOf(el: HTMLElement): number {
  const raw = getComputedStyle(el).borderRadius || "0px";
  const first = raw.split(/\s+/)[0] ?? "0px";
  const n = Number.parseFloat(first);
  return Number.isFinite(n) ? n : 0;
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
    clearTimeout(selfDestruct);
    clone.remove();
    srcEl.style.visibility = "";
    if (destEl) destEl.style.visibility = "";
    markFlying(false);
  };

  /*
   * 自毁定时器：无论走哪条路径（有没有被 hold / land / cancel），
   * 克隆层最多存在 SELF_DESTRUCT_MS。
   *
   * 只靠 holdHeroFlight 的超时是不够的 —— 那条只覆盖「已寄存」的情况。
   * 若因为异常路径（目标组件没挂载、onMounted 抛错、页面被直接替换）
   * 导致飞行既没被 hold 也没被 cancel，克隆层会**永久钉在屏幕上**，
   * 表现为「黑屏上贴着一个小封面」且怎么点都不消失。
   * 注意必须定义在 restore 之后：箭头函数体里引用，但要能 clearTimeout 到它。
   */
  const selfDestruct = setTimeout(() => restore(), SELF_DESTRUCT_MS);

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
      /*
       * 圆角也要一起补间。
       *
       * 克隆层继承的是**源**的圆角（卡片 20px / 迷你条 8px），而播放器封面用的是
       * `calc(min(42vw, 52vh) * 0.14)`（360px 封面对应 50px）。只补 transform 的话，
       * 克隆层被放大时圆角同比放大（20px × 放大倍数），落位瞬间再切成目标的 50px ——
       * 肉眼看到的就是「卡片一下变大/变形」，也就是「封面大小不一致」的观感来源。
       *
       * border-radius 在 transform 之后仍按元素自身坐标系计算，所以终点值要写成
       * `目标圆角 / 缩放倍数`，最终视觉上才等于目标的圆角。
       */
      const fromRadius = radiusOf(srcEl);
      const toRadius = radiusOf(dest);
      const endRadius = sx > 0 ? toRadius / sx : toRadius;
      const anim = clone.animate(
        [
          { transform: "translate(0px, 0px) scale(1, 1)", borderRadius: `${fromRadius}px` },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
            borderRadius: `${endRadius}px`,
          },
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

// ---- 声明式源标记：任何「点卡片进播放器」的入口自动获得 hero ----

/**
 * 源卡片 / 源封面的标记属性。
 *
 * 用**声明式属性 + 全局 capture 监听**而不是「每个入口自己调起飞函数」：
 * SilverMoon 里进播放器有 8 个入口（MediaGrid / TrackList / 在线歌单 / 文件夹 /
 * WebDAV / 收藏 / 历史 / 迷你条），逐个改 handler 必然漏，而且以后新增入口
 * 又会忘。属性方案只要在模板上标一次，任何点击都自动生效。
 *
 * - `data-hero-source`：可点击容器（判断「这次点击属于哪个 hero 源」）
 * - `data-hero-cover`：真正要飞的元素（封面），必须是 source 的后代
 *
 * 分两级是因为点击往往落在标题 / 播放数上，那时 `closest("[data-hero-cover]")`
 * 找不到封面（封面是兄弟节点）；只能先定位 source，再在其内部找封面。
 */
export const HERO_SOURCE_ATTR = "data-hero-source";
export const HERO_COVER_ATTR = "data-hero-cover";

/**
 * 从一次点击事件里找出源封面并起飞。
 *
 * 找不到 source / 封面 / 封面没有尺寸时返回 null（调用方按无动画处理）。
 * 这里**只管起飞**，不管导航 —— 由调用方在确认要跳转后再 `holdHeroFlight`，
 * 否则「点了卡片但播放失败、没跳转」会留下一条飞在半空的残影。
 */
/**
 * 标记「这个子区域不要触发 hero」。
 *
 * 卡片里往往还嵌着播放 / 收藏 / 菜单按钮，它们用 `@click.stop` 阻止了冒泡，
 * 但全局监听挂在 **capture** 阶段 —— 冒泡还没开始它就已经跑了，`.stop` 挡不住。
 * 若不排除，点「暂停」也会让封面飞出去，然后因为没导航、900ms 后才被超时收回，
 * 期间封面一直是隐藏的（肉眼可见的故障）。
 */
export const HERO_SKIP_ATTR = "data-hero-skip";

/**
 * 记录「这次点击对应的封面元素」，**不立即起飞**。
 *
 * 为什么不在 pointerdown 就 startHeroFlight：很多入口的点击处理是 async 的
 * （`playOnline` 要先解析播放地址、可能还带网络请求），从点击到 `router.push`
 * 有几百毫秒。若那时就起飞，源封面会立刻被隐藏、克隆层停在原地不动 ——
 * 用户看到的是「封面消失，过了半秒才飞」，比没有动画更糟。
 *
 * 真正起飞放在 router.afterEach：那时路由已确认、DOM 尚未替换，元素还在文档里，
 * 量到的 rect 与导航前完全一致。
 */
export function recordHeroSource(ev: Event): HTMLElement | null {
  const target = ev.target;
  if (!(target instanceof Element)) return null;
  // 卡片内的次级操作（播放 / 收藏 / 更多）不触发 hero
  if (target.closest("[" + HERO_SKIP_ATTR + "]")) return null;
  const source = target.closest<HTMLElement>("[" + HERO_SOURCE_ATTR + "]");
  if (!source) return null;
  return source.querySelector<HTMLElement>("[" + HERO_COVER_ATTR + "]");
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

/**
 * 飞行未降落时的兜底超时（ms）。
 *
 * 典型场景：用户点了歌卡片，起飞了，但 `playOnline` 抛错 / 版权不可播 →
 * 路由根本没跳 → 没人来 release → 克隆层永远钉在屏幕上。
 * 这里给一个略大于「点击→挂载」的窗口，超时未降落就取消。
 */
const PENDING_TIMEOUT_MS = 900;
/*
 * 用 `ReturnType<typeof setTimeout>` 而不是 number：本工具在浏览器里跑（number），
 * 但单测跑在 node 环境（Timeout 对象）。写死 number 会让测试里的 clearTimeout 类型不符，
 * 也会掩盖「这里其实是环境无关代码」这个事实。
 */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/** 起飞后寄存，等目标组件挂载时取走 */
export function holdHeroFlight(flight: HeroFlight): void {
  // 上一次没被取走（目标路由没挂载就退出了）的飞行要先收掉，否则会留下克隆层
  pendingFlight?.cancel();
  clearPendingTimer();
  pendingFlight = flight;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (pendingFlight === flight) {
      pendingFlight = null;
      flight.cancel();
    }
  }, PENDING_TIMEOUT_MS);
}

/** 取走并清空。没有待降落飞行时返回 null（调用方按无动画处理）。 */
export function releaseHeroFlight(): HeroFlight | null {
  const flight = pendingFlight;
  pendingFlight = null;
  clearPendingTimer();
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
 * 目标是否「看起来还没就位」。
 *
 * Vue 的 enter 流程会先给元素加 `-from` 类（本例是 `translateY(100%)`）、强制 reflow、
 * 下一帧才移除。所以**挂载后的头一两帧里元素可能在屏幕外**。若此时量 rect，
 * 得到的 `top` 会比视口高出一整个屏幕 —— 克隆层就会朝屏幕外飞，
 * 表现为「黑屏 + 小封面停在原地不动」。
 *
 * 判据故意放得很宽（只要和视口有任何一像素重叠就算就位），避免误伤
 * 「封面本来就该在屏幕边缘」的情况。
 */
function looksOffscreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return true;
  const vh = window.innerHeight || 0;
  const vw = window.innerWidth || 0;
  return r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw;
}

/** 最多等多少帧让目标就位（约 100ms @60fps，够 Vue 走完 enter 的类切换） */
const MAX_LAND_FRAMES = 6;

/**
 * 等目标页挂载并**真正就位**后再降落。
 *
 * nextTick 由调用方保证（视图已切换）。之后不能只死等两帧 —— 页面可能还在
 * 入场过渡里（哪怕时长是 0，Vue 也要走完「加 from 类 → reflow → 移除」的流程）。
 * 这里每帧检查一次「目标是否还在视口外」，就位即降，最多等 MAX_LAND_FRAMES 帧。
 */
export function landHeroFlight(
  flight: HeroFlight | null,
  getDest: () => HTMLElement | null | undefined,
): void {
  if (!flight) return;
  let tries = 0;
  const tick = () => {
    const dest = getDest();
    // 元素还没出现：继续等（可能是异步组件仍在挂载）
    if (!dest) {
      if (++tries > MAX_LAND_FRAMES) {
        flight.cancel();
        return;
      }
      requestAnimationFrame(tick);
      return;
    }
    // 还在屏幕外（入场动画未收敛）：继续等，别量错位置
    if (looksOffscreen(dest) && tries < MAX_LAND_FRAMES) {
      tries++;
      requestAnimationFrame(tick);
      return;
    }
    if (!flight.land(dest)) flight.cancel();
  };
  requestAnimationFrame(tick);
}
