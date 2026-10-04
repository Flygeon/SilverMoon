#!/usr/bin/env node
/**
 * 启动器纯逻辑模块的单元测试（在 Linux/CI 上跑**真实 Rust 代码**）。
 *
 * 为什么需要它：`splash/` 是 Windows GUI 程序，本机与 Linux CI 都跑不了二进制；
 * 而它踩过的两个坑**都只在发布版才暴露**：
 *
 * 1. 发布布局：启动器以为与 SilverMoon.exe 同级，而 electron-builder 的
 *    extraResources 实际放进 resources/ → 装出来的应用打不开；
 * 2. 主题跟随：splash 亮/暗要跟应用设置，而设置里 `theme` 与 `readerTheme`
 *    并存，用子串匹配会读错键。
 *
 * 这两类逻辑都刻意写在**无平台依赖的模块**里（pathfind / prefs / animation），
 * 并挂到 `src/lib.rs` 这个只服务测试的 lib target 上，于是 `cargo test --lib`
 * 能在宿主编译并执行**与发布二进制同一份代码**。
 *
 * 为什么不用 Node 复刻一份同样的逻辑：复刻只能证明「我以为的逻辑对」，
 * 源码改了复刻没跟着改就完全失效。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const manifest = path.join(appRoot, "splash", "Cargo.toml");

if (!existsSync(manifest)) {
  console.error(`✗ 找不到 ${manifest}`);
  process.exit(1);
}

// 找一个可用的 cargo（CI 与本机的 PATH 情况不同）
function findCargo() {
  const candidates = [
    process.env.CARGO,
    "cargo",
    path.join(process.env.HOME ?? "", ".cargo", "bin", "cargo"),
    "/root/.cargo/bin/cargo",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      continue;
    }
  }
  return null;
}

const cargo = findCargo();
if (!cargo) {
  console.error("✗ 未找到 cargo（设置 CARGO 环境变量或安装 Rust）");
  process.exit(1);
}

let report = "";
try {
  // 只跑 lib target：bin target 依赖 Win32，宿主编不过（正是要有 lib 的原因）
  report = execFileSync(cargo, ["test", "--lib", "--manifest-path", manifest], {
    cwd: appRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  console.error("✗ 启动器纯逻辑测试失败：");
  console.error(String(e.stdout ?? e.stderr ?? e.message));
  process.exit(1);
}

// 汇总行形如 "test result: ok. 21 passed; 0 failed; ..."（可能有多段）
const passed = [...report.matchAll(/(\d+) passed/g)].reduce((s, m) => s + Number(m[1]), 0);
const failed = [...report.matchAll(/(\d+) failed/g)].reduce((s, m) => s + Number(m[1]), 0);

if (failed > 0) {
  console.error(report);
  process.exit(1);
}
if (passed === 0) {
  console.error("✗ 没有跑到任何测试 —— 这本身是错误（断言失效比测试失败更危险）");
  console.error(report);
  process.exit(1);
}

console.log(`✓ 启动器纯逻辑测试通过（${passed} 例，真实 Rust 代码）`);
