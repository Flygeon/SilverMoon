/**
 * 校验「扩展插槽」的两份清单一致。
 *
 * ## 为什么要它
 *
 * 插槽白名单存在两份，各有用途，缺一不可：
 *
 *   Rust \`commands/extension.rs\` 的 \`SLOT_IDS\` —— **安装时校验**（写错的插槽名直接拒绝安装）
 *   TS   \`src/utils/extSlots.ts\` 的 \`EXT_SLOT_IDS\` —— 前端据此**渲染**
 *
 * 两侧一旦漂移，症状是**「扩展装得上，但挂到那个插槽的东西一个都不显示」** ——
 * 不报错、不崩溃，只是什么都不发生。这是最难查的一类问题，所以钉成 CI 守卫。
 *
 * 顺带还能抓出「白名单里有、但宿主根本没渲染」的插槽（反向检查见下）。
 *
 * 用法：node scripts/verify-ext-slots.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Rust 侧：从 SLOT_IDS 常量里抠出字符串字面量 */
function readRustSlots() {
  const src = readFileSync(join(ROOT, "src-tauri", "src", "commands", "extension.rs"), "utf8");
  const start = src.indexOf("pub const SLOT_IDS");
  if (start === -1) throw new Error("extension.rs 里找不到 SLOT_IDS");
  const end = src.indexOf("];", start);
  if (end === -1) throw new Error("SLOT_IDS 没有正常结束");
  const body = src.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** TS 侧：从 EXT_SLOT_IDS 数组里抠出字符串字面量 */
function readTsSlots() {
  const src = readFileSync(join(ROOT, "src", "utils", "extSlots.ts"), "utf8");
  const start = src.indexOf("export const EXT_SLOT_IDS");
  if (start === -1) throw new Error("extSlots.ts 里找不到 EXT_SLOT_IDS");
  const end = src.indexOf("] as const", start);
  if (end === -1) throw new Error("EXT_SLOT_IDS 没有正常结束");
  const body = src.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 扫前端源码里真实出现的 \`<ExtensionSlot slot="..."\`。
 *
 * 白名单里有、但哪里都没渲染的插槽 = 「声明了没人读」，扩展挂上去会静默消失。
 * 这类只能靠扫源码发现 —— 组件是运行时按 slot 名过滤的。
 */
function readRenderedSlots() {
  const found = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        walk(p);
      } else if (/\.vue$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(/<ExtensionSlot[^>]*slot="([^"]+)"/g)) found.add(m[1]);
      }
    }
  };
  walk(join(ROOT, "src"));
  return [...found].sort();
}

const rust = readRustSlots().sort();
const ts = readTsSlots().sort();
const rendered = readRenderedSlots();

let failed = false;
const diff = (label, a, b) => {
  const onlyA = a.filter((x) => !b.includes(x));
  const onlyB = b.filter((x) => !a.includes(x));
  if (onlyA.length === 0 && onlyB.length === 0) {
    console.log(`  \u2713 ${label}一致（${a.length} 项）`);
    return true;
  }
  failed = true;
  if (onlyA.length) console.error(`  \u2717 ${label}：只有前者有 → ${onlyA.join(", ")}`);
  if (onlyB.length) console.error(`  \u2717 ${label}：只有后者有 → ${onlyB.join(", ")}`);
  return false;
};

console.log(
  `[ext-slots] Rust ${rust.length} 项 / TS ${ts.length} 项 / 前端渲染点 ${rendered.length} 个`,
);
diff("Rust SLOT_IDS ↔ TS EXT_SLOT_IDS", rust, ts);

// 白名单里的每一项都得真有 <ExtensionSlot slot="..."/> 渲染它
const notRendered = rust.filter((s) => !rendered.includes(s));
if (notRendered.length) {
  failed = true;
  console.error(
    "  \u2717 白名单里有插槽没有任何渲染点（挂上去会静默不显示）：" + notRendered.join(", "),
  );
} else {
  console.log("  \u2713 白名单每一项都有真实渲染点");
}

if (failed) {
  console.error("\n[ext-slots] 插槽清单不一致 —— 修好再加插槽，否则扩展会「装得上但看不到」");
  process.exit(1);
}
console.log("\n[ext-slots] 通过");
