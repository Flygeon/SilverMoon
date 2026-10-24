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
import { BrowserWindow, app, dialog, ipcMain, net, shell, screen } from "electron";
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
import { getFqapiManager } from "./fqapi";
import {
  getSteam,
  guardAuth,
  getGameDetail,
  scanLocalLibrary,
  findInstalled,
  launchGame,
  installGame,
  openInSteam,
  readSteamSettings,
  steamSettingsState,
  updateSteamSettings,
} from "./steam";
import { BenchSession, DEFAULT_INTERVAL_MS } from "./bench";
import { applyNetworkProxy, normalizeProxyConfig } from "./net-proxy";

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

/**
 * 内存基准测试（P0）的会话。
 *
 * 采样源是 `app.getAppMetrics()`（按进程 workingSet / peak），由 `BenchSession`
 * 按固定间隔自动采。五组口径见 `electron/bench.ts` 文件头。
 */
const benchSession = new BenchSession(() => app.getAppMetrics());

/**
 * 内存基准的 IPC 分发。
 *
 * 动作：start / stop / mark / take / report / clear / status / export。
 * `export` 把报告写到 `<dataDir>/bench/bench-<时间戳>.json`，供
 * `scripts/bench-memory.mjs` 做前后对比。
 */
async function handleBench(payload: Record<string, unknown>): Promise<unknown> {
  const action = String(payload.action ?? "");
  switch (action) {
    case "start":
      return benchSession.start(Number(payload.intervalMs ?? DEFAULT_INTERVAL_MS));
    case "stop":
      benchSession.stop();
      return benchSession.status();
    case "mark":
      return benchSession.mark(String(payload.label ?? ""));
    case "take":
      return benchSession.take();
    case "report": {
      const report = benchSession.report();
      // UI 只关心汇总；整份报告含全部采样（可达数千条），不必每次过桥
      return payload.summaryOnly ? { summary: report.summary } : report;
    }
    case "clear":
      benchSession.clear();
      return benchSession.status();
    case "status":
      return benchSession.status();
    case "export": {
      const report = benchSession.report();
      const dir = path.join(dataRoot(), "bench");
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `bench-${stamp}.json`);
      await writeFile(file, JSON.stringify(report, null, 2), "utf8");
      log.info(`内存基准报告已导出：${file}`);
      return { path: file, summary: report.summary };
    }
    default:
      throw new Error(`未知基准操作：${action}`);
  }
}

/**
 * 广播 Steam 登录状态。
 *
 * 扫码登录是**跨窗口**发生的：登录面板可能开在设置窗口，而用户盯着主窗口的
 * 「游戏」页。协议层只有一份进程级会话，界面却有多份副本 —— 没有广播时，
 * 用户会看到「登录成功了，但主窗口还显示未登录」，直到手动切页才刷新。
 *
 * 事件名 `steam:auth` 必须与前端 `listen("steam:auth")` 一致（改名不报错、只静默失效）。
 */
function broadcastSteamAuth(state: unknown): void {
  try {
    dispatchEvent({ event: "steam:auth", target: null, payload: state });
  } catch (error) {
    log.warn("[steam] 广播登录状态失败：", error);
  }
}

/** 登录流程的状态变化才值得广播（pending 只是「还在等」，广播会刷屏）。 */
function broadcastAuthResult(state: { state?: string } | null | undefined): unknown {
  if (
    state &&
    (state.state === "authenticated" || state.state === "failed" || state.state === "guard")
  ) {
    broadcastSteamAuth(state);
  }
  return state;
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
      /**
       * 该窗口所在显示器的几何信息（**逻辑像素 DIP**）。
       *
       * 桌面歌词的「任务栏锚定」需要知道任务栏占哪块区域。Electron 不提供
       * 任务栏矩形，但 `bounds`（整块屏幕）与 `workArea`（去掉任务栏后的可用区）
       * 的差集就是任务栏 —— 这是零 native 代码的正解（见 utils/taskbarAnchor.ts）。
       *
       * ⚠️ **不要在这里再除以 scaleFactor。**
       * Electron 的 `Display.bounds` / `workArea` **本来就是 DIP**，
       * 而 `win.getBounds()` / `win.setPosition()` 收发的也是 DIP ——
       * 主进程这一层全程是逻辑像素。再除一次会让高 DPI 屏上的屏幕矩形
       * 缩成 1/scale（250% 缩放下 1024x640 会变成 410x256），
       * 锚定就把窗口夹进一个只有四分之一大的盒子里，表现为「吸到不知道哪去」。
       *
       * scaleFactor 仍然返回：调用方要把 `outerSize()`（那条通道按仓库约定
       * 输出**物理**像素，见下方 outerSize）换算回 DIP 时需要它。
       */
      case "displayInfo": {
        const d = screen.getDisplayMatching(win.getBounds());
        return {
          bounds: d.bounds,
          workArea: d.workArea,
          scaleFactor: d.scaleFactor || 1,
        };
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
      /**
       * 内存基准测试（P0）。
       *
       * 与上面的 `metrics` 的区别：`metrics` 是**某一瞬间**的快照，
       * `bench` 是**一段操作过程**的自动采样曲线 + 标记 + 可导出报告。
       */
      case "bench":
        return handleBench(payload);
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
  // 番茄内容源 sidecar
  //
  // 它**不在** Rust 命令表里：那是 backend sidecar 的地盘（HTTP + SSE）。
  // 这个是独立的进程（stdin/stdout 行 JSON），所以单独一条通道。
  // -------------------------------------------------------------------------
  fqapi: async (payload) => {
    // main.ts 已执行 `app.setPath("userData", DATA_DIR)`，所以这里拿到的
    // 就是 Rust 侧 app_data_dir() 的同一个目录。
    const manager = getFqapiManager(app.getPath("userData"));
    const request = {
      op: payload.op ? String(payload.op) : undefined,
      path: payload.path ? String(payload.path) : undefined,
      query: payload.query ? String(payload.query) : undefined,
      method: payload.method ? String(payload.method) : undefined,
      itemId: payload.itemId ? String(payload.itemId) : undefined,
    };
    const timeout = typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined;
    return manager.request(request, timeout);
  },

  // -------------------------------------------------------------------------
  // Steam（登录 / 游戏库 / 商店）
  //
  // 它**不在** Rust 命令表里：Steam 的 CM WebSocket 在本机被网络重置，能用的只有
  // 纯 HTTPS WebAPI；协议实现放在 electron/steam/，可以当场验证（见那边注释）。
  // -------------------------------------------------------------------------
  steam: async (payload) => {
    const op = String(payload.op ?? "");
    // 数据目录必须先由 main.ts 的 setDataDirs() 设好。真为空时宁可明确报错，
    // 也不要让 path.join("", "steam-session.json") 变成**相对当前工作目录**的路径 ——
    // 那会把登录凭据写到启动目录（开发期是仓库根），排查起来极其费解。
    const dataDir = dataRoot();
    if (!dataDir) throw new Error("数据目录尚未初始化，无法使用 Steam 能力");
    const steam = getSteam(dataDir);
    switch (op) {
      case "status":
        return steam.status();
      case "library":
        return steam.getLibrary(Boolean(payload.refresh));
      case "refreshLibrary":
        return steam.getLibrary(true);
      case "appDetails": {
        const ids = Array.isArray(payload.appIds) ? payload.appIds.map((n) => Number(n)) : [];
        return steam.fetchAppDetails(ids.filter((n) => Number.isFinite(n)));
      }

      // ---- 本地安装库 / 启动 / 详情 ----
      case "localLibrary": {
        const settings = readSteamSettings(dataDir);
        return scanLocalLibrary(settings.customRoots);
      }
      case "launchGame":
        return launchGame(Number(payload.appId));
      case "installGame":
        return installGame(Number(payload.appId));
      case "openInSteam": {
        const appId = Number(payload.appId);
        const settings = readSteamSettings(dataDir);
        const installed = Boolean(findInstalled(appId, settings.customRoots));
        return openInSteam(appId, installed);
      }
      case "achievements":
        return steam.fetchAchievements(Number(payload.appId));
      case "gameDetail":
        return getGameDetail(steam, dataDir, Number(payload.appId));

      // ---- 下载（需要 CM）----
      //
      // 凭据由**主进程**从已加密的会话里取，前端只传 appId ——
      // 不把 refresh_token 暴露到渲染进程（那是长期凭据，等同密码）。
      case "appDepots": {
        const appId = Number(payload.appId);
        const cred = await steam.exportCmCredentials();
        if ("error" in cred) return { ok: false, error: cred.error };
        const reply = await callSidecar("steam_app_depots", {
          accountName: cred.accountName,
          accessToken: cred.token,
          appId,
        });
        return reply.ok ? reply.data : { ok: false, error: reply.error ?? "查询失败" };
      }
      case "download": {
        const appId = Number(payload.appId);
        const installDir = String(payload.installDir ?? "");
        if (!installDir) return { ok: false, error: "未指定安装目录" };
        const cred = await steam.exportCmCredentials();
        if ("error" in cred) return { ok: false, error: cred.error };

        // 1) 查 depot 列表
        const depotReply = await callSidecar("steam_app_depots", {
          accountName: cred.accountName,
          accessToken: cred.token,
          appId,
        });
        if (!depotReply.ok) {
          return { ok: false, error: depotReply.error ?? "查询 depot 失败" };
        }
        const depots = Array.isArray(depotReply.data) ? depotReply.data : [];
        if (depots.length === 0) return { ok: false, error: "该游戏没有可下载的 depot" };

        // 2) 发起下载（depot key 由后端自动获取）
        const reply = await callSidecar("steam_download", {
          accountName: cred.accountName,
          accessToken: cred.token,
          installDir,
          depots: depots.map((d) => ({
            depotId: d.depotId,
            manifestGid: String(d.manifestGid ?? ""),
            depotKey: "",
            appId,
          })),
        });
        return reply.ok ? reply.data : { ok: false, error: reply.error ?? "下载失败" };
      }

      // ---- CM（下载前置）。经 sidecar 转发，失败一律降级，不阻断 UI ----
      case "cmStatus":
        return callSidecar("steam_cm_status", {}).then((r) =>
          r.ok ? r.data : { connected: false },
        );
      case "cmConnect": {
        // 走与 appDepots/download 同一条凭据选择逻辑：
        // CM 只接受 iss=="steam" 的 JWT，不能盲传 refresh_token。
        const cred = await steam.exportCmCredentials();
        if ("error" in cred) return { connected: false, error: cred.error };
        return callSidecar("steam_cm_connect", {
          accountName: cred.accountName,
          accessToken: cred.token,
        }).then((r) => (r.ok ? r.data : { connected: false, error: r.error ?? "连接失败" }));
      }
      case "cmDisconnect":
        return callSidecar("steam_cm_disconnect", {}).then((r) =>
          r.ok ? r.data : { connected: false },
        );

      // ---- 设置：Steam 安装目录 ----
      case "steamSettings":
        return steamSettingsState(dataDir);
      case "setSteamSettings": {
        const roots = Array.isArray(payload.customRoots)
          ? payload.customRoots.map((r) => String(r))
          : undefined;
        return updateSteamSettings(dataDir, roots ? { customRoots: roots } : {});
      }
      case "pickSteamRoot": {
        const result = await dialog.showOpenDialog({
          title: "选择 Steam 库目录（包含 steamapps 的文件夹）",
          properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return { path: null };
        return { path: result.filePaths[0] };
      }
      // ---- 登录：二维码 / 账号密码 + Guard ----
      case "loginQrStart": {
        const { challengeUrl, interval } = await steam.beginQr();
        // 二维码不是「状态」，但和登录状态同属一条链路，前端按同一形状消费
        return {
          state: "pending",
          message: "请用 Steam 手机应用扫描二维码",
          challengeUrl,
          interval,
        };
      }
      case "loginPoll":
        return broadcastAuthResult(await guardAuth(() => steam.pollOnce()));
      case "loginCredentials":
        return broadcastAuthResult(
          await guardAuth(() =>
            steam.beginCredentials(
              String(payload.accountName ?? ""),
              String(payload.password ?? ""),
            ),
          ),
        );
      case "submitGuard":
        return broadcastAuthResult(
          await guardAuth(() =>
            steam.submitGuard(
              String(payload.code ?? ""),
              payload.codeType === "email" ? "email" : "device",
            ),
          ),
        );
      case "cancelLogin":
        steam.cancel();
        return null;
      case "logout":
        steam.logout();
        // 退出登录也要广播：别的窗口（例如主窗口 + 迷你播放器）必须一起回到未登录态
        broadcastSteamAuth({ state: "idle", message: null, status: await steam.status() });
        return null;
      default:
        throw new Error(`未知的 steam 操作：${op}`);
    }
  },

  // -------------------------------------------------------------------------
  // 网络代理（设置 → 网络）
  // -------------------------------------------------------------------------
  netProxy: async (payload) => {
    // 非法值在 normalize 里统一退回系统代理；custom 但没填地址也退回系统代理
    await applyNetworkProxy(normalizeProxyConfig(payload.mode, payload.url));
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

    // 必须用 Electron 的 `net.fetch`（Chromium 网络栈），不能用 Node 的全局
    // `fetch`（undici）：后者**不读**系统代理，也不吃 `session.setProxy`。
    // 这正是「用户开着代理、Bangumi / 音乐接口仍然超时」的根因。
    // `net.fetch` 固定使用默认 session，代理已经由 `netProxy` 通道设到该 session。
    /*
     * 失败时把 **URL 与协议**记下来。
     *
     * 之前这里只有外层的「通道 http 调用失败：xxx」，看不出是哪个地址 ——
     * 而 `net::ERR_BLOCKED_BY_CLIENT` 恰恰是「某个域名/协议被拒」这类问题，
     * 没有 URL 就只能靠猜。特别注意 `http:` 开头的地址：Chromium 不允许在
     * 明文请求上改写请求头，见 net-headers.ts。
     */
    let response: Awaited<ReturnType<typeof net.fetch>>;
    try {
      response = await net.fetch(url, {
        method,
        headers,
        body,
        redirect: "follow",
      });
    } catch (error) {
      const protocol = url.slice(0, url.indexOf(":") + 1) || "?";
      log.warn(
        `http 请求失败（${protocol}//）：${(error as Error)?.message ?? String(error)}`,
        url.slice(0, 200),
      );
      throw error;
    }

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
