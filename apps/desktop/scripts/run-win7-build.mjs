#!/usr/bin/env node
/**
 * Win7 构建包装器：准备打过补丁的 libstd → 跑真实构建 → 还原 sysroot。
 *
 * 为什么需要它：
 *   `-Z build-std` 固定从 sysroot 的 `library/` 读 std 源码，没有「指定源码
 *   目录」的参数。要给 std 打补丁就只能替换那个目录。为了让本机其他项目
 *   不受影响，构建结束后必须还原 —— 这就是本脚本存在的理由。
 *
 * 用法：
 *   node scripts/run-win7-build.mjs backend     # 构建后端
 *   node scripts/run-win7-build.mjs splash      # 构建启动器
 *   node scripts/run-win7-build.mjs both        # 两个都建（共用一次准备/还原）
 *   node scripts/run-win7-build.mjs --restore   # 只还原 sysroot（中断后的补救）
 *
 * 还原是**尽力而为且幂等**的：无论构建成功、失败还是被 Ctrl-C，
 * 都会尝试把 `library` 符号链接换回原始目录。
 */
//
// 目录约定：
//   `library.silvermoon-orig` 是**长期保留**的原始副本，不是临时文件。
//   setup 每次从它复制出干净副本再打补丁；这里只删符号链接、不删它，
//   所以「构建 → 还原 → 再构建」可以无限次循环，且每次都以未改动源码为基准。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const desktopDir = path.resolve(import.meta.dirname, "..");

function out(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** 找到 sysroot 里 library 与备份目录的路径。 */
function paths() {
  const sysroot = out("rustc", ["+nightly", "--print", "sysroot"]);
  const rustSrcRoot = path.join(sysroot, "lib/rustlib/src/rust");
  return {
    sysroot,
    library: path.join(rustSrcRoot, "library"),
    backup: path.join(rustSrcRoot, "library.silvermoon-orig"),
  };
}

/** 把 sysroot/library 还原成原始目录。幂等。 */
function restore() {
  const { library, backup } = paths();
  if (!fs.existsSync(library)) return false;

  const st = fs.lstatSync(library);
  if (!st.isSymbolicLink()) {
    // 已经是真实目录：说明不需要还原（或已还原过）
    return false;
  }
  fs.unlinkSync(library);
  if (fs.existsSync(backup)) {
    // 注意：这里只是把「真正的目录」改名回来。备份目录本身要一直留着 ——
    // 每次 setup 都从它复制干净副本，删了就得重装 rust-src。
    fs.renameSync(backup, library);
    console.log("· 已还原 sysroot 的原始 libstd");
  } else {
    console.warn("⚠ 找不到备份目录，sysroot/library 已删除 —— 请重装 rust-src");
  }
  return true;
}

const arg = process.argv[2] || "both";

// `--restore` 单独使用：用于上次构建被强杀后的补救
if (arg === "--restore") {
  const did = restore();
  console.log(did ? "✓ 已还原" : "· 无需还原");
  process.exit(0);
}

const TARGET = "x86_64-win7-windows-gnu";
const COMMON = ["build", "--release", "-Z", "build-std=std,panic_abort", "--target", TARGET];

const JOBS = {
  backend: {
    targetDir: "backend/target/win7",
    manifest: "backend/Cargo.toml",
    extra: ["--no-default-features", "--features", "win7"],
  },
  splash: {
    targetDir: "splash/target/win7",
    manifest: "splash/Cargo.toml",
    extra: [],
  },
};

const names = arg === "both" ? ["backend", "splash"] : [arg];
for (const n of names) {
  if (!JOBS[n]) {
    console.error(`✗ 未知目标：${n}（可选 backend / splash / both / --restore）`);
    process.exit(2);
  }
}

let exitCode = 0;

// 无论走哪条路，退出前都还原
function cleanup() {
  try {
    restore();
  } catch (e) {
    console.warn(`⚠ 还原失败：${e.message}`);
  }
}
process.on("SIGINT", () => {
  console.log("\n· 收到中断信号");
  cleanup();
  process.exit(130);
});

try {
  // 1) 准备（装 nightly/rust-src/mingw + 打 std 补丁 + 接上 sysroot）
  execFileSync("node", ["scripts/setup-win7-toolchain.mjs"], {
    cwd: desktopDir,
    stdio: "inherit",
  });

  // 2) 逐个构建
  for (const n of names) {
    const job = JOBS[n];
    console.log(`\n══ build ${n} (${TARGET}) ══`);
    execFileSync(
      "cargo",
      [
        "+nightly",
        ...COMMON,
        "--target-dir",
        job.targetDir,
        "--manifest-path",
        job.manifest,
        ...job.extra,
      ],
      { cwd: desktopDir, stdio: "inherit" },
    );
  }
} catch (e) {
  exitCode = e.status ?? 1;
  console.error(`\n✗ 构建失败（exit=${exitCode}）`);
} finally {
  cleanup();
}

process.exit(exitCode);
