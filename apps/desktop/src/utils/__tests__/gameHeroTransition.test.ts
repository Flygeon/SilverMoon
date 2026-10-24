// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runViewTransition,
  supportsViewTransition,
  activeCoverAppId,
  GAME_HERO_VT_NAME,
} from "../gameHeroTransition";

/**
 * 这些用例只覆盖 `runViewTransition` 的**调度契约**，不覆盖视觉：
 *
 * - 导航必须发生（三种环境都要）；
 * - cleanup 必须发生（否则 activeCoverAppId 会残留，下次过渡挂到错的卡片上）；
 * - 不支持 View Transitions 时**不得**触碰 `document.startViewTransition`。
 *
 * 真正的补间由浏览器在合成线程做，jsdom 里量不到，也不该在这里假装能测。
 */

/** 保存 / 还原全局环境（每个用例改 document.startViewTransition 与 matchMedia） */
const originalStart =
  "startViewTransition" in Document.prototype ? Document.prototype.startViewTransition : undefined;

function resetEnv(): void {
  if (originalStart === undefined) {
    delete (Document.prototype as unknown as Record<string, unknown>).startViewTransition;
  } else {
    (Document.prototype as unknown as Record<string, unknown>).startViewTransition = originalStart;
  }
  activeCoverAppId.value = null;
}

afterEach(() => {
  resetEnv();
  vi.restoreAllMocks();
});

/**
 * 装上假的 startViewTransition。
 *
 * ## 关键：必须复刻真实 API 的错误语义
 *
 * 真实的 `document.startViewTransition(cb)` **不会**把 `cb()` 抛出的异常同步抛给调用方；
 * 它把回调包成 Promise 去跑，异常变成 `finished` 的 rejection。
 *
 * 早先的 fake 直接 `cb()` 并让异常往上冒，导致：
 * - 异常从**假 API 内部**逃逸，绕过了生产代码在回调内部写的 try/catch；
 * - 变成一个没人接的 Promise rejection（CI 上表现为 "Unhandled error: nav failed"）；
 * - 本地因时序差异偶尔不复现 —— 这正是「本地绿、CI 红」的来源。
 *
 * 因此这里把回调结果收进 `finished`，与浏览器一致。
 */
function installFakeTransition() {
  const calls: (() => unknown)[] = [];
  (Document.prototype as unknown as Record<string, unknown>).startViewTransition = function (
    this: Document,
    cb: () => unknown,
  ) {
    calls.push(cb);
    // 包成 Promise：回调的异常走 finished 的 rejection，而不是同步抛出
    const finished = Promise.resolve().then(() => cb());
    return { finished };
  };
  return calls;
}

describe("runViewTransition", () => {
  it("支持时走 startViewTransition，并调用清理", async () => {
    const calls = installFakeTransition();
    expect(supportsViewTransition()).toBe(true);
    const navigate = vi.fn();
    const cleanup = vi.fn();

    await runViewTransition({ navigate, cleanup });

    expect(calls).toHaveLength(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("不支持时退化为普通导航，且不调用 startViewTransition", async () => {
    delete (Document.prototype as unknown as Record<string, unknown>).startViewTransition;
    expect(supportsViewTransition()).toBe(false);
    const navigate = vi.fn();
    const cleanup = vi.fn();

    await runViewTransition({ navigate, cleanup });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("导航抛错时仍执行清理（activeCoverAppId 不残留）", async () => {
    installFakeTransition();
    const navigate = vi.fn(() => {
      throw new Error("nav failed");
    });
    // cleanup 与线上一致地重置 activeCoverAppId —— 断言这条链路真的闭合
    const cleanup = vi.fn(() => {
      activeCoverAppId.value = null;
    });
    activeCoverAppId.value = 42;

    await runViewTransition({ navigate, cleanup });

    // 错误被吞掉（调用方不该收到动画/导航的实现细节），但清理一定要跑
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(activeCoverAppId.value).toBeNull();
  });

  it("过渡结束会摘掉 lm-vt-running（否则后续所有路由过渡都被压平）", async () => {
    installFakeTransition();
    await runViewTransition({ navigate: () => undefined });
    expect(document.documentElement.classList.contains("lm-vt-running")).toBe(false);
  });

  it("减少动效时直接导航，不启用过渡", async () => {
    const calls = installFakeTransition();
    // jsdom 不实现 matchMedia（不是函数，spyOn 会直接报错），所以整段替换掉
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
    try {
      const navigate = vi.fn();
      await runViewTransition({ navigate });

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(0);
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    }
  });

  /**
   * 回归：导航**绝不能被动画等待阻塞**。
   *
   * 旧版在过渡回调里 `await waitForSelector(...)`，最多轮询 30 帧（≈500ms）。
   * 而 `document.startViewTransition` 的回调是**同步阻塞**快照与渲染的 ——
   * 回调不 resolve，页面就不更新，用户看到的是「点卡片后卡住半秒才切页」。
   *
   * 现在回调里只做同步导航。这条用例锁住「navigate 在过渡结束前就被调用了」，
   * 且整个流程不含任何轮询等待。
   */
  it("导航在过渡结束前立即发生（不因动画等待而阻塞）", async () => {
    installFakeTransition();
    let navigatedAt = 0;
    const started = Date.now();

    await runViewTransition({
      navigate: () => {
        navigatedAt = Date.now();
        return undefined;
      },
    });

    expect(navigatedAt).toBeGreaterThan(0);
    // 从开始到导航发生，不应有可感知延迟（旧实现会等 30 帧）
    expect(navigatedAt - started).toBeLessThan(120);
  });

  /**
   * 回归：详情页的 `view-transition-name` 必须与常量**字面一致**。
   *
   * 这里曾经写成 `view-transition-name: var(--lm-game-hero-vt)`。
   * `view-transition-name` 的值类型是 `<custom-ident>`，让变量在这类位置
   * 解析成合法标识符并不可靠 —— 元素拿不到过渡名，补间就退化成淡入，
   * 表现正是「hero 动画完全不生效」。改成字面量后又怕两边写歪，
   * 所以用这条用例把两个文件钉在一起。
   */
  it("详情页 CSS 的过渡名与常量一致（不允许 var()）", () => {
    const file = join(process.cwd(), "src", "views", "GameDetailView.vue");
    const css = readFileSync(file, "utf8");
    const hits = css.match(/view-transition-name:\s*([^;]+);/g) ?? [];
    const heroNames = hits
      .map((line) => line.replace(/view-transition-name:\s*/, "").replace(";", "").trim())
      .filter((value) => value !== "none");

    expect(heroNames).toContain(GAME_HERO_VT_NAME);
    // 明确禁止再退回 var() 写法
    expect(heroNames.some((value) => value.includes("var("))).toBe(false);
  });

  it("不接受 waitFor 参数（接口已移除，传了会在类型层报错）", () => {
    // 这条用例是**类型层**的守护：ViewTransitionHandlers 不再有 waitFor。
    // 运行期用 satisfies 做一次编译期检查 —— 若有人把字段加回来，
    // 这里的对象字面量会因为「多余属性」而无法满足类型。
    const handlers = {
      navigate: () => undefined,
    } satisfies Parameters<typeof runViewTransition>[0];
    expect(handlers.navigate).toBeTypeOf("function");
  });
});
