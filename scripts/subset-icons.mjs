#!/usr/bin/env node
/**
 * 抽取源码里可能用到的 Material Symbols 图标名，产出两个清单：
 *
 *   src/assets/fonts/icons.txt         裁剪输入（**超集**，宁可多列不可漏列）
 *   src/assets/fonts/icons-verify.txt  校验输入（确认出现在图标位置上的名字）
 *
 * 为什么要「超集」：
 *   图标以连字（ligature）引用，名字写在模板或数据表里。数据表既有
 *   icon: "play_arrow" 这种可直接抽取的写法，也有 {{ item.icon }} 这种完全动态
 *   的用法——其取值最终仍是源码里的字面量，但散落在 TYPE_ICONS / themeIconMap
 *   之类的映射表里，靠模式匹配无法保证穷尽。
 *   漏掉一个图标名的后果是界面直接显示成字面文本（"play_arrow"），而构建与类型
 *   检查都发现不了；多列一个非图标字符串的代价只是多几个 ASCII 字母字形
 *   —— pyftsubset 的连字闭包只会为「确实匹配上的字符串」保留图标字形。
 *   所以这里对拿不准的一律收录。
 *
 * 用法：
 *   node scripts/subset-icons.mjs            # 重新生成两个清单
 *   node scripts/subset-icons.mjs --check    # 只校验（CI 用），不一致退出 1
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = path.join(ROOT, "src", "assets", "fonts");
const OUT_SUBSET = path.join(FONT_DIR, "icons.txt");
const OUT_VERIFY = path.join(FONT_DIR, "icons-verify.txt");
const EXTRA = path.join(FONT_DIR, "icons-extra.txt");
const SCAN_ROOTS = ["src", "shared"];
const EXTS = new Set([".vue", ".ts"]);

/** 确定出现在「图标位置」上的写法（用于裁剪后校验） */
const CONFIRMED = [
  // <span class="material-symbols-outlined ...">name</span>
  /material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]*)\s*</g,
  // 数据表：icon: "name" / icon: 'name'
  /\bicon\s*:\s*["']([a-z][a-z0-9_]*)["']/g,
  // 组件属性：icon="name"
  /\bicon\s*=\s*["']([a-z][a-z0-9_]*)["']/g,
  // 辅助函数：icon("name")
  /\bicon\(\s*["']([a-z][a-z0-9_]*)["']\s*\)/g,
];

/** 任何看起来像图标名的字符串字面量（超集来源，含映射表取值） */
const ANY_LITERAL = /["']([a-z][a-z0-9_]{2,})["']/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(name))) out.push(p);
  }
  return out;
}

function toLines(set) {
  return [...set].sort().join("\n") + "\n";
}

const confirmed = new Set();
const superset = new Set();
for (const root of SCAN_ROOTS) {
  const abs = path.join(ROOT, root);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs, [])) {
    const text = readFileSync(file, "utf8");
    for (const re of CONFIRMED) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) confirmed.add(m[1]);
    }
    ANY_LITERAL.lastIndex = 0;
    let m;
    while ((m = ANY_LITERAL.exec(text)) !== null) superset.add(m[1]);
  }
}

// 手工登记：完全动态、源码里没有字面量的图标名（正常应为空）
if (existsSync(EXTRA)) {
  for (const raw of readFileSync(EXTRA, "utf8").split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    confirmed.add(s);
    superset.add(s);
  }
}

const subsetBody =
  "# 由 scripts/subset-icons.mjs 生成，请勿手改。\n" +
  "# 裁剪输入（超集）：scripts/subset-icons.py 的 pyftsubset --text-file 读它。\n" +
  "# 需要补充图标名时请写 src/assets/fonts/icons-extra.txt，不要改本文件。\n" +
  toLines(superset);
const verifyBody =
  "# 由 scripts/subset-icons.mjs 生成，请勿手改。\n" +
  "# 校验输入：裁剪后必须仍能由连字产出这些名字，否则 subset-icons.py 直接失败。\n" +
  toLines(confirmed);

if (process.argv.includes("--check")) {
  const stale = [];
  const readOr = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  if (readOr(OUT_SUBSET) !== subsetBody) stale.push("icons.txt");
  if (readOr(OUT_VERIFY) !== verifyBody) stale.push("icons-verify.txt");
  if (stale.length) {
    console.error("图标清单与源码不一致：" + stale.join("、"));
    console.error("请运行：node scripts/subset-icons.mjs");
    process.exit(1);
  }
  console.log(
    "图标清单校验通过：超集 " + superset.size + " 个，确认图标 " + confirmed.size + " 个",
  );
} else {
  writeFileSync(OUT_SUBSET, subsetBody);
  writeFileSync(OUT_VERIFY, verifyBody);
  console.log("超集 " + superset.size + " 个 -> src/assets/fonts/icons.txt");
  console.log("确认图标 " + confirmed.size + " 个 -> src/assets/fonts/icons-verify.txt");
}
