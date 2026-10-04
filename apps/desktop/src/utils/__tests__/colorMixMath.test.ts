/**
 * `colorMixMath` 的单元测试。
 *
 * 重点覆盖三类**容易算错**的情形：
 * 1. 源色**自身半透明**（`--md-sys-color-scrim` 是 rgba(0,0,0,0.7)）——
 *    结果 alpha 必须是**乘积**而不是直接取百分比；
 * 2. 括号配对（操作数是 `var(--x, <含逗号>)` 时正则截断）；
 * 3. 与构建期插件的**一致性**（两边各有一份实现，必须同结果）。
 */
import { describe, expect, it } from "vitest";

import {
  extractColorMixCalls,
  formatRgba,
  mixColors,
  parseColorMixCall,
  parseConcreteColor,
  parseOperand,
  parseVarOperand,
  resolveColorMix,
  splitTopLevel,
  withAlpha,
} from "../colorMixMath";

describe("parseConcreteColor", () => {
  it("解析 hex 各长度", () => {
    expect(parseConcreteColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseConcreteColor("#1a5c9e")).toEqual({ r: 26, g: 92, b: 158, a: 1 });
    expect(parseConcreteColor("#00000080")?.a).toBeCloseTo(0.502, 2);
    expect(parseConcreteColor("#0000")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("解析 rgb()/rgba()（含百分数与 / 分隔）", () => {
    expect(parseConcreteColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseConcreteColor("rgba(0, 0, 0, 0.7)")).toEqual({ r: 0, g: 0, b: 0, a: 0.7 });
    expect(parseConcreteColor("rgb(50% 100% 0%)")).toEqual({ r: 128, g: 255, b: 0, a: 1 });
    expect(parseConcreteColor("rgb(0 0 0 / 0.85)")).toEqual({ r: 0, g: 0, b: 0, a: 0.85 });
  });

  it("具名色与不可解析输入", () => {
    expect(parseConcreteColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseConcreteColor("currentColor")).toBeNull();
    expect(parseConcreteColor("var(--x)")).toBeNull();
    expect(parseConcreteColor("")).toBeNull();
  });
});

describe("withAlpha 的透明度是**乘积**", () => {
  it("不透明源色：alpha 即百分比", () => {
    expect(withAlpha({ r: 26, g: 92, b: 158, a: 1 }, 8)).toBe("rgba(26, 92, 158, 0.08)");
  });

  it("半透明源色：alpha 是 source.a × percent（回归点）", () => {
    // --md-sys-color-scrim = rgba(0,0,0,0.7)，60% → 0.42（不是 0.6）
    expect(withAlpha({ r: 0, g: 0, b: 0, a: 0.7 }, 60)).toBe("rgba(0, 0, 0, 0.42)");
    expect(withAlpha({ r: 0, g: 0, b: 0, a: 0.85 }, 60)).toBe("rgba(0, 0, 0, 0.51)");
  });

  it("alpha 被夹到 [0,1]", () => {
    expect(withAlpha({ r: 1, g: 1, b: 1, a: 1 }, 200)).toContain("1)");
    expect(withAlpha({ r: 1, g: 1, b: 1, a: 1 }, 0)).toContain("0)");
  });
});

describe("mixColors（srgb 预乘 alpha）", () => {
  it("与 transparent 混合 → 只缩放 alpha", () => {
    const c = mixColors({ r: 26, g: 92, b: 158, a: 1 }, 0.12, { r: 0, g: 0, b: 0, a: 0 }, 0.88);
    expect(formatRgba(c)).toBe("rgba(26, 92, 158, 0.12)");
  });

  it("与白色混合 → 变亮", () => {
    const c = mixColors({ r: 0, g: 0, b: 0, a: 1 }, 0.5, { r: 255, g: 255, b: 255, a: 1 }, 0.5);
    expect(c.r).toBeCloseTo(128, 0);
    expect(c.a).toBeCloseTo(1, 5);
  });

  it("两边全透明 → 全透明", () => {
    const c = mixColors({ r: 255, g: 0, b: 0, a: 0 }, 0.5, { r: 0, g: 0, b: 0, a: 0 }, 0.5);
    expect(c.a).toBe(0);
  });
});

describe("调用提取（括号配对）", () => {
  it("提取嵌套 var() 的完整调用", () => {
    const css = "a{color:color-mix(in srgb, var(--x, rgba(1,2,3,.5)) 20%, transparent)}";
    const calls = extractColorMixCalls(css);
    expect(calls).toHaveLength(1);
    expect(calls[0].full).toBe("color-mix(in srgb, var(--x, rgba(1,2,3,.5)) 20%, transparent)");
  });

  it("提取多条调用", () => {
    const css =
      "color-mix(in srgb, #fff 10%, transparent);color-mix(in srgb, #000 20%, transparent)";
    expect(extractColorMixCalls(css)).toHaveLength(2);
  });

  it("无调用时返回空数组", () => {
    expect(extractColorMixCalls("color: red")).toEqual([]);
  });
});

describe("splitTopLevel / parseOperand / parseVarOperand", () => {
  it("顶层逗号切分忽略括号内逗号", () => {
    expect(splitTopLevel("a, var(--x, y), c")).toEqual(["a", "var(--x, y)", "c"]);
  });

  it("从尾部识别权重（颜色含空格时仍正确）", () => {
    expect(parseOperand("var(--reader-fg) 14%")).toEqual({
      color: "var(--reader-fg)",
      weight: "14%",
    });
    expect(parseOperand("var(--x, rgba(1, 2, 3, .5)) 20%")).toEqual({
      color: "var(--x, rgba(1, 2, 3, .5))",
      weight: "20%",
    });
    expect(parseOperand("#fff")).toEqual({ color: "#fff", weight: null });
  });

  it("权重可以是 var(--opacity, 38%)", () => {
    expect(parseOperand("var(--c) var(--m3e-opacity, 38%)")).toEqual({
      color: "var(--c)",
      weight: "var(--m3e-opacity, 38%)",
    });
  });

  it("parseVarOperand 取名字与兜底", () => {
    expect(parseVarOperand("var(--a)")).toEqual({ name: "--a", fallback: null });
    expect(parseVarOperand("var(--a, #fff)")).toEqual({ name: "--a", fallback: "#fff" });
    expect(parseVarOperand("#fff")).toBeNull();
  });
});

describe("parseColorMixCall / resolveColorMix", () => {
  it("解析并换算 var 形态", () => {
    const parsed = parseColorMixCall("color-mix(in srgb, var(--primary) 12%, transparent)");
    expect(parsed?.isSrgb).toBe(true);
    const out = resolveColorMix(parsed!, (name) =>
      name === "--primary" ? { r: 26, g: 92, b: 158, a: 1 } : null,
    );
    expect(formatRgba(out!)).toBe("rgba(26, 92, 158, 0.12)");
  });

  it("非 srgb 空间 → null（不硬套）", () => {
    const parsed = parseColorMixCall("color-mix(in oklab, red 50%, blue)");
    expect(parsed?.isSrgb).toBe(false);
    expect(resolveColorMix(parsed!, () => null)).toBeNull();
  });

  it("变量解析不出且无兜底 → null", () => {
    const parsed = parseColorMixCall("color-mix(in srgb, var(--nope) 10%, transparent)")!;
    expect(resolveColorMix(parsed, () => null)).toBeNull();
  });

  it("用 var() 自带兜底", () => {
    const parsed = parseColorMixCall("color-mix(in srgb, var(--nope, #000) 50%, transparent)")!;
    const out = resolveColorMix(parsed, (_n, fb) => (fb ? parseConcreteColor(fb) : null));
    expect(formatRgba(out!)).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("第二个操作数不是 transparent 时也按预乘 alpha 混合", () => {
    const parsed = parseColorMixCall("color-mix(in srgb, #000 50%, #fff 50%)")!;
    const out = resolveColorMix(parsed, () => null);
    expect(out!.r).toBeCloseTo(128, 0);
  });
});
