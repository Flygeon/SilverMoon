/**
 * 检查 `src/capabilities/mock.ts` 与后端命令路由表是否已经漂移。
 *
 * 背景：`npm run dev:renderer` 的纯浏览器预览靠 mock 顶替后端。mock 是一个
 * `switch (cmd)` 大分支，**没有任何机制**保证它跟着路由表更新。于是两类问题会静默出现：
 *
 *   1. 路由表新增命令 → mock 没有对应分支 → 预览环境点到这里就抛错（覆盖缺口）；
 *   2. 路由表改名/删除命令 → mock 留下永远命中不到的分支（死分支）。
 *
 * 本脚本只把第 2 类当**错误**（它会误导后续维护者，且修复成本极低），
 * 第 1 类当**警告**输出 —— 覆盖率可以逐步补，不该一次性把 CI 卡红。
 *
 * 用法：node scripts/check-mock-coverage.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 从 `generate_handler![...]` 里取出命令函数名（末段标识符）。 */
function readRouteTable() {
  const source = readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
  const start = source.indexOf("generate_handler![");
  if (start === -1) throw new Error("未在 src-tauri/src/lib.rs 找到 generate_handler![…]");
  const end = source.indexOf("])", start);
  if (end === -1) throw new Error("generate_handler![…] 未能找到结束位置");
  const body = source.slice(start, end);

  const names = new Set();
  for (const match of body.matchAll(/::([a-z_][a-z0-9_]*)\s*,/gi)) {
    names.add(match[1]);
  }
  if (names.size === 0) throw new Error("路由表解析结果为空，正则可能已失效");
  return names;
}

/** 只取 `mockInvoke` 里的 switch 分支；`mockMusicTags` 的 op 不是命令名，必须排除。 */
function readMockCases() {
  const source = readFileSync(path.join(root, "src", "capabilities", "mock.ts"), "utf8");
  const start = source.lastIndexOf("export function mockInvoke");
  if (start === -1) throw new Error("未在 mock.ts 找到 mockInvoke");
  const body = source.slice(start);

  const cases = new Set();
  for (const match of body.matchAll(/case\s+"([^"]+)"/g)) {
    cases.add(match[1]);
  }
  return cases;
}

/** 归一化：忽略 snake_case / camelCase 差异，只比语义。 */
const norm = (name) => name.replace(/_/g, "").toLowerCase();

const commands = readRouteTable();
const cases = readMockCases();

const commandKeys = new Map([...commands].map((name) => [norm(name), name]));
const caseKeys = new Map([...cases].map((name) => [norm(name), name]));

const uncovered = [...commands].filter((name) => !caseKeys.has(norm(name)));
const stale = [...cases].filter((name) => !commandKeys.has(norm(name)));

console.log("[mock-coverage] 后端命令 " + commands.size + " 条，mock 分支 " + cases.size + " 条");
console.log(
  "[mock-coverage] 已覆盖 " +
    (commands.size - uncovered.length) +
    " / " +
    commands.size +
    "（覆盖缺口 " +
    uncovered.length +
    " 条）",
);

if (uncovered.length > 0) {
  console.log(
    "[mock-coverage] 以下命令暂无 mock（浏览器预览会走到报错分支，属可接受但应逐步补齐）：",
  );
  for (const name of uncovered.sort()) console.log("  - " + name);
}

if (stale.length > 0) {
  console.error("[mock-coverage] 以下 mock 分支在后端路由表里已不存在（死分支，请删除或改名）：");
  for (const name of stale.sort()) console.error("  - " + name);
  process.exit(1);
}

console.log("[mock-coverage] 未发现死分支。");
