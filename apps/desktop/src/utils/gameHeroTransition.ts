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
import { ref } from "vue";

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

/** 开始一次卡片 → 详情页的交接（网格侧调用）。 */
export function beginCoverFlight(appId: number, coverUrl: string | null): void {
  activeCoverAppId.value = appId;
  activeCoverUrl.value = coverUrl;
}

/** 结束交接（过渡结束或导航完成时调用）。 */
export function endCoverFlight(): void {
  activeCoverAppId.value = null;
  activeCoverUrl.value = null;
}

interface ViewTransitionLike {
  finished: Promise<void>;
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
  try {
    /*
     * 回调内部必须自己 try/catch：浏览器把回调包成 Promise 跑，
     * 回调里抛出的异常若没人接，会变成未处理的 Promise rejection
     * （被 main.ts 的全局处理器记成「出错了」），外面的 catch 抓不到。
     */
    const transition = doc.startViewTransition(() => {
      // 只做导航；**任何 await 都会让新快照延迟**，点击就会卡。
      const result = handlers.navigate();
      // router.push 返回 Promise，但这里不等它 —— 过渡结束由 finished 决定。
      void result;
    });
    await transition.finished;
  } catch {
    // 过渡被浏览器取消（例如同时触发另一次过渡）时 finished 会 reject，
    // 吞掉：导航已经完成，用户看到的只是「没有动画」。
  } finally {
    document.documentElement.classList.remove(RUNNING_CLASS);
    cleanup();
  }
}
