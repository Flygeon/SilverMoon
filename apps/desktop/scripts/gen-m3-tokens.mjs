/**
 * 生成 M3 静态配色令牌 → `src/tokens/theme.css` 的两个「M3 Color Tokens」段落。
 *
 * ## 为什么是生成
 *
 * 配色在运行时由 `shared/m3-theme.ts` 的 cssTokensFromSeed() 算出（跟随用户种子色），
 * 但首屏在设置读盘之前就要有颜色，所以 theme.css 必须有一份**与算法一致**的静态兜底。
 * 手抄一份必然漂移 —— 本次接入生成器之前，theme.css 里 34 个令牌与 MCU 算法输出对不上，
 * 其中 `--md-sys-color-surface-container-high` 还是 `#eceee0` 这种偏黄的错值。
 *
 * ## 段落标记
 *
 * 生成器只替换下面这对注释之间的内容，段落外（字体/圆角/动效/应用级令牌）原样保留：
 *
 *   /* ---- M3 Color Tokens (generated) ...  *\/
 *   …生成的 --md-sys-color-*  …
 *   /* ---- /M3 Color Tokens ---- *\/
 *
 * 文件里有两段：`:root` 里的浅色、`[data-theme="dark"]` 里的深色，按出现顺序处理。
 *
 * ## 用法
 *
 *   node scripts/gen-m3-tokens.mjs            # 重写 theme.css 的色令牌段
 *   node scripts/gen-m3-tokens.mjs --check    # 只校验是否一致（CI / 单测用）
 *
 * 生成口径见 shared/m3-theme.ts 的 M3_SCHEME：
 * **Tonal Spot · M3 Expressive color spec 2025 · phone · 标准对比度（0）**。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const KERNEL = path.join(ROOT, "shared", "m3-theme.ts");
const CSS = path.join(ROOT, "src", "tokens", "theme.css");

/** 段落主标记（两段共用；按出现顺序 = 浅色、深色） */
const BLOCK_RE =
  /\/\* ---- M3 Color Tokens \(generated\)[\s\S]*?\/\* ---- \/M3 Color Tokens ---- \*\//g;

/** 每个段落开头的注释正文（浅/深各一份，说明该段的来源与口径） */
const HEADERS = [
  [
    "本段由 scripts/gen-m3-tokens.mjs 生成，勿手改（改算法请改 shared/m3-theme.ts）。",
    "口径：Tonal Spot · M3 Expressive color spec 2025 · phone · 标准对比度（0）。",
    "种子取 DEFAULT_SEED_COLOR；运行时由动态配色把整套令牌内联覆盖。",
  ],
  [
    "同一个种子色的深色方案，口径同上（2025 spec 的深色 tone 曲线）。",
    "换种子色 / 换深浅时整套令牌由 cssTokensFromSeed() 重算并内联写入。",
  ],
];

/** 语义分组：生成时按此顺序排出，便于人工浏览与 diff。 */
const GROUPS = [
  {
    title: "primary",
    roles: [
      "primary",
      "primary-dim",
      "on-primary",
      "primary-container",
      "on-primary-container",
      "inverse-primary",
    ],
  },
  {
    title: "secondary",
    roles: [
      "secondary",
      "secondary-dim",
      "on-secondary",
      "secondary-container",
      "on-secondary-container",
    ],
  },
  {
    title: "tertiary",
    roles: [
      "tertiary",
      "tertiary-dim",
      "on-tertiary",
      "tertiary-container",
      "on-tertiary-container",
    ],
  },
  {
    title: "error",
    roles: ["error", "error-dim", "on-error", "error-container", "on-error-container"],
  },
  {
    title: "surface",
    roles: [
      "background",
      "on-background",
      "surface",
      "surface-dim",
      "surface-bright",
      "surface-container-lowest",
      "surface-container-low",
      "surface-container",
      "surface-container-high",
      "surface-container-highest",
      "surface-variant",
      "on-surface",
      "on-surface-variant",
      "outline",
      "outline-variant",
      "inverse-surface",
      "inverse-on-surface",
      "surface-tint",
    ],
  },
  {
    title: "fixed",
    roles: [
      "primary-fixed",
      "primary-fixed-dim",
      "on-primary-fixed",
      "on-primary-fixed-variant",
      "secondary-fixed",
      "secondary-fixed-dim",
      "on-secondary-fixed",
      "on-secondary-fixed-variant",
      "tertiary-fixed",
      "tertiary-fixed-dim",
      "on-tertiary-fixed",
      "on-tertiary-fixed-variant",
    ],
  },
  // 语义扩展色：M3 角色表之外、由产品语义固定下来的颜色（内核 ACCENT_ROLES）
  { title: "semantic", roles: ["success", "warning", "link"] },
  // 蒙层 / 投影：值由内核 TOKEN_OVERRIDES 决定（scrim 是半透明，不是纯黑）
  { title: "scrim & shadow", roles: ["scrim", "shadow"] },
];

/** 用 esbuild 把内核（TS + MCU）打成一份临时 ESM，再 import 取函数。 */
async function loadKernel() {
  const outDir = path.join(ROOT, "node_modules", ".cache", "m3-tokens");
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `kernel-${process.pid}.mjs`);
  await build({
    entryPoints: [KERNEL],
    bundle: true,
    outfile,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  try {
    return await import(new URL(`file://${outfile.replace(/\\/g, "/")}`).href);
  } finally {
    rmSync(outfile, { force: true });
  }
}

/** 渲染一段令牌（两空格缩进，符合 theme.css 的既有排版）。 */
function renderBlock(map) {
  const lines = [];
  const seen = new Set();
  for (const group of GROUPS) {
    const rows = [];
    for (const role of group.roles) {
      const cssVar = `--md-sys-color-${role}`;
      if (!(cssVar in map)) continue;
      seen.add(role);
      rows.push(`  ${cssVar}: ${map[cssVar]};`);
    }
    if (rows.length) lines.push(`  /* ${group.title} */`, ...rows);
  }
  // 兜底：内核新增但分组表还没登记的角色照样输出（否则会静默漏令牌）
  const extra = Object.keys(map)
    .map((k) => k.replace("--md-sys-color-", ""))
    .filter((role) => !seen.has(role));
  if (extra.length) {
    lines.push(
      "  /* extra（内核新增、尚未登记分组） */",
      ...extra.map((role) => `  --md-sys-color-${role}: ${map[`--md-sys-color-${role}`]};`),
    );
  }
  return lines.join("\n");
}

/** 组装一整段（含首尾标记与说明注释）。 */
function renderSection(index, map) {
  const header = HEADERS[index] ?? [];
  const intro = ["/* ---- M3 Color Tokens (generated) ----"];
  for (const line of header) intro.push(`   ${line}`);
  intro.push("*/");
  return [...intro, renderBlock(map), "  /* ---- /M3 Color Tokens ---- */"].join("\n");
}

/** 生成完整的 theme.css 文本（纯函数，供 --check 与单测比对）。 */
export function buildCss(kernel, css = readFileSync(CSS, "utf8")) {
  const blocks = [kernel.defaultScheme(false), kernel.defaultScheme(true)];
  let index = 0;
  const next = css.replace(BLOCK_RE, () => renderSection(index++, blocks[Math.min(index - 1, 1)]));
  if (index !== 2) {
    throw new Error(`theme.css 里应有 2 段「M3 Color Tokens (generated)」，实际 ${index} 段`);
  }
  return next;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const kernel = await loadKernel();
  const prev = readFileSync(CSS, "utf8");
  const next = buildCss(kernel, prev);
  if (process.argv.includes("--check")) {
    if (prev !== next) {
      console.error("M3 色令牌已过期：请运行 npm run gen:m3-tokens 重新生成。");
      process.exit(1);
    }
    console.log(`M3 色令牌是最新的（${Object.keys(kernel.defaultScheme(false)).length} 个角色）`);
  } else {
    writeFileSync(CSS, next);
    console.log(
      `已写入 src/tokens/theme.css（${Object.keys(kernel.defaultScheme(false)).length} 个角色）`,
    );
  }
}
