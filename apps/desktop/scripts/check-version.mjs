#!/usr/bin/env node
/**
 * 版本号一致性检查。
 *
 * 本项目的版本号同时声明在多个地方（Electron 打包、Rust sidecar、npm，
 * 以及应用的两份 README）。只改其中一处会出现很难发现的偏差：
 * 安装包名与「关于」里的版本不一致、sidecar 自报版本与宿主不同、
 * README 写着旧版本而 release 是新的。
 *
 * 这里把这些位置全部对齐校验，任何一处漂移都直接失败。CI 的 lint 作业会跑它。
 * 仓库根的两份 README 不强制写版本号（写了就必须一致）。
 *
 * 单一真源仍是 `src-tauri/silvermoon.config.json`（vite 与 Tauri 都读它），
 * 其余位置都以它为准。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 应用根目录（apps/desktop），脚本在 scripts/ 下。 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 仓库根目录：README.md / README_en.md 放在这一层。 */
const repoRoot = path.resolve(appRoot, "..", "..");

/** 各处版本号的读取方式：描述 + 取值函数。 */
const sources = [
  {
    label: "src-tauri/silvermoon.config.json（单一真源）",
    read: () => JSON.parse(read("src-tauri/silvermoon.config.json")).version,
  },
  {
    label: "package.json",
    read: () => JSON.parse(read("package.json")).version,
  },
  {
    label: "src-tauri/Cargo.toml",
    read: () => match(read("src-tauri/Cargo.toml"), /^version\s*=\s*"([^"]+)"/m, "Cargo.toml"),
  },
  {
    // 可选：Cargo.lock 是 cargo 生成的产物，未构建过的检出里可能不存在
    label: "src-tauri/Cargo.lock（silvermoon 包，可选）",
    read: () =>
      matchOptional(
        readOptional("src-tauri/Cargo.lock") ?? "",
        /name = "silvermoon"\nversion = "([^"]+)"/,
      ),
  },
  {
    // 可选：写了就必须与真源一致，没写则跳过（根 README 的版本行由文档风格决定）
    label: "README.md（仓库根，可选）",
    read: () => matchOptional(readRepo("README.md"), /当前版本 \*\*v([0-9.]+)\*\*/),
  },
  {
    label: "README_en.md（仓库根，可选）",
    read: () => matchOptional(readRepo("README_en.md"), /Current version \*\*v([0-9.]+)\*\*/),
  },
  {
    label: "apps/desktop/README.md",
    read: () => match(read("README.md"), /Current version \*\*v([0-9.]+)\*\*/, "README.md"),
  },
  {
    label: "apps/desktop/README_zh.md",
    read: () => match(read("README_zh.md"), /当前版本 \*\*v([0-9.]+)\*\*/, "README_zh.md"),
  },
];

function read(rel) {
  return readFileSync(path.join(appRoot, rel), "utf8");
}

function readRepo(rel) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function match(text, re, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`无法从 ${what} 解析出版本号`);
  return m[1];
}

/**
 * 可选位置：解析不到就返回 null（跳过校验），解析到就必须与真源一致。
 *
 * 仓库根的两份 README 是否写版本号由文档风格决定（上游已把这两行移除），
 * 不该因此让 CI 失败；但只要写了，就必须是同一个版本。
 */
function matchOptional(text, re) {
  const m = re.exec(text);
  return m ? m[1] : null;
}

/** 读文件；不存在时返回 null（用于 cargo 生成、未构建则缺失的产物）。 */
function readOptional(rel) {
  try {
    return read(rel);
  } catch {
    return null;
  }
}

const found = [];
for (const s of sources) {
  try {
    const version = s.read();
    // 可选位置解析不到 → 跳过（不算漂移，也不计入处数）
    if (version === null) continue;
    found.push({ label: s.label, version });
  } catch (e) {
    console.error(`✗ ${s.label}: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  console.error("\n版本号检查失败：有位置解析不出。");
  process.exit();
}

const expect = found[0].version;
// 语义化版本格式校验，避免写出 "0.0.2.1" 这类无效值
if (!/^\d+\.\d+\.\d+$/.test(expect)) {
  console.error(`✗ 版本号 "${expect}" 不是 x.y.z 形式`);
  process.exit(1);
}

const drifted = found.filter((f) => f.version !== expect);
if (drifted.length) {
  console.error(`\n✗ 版本号不一致（期望 ${expect}）：`);
  for (const d of drifted) console.error(`    ${d.version}  ${d.label}`);
  console.error(
    "\n把这些位置改成同一个版本号后重试。单一真源是 src-tauri/silvermoon.config.json。",
  );
  process.exit(1);
}

console.log(`✓ 版本号一致：${expect}（${found.length} 处）`);
for (const f of found) console.log(`    ${f.label}`);
