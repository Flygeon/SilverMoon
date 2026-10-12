/**
 * 自动更新（主进程侧）。
 *
 * ## 它依赖什么
 *
 * electron-updater 要能工作，发布流程必须提供两样东西，缺一样都不成立：
 * 1. `electron-builder.yml` 里的 `publish` 配置 → 打包时生成 `latest.yml`
 *    （版本号 / 安装包名 / sha512）与 `*.blockmap`（差分下载的分块哈希）；
 * 2. CI 打包带 `--publish always` → 把上面这些文件真的传到 GitHub Releases。
 *
 * ## 当前形态：仅提示，不自动安装
 *
 * 发现新版本时**只通知用户**，不偷偷重启。这是个音乐播放器，正在放歌时
 * 被应用重启是很糟的体验，所以：
 * - 有新版本 → 事件转给渲染层 → UI 提示
 * - 用户点「立即重启并更新」→ 才调 `quitAndInstall()`
 *
 * 将来若要改成「下次启动时静默安装」，把 `autoInstallOnAppQuit` 打开即可。
 *
 * ## 与本项目两个特殊点的关系
 *
 * - **快捷方式指向 `silvermoon-splash.exe` 而非 Electron 本体**：更新替换的是
 *   安装目录里的文件（Electron 本体 + asar + `resources/bin/silvermoon-server.exe`
 *   + `resources/silvermoon-splash.exe`），**一个安装包覆盖全部产物**；
 *   而 `installer.nsh` 的 `customInstall` 会在更新后重新把快捷方式指回启动器
 *   （它对首次安装与更新是同一段 install section）。
 * - **两个进程**：侧车（Rust）是独立子进程，必须先停掉，否则 Windows 文件锁
 *   会让安装失败。`quitAndInstall` 触发的退出流程会走 `shutdown()` → `sidecar.stop()`。
 */
import { app } from "electron";

import { isDev } from "./config";
import { log } from "./log";
import { dispatchEvent } from "./windows";

/** 与渲染层约定的更新事件名（见 shared/types.ts 的 UpdaterEvent）。 */
export const UPDATE_EVENT = "updater:status";

export type UpdateStatus =
  "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
}

let updater: import("electron-updater").AppUpdater | null = null;
let cached: { status: UpdateStatus; info?: UpdateInfo; percent?: number } = { status: "idle" };

function emit(status: UpdateStatus, info?: UpdateInfo, percent?: number): void {
  cached = { status, info, percent };
  log.info(
    `[更新] ${status}${info ? ` v${info.version}` : ""}${percent !== undefined ? ` ${percent.toFixed(1)}%` : ""}`,
  );
  // 同步转给渲染层，让设置页能显示「发现新版本」并给出重启按钮。
  // 渲染层挂载时会先 GET 一次 status，所以早于 UI 就绪的事件也不会丢。
  try {
    dispatchEvent({ event: UPDATE_EVENT, target: null, payload: cached });
  } catch {
    /* 窗口还没建好时忽略 */
  }
}

/** 当前更新状态（渲染层挂载时先拉一次，避免错过早期事件）。 */
export function getUpdateState(): { status: UpdateStatus; info?: UpdateInfo; percent?: number } {
  return cached;
}

/**
 * 初始化更新器。
 *
 * 开发模式**不初始化**：那时应用跑在 Vite dev server 上，没有已安装的发布物，
 * 调 checkForUpdates 只会报无意义的错。
 */
export async function initUpdater(): Promise<void> {
  if (isDev) {
    log.info("[更新] 开发模式，跳过更新器初始化");
    return;
  }
  if (updater) return;
  try {
    // 动态 import：开发模式根本不加载它，也避免主进程启动时多解析一个包
    const mod = await import("electron-updater");
    // 关闭默认的「后台静默下载」：我们要在 UI 上明确告知，而不是偷偷下 100MB
    mod.autoUpdater.autoDownload = true;
    mod.autoUpdater.autoInstallOnAppQuit = false;

    mod.autoUpdater.on("checking-for-update", () => emit("checking"));
    mod.autoUpdater.on("update-available", (info: { version: string; releaseDate?: string }) =>
      emit("available", { version: info.version, releaseDate: info.releaseDate }),
    );
    mod.autoUpdater.on("update-not-available", () => emit("not-available"));
    mod.autoUpdater.on("download-progress", (p: { percent: number }) =>
      emit("downloading", undefined, p.percent),
    );
    mod.autoUpdater.on("update-downloaded", (info: { version: string; releaseDate?: string }) =>
      emit("downloaded", { version: info.version, releaseDate: info.releaseDate }),
    );
    mod.autoUpdater.on("error", (e: Error) => {
      log.error("[更新] 检查失败：", e);
      emit("error");
    });

    updater = mod.autoUpdater;
    log.info(`[更新] 更新器就绪，当前版本 ${app.getVersion()}`);
  } catch (e) {
    // 没装 electron-updater 也不该让应用起不来
    log.warn("[更新] 更新器初始化失败，自动更新不可用：", e);
  }
}

/** 主动检查一次（设置页的「检查更新」按钮 / 启动后延时自动检查）。 */
export async function checkForUpdates(): Promise<void> {
  if (isDev || !updater) return;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    log.error("[更新] 检查失败：", e);
    emit("error");
  }
}

/** 有已下载好的更新时，重启并安装。 */
export function quitAndInstall(): void {
  if (isDev || !updater) return;
  log.info("[更新] 用户确认，重启并安装");
  updater.quitAndInstall();
}
