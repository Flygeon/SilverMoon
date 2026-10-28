/**
 * M3 动态配色内核与令牌层的一致性守卫。
 *
 * 覆盖三件事：
 * 1. 内核算法口径（Tonal Spot · 2025 spec · phone · 标准对比度）没被悄悄改掉；
 * 2. theme.css 的静态段与内核输出**逐字节一致**（手改令牌会被挡下）；
 * 3. theme.css 里出现的每个 `--md-sys-color-*` 都在内核角色表内，
 *    且皮肤白名单与内核角色表同步（少一个就说明有人只改了一边）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Contrast, Hct, argbFromHex } from "@material/material-color-utilities";
import {
  ACCENT_ROLES,
  DEFAULT_SEED_COLOR,
  M3_COLOR_ROLES,
  M3_SCHEME,
  TOKEN_OVERRIDES,
  SURFACE_TONES,
  cssTokensFromSeed,
  defaultScheme,
  normalizeSeedHex,
  primaryOfSeed,
  schemeFromSeed,
} from "@shared/m3-theme";
import { COLOR_TOKENS } from "@/utils/skinSchema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.join(HERE, "..", "..", "tokens", "theme.css");

/** 从 theme.css 的某个选择器块里取出 `--md-sys-color-*` 键值 */
function tokensOf(css: string, blockStart: string): Record<string, string> {
  const start = css.indexOf(blockStart);
  expect(start, `theme.css 缺少块：${blockStart}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const out: Record<string, string> = {};
  const re = /\s(--md-sys-color-[a-z-]+):\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2].trim();
  return out;
}

describe("M3 配色口径", () => {
  it("方案固定为 Tonal Spot / 2025 spec / phone / 标准对比度", () => {
    expect(M3_SCHEME.variant).toBe("tonal-spot");
    expect(M3_SCHEME.specVersion).toBe("2025");
    expect(M3_SCHEME.platform).toBe("phone");
    expect(M3_SCHEME.contrastLevel).toBe(0);
  });

  it("默认种子色为项目蓝", () => {
    expect(DEFAULT_SEED_COLOR).toBe("#1A5C9E");
  });

  it("覆盖 2025 spec 全部颜色角色（含 4 个 dim 与 fixed 系列）", () => {
    const light = schemeFromSeed(DEFAULT_SEED_COLOR, false);
    for (const role of M3_COLOR_ROLES) {
      expect(light[`--md-sys-color-${role}`], `缺少角色 ${role}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // 2025 spec 新增的 4 个 dim 角色必须存在
    for (const role of ["primary-dim", "secondary-dim", "tertiary-dim", "error-dim"]) {
      expect(M3_COLOR_ROLES).toContain(role);
    }
  });

  it("同一输入结果稳定（纯函数，无隐藏状态）", () => {
    expect(schemeFromSeed("#1A5C9E", true)).toEqual(schemeFromSeed("#1A5C9E", true));
  });

  it("种子非法时返回空表，调用方沿用静态兜底", () => {
    expect(schemeFromSeed("not-a-color", false)).toEqual({});
    expect(normalizeSeedHex("#abc")).toBeNull();
    expect(normalizeSeedHex("1A5C9E")).toBe("#1a5c9e");
  });

  it("primaryOfSeed 与整表计算的主色一致（设置页色板预览不能算错）", () => {
    for (const seed of ["#1A5C9E", "#00696E", "#6750A4", "#8F4C00"]) {
      for (const dark of [false, true]) {
        expect(primaryOfSeed(seed, dark)).toBe(
          schemeFromSeed(seed, dark)["--md-sys-color-primary"],
        );
      }
    }
  });
});

describe("theme.css 与内核一致", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it("浅色静态段 = 内核输出（改令牌必须重跑生成器）", () => {
    const expected = defaultScheme(false);
    const actual = tokensOf(css, ":root {");
    for (const [token, value] of Object.entries(expected)) {
      expect(actual[token], `浅色段缺少/漂移：${token}`).toBe(value);
    }
  });

  it("深色静态段 = 内核输出", () => {
    const expected = defaultScheme(true);
    const actual = tokensOf(css, '[data-theme="dark"] {');
    for (const [token, value] of Object.entries(expected)) {
      expect(actual[token], `深色段缺少/漂移：${token}`).toBe(value);
    }
  });

  it("theme.css 里没有内核角色表之外的令牌（防止手写野令牌）", () => {
    const known = new Set([
      ...M3_COLOR_ROLES.map((r) => `--md-sys-color-${r}`),
      ...Object.keys(TOKEN_OVERRIDES),
      ...Object.keys(ACCENT_ROLES),
    ]);
    for (const token of [
      ...Object.keys(tokensOf(css, ":root {")),
      ...Object.keys(tokensOf(css, '[data-theme="dark"] {')),
    ]) {
      expect(known.has(token), `未登记的颜色令牌：${token}`).toBe(true);
    }
  });

  it("scrim 保持半透明（项目语义：蒙层不能被不透明黑顶掉）", () => {
    expect(defaultScheme(false)["--md-sys-color-scrim"]).toMatch(/^rgba\(/);
    expect(defaultScheme(true)["--md-sys-color-scrim"]).toMatch(/^rgba\(/);
  });
});

describe("随种子变化的有色表面", () => {
  const seeds = ["#1A5C9E", "#00696E", "#6750A4", "#4C662B", "#8F4C00", "#B3261E", "#8B4A6C"];
  const hct = (hex: string) => Hct.fromInt(argbFromHex(hex));

  it("背景有可辨认的主题色，且切换种子会更新整个表面色阶", () => {
    for (const dark of [false, true]) {
      const backgrounds = new Set<string>();
      for (const seed of seeds) {
        const actual = cssTokensFromSeed(seed, dark);
        const background = actual["--md-sys-color-background"];
        backgrounds.add(background);
        const official = schemeFromSeed(seed, dark)["--md-sys-color-background"];
        expect(hct(background).chroma).toBeGreaterThan(hct(official).chroma);
        expect(background).toBe(actual["--md-sys-color-surface"]);
        for (const [role, tones] of Object.entries(SURFACE_TONES)) {
          expect(hct(actual["--md-sys-color-" + role]).tone).toBeCloseTo(
            dark ? tones.dark : tones.light,
            0,
          );
        }
      }
      expect(backgrounds.size).toBe(seeds.length);
    }
  });

  it("七种预设的明暗表面均保留正文和次要文字的 AA 对比度", () => {
    for (const seed of seeds) {
      for (const dark of [false, true]) {
        const actual = cssTokensFromSeed(seed, dark);
        for (const role of Object.keys(SURFACE_TONES)) {
          const background = hct(actual["--md-sys-color-" + role]).tone;
          for (const text of ["on-surface", "on-surface-variant"]) {
            const ratio = Contrast.ratioOfTones(
              background,
              hct(actual["--md-sys-color-" + text]).tone,
            );
            expect(ratio, seed + "/" + dark + "/" + role + "/" + text).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  it("强调色仍使用官方算法，低彩度种子不被强行染色", () => {
    for (const dark of [false, true]) {
      const actual = cssTokensFromSeed(DEFAULT_SEED_COLOR, dark);
      const official = schemeFromSeed(DEFAULT_SEED_COLOR, dark);
      for (const role of ["primary", "secondary", "tertiary", "error"]) {
        expect(actual["--md-sys-color-" + role]).toBe(official["--md-sys-color-" + role]);
      }
      const gray = cssTokensFromSeed("#777777", dark);
      expect(hct(gray["--md-sys-color-background"]).chroma).toBeLessThan(4);
    }
    expect(cssTokensFromSeed("invalid", false)).toEqual({});
  });
});

describe("皮肤白名单与内核同步", () => {
  it("内核角色都在皮肤白名单内（shadow/scrim 除外）", () => {
    const excluded = new Set(["--md-sys-color-shadow", "--md-sys-color-scrim"]);
    for (const token of Object.keys(defaultScheme(false))) {
      if (excluded.has(token)) continue;
      expect(COLOR_TOKENS.has(token), `白名单缺少 ${token}`).toBe(true);
    }
  });

  it("shadow / scrim 不在白名单（皮肤不许改蒙层与投影）", () => {
    expect(COLOR_TOKENS.has("--md-sys-color-shadow")).toBe(false);
    expect(COLOR_TOKENS.has("--md-sys-color-scrim")).toBe(false);
  });
});
