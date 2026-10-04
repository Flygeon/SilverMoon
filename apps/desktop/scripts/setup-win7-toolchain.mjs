/**
 * 准备 Win7 目标所需的 Rust 工具链与系统依赖。
 *
 * Win7 目标（`x86_64-win7-windows-gnu`）是 **tier-3**，因此需要：
 * - **nightly**（`-Z build-std` 只在 nightly 上可用 —— stable 会直接报
 *   `the option \`Z\` is only accepted on the nightly compiler`）；
 * - **rust-src** 组件（build-std 要从源码编 std）；
 * - **mingw-w64** 链接器（tier-3 目标不自带）。
 *
 * 本脚本幂等，可在本地与 CI 复用。Linux/macOS 下自动装 mingw；
 * Windows 下只准备 rust 部分（Win7 产物本身在 Linux 上交叉编译更省事，
 * 见 doc/win7-electron22.md 第 4 节）。
 */
import { execFileSync } from "node:child_process";

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function has(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 1) nightly + rust-src
run("rustup", ["toolchain", "install", "nightly", "--profile", "minimal"]);
run("rustup", ["component", "add", "rust-src", "--toolchain", "nightly"]);

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

console.log("\n✓ Win7 工具链就绪");
