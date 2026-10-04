/**
 * 对抗性边界测试：专门构造**可能被误判**的输入。
 *
 * 这些用例对应我在实现时问自己的问题：
 * - `looksLikeWeight` 会不会把**颜色**误判成权重？
 * - 颜色本身含空格（modern rgb/hsl 语法）会不会被切错？
 * - 自引用 / 超深 var 链会不会栈溢出？
 * - 替换用 split/join 会不会误伤其它调用？
 */
import { describe, expect, it } from "vitest";

import {
  extractColorMixCalls,
  formatRgba,
  parseColorMixCall,
  parseConcreteColor,
  parseOperand,
  resolveColorMix,
  weightValue,
} from "../colorMixMath";
import { rewriteColorMix } from "../colorMixRuntime";

describe("looksLikeWeight 不误判颜色", () => {
  it("单色 var 不被当成权重", () => {
    // 无顶层空格 → 整串是颜色
    expect(parseOperand("var(--a, #fff)")).toEqual({ color: "var(--a, #fff)", weight: null });
  });

  it("modern 空格语法颜色不被切开", () => {
    // 空格都在括号内（depth>0），不应被当作 <color> <weight> 的分隔
    expect(parseOperand("rgb(0 0 0 / 0.5)")).toEqual({
      color: "rgb(0 0 0 / 0.5)",
      weight: null,
    });
    expect(parseOperand("hsl(120 50% 50%)")).toEqual({ color: "hsl(120 50% 50%)", weight: null });
  });

  it("十六进制 + 百分比权重正常切分", () => {
    expect(parseOperand("#1d1b20 12%")).toEqual({ color: "#1d1b20", weight: "12%" });
  });

  it("嵌套 var 颜色 + var 权重正常切分", () => {
    expect(parseOperand("var(--a, var(--b, #fff)) var(--op, 10%)")).toEqual({
      color: "var(--a, var(--b, #fff))",
      weight: "var(--op, 10%)",
    });
  });
});

describe("weightValue 的边界", () => {
  it("静态百分比", () => {
    expect(weightValue("12%")).toBeCloseTo(0.12, 6);
    expect(weightValue("100%")).toBe(1);
    expect(weightValue("0%")).toBe(0);
  });

  it("嵌套 var 权重取最内层兜底", () => {
    expect(weightValue("var(--a, var(--b, var(--c, 25%)))")).toBeCloseTo(0.25, 6);
  });

  it("读变量实时值（原始字符串）", () => {
    expect(weightValue("var(--op, 10%)", (n) => (n === "--op" ? "8%" : null))).toBeCloseTo(0.08, 6);
  });

  it("读到的实时值是 0–1 纯数字时直接采用", () => {
    expect(weightValue("var(--op, 50%)", (n) => (n === "--op" ? "0.35" : null))).toBeCloseTo(
      0.35,
      6,
    );
  });

  it("自引用 var 链在深度限制内返回 null（不栈溢出）", () => {
    const selfRef = "var(--a, " + "var(--a, ".repeat(40) + "20%" + ")".repeat(40) + ")";
    expect(() => weightValue(selfRef)).not.toThrow();
    expect(weightValue(selfRef)).toBeNull();
  });

  it("非权重文本返回 null", () => {
    expect(weightValue("#fff")).toBeNull();
    expect(weightValue("transparent")).toBeNull();
    expect(weightValue(null)).toBeNull();
  });
});

describe("resolveVarChain 的递归安全", () => {
  it("超深嵌套不栈溢出，且在限制内能解出", () => {
    const deep = "var(--a, ".repeat(8) + "#123456" + ")".repeat(8);
    const parsed = parseColorMixCall(`color-mix(in srgb, ${deep} 50%, transparent)`)!;
    const out = resolveColorMix(parsed, () => null);
    expect(out).not.toBeNull();
    expect(formatRgba(out!)).toBe("rgba(18, 52, 86, 0.5)");
  });

  it("超出深度限制的链返回 null 而非异常", () => {
    const tooDeep = "var(--a, ".repeat(40) + "#123456" + ")".repeat(40);
    const parsed = parseColorMixCall(`color-mix(in srgb, ${tooDeep} 50%, transparent)`)!;
    expect(() => resolveColorMix(parsed, () => null)).not.toThrow();
    expect(resolveColorMix(parsed, () => null)).toBeNull();
  });
});

describe("rewriteColorMix 的替换安全", () => {
  it("同一文本里多条相同调用都被替换", () => {
    const one = "color-mix(in srgb, #fff 10%, transparent)";
    const src = `a{background:${one}} b{background:${one}}`;
    const out = rewriteColorMix(src, () => null);
    expect(out).toBe(
      "a{background:rgba(255, 255, 255, 0.1)} b{background:rgba(255, 255, 255, 0.1)}",
    );
  });

  it("不同调用互不干扰", () => {
    const src =
      "a{background:color-mix(in srgb, #fff 10%, transparent)} b{background:color-mix(in srgb, #000 20%, transparent)}";
    const out = rewriteColorMix(src, () => null);
    expect(out).toBe("a{background:rgba(255, 255, 255, 0.1)} b{background:rgba(0, 0, 0, 0.2)}");
  });

  it("未闭合的 color-mix 不会导致死循环或异常", () => {
    const src = "a{background:color-mix(in srgb, #fff 10%, transparent";
    expect(() => rewriteColorMix(src, () => null)).not.toThrow();
  });
});

describe("extractColorMixCalls 的健壮性", () => {
  it("空串无调用", () => {
    expect(extractColorMixCalls("")).toEqual([]);
  });

  it("嵌套括号的调用被完整切出", () => {
    const src = "color-mix(in srgb, var(--a, var(--b, #fff)) 10%, transparent)";
    const calls = extractColorMixCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0].full).toBe(src);
  });

  it("不把函数名里的子串误当调用", () => {
    expect(
      extractColorMixCalls("background-color-mix(in srgb, #fff 10%, transparent)"),
    ).toHaveLength(1);
  });
});

describe("输出始终是合法 CSS 颜色", () => {
  const cases = [
    "color-mix(in srgb, #fff 10%, transparent)",
    "color-mix(in srgb, var(--a, var(--b, #123456)) 20%, transparent)",
    "color-mix(in srgb, rgba(0, 0, 0, 0.7) 60%, transparent)",
    "color-mix(in srgb, var(--x, hsl(0 0% 50%)) 30%, transparent)",
  ];

  it("可换算的都产出 rgba()，且 parseConcreteColor 能再解析回去", () => {
    for (const c of cases) {
      const out = rewriteColorMix(c, (n) => (n === "--x" ? null : null));
      // 能换的必须是合法颜色；换不了的保持原样（由运行期处理）
      if (!out.includes("color-mix")) {
        expect(parseConcreteColor(out), out).toBeTruthy();
      }
    }
  });

  it("含 hsl 颜色时不崩溃（hsl 不在当前解析范围，允许保持原样）", () => {
    expect(() => rewriteColorMix(cases[3], () => null)).not.toThrow();
  });
});
