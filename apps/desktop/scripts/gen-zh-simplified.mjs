#!/usr/bin/env node
/**
 * 重新生成 `shared/zhSimplified.ts` 的繁体→简体字表。
 *
 * 数据源是 music-tag-web 项目里的 zhconv 词典（component/zhconv/zhcdict.json），
 * 我们只取其中「基本汉字区、一对一」的映射，因此产物很小（约 3.3k 对 / 20KB），
 * 可以直接内联进渲染层，不必引入运行时依赖。
 *
 * 用法（需要先有一份 zhconv 词典）：
 *   node scripts/gen-zh-simplified.mjs /path/to/zhcdict.json
 *
 * 获取词典：
 *   git clone --depth 1 https://github.com/xhongc/music-tag-web /tmp/music-tag-web
 *   node scripts/gen-zh-simplified.mjs /tmp/music-tag-web/component/zhconv/zhcdict.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];

if (!source) {
  console.error("用法：node scripts/gen-zh-simplified.mjs <zhcdict.json 路径>");
  process.exit(1);
}

const dict = JSON.parse(readFileSync(source, "utf8"));
const table = dict?.zh2Hans;
if (!table || typeof table !== "object") {
  console.error("词典缺少 zh2Hans 表，无法生成。");
  process.exit(1);
}

const isHan = (ch) => {
  const code = ch.codePointAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
};

const pairs = Object.entries(table)
  .filter(
    ([from, to]) =>
      typeof to === "string" &&
      from !== to &&
      from.length === 1 &&
      to.length === 1 &&
      isHan(from) &&
      isHan(to),
  )
  .sort(([a], [b]) => (a < b ? -1 : 1));

const trad = pairs.map(([from]) => from).join("");
const simp = pairs.map(([, to]) => to).join("");

const out = `/**
 * 繁体 → 简体 字符表（供「写音乐标签」的候选匹配做归一化用）。
 *
 * 语料来自 music-tag-web 的 zhconv 词典（component/zhconv/zhcdict.json），
 * 这里只抽取「基本汉字区内、一对一」的映射：标点与扩展区生僻字已剔除，
 * 因此表很小（${pairs.length} 对），可以直接内联进渲染层，不引入运行时依赖。
 *
 * 生成方式见 scripts/gen-zh-simplified.mjs。索引对应：TRAD[i] → SIMP[i]。
 */
const TRAD = "${trad}";
const SIMP = "${simp}";

const MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (let i = 0; i < TRAD.length; i += 1) map.set(TRAD[i], SIMP[i]);
  return map;
})();

/** 逐字把繁体转简体；非繁体字原样保留。 */
export function toSimplified(text: string): string {
  let out = "";
  for (const ch of text) out += MAP.get(ch) ?? ch;
  return out;
}
`;

const target = path.join(root, "shared", "zhSimplified.ts");
writeFileSync(target, out, "utf8");
console.log(`已生成 ${target}（${pairs.length} 对映射）`);
