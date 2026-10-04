/**
 * 构建期插件 与 运行期实现 的**一致性**测试。
 *
 * ## 为什么必须有这个测试
 *
 * color-mix 的换算有两份独立实现：
 * - `scripts/vite-plugin-colormix-fallback.mjs`（构建期，改写项目 CSS，纯 JS）
 * - `src/utils/colorMixMath.ts`（运行期，改写 @m3e/web 的 CSS-in-JS，TS）
 *
 * 两份实现算出的 rgba 必须**逐字一致**，否则浅色兜底与运行期重算会给出不同颜色，
 * 表现为「主题切换瞬间颜色跳一下」，且极难定位。
 *
 * 这里对整个 `src/` 目录跑一遍：
 * 1. 用插件的 `derivedVarName` 与运行期的变量名规则对齐；
 * 2. 用同一条 color-mix 分别经两份实现换算，断言输出相同。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractColorMixCalls,
  formatRgba,
  parseColorMixCall,
  parseConcreteColor,
  resolveColorMix,
} from "../colorMixMath";

// 构建期插件是 .mjs，直接 import 它的真实实现（不是复刻）
import {
  colorMixFallback,
  derivedVarName,
} from "../../../scripts/vite-plugin-colormix-fallback.mjs";

const ROOT = path.resolve(__dirname, "../../..");

/** 递归收集 src 下的 .vue / .css。 */
function collectStyleFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) collectStyleFiles(p, out);
    else if (/\.(vue|css)$/.test(entry)) out.push(p);
  }
  return out;
}

/** 从 theme.css 的 `:root` 块解析浅色 token。 */
function lightTokens(): Map<string, string> {
  const css = readFileSync(path.join(ROOT, "src/tokens/theme.css"), "utf8");
  const start = css.indexOf(":root {");
  let depth = 0;
  let end = css.length;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const out = new Map<string, string>();
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css.slice(start, end)))) out.set(m[1], m[2].trim());
  return out;
}

describe("构建期与运行期换算一致性", () => {
  const files = collectStyleFiles(path.join(ROOT, "src"));
  const tokens = lightTokens();

  /** 项目里实际出现的全部 (调用原文, token 值) 组合。 */
  const cases: Array<{ call: string; resolved: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { full } of extractColorMixCalls(text)) {
      const parsed = parseColorMixCall(full);
      if (!parsed?.isSrgb) continue;
      const resolved = resolveColorMix(parsed, (name, fallback) => {
        const raw = tokens.get(name) ?? fallback;
        return raw ? parseConcreteColor(raw) : null;
      });
      // 只有双方都能解析的才比对（组件级 token 两边都解析不出，走 transparent 兜底）
      if (resolved) cases.push({ call: full, resolved: formatRgba(resolved) });
    }
  }

  it("在 src/ 里确实扫到了 color-mix 用法（防止测试空跑）", () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it("每个用例的换算结果与构建期插件一致", () => {
    // 用插件的**真实 transform**（不是复刻）：把一条 color-mix 交给它，
    // 从产出的 `var(--sm-mix-…, rgba(...))` 里抠出兜底值来比对。
    const plugin = colorMixFallback({ enabled: true, root: ROOT });
    plugin.buildStart();

    for (const c of cases) {
      const out = plugin.transform(`a{background:${c.call}}`, path.join(ROOT, "src/x.css"));
      expect(out, `插件未改写：${c.call}`).toBeTruthy();
      const m = /var\(--sm-mix-[^,]+,\s*(rgba\([^)]*\))\)/.exec(out!.code);
      expect(m, `插件输出无 rgba 兜底：${c.call} → ${out!.code}`).toBeTruthy();
      expect(m![1], `不一致：${c.call}`).toBe(c.resolved);
    }
  });

  it("插件对组件级 token（theme.css 里没有）给 transparent 兜底", () => {
    // BookReader 的 --reader-fg 由 :style 写在组件根节点，theme.css 里没有；
    // 插件无法在构建期得知取值，只能给 transparent，真实值由运行期写入。
    const plugin = colorMixFallback({ enabled: true, root: ROOT });
    plugin.buildStart();
    const out = plugin.transform(
      "a{background:color-mix(in srgb, var(--reader-fg) 14%, transparent)}",
      path.join(ROOT, "src/x.css"),
    );
    expect(out!.code).toContain("var(--sm-mix-reader-fg-14, transparent)");
  });

  it("派生变量名规则两边一致", () => {
    // 构建期生成的 `--sm-mix-<token>-<pct>` 必须与运行期读写的键完全一致，
    // 否则运行期写进 :root 的值永远不会被 CSS 用到。
    expect(derivedVarName("var(--md-sys-color-primary)", 12)).toBe(
      "--sm-mix-md-sys-color-primary-12",
    );
    expect(derivedVarName("var(--reader-fg)", 14)).toBe("--sm-mix-reader-fg-14");
    // 小数百分数用下划线代替点
    expect(derivedVarName("var(--x)", 12.5)).toBe("--sm-mix-x-12_5");
  });
});
