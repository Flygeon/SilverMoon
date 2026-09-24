/**
 * Electron 主进程入口。
 *
 * 启动顺序（每一步都有依赖关系，不要随意调换）：
 *
 * ```
 * registerSchemes()          // 必须在 ready 之前
 * 解析路径 + 迁移旧数据       // 决定 userData，必须在 ready 之前
 * ↓ ready
 * handleAppProtocol()        // app:// 与 asset:// 必须在载入页面前注册
 * startHostServer()          // 侧车要用它的端口，必须先起来
 * registerIpc()
 * 注入各模块的侧车通道
 * startSidecar()             // 拿到数据目录/缓存目录/宿主端口后启动
 * createMainWindow()
 * ```
 */
import { app, dialog, shell } from "electron";
import path from "node:path";

import { config, cacheDir, dataDir, ensureDir, isDev, logDir, migrateLegacyData } from "./config";
import { initLog, log } from "./log";
import { initStore, flushAllStores } from "./store";
import { handleAppProtocol, handleAssetProtocol, registerSchemes } from "./protocols";
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

async function bootstrap(): Promise<void> {
  handleAppProtocol();
  handleAssetProtocol();

  hostServer = await startHostServer();
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
  sidecar.on("crashed", ({ code }: { code: number | null }) => {
    if (quitting) return;
    log.error(`后端进程异常退出（code=${code}）`);
    void dialog.showMessageBox({
      type: "error",
      title: config.productName,
      message: "后端进程已退出",
      detail:
        "媒体库后端（后端进程）意外停止，界面上的操作会陆续失败。\n" +
        "建议重启应用。若反复出现，请查看日志目录下的 main.log。",
      buttons: ["知道了"],
    });
  });

  const started = await sidecar.start({
    dataDir: DATA_DIR,
    cacheDir: CACHE_DIR,
    hostPort: hostServer.port,
    hostToken: hostServer.token,
  });

  if (!started) {
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

  const mainWindow = createMainWindow();

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
