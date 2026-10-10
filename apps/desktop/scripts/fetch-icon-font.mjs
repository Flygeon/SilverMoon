/**
 * 生成 Material Symbols 图标字体的**子集**。
 *
 * ## 为什么要子集化
 *
 * 原字体 material-symbols-rounded.woff2 是官方**全量可变字体，5.2 MB**。
 * 应用只用到两百多个图标，却要每次都把这 5.2 MB 读进来解析——表现为
 * 「窗口出来了但图标要等一会儿才齐」。子集化后约 72 KB，省 98.6%。
 *
 * ## 怎么收集图标名（宁多勿漏）
 *
 * 不做「只认 <span class="material-symbols-outlined">xxx</span>」这种精确匹配，
 * 因为图标名还会出现在三元表达式、查表（TYPE_ICONS / themeIconMap）、
 * icon: "..." 数据定义里，精确匹配很容易漏——**漏一个就是界面上缺一个图标**。
 *
 * 这里用「超集 + 过滤」，两条规则取并集，再与官方 4301 个图标名取交集：
 *
 *   规则 1：**带引号的字符串字面量**。覆盖 icon: "..."、三元表达式
 *           （如 {{ a ? "check" : "close" }}）、查表取值（TYPE_ICONS / themeIconMap）。
 *   规则 2：**<span class="material-symbols-outlined">NAME</span> 的元素文本**。
 *
 * ⚠️ 规则 2 绝不能省：实测有 **59 个图标只以元素文本形式出现**
 * （arrow_back / chevron_left / sync / delete_sweep / input / logout …），
 * 只认引号会把它们全部漏掉——而漏一个就是界面上缺一个图标。
 * 反之递归地看，规则 1 覆盖了规则 2 覆盖不到的动态取值。
 *
 * 两规则并集再过滤掉 true / vue / app_log 这类噪音，结果就是
 * **「代码里写过的所有真实图标名」的精确超集**。
 *
 * ## 用法
 *
 *   node scripts/fetch-icon-font.mjs           重新生成字体 + manifest
 *   node scripts/fetch-icon-font.mjs --check   只校验 manifest 是否与源码同步（离线）
 *
 * 新增/修改图标后需要重跑一次；--check 已接入 CI，漏跑会被拦住。
 *
 * ## 可变轴为什么钉死
 *
 * 官方全轴（opsz 20..48 / wght 100..700 / FILL 0..1 / GRAD -50..200）子集后仍有
 * 196 KB。按项目实际用到的取值范围收窄后降到 72 KB：
 *   opsz = 24       两处 font-variation-settings 都写死 24
 *   wght = 300..500 实测只用到 300 / 400 / 500
 *   FILL = 0..1     普通态与 .filled 态
 *   GRAD = 0        .material-symbols-outlined 显式覆盖为 0（body 的 -25 不影响图标）
 * 若将来用到这里没覆盖的字重或轴值，需要同步放宽本文件的 AXES 常量。
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DATA = join(ROOT, "scripts", "data", "material-symbols-codepoints.txt");
const OUT_FONT = join(SRC, "assets", "fonts", "material-symbols-rounded.woff2");
const OUT_MANIFEST = join(SRC, "assets", "fonts", "material-symbols-icons.json");

/** 可变轴取值：见文件头「可变轴为什么钉死」。 */
const AXES = "opsz,wght,FILL,GRAD@24,300..500,0..1,0";
/** 必须带浏览器 UA，否则 Google Fonts 只给 truetype 而非 woff2。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 递归收集参与扫描的源文件。
 *
 * ⚠️ **必须排除测试文件**：测试里会写 `{ Cookie: "SESSDATA=..." }` 这类字符串，
 * 而 `cookie` 恰好也是合法的 Material Symbols 图标名 —— 收进来会让字体多烘一个
 * 永远用不到的图标，更糟的是 `--check` 会误报「不同步」，逼人重跑脚本。
 * （真实踩过：加了一条 HTTP 头断言，CI 的图标校验就红了。）
 */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      out.push(...(await walk(p)));
    } else if (/\.(vue|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 官方图标名集合（忽略 # 注释行）。 */
async function loadOfficial() {
  const text = await readFile(DATA, "utf8");
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

/** 扫描源码，返回「代码里写过的真实图标名」有序数组。 */
async function collectIcons() {
  const official = await loadOfficial();
  const found = new Set();
  // 规则 1：带引号的字面量（动态取值、查表、三元表达式里的图标名）
  const reQuoted = new RegExp("[\"']([a-z][a-z0-9_]{1,40})[\"']", "g");
  // 规则 2：元素文本形式的图标名（见文件头——这条漏了会缺 59 个图标）
  const reSpanText = /material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]*)\s*</g;
  for (const file of await walk(SRC)) {
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(reQuoted)) {
      if (official.has(m[1])) found.add(m[1]);
    }
    for (const m of text.matchAll(reSpanText)) {
      if (official.has(m[1])) found.add(m[1]);
    }
  }
  return [...found].sort();
}

async function fetchSubset(icons) {
  const url =
    "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:" +
    AXES +
    "&icon_names=" +
    icons.join(",");
  const cssRes = await fetch(url, { headers: { "User-Agent": UA } });
  if (!cssRes.ok) throw new Error("取 CSS 失败：HTTP " + cssRes.status);
  const css = await cssRes.text();
  const fontUrl = css.match(/url\((https:[^)]+)\)/)?.[1];
  if (!fontUrl) throw new Error("CSS 里没有字体 URL：\n" + css.slice(0, 400));
  const fontRes = await fetch(fontUrl, { headers: { "User-Agent": UA } });
  if (!fontRes.ok) throw new Error("取字体失败：HTTP " + fontRes.status);
  return Buffer.from(await fontRes.arrayBuffer());
}

const icons = await collectIcons();
if (!icons.length) {
  throw new Error("没扫到任何图标名，扫描规则可能失效——已中止，避免写入空字体");
}

if (process.argv.includes("--check")) {
  let prev;
  try {
    prev = JSON.parse(await readFile(OUT_MANIFEST, "utf8"));
  } catch {
    console.error(
      "✗ 找不到 " + relative(ROOT, OUT_MANIFEST) + "，请先跑 node scripts/fetch-icon-font.mjs",
    );
    process.exit(1);
  }
  const have = new Set(prev.icons ?? []);
  const added = icons.filter((i) => !have.has(i));
  const removed = [...have].filter((i) => !icons.includes(i));
  if (added.length || removed.length) {
    console.error("✗ 图标字体与源码不同步：");
    if (added.length) console.error("    新增（这些图标会显示不出来）：" + added.join(" "));
    if (removed.length) console.error("    已不再使用：" + removed.join(" "));
    console.error("  请运行：node scripts/fetch-icon-font.mjs");
    process.exit(1);
  }
  console.log("✓ 图标字体与源码同步（" + icons.length + " 个图标）");
  process.exit(0);
}

const before = await readFile(OUT_FONT)
  .then((b) => b.length)
  .catch(() => 0);
const buf = await fetchSubset(icons);
await writeFile(OUT_FONT, buf);
await writeFile(
  OUT_MANIFEST,
  JSON.stringify(
    {
      note: "由 scripts/fetch-icon-font.mjs 生成，请勿手改；新增图标后重跑该脚本。",
      axes: AXES,
      icons,
    },
    null,
    2,
  ) + "\n",
);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log("✓ 图标字体已生成：" + icons.length + " 个图标");
console.log(
  "  体积：" +
    (before ? kb(before) + " → " : "") +
    kb(buf.length) +
    (before ? "（省 " + (100 - (buf.length / before) * 100).toFixed(1) + "%）" : ""),
);
