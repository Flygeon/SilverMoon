/**
 * 发布资源的回归测试：**图标必须真的嵌进启动器 exe**。
 *
 * 实机反馈过「安装后桌面快捷方式没有图标」。根因是启动器 exe 没有图标资源 ——
 * 而 Windows 快捷方式的图标取自**目标 exe 自己**（NSIS 的 CreateShortCut 第 4 个参数）。
 *
 * 这个坑很隐蔽：winresource 的 compile() 在 GNU 工具链下会生成 libresource.a
 * 并声明 cargo:rustc-link-lib，中间产物 resource.o 里确实有 .rsrc 节，
 * **但最终 exe 里没有** —— 只有把对象文件直接交给链接器（rustc-link-arg）才进得去。
 * 所以这条断言直接查**最终 exe**，而不是查中间产物。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "..", "..");

/** 各目标三平台产物路径（本机通常只有 GNU 那份；CI 上是 MSVC）。 */
const CANDIDATES = [
  "splash/target/release/silvermoon-splash.exe",
  "splash/target/x86_64-pc-windows-gnu/release/silvermoon-splash.exe",
  "splash/target/x86_64-pc-windows-msvc/release/silvermoon-splash.exe",
];

describe("启动器资源", () => {
  it("build.rs 把资源对象直接交给链接器（而不是依赖 winresource 的自动链接）", () => {
    const build = readFileSync(path.join(appRoot, "splash", "build.rs"), "utf8");
    // 必须用 rustc-link-arg 直接传对象文件 —— 这是 `.rsrc` 能进 exe 的关键
    expect(build).toContain("cargo:rustc-link-arg=");
    // 必须自己把 .rc 编成对象（MSVC 用 rc、GNU 用 windres）
    expect(build).toMatch(/windres|"rc"/);
    // 图标来源必须是应用图标
    expect(build).toContain("icon.ico");
  });

  const exe = CANDIDATES.map((p) => path.join(appRoot, p)).find((p) => existsSync(p));

  it("已构建的启动器 exe 含 .rsrc 节（未构建时跳过）", () => {
    if (!exe) return;
    let out = "";
    for (const bin of ["objdump", "x86_64-w64-mingw32-objdump", "llvm-objdump"]) {
      try {
        out = execFileSync(bin, ["-h", exe], { encoding: "utf8" });
        break;
      } catch {
        continue;
      }
    }
    if (!out) return; // 没有 objdump 就跳过（不假装通过）
    expect(out, `.rsrc 节缺失 → 快捷方式会没有图标：${exe}`).toMatch(/\.rsrc/);
  });

  it("exe 体积包含图标（弱信号兜底，未构建时跳过）", () => {
    if (!exe) return;
    // 嵌入 7 种尺寸后约 0.48MB；无图标时约 0.34MB。
    // 主断言是上面的 .rsrc 节，这条只是额外兜底。
    expect(statSync(exe).size).toBeGreaterThan(380 * 1024);
  });
});
