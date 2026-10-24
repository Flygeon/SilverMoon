import { afterEach, describe, expect, it, vi } from "vitest";
import { runViewTransition, supportsViewTransition, activeCoverAppId } from "../gameHeroTransition";

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
const originalStart = "startViewTransition" in Document.prototype
  ? Document.prototype.startViewTransition
  : undefined;

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

/** 装上假的 startViewTransition：立刻执行回调，finished 立即 resolve */
function installFakeTransition() {
  const calls: (() => unknown)[] = [];
  (Document.prototype as unknown as Record<string, unknown>).startViewTransition = function (
    this: Document,
    cb: () => unknown,
  ) {
    calls.push(cb);
    const result = cb();
    if (result instanceof Promise) void result;
    return { finished: Promise.resolve() };
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
    const cleanup = vi.fn();
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
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList);
    const navigate = vi.fn();

    await runViewTransition({ navigate });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("waitFor 命中的元素出现后不空转（立刻返回）", async () => {
    installFakeTransition();
    // .hero-media 已存在（用例里手工造一个），等待应当在这一帧就结束
    const el = document.createElement("div");
    el.className = "hero-media";
    document.body.appendChild(el);

    const started = Date.now();
    await runViewTransition({ navigate: () => undefined, waitFor: ".hero-media" });
    // 只等一帧，远小于 30 帧（500ms）；放宽到 300ms 避免慢机误判
    expect(Date.now() - started).toBeLessThan(300);

    el.remove();
  });
});
