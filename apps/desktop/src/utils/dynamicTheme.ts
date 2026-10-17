/**
 * 动态配色：由一个种子色实时生成整套 Material Design 3 颜色令牌，
 * 以内联样式写到 <html> 上，从而覆盖 tokens/theme.css 里的静态默认值
 * （行内样式优先级高于任何选择器，浅色/深色两套 [data-theme] 规则都会被盖住）。
 *
 * 算法本身在 `@shared/m3-theme.ts`（浏览器与 Electron 主进程共用），这里只负责
 * 「写进 DOM」这一层：设置页改种子色 / 切换深浅 / 跟随系统强调色都走这里。
 */
import { M3_COLOR_ROLES, cssTokensFromSeed, normalizeSeedHex } from "@shared/m3-theme";

/**
 * 已写入过的令牌名。clearSeedTokens() 据此精确清除，**不**按当前内核列表重算
 * ——否则内核升级/回滚后旧键会残留在行内样式里，永久盖住 theme.css。
 */
let appliedTokens: string[] = [];

/**
 * 依据种子色与深/浅模式，把整套 MD3 颜色令牌写到 documentElement 上。
 * seed 非法时静默返回，沿用 theme.css 的默认配色。
 */
export function applySeedColor(seed: string, dark: boolean): void {
  if (typeof document === "undefined") return;
  if (!normalizeSeedHex(seed)) return;
  const tokens = cssTokensFromSeed(seed, dark);
  const root = document.documentElement;
  for (const [cssVar, value] of Object.entries(tokens)) {
    root.style.setProperty(cssVar, value);
  }
  appliedTokens = Object.keys(tokens);
}

/** 清除 applySeedColor 写入的内联颜色令牌。
 *  皮肤系统在「皮肤不适配种子色」时调用，确保种子的残留内联值
 *  不会盖住皮肤令牌（内联样式优先级高于一切选择器）。 */
export function clearSeedTokens(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // 没写过任何令牌时退化为「按内核当前角色全清一遍」，兜住热更新等非常规路径
  const names = appliedTokens.length
    ? appliedTokens
    : M3_COLOR_ROLES.map((name) => `--md-sys-color-${name}`);
  for (const cssVar of names) root.style.removeProperty(cssVar);
  appliedTokens = [];
}

/**
 * 读取当前生效的主色（`#rrggbb`）。供 canvas / SVG / 第三方播放器这类
 * **拿不到 CSS 变量**的地方取主题色，避免各处再写死 `#1A5C9E`。
 *
 * 令牌值可能是 `#rgb` / `#rrggbb` / `rgb(a)`（皮肤可写任意合法 CSS 颜色），
 * 统一归一成 hex；都解析不出时返回 fallback。
 */
export function readPrimaryHex(fallback = "#426089"): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--md-sys-color-primary")
    .trim();
  if (!raw) return fallback;
  if (raw.startsWith("#")) {
    return raw.length === 4 ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}` : raw;
  }
  const m = raw.match(/rgba?\(([^)]+)\)/);
  if (!m) return fallback;
  const parts = m[1].split(",").map((x) => Number.parseFloat(x.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return fallback;
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("")}`;
}
