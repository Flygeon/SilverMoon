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
  invalidateLocalLibraryCache,
  findInstalled,
  registerManagedInstall,
  launchGame,
  installGame,
  openInSteam,
  readSteamSettings,
  steamSettingsState,
  updateSteamSettings,
} from "./steam";
import { CM_TOKEN_FILE, clearCmToken, readCmToken, writeCmToken } from "./steam/cm-token";
import { isSteamCmToken } from "./steam/protocol";
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

const REMOTE_WINDOW_ALLOWED_COMMANDS = new Set([
  "app_log",
  "wenku8_login_log",
  "wenku8_login_submit",
]);

function isTrustedRenderer(sender: Electron.WebContents): boolean {
  let url = "";
  try {
    url = sender.getURL();
  } catch {
    return false;
  }
  if (!url) return false;
  return url.startsWith(APP_ORIGIN) || url.startsWith(DEV_SERVER_URL);
}

function assertExternalUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`拒绝打开非 http(s) 链接：${url.slice(0, 80)}`);
  }
  return url;
}

const benchSession = new BenchSession(() => app.getAppMetrics());

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

function broadcastSteamAuth(state: unknown): void {
  try {
    dispatchEvent({ event: "steam:auth", target: null, payload: state });
  } catch (error) {
    log.warn("[steam] 广播登录状态失败：", error);
  }
}

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
  invoke: async (payload) => {
    const cmd = String(payload.cmd ?? "");
    if (!cmd) throw new Error("缺少 cmd");
    const reply = await callSidecar(cmd, payload.args ?? {});
    if (!reply.ok) {
      return { __commandError: reply.error ?? `命令 ${cmd} 失败` };
    }
    return reply.data ?? null;
  },

  invokeBatch: async (payload) => {
    const calls = Array.isArray(payload.calls) ? payload.calls : [];
    const reply = await callSidecarBatch(calls as { cmd: string; args: unknown }[]);
    if (!reply.ok) {
      return { __commandError: reply.error ?? "批量命令失败" };
    }
    return reply.data ?? [];
  },

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

  fs: async (payload) => {
    const op = String(payload.op ?? "");
    const target = String(payload.path ?? "");
    switch (op) {
      case "readFile":
        return readFile(target);
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

  store: (payload) => handleStore(payload),

  musicTags: async (payload) => handleMusicTags(payload),

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
      case "clearCoverCache":
        return clearCoverCache();
      case "logBoot": {
        const mark = String(payload.mark ?? "").trim();
        const since = Number(payload.since ?? 0);
        if (mark) {
          const ms = Number.isFinite(since) ? Math.round(since) : -1;
          log.info(`[启动][渲染] ${mark}: ${ms}ms`);
        }
        return null;
      }
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
        return { totalMB, processes, labels: listLabels() };
      }
      case "bench":
        return handleBench(payload);
      case "exit":
        quitApp();
        return null;
      default:
        throw new Error(`未知应用操作：${op}`);
    }
  },

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

  fqapi: async (payload) => {
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

  steam: async (payload) => {
    const op = String(payload.op ?? "");
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

      case "localLibrary": {
        const settings = readSteamSettings(dataDir);
        return scanLocalLibrary(settings.customRoots, dataDir);
      }
      case "launchGame":
        return launchGame(Number(payload.appId));
      case "installGame":
        return installGame(Number(payload.appId));
      case "openInSteam": {
        const appId = Number(payload.appId);
        const settings = readSteamSettings(dataDir);
        const installed = findInstalled(appId, settings.customRoots, dataDir)?.source === "steam";
        return openInSteam(appId, installed);
      }
      case "achievements":
        return steam.fetchAchievements(Number(payload.appId));
      case "gameDetail":
        return getGameDetail(steam, dataDir, Number(payload.appId));

      case "cmBeginQr":
        return callSidecar("steam_cm_begin_qr", {}).then((r) =>
          r.ok ? r.data : { error: r.error ?? "发起扫码登录失败" },
        );
      case "cmPollQr": {
        const clientId = String(payload.clientId ?? "");
        const requestId = String(payload.requestId ?? "");
        if (!clientId || !requestId) return { status: "pending" };
        const reply = await callSidecar("steam_cm_poll_qr", { clientId, requestId });
        if (!reply.ok) return { error: reply.error ?? "轮询扫码状态失败" };
        const data = reply.data as {
          status?: string;
          accountName?: string;
          refreshToken?: string;
        };
        if (data.status === "authorized" && data.accountName && data.refreshToken) {
          try {
            writeCmToken(path.join(dataDir, CM_TOKEN_FILE), {
              accountName: data.accountName,
              refreshToken: data.refreshToken,
              savedAt: Date.now(),
            });
          } catch (error) {
            log.warn("[steam] 保存 CM 凭据失败", (error as Error)?.message);
          }
        }
        return {
          status: data.status ?? "pending",
          accountName: data.accountName ?? "",
          authorized: data.status === "authorized",
        };
      }
      case "steamOwnedGames": {
        const cmSaved = readCmToken(path.join(dataDir, CM_TOKEN_FILE));
        if (!cmSaved || !isSteamCmToken(cmSaved.refreshToken)) {
          return { ok: false, error: "尚未完成 Steam 扫码登录" };
        }
        const reply = await callSidecar("steam_owned_games", {
          accountName: cmSaved.accountName,
          accessToken: cmSaved.refreshToken,
        });
        return reply.ok ? reply.data : { ok: false, error: reply.error ?? "查询游戏库失败" };
      }

      case "playerSummary": {
        const cmSaved = readCmToken(path.join(dataDir, CM_TOKEN_FILE));
        if (!cmSaved || !isSteamCmToken(cmSaved.refreshToken)) {
          return { error: "尚未完成 Steam 扫码登录" };
        }
        const reply = await callSidecar("steam_player_summary", {
          accountName: cmSaved.accountName,
          accessToken: cmSaved.refreshToken,
        });
        return reply.ok ? reply.data : { error: reply.error ?? "查询玩家资料失败" };
      }

      case "cmLoginStatus": {
        const saved = readCmToken(path.join(dataDir, CM_TOKEN_FILE));
        return {
          hasToken: Boolean(saved && isSteamCmToken(saved.refreshToken)),
          accountName: saved?.accountName ?? "",
        };
      }
      case "cmLogout":
        clearCmToken(path.join(dataDir, CM_TOKEN_FILE));
        return { ok: true };

      case "appDepots": {
        const appId = Number(payload.appId);
        const cmSaved = readCmToken(path.join(dataDir, CM_TOKEN_FILE));
        const cred =
          cmSaved && isSteamCmToken(cmSaved.refreshToken)
            ? { accountName: cmSaved.accountName, token: cmSaved.refreshToken, source: "cm_login" }
            : await steam.exportCmCredentials();
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
        const cmSaved = readCmToken(path.join(dataDir, CM_TOKEN_FILE));
        if (!cmSaved || !isSteamCmToken(cmSaved.refreshToken)) {
          return {
            ok: false,
            error: "需要先用「Steam 扫码登录（下载）」授权一次：网页登录的凭据无法用于下载",
            needCmLogin: true,
          };
        }
        const cred = { accountName: cmSaved.accountName, token: cmSaved.refreshToken };
        const steamSettings = readSteamSettings(dataDir);

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
          downloadOptions: {
            fileWorkers: steamSettings.downloadFileWorkers,
            chunkWorkers: steamSettings.downloadChunkWorkers,
            maxRequests: steamSettings.downloadMaxRequests,
            retries: steamSettings.downloadRetries,
            cdnServers: steamSettings.downloadCdnServers,
          },
        });
        if (reply.ok && (reply.data as { ok?: boolean } | null)?.ok) {
          let name = path.basename(installDir);
          try {
            const details = await steam.fetchAppDetails([appId]);
            name = details[String(appId)]?.name || name;
          } catch {
            // Download completion and local installation tracking do not depend on store metadata.
          }
          try {
            registerManagedInstall(dataDir, appId, name, installDir);
          } catch (error) {
            log.warn("[steam] 游戏已下载，但本地安装记录写入失败：", error);
          }
          invalidateLocalLibraryCache();
        }
        return reply.ok ? reply.data : { ok: false, error: reply.error ?? "下载失败" };
      }

      case "cmStatus":
        return callSidecar("steam_cm_status", {}).then((r) =>
          r.ok ? r.data : { connected: false },
        );
      case "cmConnect": {
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

      case "steamSettings":
        return steamSettingsState(dataDir);
      case "setSteamSettings": {
        const roots = Array.isArray(payload.customRoots)
          ? payload.customRoots.map((r) => String(r))
          : undefined;
        const settingNumber = (key: string) =>
          typeof payload[key] === "number" && Number.isFinite(payload[key])
            ? (payload[key] as number)
            : undefined;
        invalidateLocalLibraryCache();
        return updateSteamSettings(dataDir, {
          ...(roots ? { customRoots: roots } : {}),
          downloadFileWorkers: settingNumber("downloadFileWorkers"),
          downloadChunkWorkers: settingNumber("downloadChunkWorkers"),
          downloadMaxRequests: settingNumber("downloadMaxRequests"),
          downloadRetries: settingNumber("downloadRetries"),
          downloadCdnServers: settingNumber("downloadCdnServers"),
        });
      }
      case "pickSteamRoot": {
        const result = await dialog.showOpenDialog({
          title: "选择 Steam 库目录（包含 steamapps 的文件夹）",
          properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return { path: null };
        return { path: result.filePaths[0] };
      }
      case "loginQrStart": {
        const { challengeUrl, interval } = await steam.beginQr();
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
        broadcastSteamAuth({ state: "idle", message: null, status: await steam.status() });
        return null;
      default:
        throw new Error(`未知的 steam 操作：${op}`);
    }
  },

  netProxy: async (payload) => {
    await applyNetworkProxy(normalizeProxyConfig(payload.mode, payload.url));
    return null;
  },

  log: async (payload) => {
    const message = String(payload.message ?? "").slice(0, 500);
    const level = String(payload.level ?? "info");
    if (!message) return null;
    if (level === "warn") log.warn(`[ui] ${message}`);
    else if (level === "error") log.error(`[ui] ${message}`);
    else log.info(`[ui] ${message}`);
    return null;
  },

  http: async (payload) => {
    const url = String(payload.url ?? "");
    const method = String(payload.method ?? "GET");
    const headers = Object.fromEntries((payload.headers as [string, string][]) ?? []);
    const body = payload.body ? String(payload.body) : undefined;
    const timeoutMs = Number(payload.timeoutMs);

    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
        delete headers.Referer;
        delete headers.referer;
      }
    } catch {
      /* 忽略 */
    }

    let response: Awaited<ReturnType<typeof net.fetch>>;
    try {
      response = await net.fetch(url, {
        method,
        headers,
        body,
        redirect: "follow",
        // DASH 分片等待超时后也要释放宿主请求，不能只让渲染进程停止等待。
        signal:
          Number.isFinite(timeoutMs) && timeoutMs > 0
            ? AbortSignal.timeout(Math.min(Math.ceil(timeoutMs), 120000))
            : undefined,
      });
    } catch (error) {
      const protocol = url.slice(0, url.indexOf(":") + 1) || "?";
      // 扫码 key、签名等可能位于 query；失败日志只保留端点。
      const endpoint = url.split(/[?#]/, 1)[0].slice(0, 200);
      const message = ((error as Error)?.message ?? String(error)).replaceAll(url, endpoint);
      log.warn(`http 请求失败（${protocol}//）：${message}`, endpoint);
      throw error;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: [...response.headers.entries()],
      body: new Uint8Array(await response.arrayBuffer()),
    };
  },
};

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
        /* 忽略 */
      }
      log.warn(`已拒绝来自远程页的命令调用：${cmd}（来源 ${from}）`);
      return { ok: false, error: `该窗口无权调用命令 ${cmd}` };
    }
  }

  try {
    const data = await handler(payload, sender);
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
