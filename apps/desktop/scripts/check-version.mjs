#!/usr/bin/env node
/**
 * 版本号一致性检查。
 *
 * 本项目的版本号同时声明在 **6 个地方**（Electron 打包、Rust sidecar、npm、
 * 仓库与应用的 README 各两份）。只改其中一处会出现很难发现的偏差：
 * 安装包名与「关于」里的版本不一致、sidecar 自报版本与宿主不同、
 * README 写着旧版本而 release 是新的。
 *
 * 这里把 6 处全部对齐校验，任何一处漂移都直接失败。CI 的 lint 作业会跑它。
 *
 * 单一真源仍是 `backend/silvermoon.config.json`（vite 与主进程都读它），
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
    label: "backend/silvermoon.config.json（单一真源）",
    read: () => JSON.parse(read("backend/silvermoon.config.json")).version,
  },
  {
    label: "package.json",
    read: () => JSON.parse(read("package.json")).version,
  },
  {
    label: "backend/Cargo.toml",
    read: () => match(read("backend/Cargo.toml"), /^version\s*=\s*"([^"]+)"/m, "Cargo.toml"),
  },
  {
    label: "backend/Cargo.lock（silvermoon 包）",
    read: () =>
      match(
        read("backend/Cargo.lock"),
        /name = "silvermoon"\nversion = "([^"]+)"/,
        'Cargo.lock 里的 name = "silvermoon" 条目',
      ),
  },
  {
    label: "README.md（仓库根）",
    read: () => match(readRepo("README.md"), /当前版本 \*\*v([0-9.]+)\*\*/, "README.md"),
  },
  {
    label: "README_en.md（仓库根）",
    read: () =>
      match(readRepo("README_en.md"), /Current version \*\*v([0-9.]+)\*\*/, "README_en.md"),
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

const found = [];
for (const s of sources) {
  try {
    found.push({ label: s.label, version: s.read() });
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
  console.error("\n把这些位置改成同一个版本号后重试。单一真源是 backend/silvermoon.config.json。");
  process.exit(1);
}

console.log(`✓ 版本号一致：${expect}（${found.length} 处）`);
for (const f of found) console.log(`    ${f.label}`);
