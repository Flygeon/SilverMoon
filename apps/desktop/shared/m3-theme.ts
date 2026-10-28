/**
 * Material 3 动态配色内核（**唯一真源**）。
 *
 * 浏览器渲染层（`src/tokens/dynamic-theme.ts`）与 Electron 主进程（窗口底色、
 * 启动过渡）都从这里取色，避免两处各写一套 TonalSpot 而产生色差。
 * 因此本文件只允许依赖 `@material/material-color-utilities`，不得引用 DOM。
 *
 * 配色规范（2026-10，M3 Expressive）：
 * - Variant：**Tonal Spot**（Android 12/13 默认的 Material You 方案）
 * - SpecVersion：**2025**（M3 Expressive 的 color spec；MCU 0.4.0 起支持）
 * - Platform：**phone**（2025 spec 里 phone/watch 两套 tone 曲线，桌面端取 phone）
 * - ContrastLevel：**0 = standard**（MCU 的 -1..1 标尺，0 即设计规范标准对比度）
 */
import {
  Hct,
  MaterialDynamicColors,
  SchemeTonalSpot,
  TonalPalette,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";

/** 生成方案：改这里就是改全局配色口径 */
export const M3_SCHEME = {
  /** Tonal Spot：低-中等鲜艳度，三色相由 MCU 2025 方案生成。 */
  variant: "tonal-spot",
  /** M3 Expressive color spec */
  specVersion: "2025",
  /** phone 曲线（桌面端同样适用；watch 曲线是为圆形小屏压缩的） */
  platform: "phone",
  /** 0 = 标准对比度（MCU 标尺：-1 低 / 0 标准 / 1 高） */
  contrastLevel: 0,
} as const;

/**
 * CSS 变量名 ↔ MaterialDynamicColors 角色名。
 *
 * 顺序即输出顺序：先浅色/深色成对，再中性表面，最后固定色（fixed）。
 * 覆盖 MCU 2025 spec 在 phone 平台暴露的**全部**颜色角色（51 个），
 * 其中 4 个 `*-dim` 是 2025 spec 新增的（2021 spec 没有）。
 */
const ROLE_MAP: readonly (readonly [string, string])[] = [
  ["primary", "primary"],
  ["primary-dim", "primaryDim"],
  ["on-primary", "onPrimary"],
  ["primary-container", "primaryContainer"],
  ["on-primary-container", "onPrimaryContainer"],
  ["inverse-primary", "inversePrimary"],
  ["secondary", "secondary"],
  ["secondary-dim", "secondaryDim"],
  ["on-secondary", "onSecondary"],
  ["secondary-container", "secondaryContainer"],
  ["on-secondary-container", "onSecondaryContainer"],
  ["tertiary", "tertiary"],
  ["tertiary-dim", "tertiaryDim"],
  ["on-tertiary", "onTertiary"],
  ["tertiary-container", "tertiaryContainer"],
  ["on-tertiary-container", "onTertiaryContainer"],
  ["error", "error"],
  ["error-dim", "errorDim"],
  ["on-error", "onError"],
  ["error-container", "errorContainer"],
  ["on-error-container", "onErrorContainer"],
  ["background", "background"],
  ["on-background", "onBackground"],
  ["surface", "surface"],
  ["surface-dim", "surfaceDim"],
  ["surface-bright", "surfaceBright"],
  ["surface-container-lowest", "surfaceContainerLowest"],
  ["surface-container-low", "surfaceContainerLow"],
  ["surface-container", "surfaceContainer"],
  ["surface-container-high", "surfaceContainerHigh"],
  ["surface-container-highest", "surfaceContainerHighest"],
  ["on-surface", "onSurface"],
  ["surface-variant", "surfaceVariant"],
  ["on-surface-variant", "onSurfaceVariant"],
  ["outline", "outline"],
  ["outline-variant", "outlineVariant"],
  ["inverse-surface", "inverseSurface"],
  ["inverse-on-surface", "inverseOnSurface"],
  ["surface-tint", "surfaceTint"],
  ["shadow", "shadow"],
  ["scrim", "scrim"],
  ["primary-fixed", "primaryFixed"],
  ["primary-fixed-dim", "primaryFixedDim"],
  ["on-primary-fixed", "onPrimaryFixed"],
  ["on-primary-fixed-variant", "onPrimaryFixedVariant"],
  ["secondary-fixed", "secondaryFixed"],
  ["secondary-fixed-dim", "secondaryFixedDim"],
  ["on-secondary-fixed", "onSecondaryFixed"],
  ["on-secondary-fixed-variant", "onSecondaryFixedVariant"],
  ["tertiary-fixed", "tertiaryFixed"],
  ["tertiary-fixed-dim", "tertiaryFixedDim"],
  ["on-tertiary-fixed", "onTertiaryFixed"],
  ["on-tertiary-fixed-variant", "onTertiaryFixedVariant"],
] as const;

/** 角色名（不含 `--md-sys-color-` 前缀），供脚本/测试遍历 */
export const M3_COLOR_ROLES: readonly string[] = ROLE_MAP.map(([name]) => name);

/** 结果：CSS 变量名（含前缀）→ hex */
export type M3ColorMap = Record<string, string>;

/**
 * 项目语义覆盖：这些角色**不**直接用 MCU 的规范值。
 *
 * 目前只有 `scrim`：M3 规范里它是纯 `#000000`，但本项目的蒙层直接把它当底色用
 * （`App.vue` 的 `.skin-modal-scrim { background: var(--md-sys-color-scrim) }`），
 * 若换成不透明黑会把整屏内容盖死。因此保留「半透明黑」这个项目语义值，
 * 透明度沿用改造前的口径（浅 0.7 / 深 0.85）。
 */
export const TOKEN_OVERRIDES: Record<string, { light: string; dark: string }> = {
  "--md-sys-color-scrim": { light: "rgba(0, 0, 0, 0.7)", dark: "rgba(0, 0, 0, 0.85)" },
};

/** 产品表面色阶：保留种子色相，避免浅色近白、深色近黑吞掉主题色。
 * 使用 MCU 的 HCT 色调板；强调色和文字角色仍由官方动态配色生成。
 */
export const SURFACE_CHROMA = { light: 12, dark: 10 } as const;
export const SURFACE_TONES: Record<string, { light: number; dark: number }> = {
  background: { light: 96, dark: 10 },
  surface: { light: 96, dark: 10 },
  "surface-dim": { light: 87, dark: 8 },
  "surface-bright": { light: 98, dark: 24 },
  "surface-container-lowest": { light: 99, dark: 6 },
  "surface-container-low": { light: 94, dark: 12 },
  "surface-container": { light: 92, dark: 15 },
  "surface-container-high": { light: 90, dark: 18 },
  "surface-container-highest": { light: 88, dark: 22 },
  "surface-variant": { light: 90, dark: 26 },
};

/** `#rrggbb` / `rrggbb` → 规范化 hex；非法返回 null（不抛，调用方沿用兜底色） */
export function normalizeSeedHex(seed: string): string | null {
  const trimmed = seed.trim();
  return /^#?[0-9a-fA-F]{6}$/.test(trimmed) ? `#${trimmed.replace(/^#/, "").toLowerCase()}` : null;
}

/**
 * 由一个种子色生成整套 M3 颜色令牌。
 *
 * @param seed 种子色（`#1A5C9E` 或 `1a5c9e`）
 * @param dark 是否深色模式
 * @returns CSS 变量名 → `#rrggbb`；种子非法时返回空对象，调用方应沿用静态兜底
 */
export function schemeFromSeed(seed: string, dark: boolean): M3ColorMap {
  const hex = normalizeSeedHex(seed);
  if (!hex) return {};

  const scheme = new SchemeTonalSpot(
    Hct.fromInt(argbFromHex(hex)),
    dark,
    M3_SCHEME.contrastLevel,
    M3_SCHEME.specVersion,
    M3_SCHEME.platform,
  );

  // MaterialDynamicColors 在 0.4.x 是**实例** API（0.3.x 是静态属性）：
  // 每个角色是一个**方法**，调用后返回 DynamicColor 再取 ARGB。
  const colors = new MaterialDynamicColors() as unknown as Record<
    string,
    (() => { getArgb(s: unknown): number } | undefined) | undefined
  >;
  const out: M3ColorMap = {};
  for (const [name, api] of ROLE_MAP) {
    const dynamic = colors[api]?.();
    if (!dynamic) continue;
    out[`--md-sys-color-${name}`] = hexFromArgb(dynamic.getArgb(scheme));
  }
  return out;
}

/**
 * 无种子时（首屏 / 静态兜底）的整套令牌：种子取应用默认海蓝 `#1A5C9E`。
 * 供 `scripts/gen-m3-tokens.mjs` 生成 `src/tokens/theme.css` 的静态段，
 * 以及 Electron 主进程的窗口底色使用。
 */
export const DEFAULT_SEED_COLOR = "#1A5C9E";

/**
 * 只取一个角色的值（设置页色板预览用：展示「点这个种子会得到什么主色」）。
 * 比整表计算便宜，语义也明确。
 */
export function primaryOfSeed(seed: string, dark: boolean): string | null {
  const hex = normalizeSeedHex(seed);
  if (!hex) return null;
  const scheme = new SchemeTonalSpot(
    Hct.fromInt(argbFromHex(hex)),
    dark,
    M3_SCHEME.contrastLevel,
    M3_SCHEME.specVersion,
    M3_SCHEME.platform,
  );
  const colors = new MaterialDynamicColors() as unknown as {
    primary(): { getArgb(s: unknown): number };
  };
  return hexFromArgb(colors.primary().getArgb(scheme)).toLowerCase();
}

/**
 * 本应用**实际写进 DOM / CSS** 的整套令牌：MCU 规范值 + 项目语义覆盖。
 *
 * 与 `schemeFromSeed()` 的区别：后者是 MCU 的纯规范输出（单测拿它验算法），
 * 前者才是 UI 使用的值（`scrim` 被换成半透明）。两者分开，
 * 是为了「规范真值」与「产品取舍」不混在一起、后续能各自演进。
 */
export function cssTokensFromSeed(seed: string, dark: boolean): M3ColorMap {
  const hex = normalizeSeedHex(seed);
  if (!hex) return {};
  const scheme = schemeFromSeed(hex, dark);
  const source = Hct.fromInt(argbFromHex(hex));
  const mode = dark ? "dark" : "light";
  const surfaces = TonalPalette.fromHueAndChroma(
    source.hue,
    Math.min(source.chroma, SURFACE_CHROMA[mode]),
  );
  for (const [role, tones] of Object.entries(SURFACE_TONES)) {
    scheme["--md-sys-color-" + role] = hexFromArgb(surfaces.tone(tones[mode]));
  }
  for (const [token, pair] of Object.entries(TOKEN_OVERRIDES)) {
    scheme[token] = dark ? pair.dark : pair.light;
  }
  for (const [token, pair] of Object.entries(ACCENT_ROLES)) {
    scheme[token] = dark ? pair.dark : pair.light;
  }
  return scheme;
}

/**
 * 种子色**以外**的固定色（M3 角色表里没有、但产品语义需要）。
 *
 * 它们是「有固定含义」的颜色，不能跟着种子色漂移 —— 成功永远是绿，
 * 提示永远是琥珀，超链接永远是蓝。取值口径与 M3 的 primary/error 一致：
 * 浅色取 tone 40、深色取 tone 80，对 surface（tone 98/4）的对比度 ≈ 6.1 / 11.3，
 * 满足 WCAG AA。色相/彩度用 HCT 定死（success H150/C32、warning H75/C48、link H265/C40）。
 */
export const ACCENT_ROLES: Record<string, { light: string; dark: string }> = {
  // Hct.from(150, 32, 40) / Hct.from(150, 32, 80)
  "--md-sys-color-success": { light: "#3d6842", dark: "#a2d2a3" },
  // Hct.from(75, 48, 40) / Hct.from(75, 48, 80)
  "--md-sys-color-warning": { light: "#825500", dark: "#ffb94e" },
  // Hct.from(265, 40, 40) / Hct.from(265, 40, 80)
  "--md-sys-color-link": { light: "#3d5e98", dark: "#acc7ff" },
};

/** 便捷封装：默认种子色 → 令牌（实际写进 DOM 的版本） */
export function defaultScheme(dark: boolean): M3ColorMap {
  return cssTokensFromSeed(DEFAULT_SEED_COLOR, dark);
}
