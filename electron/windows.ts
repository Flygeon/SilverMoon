/**
 * 窗口注册表与创建逻辑。
 *
 * 三处都会在这里建窗：
 * 1. 主窗口（`label = "main"`）；
 * 2. 渲染进程经 `createWindow()` 建的子窗口（桌面歌词等）；
 * 3. 后端进程通过 `webview.create` 宿主操作建的窗口（番剧隐藏取流窗、扩展共享窗、
 *    Pixiv 登录窗、文库8 登录窗）。
 *
 * 关闭语义：一旦渲染进程注册过 `onCloseRequested`，该窗口的关闭就
 * 变成「先问渲染进程」——`preventDefault()` 即保留窗口，否则稍后真正关闭。
 */
import { BrowserWindow, screen, type WebContents } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { config, displayName, ensureDir, iconPath, isDev, rendererUrl } from "./config";
import { log } from "./log";

/** 渲染进程可监听的事件帧。 */
export interface EventFrame {
  event: string;
  target: string | null;
  payload: unknown;
}

/** 关闭请求等待渲染进程表态的时长（ms）。 */
const CLOSE_DECISION_MS = 400;

const windows = new Map<string, BrowserWindow>();
/** 已接管 close 请求的窗口（渲染进程注册过 `onCloseRequested`）。 */
const closeWatchers = new Set<string>();
/** 正在等待渲染进程表态的关闭请求。 */
const closePending = new Map<string, { denied: boolean; timer: NodeJS.Timeout }>();
/** 最近一次已提交的 URL，用于导航被拒时回退。 */
const lastCommitted = new Map<string, string>();

let preloadPath = "";
let webviewPreloadPath = "";
let cacheRoot = "";

/** 侧车回调通道：向 Rust 询问「这次导航是否放行」。由 `main.ts` 注入。 */
type SidecarCallback = (
  payload: Record<string, unknown>,
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

let sidecarCallback: SidecarCallback | null = null;

/** 注入侧车回调通道（避免 windows ↔ sidecar 循环依赖）。 */
export function setSidecarCallback(cb: SidecarCallback): void {
  sidecarCallback = cb;
}

/** 初始化（在 `app.whenReady()` 之后调用）。 */
export function initWindows(options: {
  preload: string;
  webviewPreload: string;
  cacheDir: string;
}): void {
  preloadPath = options.preload;
  webviewPreloadPath = options.webviewPreload;
  cacheRoot = options.cacheDir;
  ensureDir(cacheRoot);
}

// ---------------------------------------------------------------------------
// 事件派发
// ---------------------------------------------------------------------------

/**
 * 把事件帧投递给渲染进程。
 *
 * `target === null` 表示广播；否则只发给对应 label 的窗口。渲染进程侧的 preload
 * 会把它转成 DOM `CustomEvent("silvermoon:event")`。
 */
export function dispatchEvent(frame: EventFrame): void {
  if (frame.target === null) {
    for (const win of windows.values()) send(win, frame);
    return;
  }
  const win = windows.get(frame.target);
  if (win) send(win, frame);
}

function send(win: BrowserWindow, frame: EventFrame): void {
  if (win.isDestroyed()) return;
  try {
    win.webContents.send("sm:event", frame);
  } catch (error) {
    log.warn("派发事件失败：", error);
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function getWindow(label: string): BrowserWindow | undefined {
  const win = windows.get(label);
  return win && !win.isDestroyed() ? win : undefined;
}

export function listLabels(): string[] {
  return [...windows.keys()].filter((label) => getWindow(label) !== undefined);
}

export function webContentsByLabel(label: string): WebContents | undefined {
  return getWindow(label)?.webContents;
}

/** 标记某窗口已接管关闭请求。 */
export function watchClose(label: string): void {
  closeWatchers.add(label);
}

/** 渲染进程调用 `preventDefault()` → 保留窗口。 */
export function preventClose(label: string): void {
  const pending = closePending.get(label);
  if (pending) pending.denied = true;
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

interface CreateOptions {
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  x?: number;
  y?: number;
  center?: boolean;
  resizable?: boolean;
  decorations?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  shadow?: boolean;
  visible?: boolean;
  focus?: boolean;
  maximizable?: boolean;
  minimizable?: boolean;
}

/** 主窗口。 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    title: config.window.title,
    // 按配置去掉系统标题栏 —— 标题栏由前端自绘（WindowTitleBar.vue）
    frame: config.window.decorations,
    center: config.window.center,
    resizable: config.window.resizable,
    show: false,
    backgroundColor: "#121212",
    icon: iconPath(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ["--silvermoon-label=main"],
    },
  });

  register("main", win);
  win.once("ready-to-show", () => win.show());

  const target = rendererUrl();
  log.info(`主窗口载入：${target}`);
  void win.loadURL(target);
  if (isDev) win.webContents.openDevTools({ mode: "detach" });

  return win;
}

/** 渲染进程请求创建的子窗口。 */
export function createChildWindow(label: string, options: CreateOptions): BrowserWindow {
  const existing = getWindow(label);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: options.width ?? 800,
    height: options.height ?? 600,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    x: options.x,
    y: options.y,
    center: options.center ?? false,
    resizable: options.resizable ?? true,
    frame: options.decorations === undefined ? true : options.decorations,
    transparent: options.transparent ?? false,
    alwaysOnTop: options.alwaysOnTop ?? false,
    skipTaskbar: options.skipTaskbar ?? false,
    hasShadow: options.shadow ?? true,
    show: options.visible ?? true,
    maximizable: options.maximizable ?? true,
    minimizable: options.minimizable ?? true,
    title: options.title ?? displayName,
    icon: iconPath(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--silvermoon-label=${label}`],
    },
  });

  register(label, win);
  void win.loadURL(options.url ?? rendererUrl());
  if (options.focus) win.focus();

  return win;
}

/** 后端进程请求创建的窗口（可能带初始化脚本，需要专用 preload）。 */
export function createRustWindow(payload: {
  label: string;
  url: { kind: "external" | "app"; url?: string; path?: string };
  visible?: boolean;
  center?: boolean;
  title?: string;
  userAgent?: string;
  initializationScript?: string;
  width?: number;
  height?: number;
  resizable?: boolean;
  decorations?: boolean;
  minimizable?: boolean;
  alwaysOnTop?: boolean;
  watchNavigation?: boolean;
  initScriptFile?: string;
}): void {
  const label = payload.label;
  if (getWindow(label)) {
    log.info(`Rust 窗口 ${label} 已存在，跳过创建`);
    return;
  }

  const url = resolveRustUrl(payload.url);
  const needsInjection = !!payload.initializationScript;

  let preload = preloadPath;
  let initScriptFile: string | undefined;
  if (needsInjection) {
    // 初始化脚本必须跑在**页面世界**里（要挂钩 HTMLMediaElement.prototype /
    // fetch / XHR，还要读远程页的 document.cookie），所以这类窗口关掉
    // contextIsolation，交给专用 preload 去执行脚本。
    initScriptFile = path.join(cacheRoot, `webview-init-${sanitize(label)}.js`);
    writeFileSync(initScriptFile, payload.initializationScript!, "utf8");
    preload = webviewPreloadPath;
  }

  const win = new BrowserWindow({
    width: payload.width ? Math.round(payload.width) : 800,
    height: payload.height ? Math.round(payload.height) : 600,
    center: payload.center ?? false,
    resizable: payload.resizable ?? true,
    frame: payload.decorations ?? true,
    minimizable: payload.minimizable ?? true,
    alwaysOnTop: payload.alwaysOnTop ?? false,
    show: payload.visible ?? true,
    title: payload.title ?? displayName,
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: !needsInjection,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--silvermoon-label=${label}`,
        ...(initScriptFile ? [`--silvermoon-init-script=${initScriptFile}`] : []),
      ],
    },
  });

  if (payload.userAgent) win.webContents.setUserAgent(payload.userAgent);

  register(label, win);
  lastCommitted.set(label, url);

  if (payload.watchNavigation) attachNavigationWatcher(label, win);

  void win.loadURL(url);
}

function resolveRustUrl(url: { kind: "external" | "app"; url?: string; path?: string }): string {
  if (url.kind === "external") return url.url ?? "about:blank";
  // `WebviewUrl::App("/index.html")` → 前端入口（扩展共享窗走这条）；
  // 具体路由由 App.vue 依据窗口 label 自行重定向。
  return rendererUrl();
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ---------------------------------------------------------------------------
// 注册与生命周期
// ---------------------------------------------------------------------------

function register(label: string, win: BrowserWindow): void {
  windows.set(label, win);

  win.on("closed", () => {
    windows.delete(label);
    closeWatchers.delete(label);
    lastCommitted.delete(label);
    const pending = closePending.get(label);
    if (pending) {
      clearTimeout(pending.timer);
      closePending.delete(label);
    }
    // 桌面歌词窗 / 文库8 登录窗都依赖 "destroyed" 事件
    dispatchEvent({ event: "window:destroyed", target: label, payload: null });
  });

  win.on("close", (event) => {
    if (!closeWatchers.has(label)) return; // 未接管 → 走默认关闭

    // 已有一段等待中的表态：本次是渲染进程同意后的关闭，放行
    const pending = closePending.get(label);
    if (pending) {
      clearTimeout(pending.timer);
      closePending.delete(label);
      if (pending.denied) {
        event.preventDefault();
        return;
      }
      return;
    }

    event.preventDefault();
    const timer = setTimeout(() => {
      const state = closePending.get(label);
      closePending.delete(label);
      if (!state || state.denied) return; // 已被否决
      const target = getWindow(label);
      // 用 destroy 绕过拦截，直接销毁
      if (target) target.destroy();
    }, CLOSE_DECISION_MS);
    closePending.set(label, { denied: false, timer });
    dispatchEvent({ event: "window:close-requested", target: label, payload: null });
  });

  const emitBounds = (eventName: "window:move" | "window:resize") => {
    if (win.isDestroyed()) return;
    const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
    if (eventName === "window:move") {
      const [x, y] = win.getPosition();
      dispatchEvent({
        event: eventName,
        target: label,
        payload: { x: Math.round(x * scale), y: Math.round(y * scale) },
      });
    } else {
      const [width, height] = win.getSize();
      dispatchEvent({
        event: eventName,
        target: label,
        payload: { width: Math.round(width * scale), height: Math.round(height * scale) },
      });
    }
  };
  win.on("move", () => emitBounds("window:move"));
  win.on("resize", () => emitBounds("window:resize"));

  win.webContents.on("did-start-navigation", (_e, url, _inPlace, isMainFrame) => {
    if (isMainFrame) lastCommitted.set(label, url);
  });
}

/**
 * 导航拦截。
 *
 * 直觉上导航拦截应该能同步拒绝，但 Electron 主进程无法同步地询问后端进程，
 * 于是改成「先放行、异步问 Rust」：Rust 判定不放行时回退到上一个已提交地址。
 * 现有唯一调用点（Pixiv 登录回调）效果一致。
 */
function attachNavigationWatcher(label: string, win: BrowserWindow): void {
  const reconsider = (url: string) => {
    if (!sidecarCallback) return;
    void sidecarCallback({ kind: "navigation", label, url })
      .then((reply) => {
        const allow = (reply.data as { allow?: boolean } | undefined)?.allow ?? true;
        if (allow || win.isDestroyed()) return;
        log.info(`[${label}] 导航被 Rust 拒绝，回退：${url}`);
        win.webContents.stop();
        const back = lastCommitted.get(label);
        if (back && back !== url) void win.loadURL(back);
      })
      .catch((error) => log.warn("导航判定失败：", error));
  };

  win.webContents.on("will-navigate", (_event, url) => reconsider(url));
  win.webContents.on("will-redirect", (_event, url) => reconsider(url));
}
