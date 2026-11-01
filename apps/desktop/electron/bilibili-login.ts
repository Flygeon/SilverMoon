import { BrowserWindow, session, type Cookie, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

import { applyCurrentNetworkProxy } from "./net-proxy";

type LoginCookies = Record<string, string>;
const COOKIE_NAMES = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "sid",
  "buvid3",
  "buvid4",
  "b_nut",
]);
let pending: Promise<LoginCookies | null> | null = null;
let loginWindow: BrowserWindow | null = null;
let ownerId: number | null = null;
let cancel: (() => void) | null = null;

export function isBilibiliLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      ["bilibili.com", "biligame.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}

export function collectBilibiliLoginCookies(values: readonly Cookie[]): LoginCookies {
  return Object.fromEntries(
    values
      .filter((cookie) => {
        const domain = cookie.domain?.replace(/^\./, "");
        return (
          COOKIE_NAMES.has(cookie.name) &&
          cookie.value &&
          (domain === "bilibili.com" || domain === "www.bilibili.com")
        );
      })
      .map(({ name, value }) => [name, value]),
  );
}

export function cancelBilibiliLogin(sender: WebContents): void {
  if (ownerId === sender.id) cancel?.();
}

export function openBilibiliLogin(sender: WebContents): Promise<LoginCookies | null> {
  if (pending) {
    if (ownerId !== sender.id) return Promise.reject(new Error("另一个窗口正在登录 B 站"));
    loginWindow?.focus();
    return pending;
  }
  ownerId = sender.id;
  pending = runLogin(sender).finally(() => {
    pending = null;
    loginWindow = null;
    ownerId = null;
    cancel = null;
  });
  return pending;
}

async function runLogin(sender: WebContents): Promise<LoginCookies | null> {
  // 内存会话：官网保留自己的设备／风控上下文，不继承业务 Cookie 或媒体 Referer 改写。
  const ses = session.fromPartition(`bilibili-login-${randomUUID()}`, { cache: false });
  if (sender.isDestroyed()) return null;
  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    title: "B 站官方网页登录",
    parent: BrowserWindow.fromWebContents(sender) ?? undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  loginWindow = win;
  return new Promise<LoginCookies | null>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => finish(null, new Error("官方网页登录超时，请重试")), 600000);
    function finish(result: LoginCookies | null, error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(checkTimer);
      controller.abort();
      ses.cookies.removeListener("changed", onCookie);
      sender.removeListener("destroyed", onOwnerClosed);
      if (!win.isDestroyed()) win.destroy();
      void ses.clearStorageData().catch(() => {});
      void ses.closeAllConnections().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    }
    function scheduleCheck(delay = 200): void {
      if (settled) return;
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => void checkLogin(), delay);
    }
    async function checkLogin(): Promise<void> {
      if (settled) return;
      if (checking) {
        scheduleCheck();
        return;
      }
      checking = true;
      try {
        const values = collectBilibiliLoginCookies(
          await ses.cookies.get({ url: "https://www.bilibili.com/" }),
        );
        if (!values.SESSDATA || !values.bili_jct || !values.DedeUserID || settled) return;
        const response = await ses.fetch("https://api.bilibili.com/x/web-interface/nav", {
          credentials: "include",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (settled) return;
        if (!response.ok) {
          scheduleCheck(2000);
          return;
        }
        const json = (await response.json()) as { code?: number; data?: { isLogin?: boolean } };
        if (!settled && json.code === 0 && json.data?.isLogin === true) finish(values);
        else scheduleCheck(2000);
      } catch {
        // 暂时网络失败保留官网窗口，由后续导航／Cookie 变化继续检查；不输出凭据。
        scheduleCheck(2000);
      } finally {
        checking = false;
      }
    }
    function onCookie(
      _event: Electron.Event,
      cookie: Cookie,
      _cause: string,
      removed: boolean,
    ): void {
      if (!removed && COOKIE_NAMES.has(cookie.name)) scheduleCheck();
    }
    function onOwnerClosed(): void {
      finish(null);
    }
    cancel = onOwnerClosed;
    sender.once("destroyed", onOwnerClosed);
    ses.cookies.on("changed", onCookie);
    win.once("closed", onOwnerClosed);
    win.once("ready-to-show", () => {
      if (!settled) win.show();
    });
    win.webContents.on("did-finish-load", () => scheduleCheck());
    function guardNavigation(event: Electron.Event, url: string): void {
      if (!isBilibiliLoginUrl(url)) event.preventDefault();
    }
    win.webContents.on("will-navigate", guardNavigation);
    win.webContents.on("will-redirect", guardNavigation);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isBilibiliLoginUrl(url)) void win.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    const url = new URL("https://passport.bilibili.com/login");
    url.searchParams.set("gourl", "https://www.bilibili.com/");
    void applyCurrentNetworkProxy(ses)
      .then(() => {
        if (!settled) return win.loadURL(url.toString());
      })
      .catch(() => {
        finish(null, new Error("无法打开 B 站官方登录页面，请检查网络后重试"));
      });
  });
}
