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
    // 区分「真的没有 objdump」与「objdump 跑失败」。
    //
    // ⚠️ 上一版把「没有 objdump」降级成一条 note 就放过了 —— 那是错的：
    // 这个脚本是发布前的最后一道静态闸门，工具缺失等于**闸门根本不存在**，
    // 而 CI 的 win7 作业已经显式安装 binutils 并写明了「不能降级」。
    // 静默跳过会让人误以为「检查过了」。
    check(
      `${label} 能执行 objdump（缺 binutils 时闸门失效，必须显式失败）`,
      false,
      error && error.code === "ENOENT"
        ? "系统里没有 objdump；请安装 binutils（CI 的 win7 作业已固定依赖）"
        : String(error?.message ?? error).slice(0, 160),
    );
    return;
  }
  // -------------------------------------------------------------------------
  // Win8+ 专属符号黑名单。
  //
  // 只查 WaitOnAddress 那一组是**不够的**（这是上一版的真实缺陷）：它只覆盖
  // 内核同步原语这一条线索。同类的还有几个高频来源，任一命中都会让 Win7 上
  // 「加载即失败」或「首次调用即 AV」：
  //
  //   * WaitOnAddress / WakeByAddress*        —— Rust std 的 futex 实现（最经典）
  //   * GetSystemTimePreciseAsFileTime        —— UCRT / SQLite / 各类时间库
  //   * SetThreadDescription / GetThreadDescription —— std 的线程命名，debug 构建常见
  //   * GetTempPath2W / CreateFile2           —— 部分较新 CRT 的路径解析
  //   * DiscardVirtualMemory / OfferVirtualMemory —— Rust std 的内存建议
  //   * GetOverlappedResultEx / CancelIoEx2   —— 新版 I/O 辅助
  //   * RtlGetVersion 之外的 ntdll 新导出（Precise/Ex 后缀一类）
  //
  // ⚠️ 这份名单只能拦住「**导入表里可见**」的符号。真正危险的另一类是
  // **静态链接进去的 C 代码**（比如 `rusqlite` 的 bundled SQLite、CRT 自身）
  // 在运行期通过 `GetProcAddress` 动态解析的调用 —— 它们不会出现在 PE 导入表中，
  // 静态检查原理上就查不出来。那部分只能靠运行时诊断（见下面 [5] 的检查项
  // 与运行时启动轨迹）。
  const win8Apis = [
    "WaitOnAddress",
    "WakeByAddressAll",
    "WakeByAddressSingle",
    "GetSystemTimePreciseAsFileTime",
    "SetThreadDescription",
    "GetThreadDescription",
    "GetTempPath2W",
    "CreateFile2",
    "DiscardVirtualMemory",
    "OfferVirtualMemory",
    "GetOverlappedResultEx",
    "CancelIoEx",
    "SetThreadStackGuarantee",
    "GetPackageFamilyName",
  ];
  const hit = win8Apis.filter((a) => new RegExp(`\\b${a}\\b`).test(out));
  check(`${label} 未导入 Win8+ 专属符号`, hit.length === 0, hit.join(", "));

  // 依赖的 API set 里，synch-l1-2-0 是最常见的一个来源；其余几个同样只在
  // Win8+ 上存在，一并纳入检测，避免「换了实现方式就从闸门底下溜过去」。
  const badApiSets = out
    .split("\n")
    .filter((l) => /DLL Name:\s*api-ms-win-core-(synch-l1-2|winrt|threadpool-l1-2)/.test(l));
  check(
    `${label} 未依赖 Win8+ 的 API set`,
    badApiSets.length === 0,
    badApiSets.map((l) => l.trim()).join(", "),
  );

  // 子系统的下限：Win7 是 6.1。部分工具链会把 subsystem version 写成 6.2，
  // 这在 Win7 上会直接拒绝加载（错误 0xC000007B / 「不是有效的 Win32 应用程序」）。
  const subsys = /MajorSubsystemVersion\s+(\d+)/.exec(out);
  if (subsys) {
    const major = Number(subsys[1]);
    check(
      `${label} 子系统版本不高于 6.1（Win7）`,
      major <= 6,
      `实际 MajorSubsystemVersion=${major}`,
    );
  } else {
    notes.push(`${label}: objdump 未给出 MajorSubsystemVersion，跳过子系统版本检查`);
  }

  // 记录实际依赖的 DLL 清单（便于人工对照「是不是多了一个可疑的 Win8+ 库」）
  const dlls = [...out.matchAll(/DLL Name:\s*(\S+)/g)].map((m) => m[1]);
  notes.push(`${label}: 依赖 ${dlls.length} 个 DLL（${dlls.slice(0, 8).join(", ")}…）`);
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
console.log("\n[5] 启动诊断设施（Win7 收尾验收的必备条件）");
// ---------------------------------------------------------------------------
//
// 背景：Win7 上的崩溃是**GUI 进程静默消失**，没有控制台、没有堆栈。
// 「做 C 方案」（让用户跑一次就能定位崩溃点）依赖三样东西同时在位：
//
//   a) 后端 exe 里带着启动轨迹代码（否则跑到哪一步死无从得知）；
//   b) 启动器 exe 里同样带着（它的崩溃发生在 Electron 起来之前，
//      Electron 侧根本没有任何观测机会）；
//   c) 主进程产物里有 boot-diagnostics 的收集逻辑（崩溃弹窗要直接给出轨迹路径）。
//
// 这三项都是**运行期行为**，静态检查抓不到真实效果，但可以确认「代码在产物里」——
// 至少能拦住「改完了但打包没带上」这类低级失误。

function checkTraceInExe(label, exePath) {
  if (!existsSync(exePath)) {
    notes.push(`${label}: 未找到产物，跳过轨迹设施检查`);
    return;
  }
  // 轨迹文件的文件名会被编成字符串常量进二进制，用它作为「代码在不在」的指纹。
  const marker = Buffer.from("silvermoon-boot-", "utf8");
  let buf;
  try {
    buf = readFileSync(exePath);
  } catch (e) {
    check(`${label} 可读取以检查轨迹设施`, false, String(e).slice(0, 120));
    return;
  }
  check(`${label} 内置启动轨迹（silvermoon-boot-* 指纹存在）`, buf.includes(marker));
}

checkTraceInExe("后端 exe", findExe("backend", "silvermoon.exe"));
checkTraceInExe("启动器 exe", findExe("splash", "silvermoon-splash.exe"));

// 主进程产物里的诊断收集模块
if (existsSync(mainCjs)) {
  const src = readFileSync(mainCjs, "utf8");
  check("主进程产物含启动诊断收集（boot-diagnostics）", src.includes("silvermoon-boot-"));
  check("主进程产物含诊断落盘逻辑（boot-diagnostics.txt）", src.includes("boot-diagnostics.txt"));
}

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
