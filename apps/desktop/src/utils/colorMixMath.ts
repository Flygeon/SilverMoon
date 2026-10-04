/**
 * `color-mix()` 的解析与等价换算（纯函数，无 DOM 依赖）。
 *
 * ## 为什么需要它
 *
 * `color-mix()` 需要 **Chrome 111+**，而 Win7 兼容版必须停在 Electron 22
 * （**Chromium 108**）—— 实测 `CSS.supports('color','color-mix(in srgb, red, blue)')`
 * 返回 **false**。不支持的声明会被浏览器**静默丢弃**：不报错，但大量半透明
 * 层级直接消失 / 发灰。
 *
 * 纯 CSS 无法表达「把某变量按百分比混一下」（相对颜色语法要 Chrome 119+），
 * 所以回退只能**预先算成 rgba()**。本模块提供这份换算，被三处复用：
 *
 * - `scripts/vite-plugin-colormix-fallback.mjs`（构建期，有等价实现，
 *   由 parity 单测做一致性校验）
 * - `src/utils/colorMixRuntime.ts`（运行期，处理 `@m3e/web` 的 CSS-in-JS）
 * - 单元测试
 *
 * ## 数学
 *
 * 按 CSS Color 5 的 srgb 规则做**预乘 alpha**混合：
 *
 *   a = a1*w1 + a2*w2
 *   C = (C1*a1*w1 + C2*a2*w2) / a
 *
 * 当第二操作数是 `transparent`（a2 = 0）时退化为「把 C1 的 alpha 乘 w1」，
 * 正是本项目绝大多数用法的语义（注意 C1 自身可能已半透明，如 `--md-sys-color-scrim`）。
 */

/** 解析后的颜色。 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → Rgba。 */
export function parseHex(hex: string): Rgba | null {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const d = (c: string): number => parseInt(c + c, 16);
  const p = (c: string): number => parseInt(c, 16);
  if (h.length === 3 || h.length === 4) {
    return { r: d(h[0]), g: d(h[1]), b: d(h[2]), a: h.length === 4 ? d(h[3]) / 255 : 1 };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: p(h.slice(0, 2)),
      g: p(h.slice(2, 4)),
      b: p(h.slice(4, 6)),
      a: h.length === 8 ? p(h.slice(6, 8)) / 255 : 1,
    };
  }
  return null;
}

/** `rgb()` / `rgba()` → Rgba。
 *
 * 三种语法都要认：
 * - 逗号：`rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)`
 * - 空格 + 斜杠：`rgb(0 0 0 / 0.85)`（modern syntax）
 * - 纯空格：`rgb(50% 100% 0%)`
 */
export function parseRgbFunction(value: string): Rgba | null {
  const m = /^rgba?\(\s*([^)]+)\)$/i.exec(value.trim());
  if (!m) return null;
  let body = m[1].trim();
  let alphaPart: string | null = null;
  // 先摘掉 `/ <alpha>`（可能与通道之间只有一个空格）
  const slash = body.indexOf("/");
  if (slash >= 0) {
    alphaPart = body.slice(slash + 1).trim();
    body = body.slice(0, slash).trim();
  }
  // 有逗号按逗号切；否则按空白切（modern syntax）
  const rawParts = body.includes(",")
    ? body.split(",").map((s) => s.trim())
    : body.split(/\s+/).map((s) => s.trim());
  const parts = rawParts.filter(Boolean);
  if (alphaPart) parts.push(alphaPart);
  if (parts.length < 3) return null;
  const ch = (s: string): number =>
    s.endsWith("%") ? Math.round((parseFloat(s) / 100) * 255) : parseFloat(s);
  const r = ch(parts[0]);
  const g = ch(parts[1]);
  const b = ch(parts[2]);
  let a = 1;
  if (parts.length >= 4) {
    a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  }
  if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a) };
}

/** 具名色（只列本项目实际会出现的）。 */
const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
};

/** 解析不含变量的具体颜色字面量。 */
export function parseConcreteColor(value: string): Rgba | null {
  const v = String(value).trim();
  if (!v) return null;
  const named = NAMED[v.toLowerCase()];
  if (named) return { ...named };
  return parseHex(v) ?? parseRgbFunction(v);
}

/** 按 CSS Color 5 的 srgb 规则做预乘 alpha 混合。 */
export function mixColors(c1: Rgba, w1: number, c2: Rgba, w2: number): Rgba {
  const sum = w1 + w2;
  const n1 = sum > 0 ? w1 / sum : 0.5;
  const n2 = sum > 0 ? w2 / sum : 0.5;
  const a = c1.a * n1 + c2.a * n2;
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: clamp255((c1.r * c1.a * n1 + c2.r * c2.a * n2) / a),
    g: clamp255((c1.g * c1.a * n1 + c2.g * c2.a * n2) / a),
    b: clamp255((c1.b * c1.a * n1 + c2.b * c2.a * n2) / a),
    a: clamp01(a),
  };
}

/** Rgba → `rgba(r, g, b, a)`。 */
export function formatRgba(c: Rgba): string {
  const a = Math.round(clamp01(c.a) * 1000) / 1000;
  return "rgba(" + clamp255(c.r) + ", " + clamp255(c.g) + ", " + clamp255(c.b) + ", " + a + ")";
}

/** 仅缩放 alpha（`color-mix(..., C p%, transparent)` 的快捷路径）。 */
export function withAlpha(color: Rgba, percent: number): string {
  return formatRgba({ ...color, a: clamp01(color.a * (percent / 100)) });
}

// ---------------------------------------------------------------------------
// 调用解析
// ---------------------------------------------------------------------------

/** 从 CSS 文本里取出的一次 color-mix 调用。 */
export interface ColorMixCall {
  /** `color-mix(...)` 原文 */
  full: string;
}

/**
 * 按**括号配对**切出 CSS 文本里所有 `color-mix(...)` 调用。
 *
 * 不能用正则：操作数里可能嵌 `var(--x, ...)` 甚至多层函数，非贪婪正则会截断。
 */
export function extractColorMixCalls(cssText: string): ColorMixCall[] {
  const out: ColorMixCall[] = [];
  const needle = "color-mix(";
  let i = 0;
  while ((i = cssText.indexOf(needle, i)) >= 0) {
    let depth = 0;
    let j = i + "color-mix".length;
    for (; j < cssText.length; j += 1) {
      const ch = cssText[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    out.push({ full: cssText.slice(i, j) });
    i = j;
  }
  return out;
}

/** 按顶层逗号切分参数（忽略括号内的逗号）。 */
export function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** 一个操作数的「颜色 + 权重」。权重可为 `12%` 或 `var(--x, 12%)`。 */
export interface Operand {
  color: string;
  weight: string | null;
}

const WEIGHT_RE = /^(\d+(?:\.\d+)?)%$|^var\(\s*--[A-Za-z0-9_-]+\s*(?:,\s*\d+(?:\.\d+)?%\s*)?\)$/;

/** 拆 `<color> <weight>`。从**顶层**尾部找权重 —— 颜色可能含空格与括号
 *  （`var(--a, rgba(1, 2, 3, .5))`），直接 lastIndexOf(` `) 会切在括号里面。 */
export function parseOperand(text: string): Operand {
  const t = text.trim();
  // 从右往左找第一个「括号深度为 0」的空格
  let depth = 0;
  for (let i = t.length - 1; i > 0; i -= 1) {
    const ch = t[i];
    if (ch === ")") depth += 1;
    else if (ch === "(") depth -= 1;
    else if (ch === " " && depth === 0) {
      const tail = t.slice(i + 1).trim();
      if (WEIGHT_RE.test(tail)) return { color: t.slice(0, i).trim(), weight: tail };
      // 顶层空格但尾部不是权重：说明整串都是颜色（如 `rgb(0 0 0 / .5)`），不再往左找
      break;
    }
  }
  return { color: t, weight: null };
}

/** 取 `var(--name, fallback)` 的变量名与兜底。 */
export function parseVarOperand(operand: string): { name: string; fallback: string | null } | null {
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(operand.trim());
  if (!m) return null;
  const raw = m[2]?.trim();
  return { name: m[1], fallback: raw ? raw : null };
}

/** 权重表达式 → 0–1 的数值。静态 `12%` 直接取；`var(--x, 12%)` 取其兜底。 */
export function weightValue(weight: string | null): number | null {
  if (!weight) return null;
  const direct = /^(\d+(?:\.\d+)?)%$/.exec(weight.trim());
  if (direct) return Number(direct[1]) / 100;
  const v = parseVarOperand(weight.trim());
  if (v?.fallback) {
    const m = /^(\d+(?:\.\d+)?)%$/.exec(v.fallback.trim());
    if (m) return Number(m[1]) / 100;
  }
  return null;
}

/** color-mix 的解析结果。 */
export interface ParsedColorMix {
  /** 原文 */
  full: string;
  /** 是否形如 `color-mix(in srgb, ...)`（本项目只用这个空间） */
  isSrgb: boolean;
  operands: Operand[];
}

/** 解析一次 color-mix 调用。非 `in srgb` 或参数不足时 `isSrgb=false`。 */
export function parseColorMixCall(call: string): ParsedColorMix | null {
  const m = /^color-mix\(([\s\S]*)\)$/.exec(call.trim());
  if (!m) return null;
  const args = splitTopLevel(m[1]);
  if (args.length < 2) return null;
  const isSrgb = /^in\s+srgb$/i.test(args[0].trim());
  return { full: call, isSrgb, operands: args.slice(1).map(parseOperand) };
}

/**
 * 把一次 color-mix 换算成具体 rgba。
 *
 * `resolveVar(name, fallback)` 由调用方提供：
 * - 构建期给主题表里查到的十六进制值；
 * - 运行期给 `getComputedStyle` 读到的当前值。
 *
 * 返回 null 表示**无法安全换算**（操作数含变量但解析不出来、或非 srgb 空间），
 * 调用方应保持原样或另行兜底。
 */
export function resolveColorMix(
  parsed: ParsedColorMix,
  resolveVar: (name: string, fallback: string | null) => Rgba | null,
): Rgba | null {
  if (!parsed.isSrgb || parsed.operands.length < 2) return null;

  const resolveOperand = (op: Operand): Rgba | null => {
    const v = parseVarOperand(op.color);
    if (v) return resolveVar(v.name, v.fallback);
    return parseConcreteColor(op.color);
  };

  const c1 = resolveOperand(parsed.operands[0]);
  const c2 = resolveOperand(parsed.operands[1]);
  if (!c1 || !c2) return null;

  // CSS Color 5：只给一侧权重时，另一侧补 `100% - 给定值`；两侧都没给才各 50%。
  // 这个默认值很容易漏 —— 漏了会把 `C 12%, transparent` 算成 12/(12+50) ≈ 0.194
  // 而不是 0.12（实测踩过）。
  const given1 = weightValue(parsed.operands[0].weight);
  const given2 = weightValue(parsed.operands[1].weight);
  let w1: number;
  let w2: number;
  if (given1 !== null && given2 !== null) {
    w1 = given1;
    w2 = given2;
  } else if (given1 !== null) {
    w1 = given1;
    w2 = 1 - given1;
  } else if (given2 !== null) {
    w1 = 1 - given2;
    w2 = given2;
  } else {
    w1 = 0.5;
    w2 = 0.5;
  }
  return mixColors(c1, w1, c2, w2);
}
