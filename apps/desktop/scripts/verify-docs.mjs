#!/usr/bin/env node
/**
 * 文档一致性守卫。
 *
 * ## 为什么需要它
 *
 * 本仓库有过一次真实事故：四份 README 里**有三份长期描述 Tauri 单进程架构**，
 * 而实际早已迁回 Electron 双进程 sidecar。错误从 2026-10-11（94bfe2f）起存在，
 * **横跨 133 个提交和一次正式发版（v0.1.1）都没人发现** —— 因为文档没有任何守卫，
 * 全靠人记得同步。
 *
 * 同类事故还有一次：`vite.config.ts` 误读 `src-tauri/silvermoon.config.json` 来注入
 * `__APP_VERSION__`，导致改了版本号界面仍显示旧值，**而 CI 全绿**。
 *
 * 所以这里把「文档必须说的实话」变成断言：**跟代码对不上就红**，不靠自觉。
 *
 * ## 它检查什么
 *
 * 1. **宿主技术栈**：文档中不得再出现「Tauri 2 单进程 / 与桌面壳同进程」这类断言。
 *    允许出现 Tauri 的地方只有：历史沿革、遗留树警告、历史文档标注。
 * 2. **命令数**：文档里写的命令数必须等于 `backend/src/lib.rs` 的 `generate_handler!` 项数。
 * 3. **路径存在**：文档里引用的关键路径必须真实存在（防「文档指向已删除的文件」）。
 *
 * ## 用法
 *
 *   node scripts/verify-docs.mjs          # 检查（CI / 本地）
 *
 * 退出码非 0 即表示漂移。
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const REPO = path.join(APP, "..", "..");

const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

/** 读文件；不存在返回 null。 */
function readIfExists(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. 真实命令数：从 lib.rs 的 generate_handler! 里数
// ---------------------------------------------------------------------------

/**
 * 数出 `generate_handler![...]` 里的命令项数。
 *
 * 注意：`#[silvermoon_ipc::command]` 属性出现次数**不等于**命令数 ——
 * 实测有 3 次出现在文档注释里（`/// #[silvermoon_ipc::command] 跑在主线程…`）。
 * 所以命令数必须从注册表数，而不是数属性。
 */
function countRegisteredCommands() {
  const lib = readIfExists(path.join(APP, "backend", "src", "lib.rs"));
  if (!lib) return null;
  const start = lib.indexOf("generate_handler![");
  if (start === -1) return null;
  const end = lib.indexOf("\n        ])", start);
  if (end === -1) return null;
  const block = lib.slice(start, end);
  const names = new Set();
  for (const m of block.matchAll(/::([a-z0-9_]+)\s*,/g)) names.add(m[1]);
  return names.size;
}

const commandCount = countRegisteredCommands();
if (commandCount === null) {
  fail("无法从 backend/src/lib.rs 的 generate_handler! 解析命令数（文件或结构变了？）");
} else {
  notes.push(`注册命令数（实测）：${commandCount}`);
}

// ---------------------------------------------------------------------------
// 2. 各文档必须与实测命令数一致
// ---------------------------------------------------------------------------

/** 文档 → 其中应出现的命令数位置（用于报错时定位）。 */
const DOC_FILES = [
  "apps/desktop/doc/AGENTS.md",
  "apps/desktop/README.md",
  "apps/desktop/README_zh.md",
  "README.md",
  "README_en.md",
];

/** 从文档里提取所有「N 条命令 / N commands」的声明。 */
const COMMAND_CLAIM_RES = [
  /(\d+)\s*条业务命令/g,
  // 「注册 N 条命令」「N 条 #[...]command」
  /(\d+)\s*条\s*`?#?\[?[a-z_:]*command/gi,
  /(\d+)\s*(?:business\s+)?commands/gi,
  // 表格里的裸数字：「注册命令 | **180**」/「registrations | **180**」
  /(?:注册命令|registrations?)[^\n]*?\*{0,2}(\d{2,4})\*{0,2}\s*\|/gi,
  /命令[^0-9\n]{0,10}(\d+)\s*条/g,
];

/**
 * 这些行**有意**出现历史数字（154 / 164 / 183），属于叙述而非现状断言，豁免命令数校验：
 * LOG 里记录「旧文档写错了什么」，是审计线索，必须保留原数字。
 */
const COMMAND_COUNT_EXEMPT = [/apps\/desktop\/doc\/LOG\.md$/];

/**
 * 历史叙述白名单：即便在非豁免文件里，这些行出现的数字也是**说明历史**，
 * 不是对现状的断言。命中即跳过。
 */
const HISTORY_NARRATIVE_RES = [
  /迁移|沿革|histor|曾是|原来是|旧文档|旧写|上一版|回滚|legacy|previous/,
];

if (commandCount !== null) {
  for (const rel of DOC_FILES) {
    const text = readIfExists(path.join(REPO, rel));
    if (text === null) {
      fail(`文档不存在：${rel}`);
      continue;
    }
    if (COMMAND_COUNT_EXEMPT.some((re) => re.test(rel))) continue;

    text.split("\n").forEach((line, i) => {
      // 历史叙述行豁免：它们写的是「曾经是多少」，不是「现在是多少」
      if (HISTORY_NARRATIVE_RES.some((re) => re.test(line))) return;
      const claims = new Set();
      for (const re of COMMAND_CLAIM_RES) {
        for (const m of line.matchAll(re)) claims.add(Number(m[1]));
      }
      for (const n of claims) {
        if (n !== commandCount) {
          fail(`${rel}:${i + 1} 写「${n} 条命令」，实测为 ${commandCount} 条`);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 3. 宿主技术栈：不得再出现「Tauri 单进程」类断言
// ---------------------------------------------------------------------------

/**
 * 明确的错误断言。
 *
 * 只拦「技术栈 / 进程模型」层面的错误陈述，**不拦历史沿革与遗留警告** ——
 * 文档里合法出现 Tauri 的场景：
 *  - 「Tauri 2 → Electron 44 → 迁回 Tauri 2 → 再迁回 Electron」这类沿革；
 *  - 「src-tauri/ 是 Tauri 时代的遗留树」这类警告；
 *  - 「doc/TAURI-MIGRATION.md 是历史文档」这类标注。
 */
const STALE_HOST_ASSERTIONS = [
  /后端写\s*在\s*\*\*Rust\*\*[^。\n]{0,40}同进程/,
  /Rust\*\*[^。\n]{0,30}（与桌面壳同进程）/,
  /与桌面壳同进程/,
  /同进程\s*）\s*[:：]/,
  /single Tauri 2 process/,
  /single process as the desktop shell/,
  /same process as the desktop shell/,
  /The app is now a \*\*single Tauri/,
  /基于 \*\*Tauri 2 \+ Vue 3/,
  /Tauri 2 单进程/,
];

for (const rel of DOC_FILES) {
  const text = readIfExists(path.join(REPO, rel));
  if (text === null) continue;
  text.split("\n").forEach((line, i) => {
    for (const re of STALE_HOST_ASSERTIONS) {
      if (re.test(line)) {
        fail(`${rel}:${i + 1} 出现过时宿主断言：${line.trim().slice(0, 100)}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 4. 文档里引用的关键路径必须真实存在
// ---------------------------------------------------------------------------

/** 文档 → 必须存在的路径（相对于 apps/desktop 或仓库根）。 */
const REQUIRED_PATHS = [
  ["apps/desktop/backend", "后端目录"],
  ["apps/desktop/electron", "Electron 宿主层"],
  ["apps/desktop/fqapi", "番茄内容源 sidecar"],
  ["apps/desktop/splash", "原生启动器"],
  ["apps/desktop/backend/silvermoon.config.json", "版本号单一真源"],
  ["apps/desktop/doc/AGENTS.md", "AGENTS.md"],
  ["apps/desktop/doc/SPEC.md", "SPEC.md"],
  ["apps/desktop/doc/LOG.md", "LOG.md"],
  ["apps/desktop/backend/kugou_server", "vendored 酷狗服务端"],
];

for (const [rel, label] of REQUIRED_PATHS) {
  if (!existsSync(path.join(REPO, rel))) fail(`文档引用的 ${label} 不存在：${rel}`);
}

// ---------------------------------------------------------------------------
// 5. AGENTS.md / SPEC.md / LOG.md 三者互链（防「建了没人知道」）
// ---------------------------------------------------------------------------

const CROSS_LINK = [
  ["apps/desktop/doc/AGENTS.md", ["SPEC.md", "LOG.md"], "AGENTS.md 应链到 SPEC 与 LOG"],
  ["apps/desktop/doc/SPEC.md", ["AGENTS.md", "LOG.md"], "SPEC.md 应链到 AGENTS 与 LOG"],
  ["apps/desktop/doc/LOG.md", ["AGENTS.md", "SPEC.md"], "LOG.md 应链到 AGENTS 与 SPEC"],
];

for (const [rel, targets, why] of CROSS_LINK) {
  const text = readIfExists(path.join(REPO, rel));
  if (text === null) continue;
  for (const t of targets) {
    if (!text.includes(t)) fail(`${rel} 缺少指向 ${t} 的链接（${why}）`);
  }
}

// ---------------------------------------------------------------------------
// 6. LOG 里的 commit hash 必须真实存在（防编造）
// ---------------------------------------------------------------------------

/**
 * LOG 的价值在于「按 hash 能定位到真实施工」，所以假 hash 是致命的。
 * 这里只能校验**形如 7 位十六进制的字段**是否在 git 里存在；
 * `pending`（尚未提交）是允许的占位。
 */
const logText = readIfExists(path.join(REPO, "apps/desktop/doc/LOG.md"));
if (logText) {
  const hashes = new Set();
  for (const m of logText.matchAll(/`([0-9a-f]{7,40})`/g)) hashes.add(m[1]);
  if (hashes.size > 0) {
    // LOG 的价值在于「按 hash 能定位到真实施工」，所以编造 hash 是致命的。
    // 这里用 git cat-file 逐个验证存在性。
    //
    // 三种降级情形都要**显式说出来**，不能静默跳过 —— 静默跳过会让守卫形同虚设：
    //   ① 本地无 git / 不在仓库里（如解压出的源码包）；
    //   ② **浅克隆**（CI 默认 depth=1）：拿不到旧提交，会把真实 hash 报成假 hash；
    //   ③ 单个 hash 在当前历史里确实不存在（这才是真正要拦的）。
    let gitOk = true;
    let shallow = false;
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: REPO, stdio: "ignore" });
      shallow = readIfExists(path.join(REPO, ".git", "shallow")) !== null;
    } catch {
      gitOk = false;
    }
    if (!gitOk) {
      notes.push(`LOG.md 引用 ${hashes.size} 个 hash：未检测到 git，跳过真实性校验`);
    } else if (shallow) {
      // 只校验还够得着的那些，并明确告知这是不完整的检查。
      let checked = 0;
      let bad = 0;
      for (const h of hashes) {
        try {
          execFileSync("git", ["cat-file", "-e", h], { cwd: REPO, stdio: "ignore" });
          checked++;
        } catch {
          // 浅克隆下「不存在」可能是「没拉到」，不能据此判假 —— 但也不能当通过。
          bad++;
        }
      }
      notes.push(
        `LOG.md 引用 ${hashes.size} 个 hash：仓库是**浅克隆**，无法完整校验` +
          `（${checked} 个可达${bad ? `，${bad} 个在本地历史外` : ""}）；` +
          `CI 已配 fetch-depth: 0，本地如需校验请 git fetch --unshallow`,
      );
    } else {
      let bad = 0;
      for (const h of hashes) {
        try {
          execFileSync("git", ["cat-file", "-e", h], { cwd: REPO, stdio: "ignore" });
        } catch {
          fail(`LOG.md 引用了不存在的 commit：\`${h}\``);
          bad++;
        }
      }
      notes.push(
        `LOG.md 引用 ${hashes.size} 个 commit hash${bad ? `（${bad} 个无效）` : "，全部真实"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

console.log("文档一致性检查：");
for (const n of notes) console.log(`  · ${n}`);
if (failures.length === 0) {
  console.log("  ✓ 全部通过");
  process.exit(0);
}
console.error(`\n  ✗ 发现 ${failures.length} 处漂移：`);
for (const f of failures) console.error(`    - ${f}`);
console.error("\n文档与代码不一致时，以代码与 CI 为准，并回来修文档。");
process.exit(1);
