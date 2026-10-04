/**
 * 用 `@m3e/web` 的**真实样式片段**做回归测试。
 *
 * ## 为什么单独一个文件
 *
 * 前面那些测试用的是「我以为」的 color-mix 形态；这里从已安装的
 * `@m3e/web/dist/all.js` 里**抽取真实调用**，覆盖它实际用到的写法。
 * 这能拦住「测试自说自话、真实库却漏了」这类问题 —— 实测正是如此：
 * 早期实现只解一层 var 时，50 个 shadow root 里 29 个残留 color-mix，
 * 而当时所有单测都是绿的（测试里的 var 只有一层）。
 *
 * ## 为什么要做「插值替换」
 *
 * m3e 是**源码态** bundle：它的样式通过 JS 模板字符串拼出来，因此 bundle 里
 * 每条 color-mix 都含未替换的插值（形如 `${'{'}ColorToken.shadow}`）——
 * 实测 94/94 条如此。原始片段不是合法 CSS。
 *
 * 运行期真正注入 DOM 的是**插值后**的结果：
 * `var(--m3e-elevation-color, ${'{'}ColorToken.shadow})` → `var(--m3e-elevation-color, #000000)`。
 *
 * 因此这里按 m3e 自己的语义把 `${'{'}...}` 替换成一个具体颜色字面量，
 * 得到**与运行期等价**的 CSS 再测。这是唯一能从静态 bundle 得到真实形态的办法；
 * 端到端行为另有 Electron 22 实测兜底（50 个 shadow root、0 残留）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractColorMixCalls, parseColorMixCall, parseConcreteColor } from "../colorMixMath";
import { rewriteColorMix } from "../colorMixRuntime";

const M3E_ALL = path.resolve(__dirname, "../../../node_modules/@m3e/web/dist/all.js");

/** 未替换的 JS 模板插值起始标记（`` + `{`），用 char code 拼以免转义写坏。 */
const TEMPLATE_MARKER = String.fromCharCode(36) + String.fromCharCode(123);

/**
 * 把 m3e 源码态的 `${...}` 插值替换成具体颜色字面量，得到运行期等价 CSS。
 *
 * 括号配对地吃掉插值体：`${ColorToken.color.onSurface}`、
 * `${SearchViewToken.dockedScrimColor}` 等都可能含 `.`，但不含 `{`/`}` 嵌套。
 */
function interpolate(call: string): string {
  const COLOR = "#000000";
  const WEIGHT = "50%";
  let out = "";
  // 同一操作数内是否已出现过颜色 —— 决定插值该当颜色还是权重。
  // 插值既可能出现在颜色位置，也可能出现在权重位置；一律换成颜色会产出
  // "#000000 #000000" 这种非法形态（实测踩过）。
  let seenColor = false;

  for (let i = 0; i < call.length; i += 1) {
    const ch = call[i];
    if (ch === ",") seenColor = false;
    if (call.startsWith(TEMPLATE_MARKER, i)) {
      const end = call.indexOf(String.fromCharCode(125), i);
      if (end < 0) {
        out += call.slice(i);
        break;
      }
      if (seenColor) {
        out += WEIGHT;
      } else {
        out += COLOR;
        seenColor = true;
      }
      i = end;
      continue;
    }
    if (/^#[0-9a-fA-F]{3,8}/.test(call.slice(i, i + 9))) seenColor = true;
    out += ch;
  }
  return out;
}

/** 抽取并插值后的真实调用。 */
function m3eCalls(): string[] {
  if (!existsSync(M3E_ALL)) return [];
  const src = readFileSync(M3E_ALL, "utf8");
  return extractColorMixCalls(src).map((c) => interpolate(c.full));
}

/** 简单 token 表：让解析有真值可用。 */
const TOKENS: Record<string, { r: number; g: number; b: number; a: number }> = {
  "--md-sys-color-on-surface": { r: 29, g: 27, b: 32, a: 1 },
  "--md-sys-color-scrim": { r: 0, g: 0, b: 0, a: 0.7 },
  "--md-sys-color-primary": { r: 26, g: 92, b: 158, a: 1 },
};

const readToken = (n: string) => TOKENS[n] ?? null;
const readRaw = (n: string): string | null => {
  if (n === "--m3e-dialog-scrim-opacity") return "32%";
  if (n === "--m3e-menu-active-state-layer-opacity") return "8%";
  return null;
};

describe("@m3e/web 真实 color-mix 覆盖率", () => {
  const calls = m3eCalls();

  it("确实从 m3e 里抽到了调用（防止测试空跑）", () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  it("插值后不再含 JS 模板标记（替换逻辑正确）", () => {
    for (const c of calls) expect(c).not.toContain(TEMPLATE_MARKER);
  });

  it("每一个 m3e 调用都能被改写（无残留）", () => {
    // 核心断言：只要有一条改写不掉，Chromium 108 上就会静默失效。
    // m3e 的 token 都带最终回退值（落到 #hex），应 100% 可改写。
    const unresolved: string[] = [];
    for (const call of calls) {
      const out = rewriteColorMix(call, readToken, readRaw);
      if (out.includes("color-mix")) unresolved.push(call);
    }
    if (unresolved.length) {
      console.log("未能改写的调用（前 5 条）：");
      unresolved.slice(0, 5).forEach((c) => console.log("  " + c.slice(0, 170)));
    }
    expect(unresolved).toEqual([]);
  });

  it("改写结果只含 rgba()", () => {
    for (const call of calls) {
      const out = rewriteColorMix(call, readToken, readRaw);
      expect(out).not.toContain("color-mix");
      expect(out).toMatch(/^rgba\(\d+, \d+, \d+, [0-9.]+\)$/);
    }
  });

  it("三层嵌套 var 能解到最内层的兜底色", () => {
    const call =
      "color-mix(in srgb, var(--m3e-text-button-disabled-container-color, var(--m3e-button-disabled-container-color, var(--md-sys-color-on-surface, #1D1B20))) 12%, transparent)";
    expect(rewriteColorMix(call, readToken, readRaw)).toBe("rgba(29, 27, 32, 0.12)");
  });

  it("嵌套 var 的权重能解出百分比（且 alpha 是乘积）", () => {
    const call =
      "color-mix(in srgb, var(--md-sys-color-scrim) var(--m3e-dialog-scrim-opacity, 32%), transparent)";
    // scrim 自身 alpha 0.7 × 32% = 0.224（乘积，不是 0.32）
    expect(rewriteColorMix(call, readToken, readRaw)).toBe("rgba(0, 0, 0, 0.224)");
  });

  it("每条 m3e 调用都能解析为 srgb", () => {
    for (const call of calls) {
      const parsed = parseColorMixCall(call);
      expect(parsed, "解析失败：" + call.slice(0, 120)).toBeTruthy();
      expect(parsed!.isSrgb).toBe(true);
    }
  });

  it("产出的都是合法 CSS 颜色", () => {
    for (const call of calls) {
      const out = rewriteColorMix(call, readToken, readRaw);
      expect(parseConcreteColor(out), "产出不是合法颜色：" + out).toBeTruthy();
    }
  });
});
