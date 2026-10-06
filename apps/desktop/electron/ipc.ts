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

import { APP_ORIGIN, DEV_SERVER_URL, config, iconPath } from "./config";
import {
  dispatchEvent,
  getWindow,
  createChildWindow,
  listLabels,
  preventClose,
  watchClose,
} from "./windows";
import { handleStore } from "./store";
import { handleMusicTags } from "./tags";
import { clearCoverCache } from "./protocols";
import { checkForUpdates, getUpdateState, quitAndInstall } from "./updater";
import { log } from "./log";
import { callSidecar, callSidecarBatch } from "./main-bridge";

export interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type Handler = (
  payload: Record<string, unknown>,
  sender: Electron.WebContents,
) => Promise<unknown> | unknown;

/**
 * 远程页窗口（Pixiv / 文库8 / 番剧取流）只允许调用的命令。
 *
 * 那些窗口的预加载（`electron/webview-preload.ts`）为了挂钩 `HTMLMediaElement`
 * 与读 `document.cookie`，跑在**页面世界**且 `contextIsolation: false`，
 * 它暴露的 `invoke` 此前是一条**任意命令直通车**：第三方网页（或其中被注入的脚本）
 * 可以直接调用后端全部命令——`ext_install`（安装并执行扩展）、`ffmpeg_set_path`
 * （指定可执行文件后可被拉起）、`skin_read_external_file`（读任意文件）、
 * `empty_trash`（永久删除）。这里把可达面收敛到下面这一张白名单。
 */
const REMOTE_WINDOW_ALLOWED_COMMANDS = new Set([
  "app_log",
  "wenku8_login_log",
  // 文库8 注入脚本在提交登录表单时调用它（backend/src/novel_auth.rs:447）。
  // 漏掉这一条会直接让文库8 登录失效 —— 新增注入调用必须同步加到这里。
  "wenku8_login_submit",
]);

/** 发送方是否是自家前端（打包态 `app://`、开发态 dev server）。 */
function isTrustedRenderer(sender: Electron.WebContents): boolean {
  let url = "";
  try {
    url = sender.getURL();
  } catch {
    // 窗口已销毁等情况一律按不可信处理
    return false;
  }
  if (!url) return false;
  return url.startsWith(APP_ORIGIN) || url.startsWith(DEV_SERVER_URL);
}

/**
 * 交给系统默认程序之前必须校验协议。
 *
 * `shell.openExternal` 会把 `file:` / `ms-msdt:` / `search-ms:` 这类协议一并交给
 * 系统处理，历史上是 Electron 的经典 RCE 入口。`main.ts` 的 setWindowOpenHandler
 * 已经限了 `^https?:`，但 `opener` 与宿主 op 这两条路径此前是裸传。
 */
function assertExternalUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`拒绝打开非 http(s) 链接：${url.slice(0, 80)}`);
  }
  return url;
}

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

  /**
   * 批量命令：一次 IPC + 一次 HTTP 执行多条命令。
   *
   * 与 `invoke` 不同，这里**不把单条失败升级成通道失败**——逐条独立成败，
   * 由渲染进程按需决定怎么处理（缩略图场景下失败一张不该整批重来）。
   */
  invokeBatch: async (payload) => {
    const calls = Array.isArray(payload.calls) ? payload.calls : [];
    const reply = await callSidecarBatch(calls as { cmd: string; args: unknown }[]);
    if (!reply.ok) {
      return { __commandError: reply.error ?? "批量命令失败" };
    }
    return reply.data ?? [];
  },

  // -------------------------------------------------------------------------
  // 自动更新
  // -------------------------------------------------------------------------
  updater: async (payload) => {
    switch (String(payload.op ?? "status")) {
      case "check":
        await checkForUpdates();
        return null;
      case "install":
        quitAndInstall();
        return null;
      case "status":
      default:
        return getUpdateState();
    }
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
        win.setTitle(String(payload.title ?? config.productName));
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
        title: options.title ?? config.productName,
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
  // 音乐标签（本地写 taglib / 在线磁盘缓存）
  // -------------------------------------------------------------------------
  musicTags: async (payload) => handleMusicTags(payload),

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
        // 必须是 `config.logDir()` = `<dataDir>/logs`，也就是 `main.log` 真正所在的目录。
        // 此前用 `app.getPath("logs")`，那是 Electron 默认的 `<userData>/logs`；虽然
        // userData 已被改指到 dataDir，但两者的解析结果并不相同 —— 表现为用户点
        // 「打开日志目录」却看不到 main.log。
        return path.join(dataRoot(), "logs");
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
        return config.productName;
      case "iconPath":
        return iconPath() ?? null;
      /** M6：清空在线封面磁盘缓存（<cache>/covers），返回释放字节数 */
      case "clearCoverCache":
        return clearCoverCache();
      /**
       * 渲染进程启动打点 → 主进程 main.log。
       *
       * 为什么单独开一个 op：`app_log` 是 **Rust 命令**（要侧车在线），而启动打点
       * 恰恰要在「侧车尚未就绪」时记录；且这条不能依赖后端可用性，否则降级模式下
       * 一个数字都拿不到。这里只写主进程日志，同步返回，不产生额外往返。
       */
      case "logBoot": {
        const mark = String(payload.mark ?? "").trim();
        const since = Number(payload.since ?? 0);
        if (mark) {
          const ms = Number.isFinite(since) ? Math.round(since) : -1;
          log.info(`[启动][渲染] ${mark}: ${ms}ms`);
        }
        return null;
      }
      /**
       * 按进程内存诊断。
       *
       * `app.getAppMetrics()` 是 Electron 内置的**按进程**指标（Browser / Tab / GPU /
       * Utility 各一条），给出 workingSetSize 与 peakWorkingSetSize。内存优化若没有它，
       * 就只能靠任务管理器目测，改动前后无法做可比对照——而"少一个渲染进程"
       * 这类结论恰恰只能靠它验证。
       *
       * workingSetSize 的单位是 **KB**，这里统一换算成 MB 并保留一位小数，
       * 渲染层直接展示即可。
       */
      case "metrics": {
        const processes = app.getAppMetrics().map((m) => ({
          pid: m.pid,
          type: m.type,
          name: m.name ?? "",
          workingSetMB: Math.round(((m.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
          peakMB: Math.round(((m.memory?.peakWorkingSetSize ?? 0) / 1024) * 10) / 10,
          cpu: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
        }));
        const totalMB = Math.round(processes.reduce((sum, p) => sum + p.workingSetMB, 0) * 10) / 10;
        // 窗口 label 一并带出：把「某个进程」和「哪个窗口」对上，
        // 才能判断"隐藏窗口占了一个渲染进程"这类问题。
        return { totalMB, processes, labels: listLabels() };
      }
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
      await shell.openExternal(assertExternalUrl(String(payload.url ?? "")));
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

    // 响应体**统一**以字节过桥，不再区分文本 / 二进制。
    //
    // 曾为了省一次编解码，对 `text/*` / `application/json` 等直接交字符串，但渲染端
    // 拿到字符串后会 `new Uint8Array(字符串)` —— 原始值被当成长度 0，静默得到**空数组**，
    // 于是所有走该通道的 JSON 接口都报 `Unexpected end of JSON input`
    // （QQ / 酷狗的逐字歌词就是这样全挂的）。别再改回两套形态：形态越少，出错面越小。
    //
    // 另注：undici 的 fetch 已按 `content-encoding` 解压过（即便调用方自己传了
    // `Accept-Encoding`），这里的字节即明文；`content-encoding` / `content-length`
    // 与之不再匹配，由渲染端剥掉，见 `src/ipc/http.ts`。
    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: [...response.headers.entries()],
      body: new Uint8Array(await response.arrayBuffer()),
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

  ipcMain.handle("sm:invokeBatch", async (_event, request: { calls: unknown }) => {
    return respond("invokeBatch", { calls: request?.calls }, _event.sender);
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

  // 远程页窗口只能走白名单：见 REMOTE_WINDOW_ALLOWED_COMMANDS 的注释。
  if ((channel === "invoke" || channel === "invokeBatch") && !isTrustedRenderer(sender)) {
    if (channel === "invokeBatch") {
      log.warn("已拒绝来自非受信页面的批量命令调用");
      return { ok: false, error: "该窗口无权调用批量命令" };
    }
    const cmd = String(payload.cmd ?? "");
    if (!REMOTE_WINDOW_ALLOWED_COMMANDS.has(cmd)) {
      let from = "";
      try {
        from = sender.getURL();
      } catch {
        /* 窗口已销毁 */
      }
      log.warn(`已拒绝来自远程页的命令调用：${cmd}（来源 ${from}）`);
      return { ok: false, error: `该窗口无权调用命令 ${cmd}` };
    }
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
