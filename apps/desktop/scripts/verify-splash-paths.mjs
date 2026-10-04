#!/usr/bin/env node
/**
 * 启动器路径解析的单元测试（在 Linux/macOS 上直接跑真实 Rust 代码）。
 *
 * 为什么需要它：`splash/` 是 Windows GUI 程序，本机与 Linux CI 都跑不了二进制；
 * 而「安装后启动器与 Electron 的相对位置」这个缺陷**只在发布版暴露** ——
 * 曾经因为假设两者同级，装出来的应用直接打不开，而 CI 全绿。
 *
 * `src/pathfind.rs` 是无平台依赖的纯逻辑（只有 std::path），所以可以绕过
 * Win32 依赖，用 `rustc --test` 单独编译执行。这比「另写一份 Node 复刻逻辑」
 * 强得多：复刻只能证明「我以为的逻辑对」，这里跑的是**二进制里同一份代码**。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const src = path.join(appRoot, "splash", "src", "pathfind.rs");

if (!existsSync(src)) {
  console.error(`✗ 找不到 ${src}`);
  process.exit(1);
}

let rustc = process.env.RUSTC || "rustc";
try {
  execFileSync(rustc, ["--version"], { stdio: "pipe" });
} catch {
  // 试试 rustup 默认位置（本仓 CI 与本机都可能不在 PATH）
  const fallback = path.join(process.env.HOME ?? "", ".cargo", "bin", "rustc");
  if (existsSync(fallback)) {
    rustc = fallback;
  } else {
    console.error("✗ 未找到 rustc（设置 RUSTC 环境变量或安装 Rust）");
    process.exit(1);
  }
}

const out = path.join(mkdtempSync(path.join(tmpdir(), "sm-pathfind-")), "test");

try {
  execFileSync(rustc, ["--test", src, "-o", out], { stdio: "pipe" });
} catch (e) {
  console.error("✗ 编译 pathfind 测试失败：");
  console.error(String(e.stdout ?? e.stderr ?? e.message));
  process.exit(1);
}

let report;
try {
  report = execFileSync(out, [], { encoding: "utf8" });
} catch (e) {
  console.error("✗ pathfind 测试失败：");
  console.error(String(e.stdout ?? ""));
  process.exit(1);
}

const passed = /(\d+) passed/.exec(report)?.[1] ?? "0";
const failed = /(\d+) failed/.exec(report)?.[1] ?? "0";
if (failed !== "0") {
  console.error(report);
  process.exit(1);
}
console.log(`✓ 启动器路径解析测试通过（${passed} 例，真实 Rust 代码）`);
