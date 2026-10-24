// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runViewTransition,
  supportsViewTransition,
  activeCoverAppId,
  beginCoverFlight,
  endCoverFlight,
  findCardCover,
  GAME_HERO_VT_NAME,
} from "../gameHeroTransition";

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

function installFakeTransition() {
  const calls: (() => unknown)[] = [];
  (Document.prototype as unknown as Record<string, unknown>).startViewTransition = function (
    this: Document,
    cb: () => unknown,
  ) {
    calls.push(cb);
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
    const cleanup = vi.fn(() => {
      activeCoverAppId.value = null;
    });
    activeCoverAppId.value = 42;

    await runViewTransition({ navigate, cleanup });

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
    expect(navigatedAt - started).toBeLessThan(120);
  });

  it("详情页 CSS 的过渡名与常量一致（不允许 var()）", () => {
    const file = join(process.cwd(), "src", "views", "GameDetailView.vue");
    const css = readFileSync(file, "utf8");
    const hits = css.match(/view-transition-name:\s*([^;]+);/g) ?? [];
    const heroNames = hits
      .map((line) =>
        line
          .replace(/view-transition-name:\s*/, "")
          .replace(";", "")
          .trim(),
      )
      .filter((value) => value !== "none");

    expect(heroNames).toContain(GAME_HERO_VT_NAME);
    expect(heroNames.some((value) => value.includes("var("))).toBe(false);
  });

  it("网格 DOM 脱离文档后仍能取到卡片（返回动画的前提）", () => {
    const card = document.createElement("button");
    card.dataset.smAppid = "2704110";
    const cover = document.createElement("div");
    cover.className = "card-cover";
    card.appendChild(cover);
    document.body.appendChild(card);

    beginCoverFlight(2704110, "https://example.com/header.jpg", cover);
    expect(cover.style.viewTransitionName).toBe(GAME_HERO_VT_NAME);

    card.remove();
    expect(document.querySelector('[data-sm-appid="2704110"] .card-cover')).toBeNull();

    expect(findCardCover(2704110)).toBe(cover);
    expect(findCardCover(999)).toBeNull();

    endCoverFlight();
    expect(cover.style.viewTransitionName).toBe("");
    card.remove();
  });

  it("不接受 waitFor 参数（接口已移除，传了会在类型层报错）", () => {
    const handlers = {
      navigate: () => undefined,
    } satisfies Parameters<typeof runViewTransition>[0];
    expect(handlers.navigate).toBeTypeOf("function");
  });
});
