/**
 * 渲染进程 → 主进程的能力分发。
 *
 * 渲染进程只调用 `window.__SILVERMOON__.call(channel, payload)`，由这里按
 * `channel` 白名单转发。设计上刻意**不暴露通用的 `ipcRenderer`**，
 * 而是把能力收敛成有限的几组操作。
 *
 * 所有回复统一是 `{ ok, data?, error? }`：错误以**字符串**回传，
 * 由渲染进程的 `src/ipc/` 转成 `Promise.reject(字符串)`。
 */
import { BrowserWindow, app, dialog, ipcMain, shell, screen } from "electron";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { config, displayName, iconPath } from "./config";
import {
  dispatchEvent,
  getWindow,
  createChildWindow,
  listLabels,
  preventClose,
  watchClose,
} from "./windows";
import { handleStore } from "./store";
import { log } from "./log";
import { callSidecar } from "./main-bridge";

export interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type Handler = (
  payload: Record<string, unknown>,
  sender: Electron.WebContents,
) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  // -------------------------------------------------------------------------
  // Rust 命令
  // -------------------------------------------------------------------------
  invoke: async (payload) => {
    const cmd = String(payload.cmd ?? "");
    if (!cmd) throw new Error("缺少 cmd");
    const reply = await callSidecar(cmd, payload.args ?? {});
    if (!reply.ok) {
      // 用 Error 抛出会被 ipcMain 包一层，所以这里手动把错误塞进返回值
      return { __commandError: reply.error ?? `命令 ${cmd} 失败` };
    }
    return reply.data ?? null;
  },

  // -------------------------------------------------------------------------
  // 窗口
  // -------------------------------------------------------------------------
  window: async (payload, _sender) => {
    const op = String(payload.op ?? "");
    const label = String(payload.target ?? payload.label ?? "main");
    const win = getWindow(label);
    const scaleOf = (target: BrowserWindow) =>
      screen.getDisplayMatching(target.getBounds()).scaleFactor || 1;

    switch (op) {
      case "create": {
        const options = (payload.options ?? {}) as Record<string, unknown>;
        createChildWindow(label, options as Parameters<typeof createChildWindow>[1]);
        return null;
      }
      case "exists":
        return !!win;
      case "list":
        return listLabels();
      case "watchClose":
        watchClose(label);
        return null;
      case "preventClose":
        preventClose(label);
        return null;
      default:
        break;
    }

    if (!win) throw new Error(`窗口 ${label} 不存在`);

    switch (op) {
      case "isMaximized":
        return win.isMaximized();
      case "isVisible":
        return win.isVisible();
      case "minimize":
        win.minimize();
        return null;
      case "toggleMaximize":
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return null;
      case "close":
        // 走 close 事件，让 onCloseRequested 的接管逻辑照常生效
        win.close();
        return null;
      case "destroy":
        win.destroy();
        return null;
      case "hide":
        win.hide();
        return null;
      case "show":
        win.show();
        return null;
      case "focus":
        win.focus();
        return null;
      case "setTitle":
        win.setTitle(String(payload.title ?? displayName));
        return null;
      case "setAlwaysOnTop":
        win.setAlwaysOnTop(payload.value === true);
        return null;
      case "setIgnoreCursorEvents":
        win.setIgnoreMouseEvents(payload.value === true, { forward: true });
        return null;
      case "outerPosition": {
        const [x, y] = win.getPosition();
        const scale = scaleOf(win);
        return { x: Math.round(x * scale), y: Math.round(y * scale) };
      }
      case "outerSize": {
        const [width, height] = win.getSize();
        const scale = scaleOf(win);
        return { width: Math.round(width * scale), height: Math.round(height * scale) };
      }
      case "setPosition": {
        const pos = payload.position as { kind?: string; x: number; y: number } | undefined;
        if (!pos) return null;
        const scale = scaleOf(win);
        if (pos.kind === "physical") {
          win.setPosition(Math.round(pos.x / scale), Math.round(pos.y / scale));
        } else {
          win.setPosition(Math.round(pos.x), Math.round(pos.y));
        }
        return null;
      }
      case "setSize": {
        const size = payload.size as { kind?: string; width: number; height: number } | undefined;
        if (!size) return null;
        const scale = scaleOf(win);
        if (size.kind === "physical") {
          win.setSize(Math.round(size.width / scale), Math.round(size.height / scale));
        } else {
          win.setSize(Math.round(size.width), Math.round(size.height));
        }
        return null;
      }
      default:
        throw new Error(`未知窗口操作：${op}`);
    }
  },

  // -------------------------------------------------------------------------
  // 跨窗口事件
  // -------------------------------------------------------------------------
  emit: (payload) => {
    const target =
      payload.target === null || payload.target === undefined ? null : String(payload.target);
    dispatchEvent({
      event: String(payload.event ?? ""),
      target,
      payload: payload.payload ?? null,
    });
    return null;
  },

  // -------------------------------------------------------------------------
  // 文件对话框
  // -------------------------------------------------------------------------
  dialog: async (payload, sender) => {
    const op = String(payload.op ?? "");
    const options = (payload.options ?? {}) as {
      title?: string;
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
      multiple?: boolean;
      directory?: boolean;
    };
    const parent = BrowserWindow.fromWebContents(sender) ?? undefined;

    if (op === "open") {
      const properties: Array<"openFile" | "openDirectory" | "multiSelections"> = [];
      if (options.directory) properties.push("openDirectory");
      else properties.push("openFile");
      if (options.multiple) properties.push("multiSelections");

      const result = await dialog.showOpenDialog(parent!, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return options.multiple ? result.filePaths : result.filePaths[0];
    }

    if (op === "save") {
      const result = await dialog.showSaveDialog(parent!, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    }

    if (op === "message" || op === "confirm" || op === "ask") {
      const type =
        op === "message"
          ? String((payload.options as { kind?: string })?.kind ?? "info")
          : "question";
      const buttons = op === "message" ? ["确定"] : ["确定", "取消"];
      const result = await dialog.showMessageBox(parent!, {
        type: type as "info" | "warning" | "error" | "question",
        title: options.title ?? displayName,
        message: String(payload.message ?? ""),
        buttons,
        noLink: true,
        cancelId: op === "message" ? 0 : 1,
      });
      return op === "message" ? null : result.response === 0;
    }

    throw new Error(`未知对话框操作：${op}`);
  },

  // -------------------------------------------------------------------------
  // 文件系统
  // -------------------------------------------------------------------------
  fs: async (payload) => {
    const op = String(payload.op ?? "");
    const target = String(payload.path ?? "");
    switch (op) {
      case "readFile":
        return readFile(target);
      // 二进制过 contextBridge 的兜底通道：万一 TypedArray 无法跨隔离世界传递，
      // 渲染进程会退回到 base64 版本（见 src/ipc/fs.ts）
      case "readFileBase64":
        return (await readFile(target)).toString("base64");
      case "writeFileBase64":
        await writeFile(target, Buffer.from(String(payload.data ?? ""), "base64"));
        return null;
      case "readTextFile":
        return readFile(target, "utf8");
      case "writeFile": {
        const data = payload.data as Uint8Array | undefined;
        if (!data) throw new Error("缺少写入数据");
        await writeFile(target, Buffer.from(data));
        return null;
      }
      case "writeTextFile":
        await writeFile(target, String(payload.contents ?? ""), "utf8");
        return null;
      case "exists": {
        try {
          await stat(target);
          return true;
        } catch {
          return false;
        }
      }
      case "mkdir":
        await mkdir(target, { recursive: payload.recursive === true });
        return null;
      case "remove":
        await rm(target, { recursive: payload.recursive === true, force: true });
        return null;
      case "copyFile":
        await copyFile(String(payload.from ?? ""), String(payload.to ?? ""));
        return null;
      case "rename":
        await rename(String(payload.from ?? ""), String(payload.to ?? ""));
        return null;
      case "stat": {
        const info = await stat(target);
        return {
          isFile: info.isFile(),
          isDirectory: info.isDirectory(),
          size: info.size,
          mtime: Math.round(info.mtimeMs),
        };
      }
      case "readDir": {
        const entries = await readdir(target, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
        }));
      }
      default:
        throw new Error(`未知文件操作：${op}`);
    }
  },

  // -------------------------------------------------------------------------
  // 键值存储
  // -------------------------------------------------------------------------
  store: (payload) => handleStore(payload),

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------
  path: (payload) => {
    const op = String(payload.op ?? "");
    switch (op) {
      case "appDataDir":
        return dataRoot();
      case "appCacheDir":
        return cacheRoot();
      case "appConfigDir":
        return app.getPath("userData");
      case "appLogDir":
        return app.getPath("logs");
      case "homeDir":
        return app.getPath("home");
      case "tempDir":
        return app.getPath("temp");
      case "join":
        return path.join(...((payload.paths as string[]) ?? []));
      case "normalize":
        return path.normalize(String(payload.path ?? ""));
      case "dirname":
        return path.dirname(String(payload.path ?? ""));
      case "basename": {
        const ext = payload.ext ? String(payload.ext) : undefined;
        return ext
          ? path.basename(String(payload.path ?? ""), ext)
          : path.basename(String(payload.path ?? ""));
      }
      case "extname":
        return path.extname(String(payload.path ?? ""));
      default:
        throw new Error(`未知路径操作：${op}`);
    }
  },

  // -------------------------------------------------------------------------
  // 应用
  // -------------------------------------------------------------------------
  app: (payload) => {
    const op = String(payload.op ?? "");
    switch (op) {
      case "version":
        return config.version;
      case "hostVersion":
        return process.versions.electron ?? "unknown";
      case "name":
        return displayName;
      case "iconPath":
        return iconPath() ?? null;
      case "exit":
        quitApp();
        return null;
      default:
        throw new Error(`未知应用操作：${op}`);
    }
  },

  // -------------------------------------------------------------------------
  // 系统默认程序
  // -------------------------------------------------------------------------
  opener: async (payload) => {
    const op = String(payload.op ?? "");
    if (op === "openUrl") {
      await shell.openExternal(String(payload.url ?? ""));
      return null;
    }
    const target = String(payload.path ?? "");
    if (op === "reveal") {
      shell.showItemInFolder(target);
      return null;
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return null;
  },

  // -------------------------------------------------------------------------
  // 带 CORS 豁免的网络请求
  // -------------------------------------------------------------------------
  http: async (payload) => {
    const url = String(payload.url ?? "");
    const method = String(payload.method ?? "GET");
    const headers = Object.fromEntries((payload.headers as [string, string][]) ?? []);
    const body = payload.body ? String(payload.body) : undefined;

    const response = await fetch(url, { method, headers, body, redirect: "follow" });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    // 文本类直接给字符串，省掉一次 base64 编解码
    const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(
      contentType,
    );

    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: [...response.headers.entries()],
      body: isText ? buffer.toString("utf8") : buffer.toString("base64"),
      bodyIsBase64: !isText,
    };
  },
};

// 目录在 `main.ts` 里设定，避免此模块直接依赖 app.whenReady 时序
let dataDirRef = "";
let cacheDirRef = "";

export function setDataDirs(data: string, cache: string): void {
  dataDirRef = data;
  cacheDirRef = cache;
}

function dataRoot(): string {
  return dataDirRef;
}

function cacheRoot(): string {
  return cacheDirRef;
}

let quitHandler: (() => void) | null = null;

export function setQuitHandler(handler: () => void): void {
  quitHandler = handler;
}

function quitApp(): void {
  quitHandler?.();
}

/** 注册全部 IPC 通道。 */
export function registerIpc(): void {
  ipcMain.handle(
    "sm:call",
    async (event, request: { channel: string; payload: Record<string, unknown> }) => {
      return respond(request?.channel ?? "", request?.payload ?? {}, event.sender);
    },
  );

  ipcMain.handle("sm:invoke", async (_event, request: { cmd: string; args: unknown }) => {
    return respond("invoke", { cmd: request?.cmd, args: request?.args }, _event.sender);
  });

  ipcMain.handle(
    "sm:emit",
    async (_event, request: { label: string; event: string; payload: unknown }) => {
      dispatchEvent({
        event: String(request?.event ?? ""),
        target: request?.label ? String(request.label) : null,
        payload: request?.payload ?? null,
      });
      return { ok: true };
    },
  );
}

async function respond(
  channel: string,
  payload: Record<string, unknown>,
  sender: Electron.WebContents,
): Promise<BridgeReply> {
  const handler = handlers[channel];
  if (!handler) {
    return { ok: false, error: `未知通道：${channel}` };
  }
  try {
    const data = await handler(payload, sender);
    // `invoke` 的命令错误需要保留原始字符串，单独走这个标记
    if (data && typeof data === "object" && "__commandError" in (data as Record<string, unknown>)) {
      return { ok: false, error: String((data as { __commandError: unknown }).__commandError) };
    }
    return { ok: true, data: (data as unknown) ?? null };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    log.warn(`通道 ${channel} 调用失败：${message}`);
    return { ok: false, error: message };
  }
}
