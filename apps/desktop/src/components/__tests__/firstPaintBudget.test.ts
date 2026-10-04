/**
 * 首屏加载预算回归测试。
 *
 * 背景（真实故障，首屏凭空多拉 416KB）：
 * pako / qrcode 是 CJS，经 `App.vue → player → netease/kugou` 被**静态**拉进入口
 * chunk，它们需要 Rollup 的 `interopDefault` 助手（几十字节）。不开
 * `onlyExplicitManualChunks` 时，Rollup 会把这个助手塞进它选中的任意命名块 ——
 * 实测塞进了 amll-bg，于是入口出现真静态依赖
 * `import{g as _S}from"./amll-bg-*.js"`，Vite 顺手在 index.html 加了
 * `<link rel="modulepreload" href=".../amll-bg-*.js">`，416KB 的 AMLL 包在首帧
 * 就被下载，「切到 AMLL 引擎才加载」彻底失效。
 *
 * 判定策略：**点名重块黑名单**（精确、不会因体积阈值宽松而漏判）+ **体积兜底**。
 * 只看体积阈值是不够的：amll-bg 只有 416KB，阈值若放到 600KB 就漏了（踩过）。
 *
 * 分两层钉住：
 * 1. 构建配置（不依赖 dist 是否已构建）；
 * 2. 构建产物（dist 存在时才跑）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** __dirname = <app>/src/components/__tests__ → 退三级到 <app> */
const appRoot = path.resolve(__dirname, "..", "..", "..");

function read(relative: string): string {
  return readFileSync(path.resolve(appRoot, relative), "utf8");
}

/**
 * 绝不允许出现在首屏加载图里的重块（chunk 名前缀）。
 * 它们都应是「进对应页面 / 切对应引擎」才动态加载。
 */
const HEAVY_CHUNK_PREFIXES = [
  "amll-bg", // AMLL 背景引擎（AMLL core + @pixi/*）
  "anime-player", // artplayer + 弹幕插件
  "pdf-viewer", // pdfjs
  "epub-reader", // epubjs
  "drawing", // leafer
  "hls", // hls.js
];

/** 体积兜底：首屏允许预加载的单块上限（KB）。只有几十字节的互操作助手该在这里。 */
const FIRST_PAINT_BUDGET_KB = 64;

/** 从形如 `.../assets/name-hash.js` 的 URL 里取 chunk 名（去掉 hash 与扩展名） */
function chunkNameOf(href: string): string {
  const base = href.split("/").pop() ?? "";
  return base.replace(/\.js$/, "").replace(/-[A-Za-z0-9_-]{8}$/, "");
}

const distIndex = path.resolve(appRoot, "dist/index.html");
const hasDist = existsSync(distIndex);

/** 首屏会被加载的块：index.html 的 modulepreload + 入口的静态 import */
function firstPaintChunks(): { href: string; kb: number }[] {
  const html = readFileSync(distIndex, "utf8");
  const out: { href: string; kb: number }[] = [];

  const push = (href: string) => {
    const file = path.resolve(appRoot, "dist", href.replace(/^\//, ""));
    if (!existsSync(file)) return;
    out.push({ href, kb: readFileSync(file).byteLength / 1024 });
  };

  for (const tag of html.match(/<link[^>]*modulepreload[^>]*>/g) ?? []) {
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (href) push(href);
  }

  const entry = /src="\/assets\/([^"]+)\.js"/.exec(html)?.[1];
  if (entry) {
    const src = readFileSync(path.resolve(appRoot, "dist/assets", `${entry}.js`), "utf8");
    for (const stmt of src.match(/import\{[^}]*\}from"\.\/([^"]+)\.js";/g) ?? []) {
      const rel = /from"\.\/([^"]+)\.js"/.exec(stmt)?.[1];
      if (rel) push(`/assets/${rel}.js`);
    }
  }
  return out;
}

describe("首屏加载预算", () => {
  it("vite 配置开启了 onlyExplicitManualChunks（否则互操作助手会污染命名块）", () => {
    expect(read("vite.config.ts")).toMatch(/onlyExplicitManualChunks:\s*true/);
  });

  it("vite 配置仍把重依赖列为独立块（按需加载目标不能被删掉）", () => {
    const config = read("vite.config.ts");
    for (const name of ["amll-bg", "anime-player", "pdf-viewer", "epub-reader", "drawing"]) {
      expect(config, `manualChunks 里应有 ${name}`).toContain(`"${name}"`);
    }
  });

  it("首屏加载图不得包含任何重块（dist 未构建时跳过）", () => {
    if (!hasDist) return;
    const offenders = firstPaintChunks().filter((c) =>
      HEAVY_CHUNK_PREFIXES.some(
        (p) => chunkNameOf(c.href) === p || chunkNameOf(c.href).startsWith(p),
      ),
    );
    expect(
      offenders.map((o) => o.href),
      "这些重块被首屏加载了（应改为动态 import 按需加载）",
    ).toEqual([]);
  });

  it("首屏预加载的块体积都在预算内（dist 未构建时跳过）", () => {
    if (!hasDist) return;
    for (const c of firstPaintChunks()) {
      expect(
        c.kb,
        `${c.href} 被首屏加载且体积 ${Math.round(c.kb)}KB，超出 ${FIRST_PAINT_BUDGET_KB}KB 预算`,
      ).toBeLessThan(FIRST_PAINT_BUDGET_KB);
    }
  });

  it("重块仍作为独立产物存在（按需加载时能取到，dist 未构建时跳过）", () => {
    if (!hasDist) return;
    const assetsDir = path.resolve(appRoot, "dist/assets");
    const files = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
    // amll-bg 必须有产物，否则「切到 AMLL 引擎」会 404
    expect(files.some((f: string) => f.startsWith("amll-bg-") && f.endsWith(".js"))).toBe(true);
  });
});
