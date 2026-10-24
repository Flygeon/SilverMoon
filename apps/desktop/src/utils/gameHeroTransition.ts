/**
 * 卡片 ⇄ 详情页的 hero 飞行（View Transitions API）。
 *
 * 做法：给「被点的那张卡片的封面」和「详情页 hero 图」挂**同一个**
 * `view-transition-name`，浏览器在路由切换前后自动补间 —— 卡片从网格位置
 * 平滑放大飞到 hero 位置，返回时反向飞回。不引入依赖（Chromium 111+）。
 *
 * ## ⚠️ 绝对不能在过渡回调里等异步数据
 *
 * 早期实现用 `waitForSelector` 轮询「hero 图出现」，最多等 30 帧（≈500ms）。
 * 结果是**点击后整个界面卡住半秒**才切页 —— 因为
 * `document.startViewTransition` 的回调**同步阻塞快照与渲染**：
 * 回调不 resolve，浏览器就不拍新快照、页面就不更新。
 *
 * 现在改为：回调里**只做同步导航**，不等任何异步资源。
 * 代价是「新快照里若 hero 还没图，就补间到空位」——但这是**瞬时**的，
 * 用户看不到卡顿；而为了动画更完整去等 500ms，得到的是实打实的卡死。
 *
 * ## hero 图必须是**卡片那张图**
 *
 * 卡片显示的是 `headerUrl`（`steam/apps/<id>/header.jpg`）。
 * 详情页若用商店的 `backgroundImage`（1920×620 大背景），
 * 两张图**内容不同**，补间时会出现明显的「换图」跳变。
 * 因此详情页 hero 优先用**同一张 header 图**，见 GameDetailView 的 `heroImage`。
 *
 * ## 为什么只用一个固定名字
 *
 * 同一时刻文档里同一个 `view-transition-name` 只能有一个元素，否则浏览器
 * 直接忽略整次过渡。所以不给每张卡各起名，而是：
 * - 网格侧：只有 `activeCoverAppId` 命中的那张卡内联挂名字；
 * - 详情页侧：hero 图静态挂同一个名字。
 *
 * ## 兜底
 *
 * - 不支持 / 用户开了「减少动效」→ 直接跳转；
 * - 过渡抛错 → 忽略（导航已发生）。
 */
import { nextTick, ref } from "vue";

import { callBridge, hasBridge } from "@/ipc/bridge";

/** 两端共用的 `view-transition-name`。 */
export const GAME_HERO_VT_NAME = "game-cover";

/**
 * 当前「要飞的」卡片 appId（null = 没有卡片参与过渡）。
 *
 * 模块级 ref 而非 Pinia store：只活一次过渡，不值得引入 store
 * （还会被持久化 / devtools 记录）。
 */
export const activeCoverAppId = ref<number | null>(null);

/**
 * 被点卡片**当前显示的那张封面 URL**。
 *
 * 为什么要额外传它：详情页的商店数据（`gameDetail`）是异步的，首帧拿不到
 * `headerImage`。若 hero 那时是空的，View Transition 会补间到**空位**，
 * 等图片加载完再「弹」出来 —— 视觉上就是「飞过去一个空框」。
 *
 * 网格把 URL 塞进来，详情页首帧就能用**同一张图**，补间从头到尾都是那张图。
 */
export const activeCoverUrl = ref<string | null>(null);

/**
 * 是否正在跑封面飞行过渡。
 *
 * App.vue 用它把路由过渡从 `mode="out-in"` 切成默认模式：
 * `out-in` 会等旧页离场**之后**才挂载新页，而 View Transition 的新快照
 * 是在回调结束时拍的 —— 那期间新页根本不在 DOM 里，快照拍不到 hero，
 * 补间就退化成淡入（还会因为等待而卡顿）。
 *
 * 切成默认模式后新旧页在切换瞬间同时存在，浏览器才能把它们拆成两层补间。
 * 这也是 View Transition 用于 SPA 路由的标准形态。
 */
export const heroTransitionActive = ref(false);

/**
 * 当前被挂上过渡名的那个 DOM（直接操作，不走响应式）。
 *
 * ## 为什么不用响应式状态挂过渡名（卡顿的根因）
 *
 * 早先用 `activeCoverAppId === game.appId` 绑定内联 style。改这个 ref 会让
 * **整个网格重新渲染** —— 库里 76 款游戏就是 76 张卡片一起 diff，
 * 点一下就能卡住几百毫秒。用户的原话是「数据量太大卡掉了」。
 *
 * 现在只在被点的那一个元素上直接写 style.viewTransitionName，
 * 与卡片数量无关，也不触发任何 Vue 更新。
 */
let flownElement: HTMLElement | null = null;

/**
 * 上一次起飞时被点的那张卡片的**元素引用**（返回时用）。
 *
 * ## 为什么不能靠 querySelector 找回来
 *
 * 返回时详情页还在，网格页被 keep-alive 缓存着 —— 但 keep-alive 的 deactivate
 * 是把整棵 DOM **移进一个脱离文档的容器**（Vue 的 storageContainer），
 * 不是留在文档里隐藏。所以 `document.querySelector("[data-sm-appid] .card-cover")`
 * 在详情页里**必然返回 null**（之前的注释写反了）。
 *
 * 拿不到元素 → 返回时新快照里没有同名元素 → 浏览器只把 hero 淡出、不会飞回卡片。
 * 这正是「进入有动画、返回没有」的成因。
 *
 * 因此这里在**离开网格时**就把元素记下来：DOM 引用本身还在（只是被搬走），
 * 给它写好过渡名后，网格被重新激活时元素带着名字回到文档，新快照就能拍到。
 */
let rememberedCard: HTMLElement | null = null;

/** 开始一次卡片 → 详情页的交接（网格侧调用）。 */
export function beginCoverFlight(
  appId: number,
  coverUrl: string | null,
  element?: HTMLElement | null,
): void {
  activeCoverAppId.value = appId;
  activeCoverUrl.value = coverUrl;
  // 先摘掉上一次的（连点两张卡时不要留下残留）
  clearFlownElement();
  if (element) {
    element.style.viewTransitionName = GAME_HERO_VT_NAME;
    flownElement = element;
    // 记下来供返回时复用（见 rememberedCard 的注释）
    rememberedCard = element;
    /*
     * 强制让浏览器**立刻**算一次样式。
     *
     * `startViewTransition` 的旧快照不是同步拍的，但它在同一个任务末尾就会拍；
     * 只要 style 已写入就一定包含在内。这里读一次布局属性纯粹是把「写入」与
     * 「浏览器可能推迟的样式计算」解耦，代价是一次可忽略的同步布局 ——
     * 换来的是「过渡名一定进了旧快照」这个确定性。
     */
    void element.offsetWidth;
    heroLog(
      "[hero] 起飞侧：connected=" +
        String(element.isConnected) +
        " name=" +
        getComputedStyle(element).viewTransitionName,
    );
  }
}

/** 摘掉过渡名（不依赖 Vue 渲染）。 */
export function clearFlownElement(): void {
  if (flownElement) {
    flownElement.style.viewTransitionName = "";
    flownElement = null;
  }
}

/**
 * 找「某张卡片的封面元素」。
 *
 * 顺序：先在文档里查（网格**正被显示**时能命中，例如详情页里直接点了另一张卡），
 * 查不到再退回 `rememberedCard`（网格被 keep-alive 搬离文档时的唯一可用引用）。
 *
 * ⚠️ 别把这里改成「只查文档」：详情页里网格是**脱离文档**的，
 * querySelector 一定返回 null，返回动画会静默退化成淡出。
 */
export function findCardCover(appId: number): HTMLElement | null {
  try {
    const hit = document.querySelector<HTMLElement>(`[data-sm-appid="${appId}"] .card-cover`);
    if (hit) return hit;
  } catch {
    // 选择器语法错误只可能是改坏了常量，继续走下面的兜底
  }
  const remembered = rememberedCard;
  if (!remembered) return null;
  // appId 对不上就说明记的是**上一张**卡：宁可没有返回动画，也不要把过渡名挂错卡片
  const owner = remembered.closest<HTMLElement>("[data-sm-appid]");
  const ownerId = Number(owner?.dataset.smAppid ?? Number.NaN);
  return Number.isFinite(ownerId) && ownerId === appId ? remembered : null;
}

/**
 * 结束交接：只清 `activeCoverAppId`（网格侧那张卡的过渡名）。
 *
 * ## 为什么**不能**同时清 `activeCoverUrl`
 *
 * 过渡结束时详情页的 `gameDetail` 很可能还没回来（网络往返 > 动画时长）。
 * 此时若把 URL 清掉，`heroImage` 立刻变空 → hero 退回占位图标 →
 * 用户看到「画面刚飞进来，图就消失了」。
 *
 * 保留它，详情页在数据到达前一直用这张图占位；下一次点击卡片时
 * `beginCoverFlight` 会覆盖成新的。URL 只是个短字符串，留着没有代价。
 */
export function endCoverFlight(): void {
  activeCoverAppId.value = null;
  clearFlownElement();
}

interface ViewTransitionLike {
  finished: Promise<void>;
  /** 伪元素建好、补间已排程；用来数「这条补间到底有没有真的跑起来」。 */
  ready?: Promise<void>;
}

type DocWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike;
};

/** 运行中的过渡标记类：压平路由页的入场位移，避免「整页滑动」和「封面飞行」叠加 */
const RUNNING_CLASS = "lm-vt-running";

/** 当前环境是否支持 View Transitions */
export function supportsViewTransition(): boolean {
  return typeof (document as DocWithViewTransition).startViewTransition === "function";
}

/** 用户是否要求减少动效 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * 等一帧（rAF）。
 *
 * 过渡的「新快照」在下一帧布局后才拍，用 setTimeout 等不到真正的布局完成时刻。
 * 失败环境（jsdom / 老浏览器无 rAF）退化成 setTimeout(0)。
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

/**
 * 把 hero 动画的诊断写进主进程日志（`main.log`，前缀 `[ui]`）。
 *
 * 为什么需要：这个动画「有没有生效」是纯渲染层的事，打包版看不到 console，
 * 上一轮只能靠改代码猜。把三个关键事实记下来 —— 是否支持、两端元素在不在、
 * 过渡有没有被取消 —— 下次出问题能直接定位，不必再猜一轮。
 *
 * 浏览器预览（无 bridge）时静默跳过；记录失败也不该影响动画。
 */
function heroLog(message: string, level: "info" | "warn" = "info"): void {
  if (!hasBridge()) return;
  try {
    void callBridge("log", { message, level }).catch(() => {});
  } catch {
    /* 日志失败不影响动画 */
  }
}

/** 详情页 hero 的候选选择器（骨架屏与真图都挂了同一个过渡名）。 */
const HERO_SELECTORS = ".hero-media, .skeleton-hero";

/**
 * 等 hero 元素出现，**命中即返回**；最多 `maxFrames` 帧。
 *
 * 返回找到的元素（找不到返回 null），调用方据此记录诊断。
 *
 * 这里必须是轮询而不是固定等待：详情页是懒加载组件 + `out-in` 路由过渡，
 * 新页面进 DOM 的时刻不确定；固定帧数要么不够（补间丢目标），要么白等。
 * 但轮询预算要**小**（12 帧 ≈ 200ms）：等的是 DOM 节点，不是网络数据。
 */
async function waitForHeroElement(selector: string, maxFrames: number): Promise<Element | null> {
  if (typeof document === "undefined") return null;
  for (let frame = 0; frame < maxFrames; frame++) {
    try {
      const hit = document.querySelector(selector);
      if (hit) return hit;
    } catch {
      return null; // 选择器语法错误：立刻放弃，不空转
    }
    await nextFrame();
  }
  return null;
}

export interface ViewTransitionHandlers {
  /** 导航本身（必须能在**同一个微任务内**完成，不能 await 网络请求） */
  navigate: () => unknown;
  /** 过渡结束（或被跳过）后回调：清掉 activeCoverAppId */
  cleanup?: () => void;
}

/**
 * 跑一次 View Transition 包裹的导航。
 *
 * 返回的 Promise 在过渡结束（或退化路径导航完成）后解析，**不会 reject**。
 *
 * ⚠️ `navigate` 里**不要**等数据：`router.push` 会立即完成 DOM 更新（目标路由
 * 组件从 chunk 加载后挂载），不需要等详情接口。把请求留在组件内部自己处理。
 */
export async function runViewTransition(handlers: ViewTransitionHandlers): Promise<void> {
  const doc = document as DocWithViewTransition;
  const cleanup = () => {
    handlers.cleanup?.();
  };

  // 退化路径：不支持 / 要求减少动效 → 普通导航，全程不碰动画
  if (!supportsViewTransition() || prefersReducedMotion()) {
    heroLog(
      `[hero] 走退化路径：supports=${supportsViewTransition()} reducedMotion=${prefersReducedMotion()}`,
      "warn",
    );
    try {
      await handlers.navigate();
    } finally {
      cleanup();
    }
    return;
  }

  /*
   * 压平入场过渡。
   *
   * App.vue 的路由过渡是 `mode="out-in"`：旧页先播离场，新页才挂载，
   * 会让「新快照」拍到空页面。挂上这个类后入场位移/时长归零，
   * 新页在路由确认的同一帧就落位。类必须在起飞前挂（此时旧页还在）。
   */
  document.documentElement.classList.add(RUNNING_CLASS);
  heroTransitionActive.value = true;
  try {
    /*
     * 回调内部必须自己 try/catch：浏览器把回调包成 Promise 跑，
     * 回调里抛出的异常若没人接，会变成未处理的 Promise rejection
     * （被 main.ts 的全局处理器记成「出错了」），外面的 catch 抓不到。
     */
    const transition = doc.startViewTransition(async () => {
      // ⚠️ **必须 await 导航**，否则浏览器立刻拍新快照，而新路由组件还没挂载 ——
      // 快照里根本没有 hero 元素，补间无从发生，动画就「不生效」（只剩淡入）。
      //
      // 这里的 await 只等「路由解析 + 组件挂载」，**不等任何网络数据**
      // （详情页自己发请求）。首次进入可能要等懒加载 chunk，之后有缓存。
      /*
       * 分段计时。
       *
       * 「点击后卡一下」这类反馈无法靠猜定位：可能是路由解析慢、懒加载 chunk 慢、
       * 等 hero 元素慢，也可能是别处。把每段耗时记进日志，一次就能看出瓶颈在哪。
       */
      const tStart = performance.now();
      await handlers.navigate();
      const tNavigate = performance.now();
      // Vue 的渲染周期（把 hero 元素写进 DOM）
      await nextTick();
      const tTick = performance.now();

      /*
       * 等 hero 元素真正进入 DOM。
       *
       * ## 为什么固定帧数不够（实测日志）
       *
       * 曾经 `await navigate()` + `nextTick()` + 固定两帧就能走，实测日志却是
       * `heroEl=null` —— 因为：
       * 1. 详情页是**异步路由组件**（`() => import(...)`），首次进入要等 chunk；
       * 2. App.vue 的路由过渡是 `mode="out-in"`：旧页离场与新页挂载跨多帧，
       *    两帧根本等不到新页。
       *
       * ## 为什么这次可以用轮询（上次不行）
       *
       * 上一版轮询 30 帧（≈500ms）等的是 `gameDetail` **网络数据**，慢网下必然久等。
       * 现在等的是「组件挂载 + 一个 DOM 节点」，正常 2-4 帧（≈60ms）就命中，
       * 上限也只有 12 帧（≈200ms）—— 用户感知不到，而换来的是补间真的发生。
       *
       * 命中即返回，不做无谓空转。
       */
      /*
       * 正常 1-2 帧就能命中；上限 3 帧 ≈50ms，纯粹兜底懒加载 chunk。
       *
       * 这里**不再**在命中后再补等一帧布局：`.hero-media` 有 `aspect-ratio: 21/9`，
       * 宽度一确定尺寸就确定，不存在「量到 0 尺寸、从原点飞」的问题；
       * 而每多等一帧，用户就多看到一帧「点下去没反应」的冻结画面。
       */
      const heroEl = await waitForHeroElement(HERO_SELECTORS, 3);
      const tHero = performance.now();
      const heroName = heroEl ? getComputedStyle(heroEl).viewTransitionName : "(无元素)";
      heroLog(
        `[hero] 起飞前：heroEl=${heroEl ? heroEl.className : "null"} name=${heroName} ` +
          `coverId=${activeCoverAppId.value} ` +
          `耗时: navigate=${(tNavigate - tStart).toFixed(0)}ms ` +
          `tick=${(tTick - tNavigate).toFixed(0)}ms ` +
          `waitHero=${(tHero - tTick).toFixed(0)}ms ` +
          `total=${(tHero - tStart).toFixed(0)}ms`,
        tHero - tStart > 400 ? "warn" : "info",
      );
    });

    /*
     * 过渡真正开始后数一次补间。
     *
     * 为什么需要：前面那条日志只能证明「hero 元素带上了名字」，
     * 证明不了「浏览器为它建了 ::view-transition-group(game-cover) 的动画」。
     * 两者之间还可能断在「同名元素在快照里出现了两次」（浏览器会直接丢弃整次过渡，
     * 不报错）—— 那正是最难靠读代码发现的一类失败。这条日志把那种情况暴露出来：
     * animations=0 就是「补间没建立」，与「动画太短看不清」区分开。
     */
    void transition.ready
      ?.then(() => {
        try {
          const pseudoOf = (animation: Animation): string =>
            (animation.effect as KeyframeEffect | null)?.pseudoElement ?? "";
          const running = document
            .getAnimations()
            .filter((a) => pseudoOf(a).includes(GAME_HERO_VT_NAME));
          const detail = running
            .map((a) => {
              const timing = a.effect?.getTiming();
              return `${pseudoOf(a) || "?"}:${Math.round(Number(timing?.duration ?? 0))}ms`;
            })
            .join(",");
          heroLog(
            `[hero] 补间已建立：animations=${running.length}${detail ? ` [${detail}]` : ""}`,
            running.length === 0 ? "warn" : "info",
          );
        } catch {
          /* 诊断失败不影响动画 */
        }
      })
      .catch(() => {
        /* 过渡被取消时 ready 会 reject：忽略 */
      });

    await transition.finished;
  } catch {
    // 过渡被浏览器取消（例如同时触发另一次过渡）时 finished 会 reject，
    // 吞掉：导航已经完成，用户看到的只是「没有动画」。
  } finally {
    document.documentElement.classList.remove(RUNNING_CLASS);
    heroTransitionActive.value = false;
    cleanup();
  }
}
