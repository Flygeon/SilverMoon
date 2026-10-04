/**
 * 构建期把 `color-mix(in srgb, C p%, transparent)` 改写为
 * `var(--sm-mix-<key>-<pct>, <静态 rgba 兜底>)`。
 *
 * ## 为什么要「构建期 + 运行期」两层
 *
 * Chromium 108（Electron 22 / Win7 版）不支持 `color-mix()`（要 Chrome 111+）。
 * 不支持的声明会被**静默丢弃** —— 不报错，但大量半透明层级直接消失/发灰。
 *
 * 纯 CSS 无法表达「把某变量的透明度乘一下」（相对颜色语法要 Chrome 119+），
 * 只能预先算成 `rgba()`。而项目 token 是**动态的**（种子色 / 皮肤 / 深浅切换
 * 都会改 `--md-sys-color-*`），所以分两层：
 *
 * 1. **构建期（本插件）**：换成 `var(--sm-mix-X-12, rgba(...))`。
 *    外层 `var()` 让运行期可覆盖；兜底值是**浅色主题的静态换算**，
 *    保证「运行期尚未执行」的瞬间不闪透明。
 * 2. **运行期（`src/utils/colorMixRuntime.ts`）**：探测到不支持 color-mix 时，
 *    从 `getComputedStyle` 读真实 token 值重算 `--sm-mix-*` 写到 `:root`，
 *    并在主题/种子/皮肤变化时重算。
 *
 * 仅在 `SM_COLORMIX_FALLBACK=1` 时启用 —— 现代构建的 CSS **逐字节不变**。
 *
 * ## 虚拟模块 `virtual:sm-colormix-pairs`
 *
 * 运行期需要知道「同步哪些 (token, 百分数) 组合」。插件在 `buildStart`
 * **一次性扫描源码树**收集（而不是在 transform 里顺手记 —— transform 顺序
 * 与虚拟模块的 load 顺序没有保证），再经虚拟模块交给运行期。不做第二份清单。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const VIRTUAL_ID = "virtual:sm-colormix-pairs";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

/** 与 src/utils/colorMixMath.ts 保持一致的等价正则。 */
const MIX_RE =
  /color-mix\(\s*in\s+srgb\s*,\s*(var\([^()]*(?:\([^()]*\))?[^()]*\)|currentColor|#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)/g;

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

function parseHex(hex) {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(String(hex).trim());
  if (!m) return null;
  const h = m[1];
  const d = (c) => parseInt(c + c, 16);
  const p = (c) => parseInt(c, 16);
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

function parseRgb(value) {
  const m = /^rgba?\(\s*([^)]+)\)$/i.exec(String(value).trim());
  if (!m) return null;
  const parts = m[1]
    .split(/[,/]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const ch = (s) => (s.endsWith("%") ? Math.round((parseFloat(s) / 100) * 255) : parseFloat(s));
  const r = ch(parts[0]);
  const g = ch(parts[1]);
  const b = ch(parts[2]);
  let a = 1;
  if (parts.length >= 4) {
    a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  }
  if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

function parseConcrete(v) {
  const s = String(v).trim();
  if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 };
  return parseHex(s) ?? parseRgb(s);
}

function withAlpha(c, percent) {
  const a = Math.max(0, Math.min(1, c.a * (percent / 100)));
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${Math.round(a * 1000) / 1000})`;
}

function parseVarOperand(operand) {
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(operand.trim());
  if (!m) return null;
  const fb = m[2]?.trim();
  return { name: m[1], fallback: fb ? fb : null };
}

export function derivedVarName(operand, percent) {
  const v = parseVarOperand(operand);
  const key = v ? v.name.replace(/^--/, "") : operand.replace(/[^A-Za-z0-9_-]/g, "_");
  return `--sm-mix-${key}-${String(percent).replace(/\./g, "_")}`;
}

/** 从 theme.css 的 `:root`（浅色）块解析 token 静态值。 */
function parseLightTokens(themeCssPath) {
  const tokens = new Map();
  if (!existsSync(themeCssPath)) return tokens;
  const css = readFileSync(themeCssPath, "utf8");
  const start = css.indexOf(":root {");
  if (start < 0) return tokens;
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
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css.slice(start, end)))) tokens.set(m[1], m[2].trim());
  return tokens;
}

/** 递归收集 src 下所有样式来源（.vue / .css）。 */
function collectStyleFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) collectStyleFiles(p, out);
    else if (/\.(vue|css)$/.test(entry)) out.push(p);
  }
  return out;
}

export function colorMixFallback(options = {}) {
  const enabled = options.enabled ?? process.env.SM_COLORMIX_FALLBACK === "1";
  const root = options.root ?? process.cwd();
  const themeCssPath = path.join(root, "src", "tokens", "theme.css");

  /** name（不含 --）→ Set(percent)。currentColor 单独记在 currentColorPercents。 */
  let neededPairs = [];
  let currentColorPercents = [];
  let tokens = new Map();

  return {
    name: "sm-colormix-fallback",
    enforce: "pre",

    buildStart() {
      tokens = parseLightTokens(themeCssPath);
      const pairsMap = new Map();
      const cc = new Set();

      // 一次性扫描：与 transform 的执行顺序解耦，虚拟模块 load 时一定已就绪
      for (const file of collectStyleFiles(path.join(root, "src"))) {
        const text = readFileSync(file, "utf8");
        MIX_RE.lastIndex = 0;
        let m;
        while ((m = MIX_RE.exec(text))) {
          const operand = m[1].trim();
          const percent = Number(m[2]);
          if (operand === "currentColor") {
            cc.add(percent);
            continue;
          }
          const v = parseVarOperand(operand);
          if (!v) continue; // 字面量：transform 时内联兜底，无需运行期同步
          const key = v.name.replace(/^--/, "");
          if (!pairsMap.has(key)) pairsMap.set(key, new Set());
          pairsMap.get(key).add(percent);
        }
      }

      neededPairs = [...pairsMap]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, set]) => ({
          name,
          token: `--${name}`,
          percents: [...set].sort((a, b) => a - b),
        }));
      currentColorPercents = [...cc].sort((a, b) => a - b);
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_ID) return null;
      // 只有启用回退的构建才带真实组合表；现代构建导出空表，运行期直接 no-op
      const pairs = enabled ? neededPairs : [];
      const cc = enabled ? currentColorPercents : [];
      return (
        `export const COLOR_MIX_PAIRS = ${JSON.stringify(pairs)};\n` +
        `export const COLOR_MIX_CURRENT_COLOR_PERCENTS = ${JSON.stringify(cc)};\n`
      );
    },

    transform(code, id) {
      if (!enabled) return null;
      if (id.includes("node_modules")) return null;
      if (!/\.(vue|css)$/.test(id)) return null;
      if (!code.includes("color-mix")) return null;

      let changed = false;
      const out = code.replace(MIX_RE, (full, colorOperand, percentText) => {
        const operand = colorOperand.trim();
        const percent = Number(percentText);

        // currentColor：构建期无法得知实际颜色。仍换成 var()，兜底给
        // 「透明」——与「浏览器不支持该声明」的效果一致，不会更差；
        // 真正有值由组件按上下文写入（见 BookReader/NovelReader 的混色变量）。
        if (operand === "currentColor") {
          changed = true;
          return `var(${derivedVarName(operand, percent)}, transparent)`;
        }

        const v = parseVarOperand(operand);

        if (v) {
          // 先看静态主题表，再看 var() 自带的兜底
          const raw = tokens.get(v.name) ?? v.fallback;
          const base = raw ? parseConcrete(raw) : null;
          changed = true;
          if (base) {
            return `var(${derivedVarName(operand, percent)}, ${withAlpha(base, percent)})`;
          }
          // 变量既不在 theme.css、又没有兜底 —— 典型是**组件级 token**
          // （BookReader 的 --reader-fg / --reader-bg 由 :style 写在组件根节点上，
          // 构建期无从得知）。仍然换成 var()，兜底给 transparent：
          // 这与「浏览器不支持 color-mix 时整条声明被丢弃」的现状等价，不会更差；
          // 真实值由组件在运行期用 syncDerivedVarsForElement 写入
          // （见 src/components/BookReader.vue）。
          return `var(${derivedVarName(operand, percent)}, transparent)`;
        }

        // 字面量：直接内联算好的 rgba
        const literal = parseConcrete(operand);
        if (!literal) return full;
        changed = true;
        return `var(${derivedVarName(operand, percent)}, ${withAlpha(literal, percent)})`;
      });

      return changed ? { code: out, map: null } : null;
    },
  };
}
