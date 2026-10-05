/**
 * Electron 主进程入口。
 *
 * 启动顺序（每一步都有依赖关系，不要随意调换）：
 *
 * ```
 * installWebGlobals()        // Electron < 25 的 fetch/Response 回填，必须最先
 * registerSchemes()          // 必须在 ready 之前
 * 解析路径 + 迁移旧数据       // 决定 userData，必须在 ready 之前
 * ↓ ready
 * handleAppProtocol()        // app:// 与 asset:// 必须在载入页面前注册
 * startHostServer()          // 侧车要用它的端口，必须先起来
 * registerIpc()
 * 注入各模块的侧车通道
 * startSidecar() ─┐          // 拿到数据目录/缓存目录/宿主端口后启动
 * createMainWindow() ┘       // 两者并行：界面加载不依赖后端就绪
 * ```
 */
import { app, dialog, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { installWebGlobals } from "./compat/web-globals";
import { collectBootDiagnostics, persistBootDiagnostics } from "./boot-diagnostics";
import { config, cacheDir, dataDir, ensureDir, isDev, logDir, migrateLegacyData } from "./config";

// ⚠️ 必须在使用 fetch / Response 之前执行。Electron < 25（Node < 18）没有这些
// Web 标准全局，而 protocols.ts 有 12 处 `new Response(...)`、sidecar.ts 依赖
// `fetch` 与 `response.body.getReader()`。见 compat/web-globals.ts。
installWebGlobals();
import { initLog, log } from "./log";
import { initStore, flushAllStores } from "./store";
import {
  handleAppProtocol,
  handleAssetProtocol,
  handleCoverProtocol,
  registerSchemes,
} from "./protocols";
import { installBiliMediaHeaders } from "./net-headers";
import { Sidecar, type EventFrame } from "./sidecar";
import { setSidecar, getSidecar } from "./main-bridge";
import { registerIpc, setDataDirs, setQuitHandler } from "./ipc";
import {
  startHostServer,
  setExitHandler,
  setSidecarNotifier,
  type HostServer,
} from "./host-server";
import { destroyTray, setTrayCallback } from "./tray";
import {
  createMainWindow,
  dispatchEvent,
  getWindow,
  initWindows,
  setSidecarCallback,
} from "./windows";

// ---------------------------------------------------------------------------
// ready 之前的准备工作
// ---------------------------------------------------------------------------

// 自定义协议必须在 app ready 之前登记
registerSchemes();

// 单实例：第二次启动直接聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getWindow("main");
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

/** Electron 的 appData 根目录（Windows 为 `%APPDATA%`）。 */
const appDataRoot = app.getPath("appData");
const localAppDataRoot =
  process.platform === "win32" ? (process.env.LOCALAPPDATA ?? appDataRoot) : appDataRoot;

// 数据目录用 `<appData>/<identifier>`，并与后端进程共用同一份
const DATA_DIR = dataDir(appDataRoot);
const CACHE_DIR = cacheDir(localAppDataRoot);

// 首次运行：把旧项目 LumiLuna 的数据整份搬过来（只读旧目录）
const migration = migrateLegacyData(appDataRoot);

ensureDir(DATA_DIR);
ensureDir(CACHE_DIR);

// userData 指向数据目录，这样 Electron 自身的 localStorage / IndexedDB /
// GPU 缓存也落在同一处，便于整体备份（IndexedDB 用的是 profile 目录）
app.setPath("userData", DATA_DIR);

initLog(logDir(appDataRoot));
initStore(DATA_DIR);
initWindows({
  preload: path.join(__dirname, "preload.cjs"),
  webviewPreload: path.join(__dirname, "webview-preload.cjs"),
  cacheDir: CACHE_DIR,
});
setDataDirs(DATA_DIR, CACHE_DIR);

if (migration.migrated) {
  log.info(`已从旧项目目录迁移数据：${migration.from}`);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let hostServer: HostServer | null = null;
let quitting = false;

/**
 * 读主进程日志的尾部（用于崩溃诊断快照）。
 *
 * 只取尾部：日志会跨多次启动累积，崩溃时关心的必然是最近这一段；
 * 整份读进来既慢又会把弹窗撑爆。
 */
function readLogTail(maxChars = 4000): string | undefined {
  try {
    const file = path.join(logDir(appDataRoot), "main.log");
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, "utf8");
    return text.length <= maxChars ? text : `…（已截断）…\n${text.slice(-maxChars)}`;
  } catch {
    return undefined;
  }
}

async function bootstrap(): Promise<void> {
  // 启动打点：一次日志看清时间花在哪段（验收优化用，保持低成本）
  const bootT0 = performance.now();
  const mark = (label: string) =>
    log.info(`[启动] ${label}: ${Math.round(performance.now() - bootT0)}ms`);

  handleAppProtocol();
  handleAssetProtocol();
  handleCoverProtocol(path.join(CACHE_DIR, "covers"));
  // B 站视频 CDN 防盗链：为 <video> 请求自动补 Referer（仅限 B 站域名）
  installBiliMediaHeaders();

  hostServer = await startHostServer();
  mark("宿主服务器就绪");
  registerIpc();

  const sidecar = new Sidecar();
  setSidecar(sidecar);

  // 侧车 → 宿主：导航判定、托盘点击、热键
  setSidecarCallback((payload) => sidecar.callback(payload));
  setSidecarNotifier((payload) => sidecar.callback(payload));
  // 宿主 → 渲染进程：托盘点击/热键之后由 Rust 再 emit 事件，这里不需要额外接线
  setTrayCallback((payload) => sidecar.callback(payload));

  setExitHandler(() => void shutdown(0));
  setQuitHandler(() => void shutdown(0));

  // 侧车 → 渲染进程：SSE 事件转发
  sidecar.on("event", (frame: EventFrame) => dispatchEvent(frame));
  sidecar.on("crashed", ({ code, signal }: { code: number | null; signal: string | null }) => {
    if (quitting) return;
    log.error(`后端进程异常退出（code=${code} signal=${signal}）`);

    // 原生侧车没有控制台，崩溃时只会「静默消失」，Electron 这边原本只有一个
    // 退出码可看。这里把它的**启动轨迹**收集起来 —— 轨迹最后一行 STEP 就是
    // 崩溃区间下界，这比任何错误码都更有指向性（Win7 上实测 code=3221225477
    // = 0xC0000005 访问违例，光看码无法知道崩在哪一步）。
    const diag = collectBootDiagnostics(readLogTail());
    const saved = persistBootDiagnostics(logDir(appDataRoot), diag.text);
    if (diag.backendLastStep) {
      log.warn(`后端崩溃前最后阶段：${diag.backendLastStep}`);
    } else if (diag.found === 0) {
      // 两个原生进程的轨迹都不存在 → 崩溃发生在 Rust main 之前（加载期），
      // 或者轨迹目录不可写。这是与「跑到一半崩」完全不同的两类问题。
      log.warn("未找到任何启动轨迹文件（崩溃可能发生在进程进入 main 之前）");
    }

    void dialog.showMessageBox({
      type: "error",
      title: config.productName,
      message: "后端进程已退出",
      detail:
        "媒体库后端（后端进程）意外停止，界面上的操作会陆续失败。\n" +
        "建议重启应用。\n\n" +
        `退出码：${code}${signal ? `（signal=${signal}）` : ""}\n` +
        (diag.backendLastStep
          ? `崩溃前最后阶段：\n  ${diag.backendLastStep}\n\n`
          : "未捕获到启动轨迹（崩溃可能发生在进程初始化之前）。\n\n") +
        (saved ? `完整诊断已保存到：\n${saved}` : ""),
      buttons: ["知道了"],
    });
  });

  // 窗口创建与后端握手**并行**：渲染层的页面加载与转场不依赖后端就绪（数据由
  // "先转场、后加载"范式异步填充），后端起来后数据自然到位；后端缺失时窗口
  // 也能立即出现并给出降级提示，而不是白等握手（上限 15s）。
  const sidecarReady = sidecar
    .start({
      dataDir: DATA_DIR,
      cacheDir: CACHE_DIR,
      hostPort: hostServer.port,
      hostToken: hostServer.token,
    })
    .then((ok) => {
      mark("后端握手完成");
      return ok;
    });

  const mainWindow = createMainWindow();
  mark("主窗口已创建");

  if (!(await sidecarReady)) {
    log.warn("后端未就绪，将以降级模式启动界面");
    const exe = process.platform === "win32" ? ".exe" : "";
    // 不阻塞启动：让用户能看到界面与明确的错误提示，而不是一个白屏
    setTimeout(() => {
      void dialog.showMessageBox({
        type: "warning",
        title: config.productName,
        message: "后端未启动",
        detail:
          "没有找到媒体库后端（后端进程）可执行文件，界面上的数据操作都会失败。\n\n" +
          (isDev
            ? `开发模式请先构建后端：\n  npm run build:backend\n` +
              `产物应在：backend/target/debug/silvermoon${exe}\n\n`
            : `安装包的 resources/bin 下应包含 silvermoon-server${exe}，当前缺失，安装包可能不完整。\n\n`) +
          `也可以用 SILVERMOON_SERVER_BIN 环境变量直接指定可执行文件。\n` +
          `已尝试的完整路径见日志：${path.join(logDir(appDataRoot), "main.log")}`,
        buttons: ["知道了"],
      });
    }, 1200);
  }

  // 主窗口一旦消失就直接退出。
  //
  // 不能只依赖 `window-all-closed`：番剧取流窗、扩展共享窗这类**隐藏窗口**同样
  // 计入 Electron 的窗口表，只要它们还在，主窗口关闭后该事件就不会触发，
  // 应用会变成「有托盘图标但没有界面」的僵尸进程。
  // （正常路径上 `useDesktopChrome` 会拦截关闭并走 `exit_app`，这里是兜底。）
  mainWindow.on("closed", () => {
    if (!quitting) void shutdown(0);
  });

  // 外部链接一律交给系统浏览器，绝不在应用内导航
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  });
}

// ---------------------------------------------------------------------------
// 退出
// ---------------------------------------------------------------------------

async function shutdown(code: number): Promise<void> {
  if (quitting) return;
  quitting = true;
  log.info("正在退出…");

  destroyTray();
  flushAllStores();
  await getSidecar()?.stop();
  hostServer?.close();

  app.exit(code);
}

app
  .whenReady()
  .then(bootstrap)
  .catch((error) => {
    log.error("启动失败：", error);
    void dialog.showMessageBoxSync({
      type: "error",
      title: config.productName,
      message: "启动失败",
      detail: String((error as Error)?.stack ?? error),
    });
    app.exit(1);
  });

app.on("window-all-closed", () => {
  // 主窗口关闭即退出（closeToTray 时前端会 hide 而不是 close，不会走到这里）
  void shutdown(0);
});

app.on("before-quit", () => {
  quitting = true;
  destroyTray();
  flushAllStores();
});

process.on("uncaughtException", (error) => log.error("未捕获异常：", error));
process.on("unhandledRejection", (reason) => log.error("未处理的 Promise 拒绝：", reason));
