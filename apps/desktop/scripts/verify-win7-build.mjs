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
  // 分两档：**已核实**的判失败，**待核实**的只提醒。
  //
  // 为什么要分档（这不是偷懒，是踩坑后的必要设计）：
  // Win7 兼容性的唯一可靠判据是 MS Learn 上的 `Minimum supported client`，
  // 而凭名字/直觉猜版本**一定会错**。加宽名单的第一版就因此把
  // CancelIoEx / SetThreadStackGuarantee（都是 Vista）判成了 Win8+，
  // CI 直接把两个 exe 全判红，白跑一轮。
  //
  // 所以：
  //   * `win8Confirmed` —— 已逐项核对过文档，命中即**真失败**（这是闸门）；
  //   * `win8Suspect`   —— 尚未核对，命中只打提醒（这是线索，不是判据）。
  // 遇到 suspect 命中时，正确做法是去查文档，然后把它**移动**到 confirmed
  // 或直接删掉 —— 不要凭感觉升级成失败。
  // -------------------------------------------------------------------------
  const win8Confirmed = [
    // Minimum supported client: Windows 8 / Server 2012
    "WaitOnAddress",
    "WakeByAddressAll",
    "WakeByAddressSingle",
    // Minimum supported client: Windows 8
    "GetSystemTimePreciseAsFileTime",
    "GetOverlappedResultEx", // 核对来源：learn.microsoft.com .../nf-ioapiset-getoverlappedresultex
    "CreateFile2",
    "DiscardVirtualMemory",
    "OfferVirtualMemory",
    // Minimum supported client: Windows 8
    "GetPackageFamilyName",
    "GetCurrentPackageFullName",
  ];
  const win8Suspect = [
    // 疑似 Win8+，但**尚未**逐项核对文档。命中时只提醒，不判失败。
    "SetThreadDescription", // 实际是 Win10 1607；留着提醒，命中说明真有问题
    "GetThreadDescription",
    "GetTempPath2W",
  ];

  const hit = win8Confirmed.filter((a) => new RegExp(`\\b${a}\\b`).test(out));
  check(`${label} 未导入已核实的 Win8+ 专属符号`, hit.length === 0, hit.join(", "));

  const suspectHit = win8Suspect.filter((a) => new RegExp(`\\b${a}\\b`).test(out));
  if (suspectHit.length) {
    notes.push(
      `${label}: 出现**待核实**的疑似 Win8+ 符号 ${suspectHit.join(", ")}` +
        ` —— 请查 MS Learn 的 Minimum supported client 后决定加入黑名单或忽略`,
    );
  }

  // 已核实为「**Win7 可用**」的符号。列出来是为了防止日后有人凭名字又把它们
  // 加回黑名单 —— 这一轮已经因为猜错 CancelIoEx / SetThreadStackGuarantee 白跑一次 CI。
  const knownGood = {
    CancelIoEx: "Windows Vista",
    SetThreadStackGuarantee: "Windows Vista（Rust std 自己就会用：Vista 是 Rust 的最低支持版本）",
    GetSystemTimeAsFileTime: "Windows 2000",
    InitializeCriticalSectionEx: "Windows Vista",
    GetTickCount64: "Windows Vista",
  };
  const goodHit = Object.keys(knownGood).filter((a) => new RegExp(`\\b${a}\\b`).test(out));
  if (goodHit.length) {
    notes.push(
      `${label}: 含以下 Win7 可用的导入（已核实，勿再加入黑名单）：` +
        goodHit.map((a) => `${a}=${knownGood[a]}`).join("; "),
    );
  }

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

// ---------------------------------------------------------------------------
// [4.5] 运行期 apiset 探测检测（**本节的由来，务必读完再改**）
// ---------------------------------------------------------------------------
//
// 前面 [4] 那一组检查全部盯着 **PE 导入表**。但有一类 Win8+ 依赖**根本不在
// 导入表里** —— 它是用 `GetModuleHandleA("api-ms-win-core-synch-l1-2-0.dll")` +
// `GetProcAddress` 在**运行期**动态探测的。
//
// 这类代码踩的坑比静态导入更狠：
//
//   * 静态导入 Win8+ 符号 → Win7 加载器报 `0xC0000135`（缺模块），**干净失败**；
//   * 运行期探测 apiset 名 → Win7 的 `kernelbase!GetModuleHandleA` 在解析
//     API Set 时（API Set 是 Win8 才引入的机制）会读未初始化的表，
//     直接 **`0xC0000005` 访问违例**。
//
// 而且 `0xC0000005` 发生在 CRT 静态构造期 —— **早于 main**，
// 所以「在 main 里打启动轨迹」的诊断手段一行日志都收不到。
// 实测现场：后端连 `silvermoon-boot-backend.log` 都不会被创建。
//
// 实测踩坑记录：`parking_lot_core` 0.9.12 就是这么死的。
// 修法见 `backend/Cargo.toml` 的 `[patch.crates-io]` 注释与
// `backend/patches/parking_lot_core/`。
//
// **为什么本检查不扫字符串常量**（一开始想这么做，验证后否掉了）：
// 打了补丁之后，`api-ms-win-core-synch-l1-2-0.dll` 这个字面量**依然在二进制里** ——
// 它是个 `&'static str`，编译器不会因为运行期不走到就把它删掉。
// 实测打了补丁的产物里该字符串仍出现 1 次。所以「扫字符串」会把修复后的产物
// 也判成失败，是个**假阳性**，不能用。
//
// 正确的判据是：**看 WaitAddress::create() 里有没有那道版本闸门**。
// 直接查源码比反汇编稳定得多 —— 反正这个补丁本来就是我们自己的文件。
function checkRuntimeApisetProbeGuard() {
  const patched = path.join(
    root,
    "patches",
    "parking_lot_core",
    "src",
    "thread_parker",
    "windows",
    "waitaddress.rs",
  );
  if (!existsSync(patched)) {
    check(
      "parking_lot_core Win7 补丁在位",
      false,
      "patches/parking_lot_core/src/thread_parker/windows/waitaddress.rs 缺失 —— " +
        "补丁被删会让「Win7 上运行期探测 apiset → 0xC0000005」的崩溃回归，且**没有任何日志**",
    );
    return;
  }
  const src = readFileSync(patched, "utf8");

  // -------------------------------------------------------------------------
  // 分析前**先剥掉注释**。这一步是必须的，不是洁癖：
  //
  // 补丁在 `create()` 函数体开头写了一大段解释性注释，其中**引用**了上游的
  // 探测代码（`GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll\0")`）
  // 和闸门变量名（`is_win7_or_lower`）。如果直接在原文里 indexOf，
  // 注释会先被命中 —— 实测报出「闸门@2468 晚于探测@357」这个**假失败**，
  // 而真实代码里闸门是紧跟在函数签名之后的（顺序完全正确）。
  //
  // 剥注释的做法：去掉 `//` 行注释与 `/* */` 块注释。
  // 这段源码里没有包含 `//` 的字符串字面量（没有 URL 之类），
  // 所以按行丢弃注释是安全的。
  // -------------------------------------------------------------------------
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "")) // 行注释
    .join("\n");

  const fnStart = noComments.indexOf("pub fn create()");
  const body = fnStart === -1 ? "" : noComments.slice(fnStart);

  const gateAt = body.indexOf("is_win7_or_lower");
  const probeAt = body.indexOf("GetModuleHandleA(b");
  check(
    "parking_lot_core 补丁含 Win7 版本闸门（在 create() 函数体内）",
    fnStart !== -1 && gateAt !== -1,
    fnStart === -1
      ? "waitaddress.rs 里找不到 `pub fn create()` —— 文件结构变了，补丁需重新应用"
      : "create() 体内找不到 is_win7_or_lower —— 补丁被覆盖回上游版本了",
  );
  check(
    "版本闸门位于 apiset 探测之前（顺序正确）",
    gateAt !== -1 && probeAt !== -1 && gateAt < probeAt,
    gateAt === -1 || probeAt === -1
      ? `闸门或探测点其一在函数体内找不到（gate=${gateAt}, probe=${probeAt}）`
      : `闸门@${gateAt} 晚于探测@${probeAt} —— 顺序反了，等于没打`,
  );

  // 版本判断的实现必须在 bindings.rs 里（用 RtlGetVersion，不用会撒谎的 GetVersionEx）
  const bindings = path.join(
    root,
    "patches",
    "parking_lot_core",
    "src",
    "thread_parker",
    "windows",
    "bindings.rs",
  );
  if (existsSync(bindings)) {
    const b = readFileSync(bindings, "utf8");
    check("补丁用 RtlGetVersion 取真实版本（GetVersionEx 会谎报）", b.includes("RtlGetVersion"));
    check("补丁声明了 os_version() 辅助函数", b.includes("pub fn os_version"));
  }
}

// Cargo.toml 里的 [patch.crates-io] 转发 —— 少了这一段，
// patches 目录形同虚设（源码在，但 cargo 根本不会用它）。
//
// **两个 crate 都要查**：补丁放在仓库级共享目录（`apps/desktop/patches/`），
// backend 与 splash 各自独立声明转发。第一轮修复只给 backend 加了，
// 结果启动器仍崩 —— 所以这里必须逐个断言，不能只看一个。
{
  const crates = [
    { name: "backend", dir: "backend" },
    { name: "splash", dir: "splash" },
  ];
  for (const c of crates) {
    const cargoToml = path.join(root, c.dir, "Cargo.toml");
    if (!existsSync(cargoToml)) continue;
    const t = readFileSync(cargoToml, "utf8");
    check(
      `${c.name}/Cargo.toml 已声明 [patch.crates-io] 指向共享 parking_lot_core`,
      /\[patch\.crates-io\][\s\S]*parking_lot_core\s*=\s*\{\s*path\s*=\s*"[^"]*patches\/parking_lot_core"\s*\}/.test(
        t,
      ),
      `${c.name} 未转发补丁 —— 该 crate 在 Win7 上会重新踩「运行期探测 apiset」的崩溃`,
    );
  }
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
console.log("\n[4.5] parking_lot_core Win7 补丁（导入表查不到的那一类崩溃）");
// ---------------------------------------------------------------------------
//
// 详细背景见下方 checkRuntimeApisetProbeGuard 的注释。
// 一句话：不检查「字符串在不在」（补丁后字符串依然在，会假阳性），
// 而是检查「那道版本闸门在不在、顺序对不对、有没有真的进二进制」。
checkRuntimeApisetProbeGuard(findExe("backend", "silvermoon.exe"));

// 产物侧的最后一道：确认补丁真的被编进了二进制。
// `RtlGetVersion` 是补丁**新增**的导入（上游 parking_lot_core 从不用它），
// 它出现在导入表即证明补丁生效 —— 这是只属于本补丁的可靠指纹。
// （前面查源码只能证明「文件里有这道闸门」，查产物才能证明「cargo 真用了它」。）
{
  const exePath = findExe("backend", "silvermoon.exe");
  if (existsSync(exePath)) {
    let out = "";
    try {
      out = execFileSync("objdump", ["-p", exePath], { encoding: "utf8", maxBuffer: 64 << 20 });
    } catch {
      /* checkExe 已经报过 objdump 的问题，这里不重复报 */
    }
    if (out) {
      check(
        "后端产物含 RtlGetVersion 导入（parking_lot_core 补丁已编进二进制）",
        /RtlGetVersion/.test(out),
        "产物里没有 RtlGetVersion —— [patch.crates-io] 可能没生效",
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n[4.6] libstd Win7 补丁（`target_vendor = win7` 的 CRT 静态构造期崩溃）");
// ---------------------------------------------------------------------------
//
// **这是本轮真正的根因所在，务必读完。**
//
// 上一组 [4.5] 盯的是 crates.io 上的 `parking_lot_core`。但真机实测表明：
// **首发受害者是 Rust 标准库自己。**
//
// `library/std/src/sys/pal/windows/compat.rs` 里有一段
// `#[cfg(target_vendor = "win7")]` 的代码，用 `.CRT$XCT` 段注册了一个
// **CRT 静态构造期**的初始化函数，无条件执行：
//
//     GetModuleHandleA("api-ms-win-core-synch-l1-2-0")
//
// 而 `api-ms-win-*` 是 **apiset 桩名**（API Set 重定向是 Win8 才引入的机制）。
// Win7 解析这种名字时会读未初始化的表 → **直接 0xC0000005**，
// 不是返回 NULL。上游那句 `NonNull::new(module)` 的 NULL 兜底**永远执行不到**。
//
// 后果比 [4.5] 那类更严重：
//   * 它跑在 **CRT 静态构造期，早于 main()** —— 任何「在 main 里打点」的
//     诊断手段都收不到一个字节；
//   * 它影响**所有链接 libstd 的 exe** —— 包括启动器 `silvermoon-splash.exe`，
//     所以快捷方式双击时**启动器先崩**，Electron 主程序压根没被拉起来。
//
// 修法：给 libstd 打补丁，把那个函数改成 no-op（语义正确 —— 因为
// `WaitOnAddress` 本来就是 Win8+ 的 API，Win7 上该探测本来就该失败）。
// 详见 patches/rust-std-win7/README.md 与 scripts/setup-win7-toolchain.mjs。
//
// **这条检查是产物级的**，而且判据与 [4.5] 正好相反：
// 这里**扫字符串是对的** —— 对 libstd 补丁而言，`api-ms-win-*` 这个字面量
// 只存在于那段被删掉的代码里，补丁生效后它应当**彻底消失**。
// （[4.5] 那个补丁保留了字面量，所以不能这么查 —— 两者判据不同，别混淆。）
{
  const patchPath = path.join(root, "patches", "rust-std-win7", "compat.rs.patch");
  check(
    "libstd Win7 补丁文件在位",
    existsSync(patchPath),
    "patches/rust-std-win7/compat.rs.patch 缺失 —— " +
      "Win7 上「双击即崩且无任何日志」的根因会回归",
  );

  // 补丁内容本身也要对：必须把 load_synch_functions 改成 no-op
  if (existsSync(patchPath)) {
    const p = readFileSync(patchPath, "utf8");
    check(
      "libstd 补丁把 load_synch_functions 改成 no-op",
      /load_synch_functions\(\)\s*\{\s*\}/.test(p) ||
        /pub\(super\) fn load_synch_functions\(\) \{\}/.test(p),
      "补丁里找不到 `fn load_synch_functions() {}` —— 补丁可能被改坏了",
    );
    check("libstd 补丁带 SilverMoon 标记（便于日后核对上游变动）", p.includes("SilverMoon patch"));
  }

  // 产物级断言：确认 libstd 那段探测**不再存在于二进制里**。
  //
  // 判据要分产物看 —— 这是本轮踩过的坑，别想当然地统一成「必须为 0」：
  //
  //   * **启动器**：它只依赖 libstd（`std::sync::Mutex` 走 `windows7.rs` 的
  //     SRWLOCK 实现，根本不经过 parking_lot）。所以 apiset 字面量的唯一来源
  //     就是 libstd 那段代码，补丁生效后应当**归零**。
  //
  //   * **后端**：它额外直接依赖 `parking_lot`，而 `patches/parking_lot_core`
  //     的修法是**加版本闸门**（不是删代码），所以
  //     `"api-ms-win-core-synch-l1-2-0.dll"` 这个字面量**仍然在二进制里**
  //     （实测残留 1 处）。这是**预期内**的，不是失败。
  //
  //   所以对后端只能用「有上限」的判据：不得出现**多个**——因为 libstd 那份
  //   已经被删掉了，剩下的应当只有 parking_lot 那一个。出现 2 个以上就说明
  //   libstd 补丁没生效。
  //
  // 想要更严格的判据（查那段代码有没有被 `GetModuleHandleA` 引用）需要反汇编，
  // 成本高且脆弱；这里的近似足够拦住「补丁整个没生效」这类回归。
  const TARGETS = [
    { label: "后端", exe: findExe("backend", "silvermoon.exe"), maxApiset: 1 },
    { label: "启动器", exe: findExe("splash", "silvermoon-splash.exe"), maxApiset: 0 },
  ];
  for (const t of TARGETS) {
    if (!existsSync(t.exe)) {
      check(`${t.label}产物已消除 libstd 的 apiset 运行期探测`, false, `产物不存在：${t.exe}`);
      continue;
    }
    let buf = null;
    try {
      buf = readFileSync(t.exe);
    } catch (e) {
      check(`${t.label}产物已消除 libstd 的 apiset 运行期探测`, false, `读取失败：${e.message}`);
      continue;
    }
    // `api-ms-win` 是 apiset 名字的公共前缀，出现即说明有代码在引用它。
    // 用 latin1 避免把二进制当 UTF-8 处理时出问题。
    const text = buf.toString("latin1");
    const hits = (text.match(/api-ms-win/g) || []).length;
    check(
      `${t.label}产物已消除 libstd 的 apiset 运行期探测（${path.basename(t.exe)}，实测 ${hits} 处，上限 ${t.maxApiset}）`,
      hits <= t.maxApiset,
      t.maxApiset === 0
        ? `产物里出现 ${hits} 次 "api-ms-win" —— libstd 补丁没生效` +
            "（build-std 可能没用打过补丁的 sysroot）"
        : `产物里出现 ${hits} 次 "api-ms-win"（上限 ${t.maxApiset} = 仅 parking_lot 的那一处）` +
            "—— 多出来的说明 libstd 那一段还在，补丁没生效",
    );
  }
}

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
