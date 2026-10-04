/**
 * Win7 兼容版构建产物验收。
 *
 * 这个脚本存在的理由：Win7 的失败模式**全是静默的** ——
 * - 主进程用了 Electron 22 没有的 API → 应用启动即异常，但日志只有一行 `{}`；
 * - 二进制里残留 Win8+ 符号（`WaitOnAddress`）→ 在开发机（Win10/11）上完全正常，
 *   只在 Win7 上加载失败；
 * - 主进程产物里残留 `taglib-wasm` 依赖 → Node 16 上初始化抛 EnvironmentError。
 *
 * 因此这里对**产物本身**做静态断言，能在没有 Win7 机器的 CI 上先拦一道。
 *
 * 用法：node scripts/verify-win7-build.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

// ---------------------------------------------------------------------------
console.log("\n[1] 主进程产物（dist-electron-win7）");
// ---------------------------------------------------------------------------

const mainDir = path.join(root, "dist-electron-win7");
const mainCjs = path.join(mainDir, "main.cjs");

check("dist-electron-win7/ 存在（先跑 npm run build:main:win7）", existsSync(mainCjs));
if (existsSync(mainCjs)) {
  const src = readFileSync(mainCjs, "utf8");

  // Electron 22 上没有这些 API。构建若把它们当作运行时依赖调用，说明兼容层没接上。
  // 注意：`protocol.handle` 现在只可能出现在**现代分支**里（被 define 裁掉），
  // 因此 Win7 产物里不应无条件出现。
  check(
    "未直接调用 protocol.handle（应走 registerProtocolHandler 适配）",
    !/\.handle\(\s*[A-Z_]+,\s*async/.test(src),
  );

  check(
    "已内联 undici（Win7 版 main 自包含，不依赖 node_modules）",
    src.includes("undici") || src.includes("fetch("),
  );

  check(
    "未把 taglib-wasm 作为运行期硬依赖（Node 16 无法初始化它）",
    !/require\(\s*["']taglib-wasm["']\s*\)/.test(src),
  );

  const size = statSync(mainCjs).size;
  notes.push(`main.cjs 体积 ${(size / 1024).toFixed(1)} KB`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] 主进程产物语法（必须能被 Node 16 解析）");
// ---------------------------------------------------------------------------

if (existsSync(mainCjs)) {
  // Node 16 是 Electron 22 的内置版本。当前 Node 无法直接以 16 的语义 parse，
  // 但 esbuild 已按 target=node16 降级；这里至少确认没有明显的 18+ 独有语法。
  const src = readFileSync(mainCjs, "utf8");
  check("无 `??=` 之外的新型赋值以外的 18+ 语法残留（粗检通过）", !/\bstatic\s*\{/.test(src));
}

// ---------------------------------------------------------------------------
console.log("\n[3] Windows 二进制：不得依赖 Win8+ 符号");
// ---------------------------------------------------------------------------

function checkExe(label, exePath) {
  if (!existsSync(exePath)) {
    notes.push(`${label}: 未找到 ${path.relative(root, exePath)}（需要先用 win7 目标编译）`);
    return;
  }
  let out = "";
  try {
    // maxBuffer 必须放大：后端 exe 有 12 MB，`objdump -p` 会输出 ~30 万行，
    // 默认 1 MB 会直接抛错，表现成「跳过检查」——那就等于这道闸门形同虚设。
    out = execFileSync("objdump", ["-p", exePath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // 区分「真的没有 objdump」与「objdump 跑失败」，后者不能静默放过
    if (error && error.code === "ENOENT") {
      notes.push(`${label}: 无 objdump，跳过 PE 检查`);
      return;
    }
    check(`${label} 可被 objdump 解析`, false, String(error?.message ?? error).slice(0, 120));
    return;
  }
  // WaitOnAddress / WakeByAddressSingle 属于 Windows 8+ 的 API set；
  // 一旦导入，Win7 上加载即失败（已在本仓库现成 splash exe 上实测复现）。
  const win8Apis = ["WaitOnAddress", "WakeByAddressAll", "WakeByAddressSingle"];
  const hit = win8Apis.filter((a) => new RegExp(`\\b${a}\\b`).test(out));
  check(`${label} 未导入 Win8+ 同步原语`, hit.length === 0, hit.join(", "));

  const apisets = out.split("\n").filter((l) => /DLL Name:\s*api-ms-win-core-synch-l1-2/.test(l));
  check(`${label} 未依赖 api-ms-win-core-synch-l1-2`, apisets.length === 0);
}

// 本仓库实际使用的路径是 `--target-dir <crate>/target/win7`，因此产物落在
// `<crate>/target/win7/<triple>/release/` 下。两条可行路线的 triple 不同
// （见 doc/win7-electron22.md 第 4 节），这里两种都探一遍。
const WIN7_TRIPLES = ["x86_64-win7-windows-gnu", "x86_64-pc-windows-gnu"];

function findExe(crate, exeName) {
  for (const triple of WIN7_TRIPLES) {
    const p = path.join(root, crate, "target", "win7", triple, "release", exeName);
    if (existsSync(p)) return p;
  }
  // 也接受「直接把 target-dir 指到 crate/target」的情形
  for (const triple of WIN7_TRIPLES) {
    const p = path.join(root, crate, "target", triple, "release", exeName);
    if (existsSync(p)) return p;
  }
  return path.join(root, crate, "target", "win7", WIN7_TRIPLES[0], "release", exeName);
}

checkExe("后端 silvermoon-server.exe", findExe("backend", "silvermoon.exe"));
checkExe("启动器 silvermoon-splash.exe", findExe("splash", "silvermoon-splash.exe"));

// ---------------------------------------------------------------------------
console.log("\n[4] 渲染层产物（Chromium 108 安全）");
// ---------------------------------------------------------------------------

const dist = path.join(root, "dist");
check("dist/ 存在（先跑 npm run build:renderer）", existsSync(dist));

// ---------------------------------------------------------------------------
console.log("");
if (notes.length) {
  console.log("备注：");
  for (const n of notes) console.log(`  - ${n}`);
}
if (failures.length) {
  console.error(`\n✗ 验收失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ Win7 构建产物检查通过");
