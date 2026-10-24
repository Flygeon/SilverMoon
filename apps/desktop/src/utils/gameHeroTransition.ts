import { nextTick, ref } from "vue";

import { callBridge, hasBridge } from "@/ipc/bridge";

export const GAME_HERO_VT_NAME = "game-cover";

export const activeCoverAppId = ref<number | null>(null);

export const activeCoverUrl = ref<string | null>(null);

export const heroTransitionActive = ref(false);

let flownElement: HTMLElement | null = null;

let rememberedCard: HTMLElement | null = null;

export function beginCoverFlight(
  appId: number,
  coverUrl: string | null,
  element?: HTMLElement | null,
): void {
  activeCoverAppId.value = appId;
  activeCoverUrl.value = coverUrl;
  clearFlownElement();
  if (element) {
    element.style.viewTransitionName = GAME_HERO_VT_NAME;
    flownElement = element;
    rememberedCard = element;
    void element.offsetWidth;
    heroLog(
      "[hero] 起飞侧：connected=" +
        String(element.isConnected) +
        " name=" +
        getComputedStyle(element).viewTransitionName,
    );
  }
}

export function clearFlownElement(): void {
  if (flownElement) {
    flownElement.style.viewTransitionName = "";
    flownElement = null;
  }
}

export function findCardCover(appId: number): HTMLElement | null {
  try {
    const hit = document.querySelector<HTMLElement>(`[data-sm-appid="${appId}"] .card-cover`);
    if (hit) return hit;
  } catch {
    /* 忽略 */
  }
  const remembered = rememberedCard;
  if (!remembered) return null;
  const owner = remembered.closest<HTMLElement>("[data-sm-appid]");
  const ownerId = Number(owner?.dataset.smAppid ?? Number.NaN);
  return Number.isFinite(ownerId) && ownerId === appId ? remembered : null;
}

export function endCoverFlight(): void {
  activeCoverAppId.value = null;
  clearFlownElement();
}

interface ViewTransitionLike {
  finished: Promise<void>;
  ready?: Promise<void>;
}

type DocWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike;
};

const RUNNING_CLASS = "lm-vt-running";

export function supportsViewTransition(): boolean {
  return typeof (document as DocWithViewTransition).startViewTransition === "function";
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

function heroLog(message: string, level: "info" | "warn" = "info"): void {
  if (!hasBridge()) return;
  try {
    void callBridge("log", { message, level }).catch(() => {});
  } catch {
    /* 忽略 */
  }
}

const HERO_SELECTORS = ".hero-media, .skeleton-hero";

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
  navigate: () => unknown;
  cleanup?: () => void;
}

export async function runViewTransition(handlers: ViewTransitionHandlers): Promise<void> {
  const doc = document as DocWithViewTransition;
  const cleanup = () => {
    handlers.cleanup?.();
  };

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

  document.documentElement.classList.add(RUNNING_CLASS);
  heroTransitionActive.value = true;
  try {
    const transition = doc.startViewTransition(async () => {
      const tStart = performance.now();
      await handlers.navigate();
      const tNavigate = performance.now();
      await nextTick();
      const tTick = performance.now();

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
          /* 忽略 */
        }
      })
      .catch(() => {});

    await transition.finished;
  } catch {
    /* 忽略 */
  } finally {
    document.documentElement.classList.remove(RUNNING_CLASS);
    heroTransitionActive.value = false;
    cleanup();
  }
}
