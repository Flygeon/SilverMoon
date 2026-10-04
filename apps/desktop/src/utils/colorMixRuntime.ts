/**
 * 运行期 `color-mix()` 回退（Chromium < 111 / Electron 22）。
 *
 * ## 与构建期插件的分工
 *
 * | 来源 | 处理方式 |
 * |---|---|
 * | 项目自己的 `.vue` / `.css` | **构建期**已改写成 `var(--sm-mix-X-p, rgba(...))` |
 * | `@m3e/web` 的 CSS-in-JS | **运行期**补 `CSSStyleSheet.replaceSync`，在注入前改写 |
 * | 动态 token（种子色 / 皮肤 / 深浅色） | **运行期**重算 `--sm-mix-*` 写到 `:root` |
 *
 * ## 为什么 m3e 必须在运行期处理
 *
 * `@m3e/web` 把样式以 JS 字符串内联在组件类里（实测 94 处 `color-mix`，全部形如
 * `color-mix(in srgb, C p%, transparent)`），在**组件首次渲染时**才通过
 * `new CSSStyleSheet().replaceSync(cssText)` 注入。构建期拿不到这些字符串；
 * 而 `replaceSync` 正好是最干净的拦截点 —— 注入前把 color-mix 换成 rgba 即可。
 *
 * 实测确认 m3e 的样式表是**惰性创建**的（`styleSheet` getter 里才 new），
 * 因此只要在 Vue 挂载前装好补丁，就能覆盖全部组件。
 *
 * ## 为什么还要重算 `--sm-mix-*`
 *
 * 构建期的兜底值是**浅色主题的静态快照**，但运行时会改 token：深色模式、
 * 种子色（`applySeedColor`）、皮肤（`applySkin`）都会覆盖 `--md-sys-color-*`。
 * 不重算的话深色下会用浅色算出的半透明色，明显发灰。这里从 `getComputedStyle`
 * 读当前真实值重算，并在主题变化时重新同步。
 */
import {
  extractColorMixCalls,
  formatRgba,
  parseConcreteColor,
  parseColorMixCall,
  parseVarOperand,
  resolveColorMix,
  type Rgba,
} from "./colorMixMath";
import { COLOR_MIX_PAIRS } from "virtual:sm-colormix-pairs";

/** 已改写过的样式表（library 可能复用同一实例）。 */
const PATCHED = new WeakSet<CSSStyleSheet>();

/** 补丁是否已装。 */
let installed = false;

/** 上次同步写入的「变量名 → 值」，用于两件事：
 *  1. 主题切换时清理已不再需要的派生变量；
 *  2. **避免自触发死循环** —— 同步会写 documentElement 的 style 属性，
 *     而 MutationObserver 正在监听该属性。只在值真的变化时才写，循环就会收敛。 */
const lastWritten = new Map<string, string>();

/** 宿主是否支持 `color-mix()`（Chromium 111+）。 */
export function supportsColorMix(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  try {
    return CSS.supports("color", "color-mix(in srgb, red, blue)");
  } catch {
    return false;
  }
}

/** 把一条 CSS 值解析成 Rgba（支持 `var(--x, fallback)`）。 */
function resolveTokenValue(value: string, readToken: (name: string) => Rgba | null): Rgba | null {
  const v = parseVarOperand(value);
  if (v) {
    const direct = readToken(v.name);
    if (direct) return direct;
    return v.fallback ? parseConcreteColor(v.fallback) : null;
  }
  return parseConcreteColor(value);
}

/**
 * 把一段 CSS 文本里所有可换算的 `color-mix(...)` 换成具体 `rgba()`。
 *
 * 无法换算的（非 srgb、操作数解析不出）**保持原样** —— 交给浏览器按原有语义处理，
 * 不会比现状更差。
 */
export function rewriteColorMix(cssText: string, readToken: (name: string) => Rgba | null): string {
  if (!cssText.includes("color-mix")) return cssText;
  let out = cssText;
  for (const call of extractColorMixCalls(cssText)) {
    const parsed = parseColorMixCall(call.full);
    if (!parsed) continue;
    const resolved = resolveColorMix(parsed, (name, fallback) => {
      const direct = readToken(name);
      if (direct) return direct;
      return fallback ? parseConcreteColor(fallback) : null;
    });
    if (!resolved) continue;
    out = out.split(call.full).join(formatRgba(resolved));
  }
  return out;
}

/** 基于某元素的当前计算样式构造 token 读取器（带缓存）。 */
function tokenReaderFor(el: Element): (name: string) => Rgba | null {
  const cache = new Map<string, Rgba | null>();
  const style = getComputedStyle(el);
  return (name: string) => {
    if (cache.has(name)) return cache.get(name) ?? null;
    const raw = style.getPropertyValue(name).trim();
    const parsed = raw ? parseConcreteColor(raw) : null;
    cache.set(name, parsed);
    return parsed;
  };
}

/**
 * 依据当前 token 值，为 `:root` 重算整套 `--sm-mix-*`。
 *
 * 变量名与百分数来自构建期插件（经 `virtual:sm-colormix-pairs`），
 * 因此这里不需要维护第二份清单。
 */
export function syncDerivedRootVars(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const readToken = tokenReaderFor(root);

  /** 本轮期望写入的 变量名 → 值。 */
  const desired = new Map<string, string>();
  for (const pair of COLOR_MIX_PAIRS) {
    const base = readToken(pair.token);
    if (!base) continue;
    for (const percent of pair.percents) {
      const name = "--sm-mix-" + pair.name + "-" + String(percent).replace(/\./g, "_");
      desired.set(name, formatRgba({ ...base, a: clamp01(base.a * (percent / 100)) }));
    }
  }

  // ⚠️ 只在**值真的变化**时才动 style 属性。
  //
  // 本函数由 MutationObserver(documentElement, {attributes:[...,'style']}) 触发，
  // 而它自己也会写 style —— 无条件写会形成「写 → 观察 → 再写」的**死循环**，
  // 实测表现为页面永远加载不完（renderer 卡死）。
  // 只在有差异时写，第二次回调算出的 desired 与 lastWritten 相同 → 不再写 → 收敛。
  let mutated = false;
  for (const [name, value] of desired) {
    if (lastWritten.get(name) === value) continue;
    root.style.setProperty(name, value);
    mutated = true;
  }
  // 清理上一轮写过、本轮不再需要的（皮肤切换后 token 名可能变）
  for (const name of lastWritten.keys()) {
    if (!desired.has(name)) {
      root.style.removeProperty(name);
      mutated = true;
    }
  }
  if (!mutated) return;

  lastWritten.clear();
  for (const [k, v] of desired) lastWritten.set(k, v);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * 给 `CSSStyleSheet.prototype.replaceSync` 打补丁：库样式表注入前完成改写。
 *
 * 用 `getComputedStyle(document.documentElement)` 作为 token 来源 —— 库样式表里
 * 的 `var(--m3e-*, fallback)` 最终都指向 `--md-sys-color-*`，在根上读到的就是
 * 当前主题的真实值。
 */
function patchConstructableStyleSheets(): void {
  if (typeof CSSStyleSheet === "undefined") return;
  const proto = CSSStyleSheet.prototype;
  const original = proto.replaceSync;
  if (typeof original !== "function") return;

  proto.replaceSync = function patchedReplaceSync(this: CSSStyleSheet, text: string): void {
    if (PATCHED.has(this)) return original.call(this, text);
    PATCHED.add(this);
    try {
      const readToken = tokenReaderFor(document.documentElement);
      return original.call(this, rewriteColorMix(String(text), readToken));
    } catch {
      // 改写自身出错绝不能阻断样式注入 —— 原样交给浏览器
      return original.call(this, text);
    }
  };
}

/**
 * 安装运行期回退。幂等；应在 Vue 挂载**之前**调用。
 *
 * 返回是否真正启用了回退（不支持 color-mix 时为 true）。
 */
export function installColorMixFallback(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (supportsColorMix()) return false;
  if (installed) return true;
  installed = true;

  patchConstructableStyleSheets();

  const sync = (): void => syncDerivedRootVars();
  sync();

  // 主题变化后重算：
  // - data-theme / class 变化（深色切换）
  // - 内联样式变化（applySeedColor / applySkin 直接 setProperty 到 root）
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });

  // 首帧后补一次：首屏渲染可能早于样式表就绪
  requestAnimationFrame(sync);

  return true;
}

// ---------------------------------------------------------------------------
// 元素级同步（组件自定义 token）
// ---------------------------------------------------------------------------

/**
 * 为一个**元素**（而非 `:root`）同步派生变量。
 *
 * 用于组件自己定义的 token —— 典型是阅读器的 `--reader-fg` / `--reader-bg`：
 * 它们由 `BookReader.vue` 通过 `:style` 写在组件根节点上，**根节点读不到**，
 * 因此 `syncDerivedRootVars` 覆盖不到。组件在主题/设置变化后调用本函数即可。
 *
 * `tokens` 形如 `{ "--reader-fg": [9, 10, 12, ...] }`（value 为该 token 用到的
 * 百分数列表，与构建期插件收集的一致）。
 *
 * 不支持的宿主下直接 no-op（现代版 CSS 原生就能算对）。
 */
export function syncDerivedVarsForElement(
  el: HTMLElement | null | undefined,
  tokens: Record<string, number[]>,
): void {
  if (!el || typeof getComputedStyle !== "function") return;
  if (supportsColorMix()) return;

  const readToken = tokenReaderFor(el);
  for (const [token, percents] of Object.entries(tokens)) {
    const base = readToken(token);
    if (!base) continue;
    const name = token.replace(/^--/, "");
    for (const percent of percents) {
      el.style.setProperty(
        `--sm-mix-${name}-${String(percent).replace(/\./g, "_")}`,
        formatRgba({ ...base, a: clamp01(base.a * (percent / 100)) }),
      );
    }
  }
}

/**
 * 把 `currentColor` 形态的派生变量按给定颜色写入元素。
 *
 * `color-mix(in srgb, currentColor p%, transparent)` 里的 currentColor 取决于
 * **元素自身**的 `color`，根节点推不出来，只能由组件按自己的上下文显式给定。
 *
 * `NovelReader.vue` 就是这种情形：它的 7 处混色都基于当前阅读主题的前景色。
 */
export function syncCurrentColorVars(
  el: HTMLElement | null | undefined,
  color: string,
  percents: number[],
): void {
  if (!el) return;
  if (supportsColorMix()) return;

  const base = parseConcreteColor(color);
  if (!base) return;
  for (const percent of percents) {
    el.style.setProperty(
      `--sm-mix-currentColor-${String(percent).replace(/\./g, "_")}`,
      formatRgba({ ...base, a: clamp01(base.a * (percent / 100)) }),
    );
  }
}

/**
 * 本项目里 `currentColor` 混色用到的百分数。
 *
 * 与构建期插件收集的一致（见 `virtual:sm-colormix-pairs` 的
 * `COLOR_MIX_CURRENT_COLOR_PERCENTS`）。这里硬编码一份是因为：
 * 该清单只在 `SM_COLORMIX_FALLBACK=1` 的构建里有值，而组件代码两个构建共用，
 * 不能依赖构建期环境变量。
 */
export const CURRENT_COLOR_PERCENTS: readonly number[] = [6, 8, 10, 12, 16];

/** 测试用：重置安装标记。 */
export function __resetColorMixFallbackForTest(): void {
  installed = false;
  lastWritten.clear();
}
