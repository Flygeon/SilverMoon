/**
 * 发布布局一致性检查。
 *
 * 这是**唯一能在 Linux/CI 上发现「启动器找不到 Electron」这类缺陷的手段**：
 * 真实二进制是 Windows 程序跑不了，而 CI 又只校验构建产物、不解包安装包。
 *
 * 做法：起一个临时目录**真实复刻安装后的布局**（root\SilverMoon.exe +
 * root\resources\silvermoon-splash.exe），然后按 Rust 与 NSIS 各自的探测规则
 * 去找 Electron，断言两者都能命中。
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "..", "..");

/** 复刻 Rust `locate_electron()` 的候选顺序 */
function locateLikeRust(launcherExe: string): string | null {
  const here = path.dirname(launcherExe);
  const candidates = [
    path.join(here, "SilverMoon.exe"),
    path.join(path.dirname(here), "SilverMoon.exe"),
  ];
  for (const exe of candidates) {
    try {
      if (statSync(exe).isFile()) return exe;
    } catch {
      /* 不存在则继续 */
    }
  }
  return null;
}

describe("安装后布局", () => {
  it("发布布局（启动器在 resources\\ 下）能被 Rust 的候选顺序命中", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sm-layout-"));
    mkdirSync(path.join(root, "resources"), { recursive: true });
    writeFileSync(path.join(root, "SilverMoon.exe"), "stub");
    const launcher = path.join(root, "resources", "silvermoon-splash.exe");
    writeFileSync(launcher, "stub");

    const found = locateLikeRust(launcher);
    expect(found, "Rust 探测应能找到上一级的 SilverMoon.exe").toBe(
      path.join(root, "SilverMoon.exe"),
    );
  });

  it("开发布局（两者同级）同样能被命中", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sm-layout-dev-"));
    writeFileSync(path.join(dir, "SilverMoon.exe"), "stub");
    const launcher = path.join(dir, "silvermoon-splash.exe");
    writeFileSync(launcher, "stub");

    expect(locateLikeRust(launcher)).toBe(path.join(dir, "SilverMoon.exe"));
  });

  it("Rust 源码里的候选顺序与上面复刻的一致（防止只改一处）", () => {
    // 真实逻辑在 pathfind.rs（纯函数，可在 Linux 直接跑），main.rs 只调用它。
    // 这里做**结构断言**，行为断言由 scripts/verify-splash-paths.mjs 跑真实 Rust 代码。
    const rs = readFileSync(path.join(appRoot, "splash", "src", "pathfind.rs"), "utf8");
    // 同目录候选
    expect(rs).toMatch(/here\.join\(ELECTRON_EXE\)/);
    // 上一级候选
    expect(rs).toMatch(/parent\.join\(ELECTRON_EXE\)/);
    // main.rs 必须真的调用它，而不是自己另写一份
    const mainRs = readFileSync(path.join(appRoot, "splash", "src", "main.rs"), "utf8");
    expect(mainRs).toMatch(/pick_electron\(&here/);
  });

  it("NSIS 脚本的探测顺序与 Rust 一致：先 resources、再根目录", () => {
    const nsh = readFileSync(path.join(appRoot, "build", "installer.nsh"), "utf8")
      .split("\n")
      .map((l) => l.replace(/;.*$/, ""))
      .join("\n");
    const resIdx = nsh.indexOf("resources\\silvermoon-splash.exe");
    const rootIdx = nsh.indexOf("$INSTDIR\\silvermoon-splash.exe");
    expect(resIdx, "应有 resources\\ 候选").toBeGreaterThan(-1);
    expect(rootIdx, "应有根目录回退候选").toBeGreaterThan(-1);
    expect(resIdx, "resources\\ 必须排在根目录之前").toBeLessThan(rootIdx);
  });
});
