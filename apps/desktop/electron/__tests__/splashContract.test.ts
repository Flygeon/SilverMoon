/**
 * 启动器 ↔ Electron 握手契约测试。
 *
 * 为什么要有它：Rust 启动器是 Windows 专用二进制，本机/CI 的 Linux 作业都跑不了它。
 * 但协议本身（READY / FADING:<ms>）是两端共享的**接口**，接口错了就是「splash 不消失」
 * 或「主窗口不出现」这类致命体验问题。
 *
 * 这里分两层：
 * 1. 用真实的 Electron 侧实现（electron/splash.ts）连接一个 Node 模拟的启动器端，
 *    验证协议对话与失败降级；
 * 2. 静态检查 Rust 侧源码，确保「无限等待」的兜底常量真的被引用
 *    （曾经的真实缺陷：ConnectNamedPipe 无限阻塞导致 splash 永不消失）。
 */
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handshakeWithSplash } from "../splash";

const appRoot = path.resolve(__dirname, "..", "..");

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * 起一个冒充「启动器端」的 Unix domain socket 服务。
 *
 * Windows 命名管道无法在 POSIX 上建立，但**协议字节流完全一致**
 * （一行一条、\n 结尾），所以用 Unix socket 验协议对话是有效等价物。
 * 返回 socket 路径，可直接作为 --splash-pipe 的值（绝对路径会原样透传）。
 */
function fakeLauncher(onReady: (reply: (msg: string) => void) => void): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "sm-splash-"));
  const sockPath = path.join(dir, "pipe");
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.includes("READY")) {
          buf = "";
          onReady((msg) => socket.write(msg + "\n"));
        }
      });
    });
    servers.push(server);
    server.listen(sockPath, () => resolve(sockPath));
  });
}

describe("启动器握手契约", () => {
  it("FADING:220 会被解析出 220ms 并回调", async () => {
    const addr = await fakeLauncher((reply) => reply("FADING:220"));
    let received = -1;
    const ok = await handshakeWithSplash(
      (ms) => {
        received = ms;
      },
      ["electron", `--splash-pipe=${addr}`],
    );
    expect(ok).toBe(true);
    expect(received).toBe(220);
  });

  it("FADING 值非法时回退到 200ms（不能让窗口等 0 或 NaN）", async () => {
    const addr = await fakeLauncher((reply) => reply("FADING:abc"));
    let received = -1;
    const ok = await handshakeWithSplash(
      (ms) => {
        received = ms;
      },
      ["electron", `--splash-pipe=${addr}`],
    );
    expect(ok).toBe(true);
    expect(received).toBe(200);
  });

  it("启动器一直不回 FADING 时返回 false（调用方据此直接显示窗口）", async () => {
    const addr = await fakeLauncher(() => {
      /* 故意不回，模拟卡住的启动器 */
    });
    const ok = await handshakeWithSplash(() => {}, ["electron", `--splash-pipe=${addr}`]);
    expect(ok).toBe(false);
  }, 10000);
});

// 启动器源码的只读快照（文件级：多个 describe 都要断言）
const handshakeRs = readFileSync(path.join(appRoot, "splash", "src", "handshake.rs"), "utf8");
const mainRs = readFileSync(path.join(appRoot, "splash", "src", "main.rs"), "utf8");
const windowRs = readFileSync(path.join(appRoot, "splash", "src", "window.rs"), "utf8");

describe("Rust 启动器的兜底不变量", () => {
  it("定义了 CONNECT_TIMEOUT 兜底，且在 main.rs 里真的被引用", () => {
    expect(handshakeRs).toMatch(/CONNECT_TIMEOUT\s*:\s*Duration/);
    expect(mainRs).toContain("CONNECT_TIMEOUT");
  });

  it("不能用阻塞版 ConnectNamedPipe 直接等（会导致无限挂起）", () => {
    // 连接必须放到独立线程里，主流程用轮询 + 超时
    expect(handshakeRs).toMatch(/thread::spawn/);
    expect(handshakeRs).toContain("connected");
  });

  it("FADE_MS 在两端一致：Rust 常量与 Electron 侧协议同名", () => {
    const m = handshakeRs.match(/FADE_MS\s*:\s*u64\s*=\s*(\d+)/);
    expect(m, "Rust 侧应有 FADE_MS").toBeTruthy();
    // Electron 侧不硬编码该值（由 Rust 通过 FADING:<ms> 告知），只保证存在解析逻辑
    expect(readFileSync(path.join(appRoot, "electron", "splash.ts"), "utf8")).toContain("FADING:");
  });

  it("窗口在收到就绪后必须能自行判定结束（否则消息循环不退出）", () => {
    expect(windowRs).toContain("is_done");
    expect(mainRs).toMatch(/window::is_done\(\)/);
  });
});

describe("发布布局：安装包里的实际落点", () => {
  /**
   * 这一组是**实测安装包解包后**才发现的缺陷的回归防线。
   *
   * 事实：electron-builder 的 `win.extraResources` 把文件放进 `<安装目录>\\resources\\`，
   * 而 `SilverMoon.exe` 在安装根目录。所以启动器不在 Electron 旁边，而在上一级的
   * `resources\\` 里。
   *
   * 后果（如果按“同级”假设写死）：启动器找不到 SilverMoon.exe → 拉起失败 →
   * 快捷方式指向一个什么都不做的程序，应用打不开。而 CI 当时是全绿的 ——
   * 因为 CI 只校验构建产物存在，从不解包安装包看布局。
   */
  // **去掉注释再断言**：NSIS 注释里正好写着「先 resources、再根目录」，
  // 直接对全文 includes 会让注释本身满足断言 —— 变异测试因此假通过过（实测）。
  const nshCode = readFileSync(path.join(appRoot, "build", "installer.nsh"), "utf8")
    .split("\n")
    .map((line) => line.replace(/;.*$/, ""))
    .join("\n");

  it("NSIS 优先按 resources\\ 定位启动器，并保留根目录回退", () => {
    expect(nshCode).toContain("resources\\silvermoon-splash.exe");
    // 回退分支也要在，兼容手工摆放/未来布局变化
    expect(nshCode).toContain("$INSTDIR\\silvermoon-splash.exe");
    expect(nshCode).toMatch(/FileExists/);
  });

  it("Rust 启动器会向上级目录探测 Electron（而不是只看同目录）", () => {
    // 路径判断已抽到 pathfind.rs（纯函数，可在 Linux 上跑真实代码）；
    // **行为**断言交给 scripts/verify-splash-paths.mjs（rustc --test），
    // 这里只做结构断言，确认模块成形且 main.rs 真的在用它。
    const pf = readFileSync(path.join(appRoot, "splash", "src", "pathfind.rs"), "utf8");
    expect(pf).toMatch(/if let Some\(parent\) = here\.parent\(\)/);
    expect(pf).toMatch(/parent\.join\(ELECTRON_EXE\)/);
    // 逐个 is_file() 判断，而不是盲选
    expect(pf).toMatch(/find\(\|p\| exists\(p\)\)/);
    // main.rs 必须调用它
    expect(mainRs).toContain("pick_electron");
    expect(mainRs).toContain("locate_electron");
  });

  it("extraResources 的 to 字段仍是纯文件名（决定它落在 resources\\ 下）", () => {
    const builder = readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8");
    expect(builder).toMatch(/from: splash\/target\/release\/silvermoon-splash\.exe/);
    expect(builder).toMatch(/to: silvermoon-splash\.exe/);
  });
});
