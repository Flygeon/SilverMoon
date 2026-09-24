/**
 * 宿主 HTTP 服务：Rust 侧车 → Electron 的反向调用入口。
 *
 * 侧车在启动时通过环境变量拿到本服务的端口与令牌，随后用 `POST /rpc` 发起
 * 「宿主操作」（建窗、eval、读 cookie、建托盘、注册热键、打开文件…）。
 *
 * 与侧车的命令服务对称：两边都只绑 `127.0.0.1`，都用 `X-SilverMoon-Token` 鉴权。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { shell } from "electron";
import { globalShortcut } from "electron";

import {
  dispatchEvent,
  getWindow,
  listLabels,
  createRustWindow,
  webContentsByLabel,
} from "./windows";
import { createTray, setTrayVisible } from "./tray";
import { log } from "./log";

export interface HostServer {
  port: number;
  token: string;
  /** 关闭服务 */
  close(): void;
}

/** 侧车可调用的宿主操作。 */
type HostOpHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

let stopHandler: (() => void) | null = null;
/** 应用退出请求（由 `main.ts` 注入）。 */
let exitHandler: (() => void) | null = null;

export function setExitHandler(handler: () => void): void {
  exitHandler = handler;
}

/** 已注册的全局热键（accelerator → 解绑函数）。 */
const registeredShortcuts = new Map<string, () => void>();

function buildOps(): Record<string, HostOpHandler> {
  return {
    "window.list": () => listLabels(),

    "webview.exists": (args) => {
      const label = String(args.label ?? "");
      return !!getWindow(label);
    },

    "webview.create": (args) => {
      createRustWindow(args as Parameters<typeof createRustWindow>[0]);
      return null;
    },

    "webview.eval": async (args) => {
      const label = String(args.label ?? "");
      const script = String(args.script ?? "");
      const wantResult = args.wantResult === true;
      const contents = webContentsByLabel(label);
      if (!contents) throw new Error(`窗口 ${label} 不存在`);

      try {
        if (!wantResult) {
          await contents.executeJavaScript(script, false);
          return { result: "null" };
        }
        const value = await contents.executeJavaScript(script, true);
        // Rust 侧的 `eval_with_callback` 约定拿到的是 JS 值的 JSON 文本
        return { result: JSON.stringify(value ?? null) };
      } catch (error) {
        // 页面未就绪 / 脚本抛错时不能把整条链路打断：
        // 番剧取流是轮询式的，单次失败下一次会重试。
        log.warn(`[${label}] eval 失败：`, (error as Error).message);
        return { result: "null" };
      }
    },

    "webview.navigate": (args) => {
      const label = String(args.label ?? "");
      const win = getWindow(label);
      if (!win) throw new Error(`窗口 ${label} 不存在`);
      if (args.block === true) {
        // `on_navigation` 返回 false：放弃当前导航并回退
        win.webContents.stop();
        return null;
      }
      void win.loadURL(String(args.url ?? "about:blank"));
      return null;
    },

    "webview.show": (args) => {
      const win = getWindow(String(args.label ?? ""));
      if (!win) throw new Error("窗口不存在");
      const action = String(args.action ?? "show");
      if (action === "show") {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      } else if (action === "unminimize") {
        if (win.isMinimized()) win.restore();
      } else if (action === "focus") {
        win.focus();
      }
      return null;
    },

    "webview.close": (args) => {
      const win = getWindow(String(args.label ?? ""));
      if (!win) return null; // 已经关掉了，视作成功
      win.destroy();
      return null;
    },

    "webview.isVisible": (args) => {
      const win = getWindow(String(args.label ?? ""));
      return win ? win.isVisible() : false;
    },

    "webview.openDevtools": (args) => {
      webContentsByLabel(String(args.label ?? ""))?.openDevTools({ mode: "detach" });
      return null;
    },

    "webview.cookies": async (args) => {
      const contents = webContentsByLabel(String(args.label ?? ""));
      if (!contents) return [];
      const cookies = await contents.session.cookies.get({});
      // 含 httpOnly —— 这正是文库8 登录要拿的内容
      return cookies.map((c) => ({ name: c.name, value: c.value }));
    },

    "webview.setAlwaysOnTop": (args) => {
      getWindow(String(args.label ?? ""))?.setAlwaysOnTop(args.value === true);
      return null;
    },

    "webview.setIgnoreCursorEvents": (args) => {
      const win = getWindow(String(args.label ?? ""));
      if (!win) return null;
      win.setIgnoreMouseEvents(args.value === true, { forward: true });
      return null;
    },

    "tray.create": (args) => {
      createTray(args as Parameters<typeof createTray>[0]);
      return null;
    },

    "tray.setVisible": (args) => {
      setTrayVisible(args.visible === true);
      return null;
    },

    "app.exit": (args) => {
      log.info(`Rust 请求退出应用（code=${args.code ?? 0}）`);
      exitHandler?.();
      return null;
    },

    "shortcut.register": (args) => {
      const accelerator = String(args.accelerator ?? "");
      if (!accelerator) throw new Error("热键为空");
      if (registeredShortcuts.has(accelerator)) return null;
      const ok = globalShortcut.register(accelerator, () => {
        // 热键按下时通知 Rust（Rust 侧再决定开/关扩展窗口）
        void notifySidecar({ kind: "shortcut", accelerator, pressed: true });
      });
      if (!ok) throw new Error(`系统拒绝注册热键：${accelerator}`);
      registeredShortcuts.set(accelerator, () => globalShortcut.unregister(accelerator));
      return null;
    },

    "shortcut.unregister": (args) => {
      const accelerator = String(args.accelerator ?? "");
      registeredShortcuts.get(accelerator)?.();
      registeredShortcuts.delete(accelerator);
      return null;
    },

    "opener.openPath": async (args) => {
      if (typeof args.url === "string" && args.url) {
        await shell.openExternal(args.url);
        return null;
      }
      const target = String(args.path ?? "");
      if (!target) throw new Error("缺少路径");
      // `ext_open_impl` 已经自己处理了「视频跳秒优先用 mpv/PotPlayer」的分支，
      // 走到这里说明应当交给系统默认程序。
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return null;
    },

    "opener.reveal": (args) => {
      shell.showItemInFolder(String(args.path ?? ""));
      return null;
    },
  };
}

let ops: Record<string, HostOpHandler> = buildOps();

/** 侧车回调通道（供 `windows.ts` 询问导航是否放行、`main.ts` 转发托盘/热键事件）。 */
type Notifier = (payload: Record<string, unknown>) => Promise<unknown>;

let notifySidecar: Notifier = async () => ({ ok: false, error: "侧车未就绪" });

export function setSidecarNotifier(notifier: Notifier): void {
  notifySidecar = notifier;
}

/** 启动宿主服务。 */
export async function startHostServer(): Promise<HostServer> {
  const token = randomBytes(24).toString("hex");
  ops = buildOps();

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, token);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log.info(`宿主服务已监听 127.0.0.1:${port}`);

  stopHandler = () => server.close();

  return {
    port,
    token,
    close: () => stopHandler?.(),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    const text = JSON.stringify(body ?? null);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  if (req.method !== "POST" || !req.url?.startsWith("/rpc")) {
    reply(404, { ok: false, error: "not found" });
    return;
  }
  if (req.headers["x-silvermoon-token"] !== token) {
    reply(401, { ok: false, error: "令牌无效" });
    return;
  }

  const body = await readBody(req);
  let parsed: { op?: string; args?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    reply(400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }

  const op = String(parsed.op ?? "");
  const handler = ops[op];
  if (!handler) {
    log.warn(`收到未知宿主操作：${op}`);
    reply(404, { ok: false, error: `未知宿主操作 ${op}` });
    return;
  }

  try {
    const data = await handler(parsed.args ?? {});
    reply(200, { ok: true, data: data ?? null });
  } catch (error) {
    const message = (error as Error).message || String(error);
    log.error(`宿主操作 ${op} 失败：${message}`);
    reply(200, { ok: false, error: message });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 供其它模块（托盘点击、热键）主动推事件给渲染进程。 */
export { dispatchEvent };
