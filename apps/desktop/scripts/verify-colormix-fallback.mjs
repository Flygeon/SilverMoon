/**
 * color-mix 回退的产物验收。
 *
 * ## 为什么要有这道闸门
 *
 * color-mix 的失败模式**完全静默**：Chromium < 111 不认识 `color-mix()`，
 * 只会把那条声明丢掉 —— 不报错、不警告，只在运行期表现为「一堆半透明元素变透明」。
 * 而开发机是 Chromium 132，**永远看不到这个问题**。所以必须对产物做静态断言。
 *
 * 检查两件互补的事：
 *
 * 1. **Win7 产物**（`SM_COLORMIX_FALLBACK=1` 构建）：CSS 里不得再有裸 `color-mix`；
 *    每一处都应变成 `var(--sm-mix-…, rgba(...))`，且兜底值是合法的 rgba。
 * 2. **现代产物**（默认构建）：CSS 里**必须保持** `color-mix`，且不得出现
 *    `--sm-mix-` —— 证明回退开关没有泄漏到正式版。
 *
 * 用法：
 *   node scripts/verify-colormix-fallback.mjs --mode=win7    # 检查 Win7 产物
 *   node scripts/verify-colormix-fallback.mjs --mode=modern  # 检查现代产物
 *   node scripts/verify-colormix-fallback.mjs                # 自动按产物特征判定
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length);
const failures = [];

function fail(msg) {
  console.log("  ✗ " + msg);
  failures.push(msg);
}
function ok(msg) {
  console.log("  ✓ " + msg);
}

if (!existsSync(distDir)) {
  console.error("找不到 dist/ —— 请先构建渲染层（npm run build:renderer:win7）");
  process.exit(1);
}

/** 读全部产物 CSS。 */
function readCss() {
  const assets = path.join(distDir, "assets");
  const dir = existsSync(assets) ? assets : distDir;
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  return files.map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }));
}

const css = readCss();
const allCss = css.map((c) => c.text).join("\n");

const count = (re) => (allCss.match(re) ?? []).length;
const rawColorMix = count(/color-mix\s*\(/g);
const smMixRefs = count(/--sm-mix-/g);

console.log(
  `\n检查 dist/ 下 ${css.length} 个 CSS 文件：color-mix=${rawColorMix}，sm-mix=${smMixRefs}`,
);

// 自动判定模式：有 sm-mix 说明是回退产物
const mode = modeArg ?? (smMixRefs > 0 ? "win7" : "modern");

if (mode === "win7") {
  console.log("\n[Win7 产物] 期望：无裸 color-mix、全部走 --sm-mix-*");

  if (rawColorMix > 0) {
    // 项目源码里的 color-mix 应当全部被改写；残留说明插件漏了某些文件
    fail(`仍有 ${rawColorMix} 处裸 color-mix（插件未覆盖全部来源）`);
    const sample = allCss.match(/.{0,60}color-mix\(.{0,80}/);
    if (sample) console.log("     样例：" + sample[0].replace(/\s+/g, " "));
  } else {
    ok("CSS 里已无裸 color-mix");
  }

  if (smMixRefs === 0) {
    fail("没有任何 --sm-mix-* 引用 —— 回退插件似乎没运行（SM_COLORMIX_FALLBACK=1？）");
  } else {
    ok(`有 ${smMixRefs} 处 --sm-mix-* 引用`);
  }

  // 每处 var(--sm-mix-…) 的兜底必须是合法 rgba，或是 transparent。
  //
  // 注意兜底值自身含括号（`rgba(68, 147, 248, .08)`），所以**不能**用
  // `[^)]*` 匹配整体 —— 会在内层 `)` 处提前截断，把合法值误判成不合法
  //（实测踩过：24 处误报）。这里按**括号配对**取完整的 var(...)。
  const refs = [];
  {
    const needle = "var(--sm-mix-";
    let i = 0;
    while ((i = allCss.indexOf(needle, i)) >= 0) {
      let depth = 0;
      let j = i + 3; // 指向 "var(" 的左括号
      for (; j < allCss.length; j += 1) {
        if (allCss[j] === "(") depth += 1;
        else if (allCss[j] === ")") {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }
      refs.push(allCss.slice(i, j));
      i = j;
    }
  }
  const bad = refs.filter((r) => !/,\s*(rgba\([^)]*\)|transparent)\s*\)$/.test(r));
  if (bad.length) {
    fail(`${bad.length} 处 --sm-mix-* 的兜底既不是 rgba 也不是 transparent`);
    console.log("     样例：" + bad[0].slice(0, 120));
  } else {
    ok(`每处 --sm-mix-* 都带合法兜底（rgba 或 transparent），共 ${refs.length} 处`);
  }

  // 兜底 rgba 的 alpha 必须落在 (0,1]
  const alphas = [
    ...allCss.matchAll(/--sm-mix-[^,]+,\s*rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/g),
  ].map((m) => Number(m[1]));
  const badAlpha = alphas.filter((a) => !(a > 0 && a <= 1));
  if (badAlpha.length) {
    fail(`${badAlpha.length} 处兜底 alpha 越界（应为 (0,1]）：${badAlpha.slice(0, 5).join(", ")}`);
  } else if (alphas.length) {
    ok(`${alphas.length} 处兜底 alpha 均在 (0,1]`);
  }

  // 抽查：源色自身半透明时 alpha 必须是**乘积**（scrim 0.7 × 60% = 0.42）
  const scrim = /--sm-mix-md-sys-color-scrim-60,\s*rgba\(([^)]*)\)/.exec(allCss);
  if (scrim) {
    const a = Number(scrim[1].split(",")[3]);
    if (Math.abs(a - 0.42) > 0.01) {
      fail(`scrim 60% 的兜底 alpha 应为 0.42（0.7×0.6），实际 ${a}`);
    } else {
      ok("半透明源色按乘积计算（scrim 0.7×60% = 0.42）");
    }
  }
} else {
  console.log("\n[现代产物] 期望：保留原生 color-mix、不得出现 --sm-mix-*");

  if (rawColorMix === 0) {
    fail("现代产物里 color-mix 消失了 —— 回退插件可能被误启用");
  } else {
    ok(`保留 ${rawColorMix} 处原生 color-mix`);
  }

  if (smMixRefs > 0) {
    fail(`现代产物里出现 ${smMixRefs} 处 --sm-mix-* —— 回退开关泄漏了`);
  } else {
    ok("无 --sm-mix-* 泄漏");
  }
}

console.log("");
if (failures.length) {
  console.error(`✗ color-mix 回退验收失败（${failures.length} 项，模式=${mode}）`);
  process.exit(1);
}
console.log(`✓ color-mix 回退验收通过（模式=${mode}）`);
