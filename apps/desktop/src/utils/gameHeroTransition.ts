/**
 * 卡片 ⇄ 详情页的 hero 飞行（View Transitions API 版）。
 *
 * 做法：给「被点的那张卡片的封面」和「详情页 hero 图」挂**同一个**
 * `view-transition-name`，交给浏览器在路由切换前后自动补间 —— 卡片会从网格位置
 * 平滑放大飞到 hero 位置，返回时反向飞回。不引入任何依赖（Chromium 111+，
 * Electron 44 原生支持）。
 *
 * ## 为什么只用**一个**固定名字
 *
 * 同一时刻文档里同一个 `view-transition-name` 只能有一个元素，否则浏览器直接
 * 忽略整次过渡（并在控制台报 duplicate）。所以这里**不给每张卡片各起一个名字**
 * （那样网格里会同时存在 N 个），而是：
 * - 网格侧：只有 `activeCoverAppId` 命中的那张卡内联挂名字，其余不挂；
 * - 详情页侧：hero 图在 CSS 里静态挂同一个名字。
 *
 * 名字值是自定义标识符（不能有空格），这里用常量 `gameHeroTransitionName`，
 * 两个页面都从本模块取，避免两边字符串写歪了静默失效。
 *
 * ## 兜底
 *
 * - `document.startViewTransition` 不存在（老 Chromium / jsdom / 浏览器预览）→ 直接跳转；
 * - 用户开了「减少动效」→ 直接跳转（不做任何补间）；
 * - 过渡自身抛错 → 忽略，导航已经发生了，不该因为动画失败而白屏。
 */
import { ref } from "vue";

/**
 * 两端共用的 `view-transition-name`。
 *
 * ⚠️ 改这个值必须同时改两处 CSS（GamesView 的内联 style 从本常量取，详情页的
 * `.hero-media` 是写死的）—— 详情页用 CSS 变量 `--sm-game-hero-vt` 承接，
 * 见 GameDetailView.vue 的 `.hero-media`。
 */
export const GAME_HERO_VT_NAME = "game-cover";

/**
 * 当前「要飞的」卡片 appId（null = 没有卡片参与过渡）。
 *
 * 模块级 ref 而不是 Pinia store：这是同一渲染进程内的瞬时交接，只活一次过渡，
 * 不值得为它引入一个 store（还会被持久化 / devtools 记录）。
 */
export const activeCoverAppId = ref<number | null>(null);

interface ViewTransitionLike {
  finished: Promise<void>;
}

type DocWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike;
};

/** 运行中的过渡标记类：把路由页的入场位移压平，避免「整页滑动」和「封面飞行」叠在一起 */
const RUNNING_CLASS = "lm-vt-running";

/** 当前环境是否支持 View Transitions */
export function supportsViewTransition(): boolean {
  return typeof (document as DocWithViewTransition).startViewTransition === "function";
}

/** 用户是否要求减少动效（查询失败时按「不减少」处理，宁可多给动效） */
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
 * 用 rAF 而不是 setTimeout：过渡的「新快照」是在下一帧布局后才拍的，
 * 用定时器等不到真正的布局完成时刻。
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
 * 等某个选择器出现，最多等 maxFrames 帧（默认约 500ms @60fps）。
 *
 * 要等的东西有两层不确定性：
 * 1. 详情页是**异步路由组件**（`() => import(...)`），首次进入要等 chunk 解析；
 * 2. hero 图要等 `gameDetail` 请求回来才有 `src` —— 在那之前模板渲染的是骨架屏
 *    （`.hero-skeleton` 而不是 `.hero-media`）。
 *
 * 所以这个等待必须**比一帧两帧宽**，但又不能无限等：等不到就退化成普通淡入
 * （浏览器会照常补间「页面淡出 → 页面淡入」，用户不会看到卡住）。
 * 30 帧 ≈ 500ms，超过这个时长说明网络慢，此时硬等只会让点击显得没反应。
 */
async function waitForSelector(selector: string, maxFrames = 30): Promise<void> {
  if (typeof document === "undefined") return;
  for (let i = 0; i < maxFrames; i++) {
    try {
      if (document.querySelector(selector)) return;
    } catch {
      // 选择器语法错误（写错逗号 / 伪类不支持）时**立刻放弃等待**，不要空转 30 帧：
      // 空转只会让点击到导航的延迟凭空变长，而过渡照样拿不到目标元素。
      return;
    }
    await nextFrame();
  }
}

export interface ViewTransitionHandlers {
  /**
   * 导航本身（DOM 更新必须发生在它被 await 完成之后）。
   *
   * 返回类型故意写 `unknown`：`router.push` 解析出来是
   * `void | NavigationFailure | undefined`，而 GoBack 的 `router.back()` 是 void。
   * 这里只关心「它跑完了没有」，不消费返回值 —— 收窄成 void 会让调用方
   * 逐个去包一层 `.then(() => {})`，纯属噪音。
   */
  navigate: () => unknown;
  /** 过渡结束（或被跳过）后回调：用来清掉 activeCoverAppId */
  cleanup?: () => void;
  /**
   * 导航后要等出现的元素选择器（可以是逗号分隔的多个）。
   *
   * 传**多个候选**的典型场景：详情页首帧是骨架屏、之后才换成真 hero ——
   * 两者都挂了同一个 view-transition-name，任意一个出现即可起飞。
   * 不传则只等两帧。
   */
  waitFor?: string;
}

/**
 * 跑一次 View Transition 包裹的导航。
 *
 * 返回的 Promise 在过渡结束（或退化路径导航完成）后解析，**不会 reject** ——
 * 动画失败不该让调用方拿到一个错误去处理，导航本身已经发生了。
 */
export async function runViewTransition(handlers: ViewTransitionHandlers): Promise<void> {
  const doc = document as DocWithViewTransition;
  const cleanup = () => {
    handlers.cleanup?.();
  };

  // 退化路径：不支持 / 要求减少动效 → 普通导航，全程不碰动画
  if (!supportsViewTransition() || prefersReducedMotion()) {
    try {
      await handlers.navigate();
    } finally {
      cleanup();
    }
    return;
  }

  /*
   * 压低页面入场过渡。
   *
   * App.vue 的路由过渡是 `mode="out-in"`：旧页先播 420ms 离场，新页才挂载。
   * 那会让「新快照」拍到一张空页面（hero 还没挂），补间自然不成立。
   * 挂上这个类后入场位移/时长归零，新页在路由确认的同一帧就落位，
   * 整段视觉由 View Transition 自己的补间承担。
   * 类必须**在起飞前**挂上（此时旧页还在，CSS 立刻生效），过渡结束再摘掉。
   */
  document.documentElement.classList.add(RUNNING_CLASS);
  try {
    const transition = doc.startViewTransition(async () => {
      await handlers.navigate();
      if (handlers.waitFor) await waitForSelector(handlers.waitFor);
      // 再等一帧，确保新元素的布局尺寸已确定（否则量与补间都按 0 算）
      await nextFrame();
    });
    await transition.finished;
  } catch {
    // 过渡被浏览器取消（例如同时触发了另一次过渡）时 finished 会 reject，
    // 这里吞掉：导航已经完成，用户看到的就是「没有动画」而不是报错。
  } finally {
    document.documentElement.classList.remove(RUNNING_CLASS);
    cleanup();
  }
}
