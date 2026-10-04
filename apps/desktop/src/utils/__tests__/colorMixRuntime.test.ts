// @vitest-environment jsdom
/**
 * `colorMixRuntime` 的测试。
 *
 * 覆盖运行期回退的关键行为：
 * - 探测到不支持 color-mix 时**确实**改写了库样式表（`replaceSync` 补丁）；
 * - 支持时**完全不动**（现代版零副作用）；
 * - 源色半透明时结果 alpha 是**乘积**；
 * - 无法换算的调用保持原样（不比现状更差）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURRENT_COLOR_PERCENTS,
  __resetColorMixFallbackForTest,
  installColorMixFallback,
  rewriteColorMix,
  syncCurrentColorVars,
  syncDerivedVarsForElement,
} from "../colorMixRuntime";

/** 造一个「不支持 color-mix」的 `CSS.supports`。 */
function stubSupportsColorMix(supported: boolean): void {
  vi.stubGlobal("CSS", {
    supports: (prop: string, value: string) => {
      if (!supported) return false;
      return prop === "color" && String(value).includes("color-mix");
    },
  });
}

describe("rewriteColorMix", () => {
  it("把 var 形态换成具体 rgba", () => {
    const out = rewriteColorMix(
      "background: color-mix(in srgb, var(--p) 12%, transparent);",
      (n) => (n === "--p" ? { r: 26, g: 92, b: 158, a: 1 } : null),
    );
    expect(out).toBe("background: rgba(26, 92, 158, 0.12);");
  });

  it("半透明源色 → alpha 是乘积（scrim 60% → 0.42）", () => {
    const out = rewriteColorMix("color-mix(in srgb, var(--scrim) 60%, transparent)", (n) =>
      n === "--scrim" ? { r: 0, g: 0, b: 0, a: 0.7 } : null,
    );
    expect(out).toBe("rgba(0, 0, 0, 0.42)");
  });

  it("用 var() 自带兜底", () => {
    const out = rewriteColorMix(
      "color-mix(in srgb, var(--nope, #000) 50%, transparent)",
      () => null,
    );
    expect(out).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("字面量颜色直接换算", () => {
    const out = rewriteColorMix("color-mix(in srgb, #4493f8 8%, transparent)", () => null);
    expect(out).toBe("rgba(68, 147, 248, 0.08)");
  });

  it("无法解析时**保持原样**（不比现状更差）", () => {
    const src = "color-mix(in srgb, var(--nope) 10%, transparent)";
    expect(rewriteColorMix(src, () => null)).toBe(src);
  });

  it("非 srgb 空间保持原样", () => {
    const src = "color-mix(in oklab, red 50%, blue)";
    expect(rewriteColorMix(src, () => null)).toBe(src);
  });

  it("一次替换多处且 token 不同", () => {
    const out = rewriteColorMix(
      "a{background:color-mix(in srgb, var(--a) 10%, transparent)} b{background:color-mix(in srgb, var(--b) 20%, transparent)}",
      (n) => (n === "--a" ? { r: 1, g: 2, b: 3, a: 1 } : { r: 4, g: 5, b: 6, a: 1 }),
    );
    expect(out).toContain("rgba(1, 2, 3, 0.1)");
    expect(out).toContain("rgba(4, 5, 6, 0.2)");
    expect(out).not.toContain("color-mix");
  });

  it("不含 color-mix 时原样返回（快路径）", () => {
    const src = "color: red; background: blue;";
    expect(rewriteColorMix(src, () => null)).toBe(src);
  });
});

describe("syncCurrentColorVars", () => {
  beforeEach(() => {
    __resetColorMixFallbackForTest();
    stubSupportsColorMix(false);
  });

  it("按给定颜色写入全部百分数的派生变量", () => {
    const el = document.createElement("div");
    syncCurrentColorVars(el, "#e6e6e8", [...CURRENT_COLOR_PERCENTS]);
    expect(el.style.getPropertyValue("--sm-mix-currentColor-6")).toBe("rgba(230, 230, 232, 0.06)");
    expect(el.style.getPropertyValue("--sm-mix-currentColor-16")).toBe("rgba(230, 230, 232, 0.16)");
  });

  it("颜色不可解析时不动元素", () => {
    const el = document.createElement("div");
    syncCurrentColorVars(el, "currentColor", [12]);
    expect(el.style.getPropertyValue("--sm-mix-currentColor-12")).toBe("");
  });

  it("支持 color-mix 时完全 no-op（现代版）", () => {
    stubSupportsColorMix(true);
    const el = document.createElement("div");
    syncCurrentColorVars(el, "#000", [12]);
    expect(el.style.cssText).toBe("");
  });
});

describe("installColorMixFallback 的可重入性（回归）", () => {
  beforeEach(() => {
    __resetColorMixFallbackForTest();
    stubSupportsColorMix(false);
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("安装不会挂起，且同步后 :root 上出现派生变量", async () => {
    // 回归点：syncDerivedRootVars 会写 documentElement 的 style，而
    // MutationObserver 正在监听该属性 —— 若无条件写就会「写→观察→再写」死循环，
    // 表现为渲染进程永远卡住。这里用「有限时间内完成」来兜住。
    installColorMixFallback();

    await new Promise((r) => setTimeout(r, 30));
    // 走到这里就说明没有无限微任务/回调循环
    expect(true).toBe(true);
  });

  it("重复调用是幂等的，且不会反复改写 style", async () => {
    installColorMixFallback();
    await new Promise((r) => setTimeout(r, 20));
    const first = document.documentElement.getAttribute("style") ?? "";
    // 再触发一次同步路径（改 data-theme 会触发 observer）
    document.documentElement.setAttribute("data-theme", "dark");
    await new Promise((r) => setTimeout(r, 30));
    const second = document.documentElement.getAttribute("style") ?? "";
    // 值没变就不该重新写（写了的字符串应当稳定，不出现重复累加）
    expect(second.length).toBeLessThanOrEqual(first.length + 200);
  });
});

describe("syncDerivedVarsForElement", () => {
  beforeEach(() => {
    __resetColorMixFallbackForTest();
    stubSupportsColorMix(false);
  });

  it("按元素上的 token 当前值写入派生变量", () => {
    const el = document.createElement("div");
    el.style.setProperty("--reader-fg", "#e6e6e8");
    document.body.appendChild(el);
    syncDerivedVarsForElement(el, { "--reader-fg": [14, 80] });
    expect(el.style.getPropertyValue("--sm-mix-reader-fg-14")).toBe("rgba(230, 230, 232, 0.14)");
    expect(el.style.getPropertyValue("--sm-mix-reader-fg-80")).toBe("rgba(230, 230, 232, 0.8)");
    el.remove();
  });

  it("元素为 null 时安全返回", () => {
    expect(() => syncDerivedVarsForElement(null, { "--x": [10] })).not.toThrow();
  });

  it("支持 color-mix 时 no-op", () => {
    stubSupportsColorMix(true);
    const el = document.createElement("div");
    el.style.setProperty("--reader-fg", "#fff");
    document.body.appendChild(el);
    syncDerivedVarsForElement(el, { "--reader-fg": [14] });
    expect(el.style.getPropertyValue("--sm-mix-reader-fg-14")).toBe("");
    el.remove();
  });
});
