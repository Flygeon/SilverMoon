/**
 * 准备 Win7 目标所需的 Rust 工具链与系统依赖。
 *
 * Win7 目标（`x86_64-win7-windows-gnu`）是 **tier-3**，因此需要：
 * - **nightly**（`-Z build-std` 只在 nightly 上可用 —— stable 会直接报
 *   `the option \`Z\` is only accepted on the nightly compiler`）；
 * - **rust-src** 组件（build-std 要从源码编 std）；
 * - **mingw-w64** 链接器（tier-3 目标不自带）。
 *
 * 另外还要给 **libstd 打一个补丁** —— 见第 3 步与
 * `patches/rust-std-win7/README.md`：`target_vendor = "win7"` 的 std 里有一段
 * 自述「为兼容老 Windows」的代码，却在 Win7 上直接访问违例，且它跑在
 * **CRT 静态构造期**（早于 `main`），导致任何 exe 双击即崩、且写不出日志。
 *
 * 本脚本幂等，可在本地与 CI 复用。Linux/macOS 下自动装 mingw；
 * Windows 下只准备 rust 部分（Win7 产物本身在 Linux 上交叉编译更省事，
 * 见 doc/win7-electron22.md 第 4 节）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// rustup 默认每次都会尝试 self-update（联网下载）。在 CI/离线机器上这一步
// 可能长时间挂住，把构建卡死在第一步。全部显式禁掉 —— 工具链版本由
// rustup-toolchain 自己声明，不需要顺带升级 rustup 本体。
function rustup(args) {
  run("rustup", args, { env: { ...process.env, RUSTUP_NO_SELF_UPDATE: "1" } });
}

function has(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function out(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

// 1) nightly + rust-src
rustup(["toolchain", "install", "nightly", "--profile", "minimal", "--no-self-update"]);
rustup(["component", "add", "rust-src", "--toolchain", "nightly"]);

// 2) mingw-w64（Linux 交叉编译 Win7 产物用）
if (process.platform === "linux") {
  if (has("x86_64-w64-mingw32-gcc")) {
    console.log("· mingw-w64 已就绪");
  } else {
    run("sudo", ["apt-get", "update", "-qq"]);
    run("sudo", [
      "apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "mingw-w64",
      "pkg-config",
      "libssl-dev",
    ]);
  }
} else if (process.platform === "darwin" && !has("x86_64-w64-mingw32-gcc")) {
  console.log("· macOS 未检测到 mingw-w64（brew install mingw-w64），Win7 构建请用 Linux/CI");
}

// 3) 生成打过补丁的 std 源码副本，并把它接到 sysroot 上
//
// 为什么必须替换 sysroot 里的 library/：
//   `-Z build-std` 没有「指定源码目录」的参数，它固定读
//   `$(rustc --print sysroot)/lib/rustlib/src/rust/library`。
//   所以只能把那个目录换掉（先备份原目录，构建结束再还原 ——
//   见 scripts/run-win7-build.mjs 的还原逻辑）。
//
// 为什么不在原地改：改完就丢掉了「原始未改动」这份参照，
//   一旦上游换版本、补丁对不上，就没法自动重建，只能靠人肉回忆。
//   所以始终保留原始目录，每次从它复制一份干净副本再打补丁。
const desktopDir = path.resolve(import.meta.dirname, "..");
const patchFile = path.join(desktopDir, "patches/rust-std-win7/compat.rs.patch");
const targetRel = "std/src/sys/pal/windows/compat.rs";

if (!fs.existsSync(patchFile)) {
  console.error(`✗ 找不到 std 补丁：${patchFile}`);
  process.exit(1);
}

const sysroot = out("rustc", ["+nightly", "--print", "sysroot"]);
const rustSrcRoot = path.join(sysroot, "lib/rustlib/src/rust");
const sysLibrary = path.join(rustSrcRoot, "library");
const backupLibrary = path.join(rustSrcRoot, "library.silvermoon-orig");

if (!fs.existsSync(sysLibrary)) {
  console.error(
    `✗ 找不到 libstd 源码：${sysLibrary}\n` +
      `  请先装 rust-src：rustup component add rust-src --toolchain nightly`,
  );
  process.exit(1);
}

// 若上次构建被中断，可能残留符号链接：先还原，保证基于原始副本工作。
const libStat = fs.lstatSync(sysLibrary);
if (libStat.isSymbolicLink()) {
  console.log("· 检测到上次构建残留的链接，先还原");
  fs.unlinkSync(sysLibrary);
  if (fs.existsSync(backupLibrary)) fs.renameSync(backupLibrary, sysLibrary);
}

// 备份原始 library（只做一次；已存在说明之前备份过）
if (!fs.existsSync(backupLibrary)) {
  console.log(`· 备份原始 libstd → ${path.basename(backupLibrary)}`);
  fs.cpSync(sysLibrary, backupLibrary, { recursive: true });
}

// 复制一份干净副本并打补丁。放在仓库外，避免污染工作区。
const workRoot = path.join(os.tmpdir(), "silvermoon-win7-std");
const patchedLibrary = path.join(workRoot, "library");
const readyFlag = path.join(workRoot, ".ready");

// 用 sysroot 路径 + 两个文件的 mtime 做指纹：nightly 升级或补丁改动后自动重建。
const { createHash } = await import("node:crypto");
const stamp = `${sysroot}\n${fs.statSync(patchFile).mtimeMs}\n${fs.statSync(backupLibrary).mtimeMs}`;
const key = createHash("sha256").update(stamp).digest("hex").slice(0, 12);

if (fs.existsSync(readyFlag) && fs.readFileSync(readyFlag, "utf8") === stamp) {
  console.log(`· 复用已打补丁的 std 副本（key=${key}）`);
} else {
  console.log(`· 复制 libstd 源码 → ${patchedLibrary}（key=${key}）`);
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.cpSync(backupLibrary, patchedLibrary, { recursive: true });

  // 用 patch(1) 而非手工字符串替换：补丁带上下文，上游改动导致对不上时
  // 会**显式失败**，而不是静默改错地方。
  console.log(`· 应用 std 补丁：${path.relative(desktopDir, patchFile)}`);
  try {
    execFileSync("patch", ["-p1", "-i", patchFile, "--forward", "--no-backup-if-mismatch"], {
      cwd: patchedLibrary,
      stdio: "inherit",
    });
  } catch {
    console.error(
      "\n✗ std 补丁应用失败。\n" +
        "  大概率是 nightly 更新后 upstream 的 compat.rs 变了。\n" +
        "  处理办法：按 patches/rust-std-win7/README.md 重新生成补丁。\n" +
        `  当前 sysroot: ${sysroot}`,
    );
    process.exit(1);
  }

  // 校验补丁确实落到了目标文件上（防止 patch 匹配到别处）。
  const patched = fs.readFileSync(path.join(patchedLibrary, targetRel), "utf8");
  if (!patched.includes("SilverMoon patch")) {
    console.error(`✗ 补丁未生效：${targetRel} 里找不到标记字符串`);
    process.exit(1);
  }
  fs.writeFileSync(readyFlag, stamp);
  console.log("· 补丁已应用并校验");
}

// 把 sysroot 的 library 指向打过补丁的副本。
// 用符号链接而非移动目录：还原时只需删链接，不会丢文件。
fs.rmSync(sysLibrary, { recursive: true, force: true });
fs.symlinkSync(patchedLibrary, sysLibrary);
console.log(`· sysroot/library → ${patchedLibrary}`);

console.log("\n✓ Win7 工具链就绪（含 libstd 补丁）");
console.log("  提示：构建结束后请跑 `node scripts/run-win7-build.mjs --restore` 还原 sysroot，");
console.log("        或用 run-win7-build.mjs 包一层（它会自动还原）。");
