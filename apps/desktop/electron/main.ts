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
 * startSidecar() ─┐          // 拿到数据目录/缓存目录/宿主端口后启动
 * createMainWindow() ┘       // 两者并行：界面加载不依赖后端就绪
 * ```
 */
import { app, dialog, session, shell } from "electron";
import path from "node:path";

import {
  APP_ORIGIN,
  DEV_SERVER_URL,
  config,
  cacheDir,
  dataDir,
  ensureDir,
  isDev,
  logDir,
  migrateLegacyData,
} from "./config";
import { installCsp } from "./csp";
import { initUpdater } from "./updater";
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

// 单实例：第二次启动直接聚焦已有窗口。
//
// `app.quit()` 只是把退出**排入队列**：当前 tick 之后的模块级代码与 `whenReady()`
// 回调仍会照常执行 —— 第二个实例会再起一个宿主服务、拉起后端、建窗口，原生启动器
// 也要空等命名管道。所以把结果记进变量，用它守卫所有启动副作用。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  log.warn("已有实例在运行，本进程立即退出");
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
// 第二个实例不碰迁移：否则会与正在运行的第一个实例争抢同一份数据目录
const migration = hasSingleInstanceLock ? migrateLegacyData(appDataRoot) : { migrated: false };

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
 * 收敛 web 权限。
 *
 * Electron 默认**授予**页面申请的一切（摄像头 / 麦克风 / 定位 / 通知 / MIDI…），
 * 而番剧、Pixiv、文库8 这些窗口加载的是第三方远程页。本应用一项都不需要，
 * 只保留两个：`clipboard-sanitized-write`（各处的「复制」按钮）与 `fullscreen`
 * （ArtPlayer 的全屏控件）。
 */
function hardenSession(): void {
  const allowed = new Set<string>(["clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = allowed.has(permission);
    if (!ok) log.warn(`已拒绝页面权限请求：${permission}`);
    callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
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
  hardenSession();
  // CSP 默认只上报不阻断（见 electron/csp.ts 的「为什么分两步走」）。
  // 必须在这之后：onHeadersReceived 依赖 app:// 协议已注册。
  installCsp();
  // 自动更新：开发模式内部会自行跳过（见 electron/updater.ts）
  void initUpdater();

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
  // 启动参数留一份：崩溃重启要原样复用（宿主端口/令牌不变，SSE 逻辑无需改动）
  const sidecarOptions = {
    dataDir: DATA_DIR,
    cacheDir: CACHE_DIR,
    hostPort: hostServer.port,
    hostToken: hostServer.token,
  };

  /**
   * 后端崩溃自动重启。
   *
   * 此前崩溃只弹一个「知道了」，没有任何恢复路径：`start()` 只在 bootstrap 调一次，
   * 之后所有命令永久返回「后端未启动」，用户只能重启整个应用。
   * 这里做指数退避重启（1s / 2s / 4s，最多 3 次）；稳定运行 60s 后清零计数，
   * 避免「每小时崩一次」被误判成雪崩而停止恢复。
   */
  let restartCount = 0;
  const MAX_RESTARTS = 3;
  sidecar.on("crashed", ({ code }: { code: number | null }) => {
    if (quitting) return;
    log.error(`后端进程异常退出（code=${code}）`);

    if (restartCount >= MAX_RESTARTS) {
      log.error(`后端已连续退出 ${restartCount} 次，停止自动重启`);
      void dialog.showMessageBox({
        type: "error",
        title: config.productName,
        message: "后端进程已退出",
        detail:
          "媒体库后端（后端进程）反复意外停止，已停止自动重启。\n" +
          "界面上的操作会陆续失败，建议重启应用。\n" +
          "若反复出现，请查看日志目录下的 main.log。",
        buttons: ["知道了"],
      });
      return;
    }

    restartCount += 1;
    const delay = 1000 * 2 ** (restartCount - 1);
    log.warn(`${delay}ms 后自动重启后端（第 ${restartCount}/${MAX_RESTARTS} 次）`);
    setTimeout(() => {
      if (quitting) return;
      void sidecar.start(sidecarOptions).then((ok) => {
        if (!ok) {
          log.error("后端自动重启失败");
          return;
        }
        log.info("后端已自动重启");
        // 稳定运行 60s 后清零，允许后续再次自愈
        setTimeout(() => {
          restartCount = 0;
        }, 60_000);
      });
    }, delay);
  });

  // 窗口创建与后端握手**并行**：渲染层的页面加载与转场不依赖后端就绪（数据由
  // "先转场、后加载"范式异步填充），后端起来后数据自然到位；后端缺失时窗口
  // 也能立即出现并给出降级提示，而不是白等握手（上限 15s）。
  const sidecarReady = sidecar.start(sidecarOptions).then((ok) => {
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

  // 渲染进程崩溃此前完全没有监听：用户只会看到白屏，日志里也找不到线索。
  // 只对自家前端来源提示——番剧取流窗这类远程页崩掉不该打断用户。
  app.on("render-process-gone", (_event, contents, details) => {
    let url = "";
    try {
      url = contents.getURL();
    } catch {
      /* 窗口可能已销毁 */
    }
    log.error(`渲染进程崩溃：reason=${details.reason} exitCode=${details.exitCode} url=${url}`);
    if (quitting || details.reason === "clean-exit") return;
    if (url.startsWith(APP_ORIGIN) || url.startsWith(DEV_SERVER_URL)) {
      void dialog.showMessageBox({
        type: "error",
        title: config.productName,
        message: "界面进程已崩溃",
        detail:
          "渲染进程意外退出，界面可能已无法交互。\n" +
          `原因：${details.reason}（exitCode=${details.exitCode}）\n` +
          "建议重启应用；反复出现请把日志目录下的 main.log 一并反馈。",
        buttons: ["知道了"],
      });
    }
  });

  app.on("child-process-gone", (_event, details) => {
    log.error(
      `子进程退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
    );
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

// 只有拿到单实例锁的进程才真正启动：否则第二个实例会连带起宿主服务与后端进程。
if (hasSingleInstanceLock) {
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
}

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
