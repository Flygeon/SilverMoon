/**
 * 启动器（splash）握手：在 Electron 这一侧。
 *
 * 背景：用户可见的「等待」发生在 Electron 主进程起来**之前**，所以那段时间由
 * 一个原生启动器（splash/，Rust + Win32）负责出画面。启动器用命名管道通知我们
 * 「主窗口已渲染完」，我们收到后让它淡出，并在它淡出的同时显示主窗口。
 *
 * 本模块只做两件事：
 * 1. 解析 --splash-pipe=<name>（没有该参数 = 不是从启动器拉起的，直接忽略）；
 * 2. 连上管道 → 发 READY → 等 FADING:<ms> → 回调告知「等 ms 后显示窗口」。
 *
 * 为什么失败一律静默降级：启动器只是「可选的观感增强」。任何一步失败都必须让主窗口
 * 照常显示，绝不能因为握手出问题而让用户看不到应用。
 */
import { connect, type Socket } from "node:net";

import { log } from "./log";

/** 等待启动器回 FADING 的上限；超时就自己显示窗口，不等了。 */
const FADING_TIMEOUT_MS = 3000;

/** 从进程命令行里取出 --splash-pipe= 的值。 */
export function splashPipeName(argv: readonly string[] = process.argv): string | null {
  const prefix = "--splash-pipe=";
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const name = arg.slice(prefix.length).trim();
      return name.length > 0 ? name : null;
    }
  }
  return null;
}

/**
 * 把管道名转成 Node 可连的路径。
 *
 * 启动器传的是完整形式（\\\\.\\pipe\\name）；若只给了裸名也补全。
 */
function toPipePath(name: string): string {
  // Windows 命名管道路径形如 \\.\pipe\name。
  // 启动器（Rust 侧）传的就是完整形式，只需在裸名时补全。
  const PREFIX = "\\\\.\\pipe\\";
  if (name.startsWith(PREFIX)) return name;
  // POSIX 绝对路径原样透传：**仅为可测性**。
  // 真实运行只会走上面的命名管道分支（启动器是 Windows 程序）；
  // 但命名管道无法在 Linux/macOS 上建立，测试要用 Unix domain socket 才能
  // 端到端验证协议对话。没有这一条，协议就只能靠"看代码"保证正确。
  if (name.startsWith("/")) return name;
  return PREFIX + name;
}

/**
 * 与启动器握手。
 *
 * @param onFadeStart 收到启动器「开始淡出、预计 ms 后消失」时调用；
 *                    Electron 应在此之后等 ms 再 show 主窗口，形成视觉交叠。
 * @returns 是否成功握手（false = 没有启动器 / 连接失败，调用方应直接显示窗口）
 */
export async function handshakeWithSplash(
  onFadeStart: (fadeMs: number) => void,
  argv: readonly string[] = process.argv,
): Promise<boolean> {
  const pipeName = splashPipeName(argv);
  if (!pipeName) return false;

  let socket: Socket;
  try {
    socket = await connectPipe(toPipePath(pipeName));
  } catch (e) {
    log.warn(`splash 握手失败（将直接显示主窗口）：${String(e)}`);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let buffer = "";

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    const timer = setTimeout(() => {
      // 启动器没回 FADING（可能是老版本）：直接显示窗口，别把用户晾着
      log.warn("splash 未在限时内回应 FADING，直接显示主窗口");
      finish(false);
    }, FADING_TIMEOUT_MS);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("FADING:")) {
          const ms = Number.parseInt(line.slice("FADING:".length), 10);
          onFadeStart(Number.isFinite(ms) && ms > 0 ? ms : 200);
          finish(true);
        }
      }
    });

    socket.on("error", (e) => {
      log.warn(`splash 管道出错（将直接显示主窗口）：${e.message}`);
      finish(false);
    });
    socket.on("close", () => finish(false));

    // 告诉启动器：主窗口已可显示
    socket.write("READY\n");
  });
}

/** 连接命名管道（resolve = 已连接）。 */
function connectPipe(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const onError = (e: Error) => {
      socket.removeListener("connect", onConnect);
      reject(e);
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}
