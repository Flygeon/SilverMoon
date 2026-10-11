/**
 * 扩展侧桥客户端：扩展的 web UI 跑在宿主窗口的 iframe 里，没有 Tauri IPC，
 * 只能通过 `postMessage` 与宿主页（`src/views/ExtensionHost.vue`）通信。
 *
 * 消息形态（扩展框架 v2 冻结契约）：
 * ```text
 * 扩展 → 宿主: { source: "ext:<扩展 id>", type: "invoke", reqId, method, payload }
 * 宿主 → 扩展: { source: "lumiluna-host", type: "invoke-result", reqId, ok, data, error }
 * ```
 *
 * 宿主收到 `invoke` 后统一走 Rust 的 `ext_invoke`，转发给扩展引擎的 localhost HTTP；
 * 但有一小撮**宿主保留方法**由宿主自己处理，不转发引擎：
 *
 * | method | payload | 返回 |
 * | --- | --- | --- |
 * | `"settings:get"` | 无 | `{ values: Record<string, unknown> }` |
 * | `"settings:set"` | `{ values }` | `{ ok: true }` |
 * | `"open"` / `"reveal"` | `{ path, ts?, reveal? }` | `{ ok: true }`（需 `opener:open-path` 权限） |
 * | `"themes:list"` | 无 | `{ themes: ExtThemeEntry[] }` |
 * | `"themes:apply"` | `{ themeId }` | `{ ok: true }` |
 * | `"themes:clear"` | 无 | `{ ok: true }` |
 *
 * `themes:list` 返回**全部**扩展的皮肤；`themes:apply` 缺省作用于本扩展，
 * 管理器类扩展可显式传 `extId` 应用他人的皮肤（见 {@link ExtThemeApi.apply}）。
 */

import type { ExtThemeEntry } from "./manifest";

/** 宿主回复消息的固定 source 标识（历史名字，改了会破坏已发布的扩展包）。 */
export const HOST_SOURCE = "lumiluna-host";

/** 自定义事件名：宿主直接在本窗口派发事件时用的 `CustomEvent` 名（另一种投递通道）。 */
export const BRIDGE_EVENT = "silvermoon:ext-bridge";

/** URL 查询参数名：宿主会在 iframe 地址上带 `?ext=<扩展 id>&route=<路由>`。 */
export const EXT_ID_PARAM = "ext";

/**
 * 单次 `invoke` 的默认超时（毫秒）。
 *
 * 取 60s 是有依据的：宿主侧最坏情况 ≈ 冷启动引擎 20s（`read_ready_port` 超时）
 * + 引擎 HTTP 调用 30s（reqwest timeout）。给得比宿主更宽，作者拿到的才是**宿主报的真实错误**，
 * 而不是本地超时 —— 后者会把「引擎起不来」误报成「扩展调用超时」。
 */
export const DEFAULT_TIMEOUT = 60_000;

/** `invoke()` 的可选项。 */
export interface InvokeOptions {
  /** 本次调用的超时覆盖（毫秒）。`0` 或负数 = 不超时（不推荐）。 */
  timeout?: number;
  /** 请求级信号，保留字段；宿主当前不消费它。 */
  signal?: AbortSignal;
}

/** 桥客户端构造参数。 */
export interface ExtBridgeOptions {
  /**
   * 扩展 id。缺省从 iframe 地址的 `?ext=` 读取；
   * 两者都取不到时构造会抛错（否则 `source` 会退化成所有扩展共用的 `ext:`，宿主一律忽略）。
   */
  extId?: string;
  /** 单次 invoke 的超时（毫秒），缺省 {@link DEFAULT_TIMEOUT}。 */
  timeout?: number;
  /**
   * 是否校验回复消息必须来自父窗口（`event.source === window.parent`）。
   * 缺省 `true`。注意 Tauri WebView2 下 `MessageEvent.source` 实测可能为 `null`，
   * 这种情况会被放行（只按 `source` 字段过滤），不会误伤正常回复。
   */
  strictOrigin?: boolean;
  /**
   * 宿主返回错误时（`ok: false` 或超时）的旁路回调。
   * 适合在这里打点 / 弹提示；`invoke` 的 Promise 仍会正常 reject。
   */
  onError?: (error: ExtBridgeError, context: { method: string; reqId: string }) => void;
  /**
   * 是否在控制台输出收到的原始错误。缺省 `false`。
   * 打开后能直接看到宿主侧原因（如权限被拒、引擎未就绪）。
   */
  debug?: boolean;
}

/** 桥客户端抛出的错误；`code` 在宿主给了 `[CODE] 消息` 形式时会被解析出来。 */
export interface ExtBridgeError extends Error {
  /** 形如 `EXT_INVOKE_TIMEOUT` / `EXT_BRIDGE_DISPOSED`，或宿主透传的 `[CODE]`。 */
  code?: string;
  /** 原始 `error` 字段（宿主侧目前是字符串，保留 unknown 以便将来传结构体）。 */
  data?: unknown;
}

/** 宿主保留方法名（不转发引擎）。 */
export const HOST_METHODS = {
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  open: "open",
  reveal: "reveal",
  themeList: "themes:list",
  themeApply: "themes:apply",
  themeClear: "themes:clear",
} as const;

/** 宿主保留方法名的联合类型。 */
export type HostMethod = (typeof HOST_METHODS)[keyof typeof HOST_METHODS];

/** 宿主 → 扩展的调用结果消息。 */
export interface HostInvokeResultMessage {
  source: typeof HOST_SOURCE;
  type: "invoke-result";
  reqId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 扩展 → 宿主的调用请求消息。 */
export interface ExtInvokeMessage {
  source: string;
  type: "invoke";
  reqId: string;
  method: string;
  payload: unknown;
}

/** 事件回调。 */
export type ExtEventListener = (payload: unknown) => void;

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: ExtBridgeError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 把宿主返回的字符串错误转成带 `code` 的错误对象。 */
export function toBridgeError(raw: unknown, fallbackCode?: string): ExtBridgeError {
  const message = typeof raw === "string" && raw.trim() ? raw : "扩展调用失败（宿主未返回原因）";
  const err = new Error(message) as ExtBridgeError;
  err.name = "ExtBridgeError";
  const m = /^\s*\[([A-Za-z0-9_:.-]+)\]\s*(.*)$/.exec(message);
  if (m) {
    err.code = m[1];
    err.message = m[2] || message;
  } else if (fallbackCode) {
    err.code = fallbackCode;
  }
  if (raw !== undefined && typeof raw !== "string") err.data = raw;
  return err;
}

/**
 * 把扩展目录内的**相对路径**转成扩展 UI 可直接加载的 URL。
 *
 * 扩展 UI 跑在 `ext:` 自定义协议下（不是 `asset:`），所以扩展自己就能用**相对路径**
 * 直接取同目录的资源（`<img src="./assets/bg.png">` 就够了）。
 *
 * 只有在需要「从扩展 UI 指向扩展目录内另一处文件」时（例如动态拼样式里的背景图），
 * 才需要这个函数；它返回的是**相对当前文档**的路径，不做任何协议转换 ——
 * 因为扩展文档本身已经是 `ext:` origin：
 *
 * ```ts
 * el.style.backgroundImage = `url(${toAssetHtmlUrl("assets/bg.png")})`;
 * ```
 *
 * ⚠️ 不要用它去访问扩展目录**之外**的文件：跨出扩展根目录的路径会被 `ext:` 协议拒绝，
 * 而且那正是「扩展与任意 asset 同源」这一历史漏洞要堵的东西。
 */
export function toAssetHtmlUrl(relativePath: string): string {
  const p = relativePath.trim();
  if (!p) return p;
  // 已经是相对/绝对/带协议的路径就原样保留；否则补 `./` 让浏览器按同目录解析。
  // （产物 URL 形如 http://ext.localhost/<abs-encoded>，扩展文档本身就在 ext: origin 下。）
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\.\.?\/|\/)/i.test(p)) return p;
  return `./${p}`;
}

/** 读 iframe 地址上的 `?ext=`。 */
export function readExtIdFromLocation(loc?: Pick<Location, "search">): string | null {
  const search = loc ? loc.search : typeof window !== "undefined" ? window.location.search : "";
  if (!search) return null;
  const v = new URLSearchParams(search).get(EXT_ID_PARAM);
  return v && v.trim() ? v.trim() : null;
}

/** 读 iframe 地址上的 `?route=`（宿主用 `ext:navigate` 事件驱动，刷新后会保留）。 */
export function readRouteFromLocation(loc?: Pick<Location, "search">): string | null {
  const search = loc ? loc.search : typeof window !== "undefined" ? window.location.search : "";
  if (!search) return null;
  const v = new URLSearchParams(search).get("route");
  return v && v.trim() ? v.trim() : null;
}

/**
 * 扩展侧桥客户端。
 *
 * ```ts
 * import { createExtBridge } from "@silvermoon/extension-api";
 * const bridge = createExtBridge();
 *
 * const page = await bridge.invoke<{ items: string[] }>("search", { q: "关键词" });
 * await bridge.open("D:/media/a.mp4", { ts: 95 });
 * await bridge.settings.set({ roots: ["D:/media"] });
 * const themes = await bridge.theme.list();
 * ```
 */
export class ExtBridge {
  /** 扩展 id（消息 `source` 的组成）。 */
  readonly extId: string;

  private readonly defaultTimeout: number;
  private readonly strictOrigin: boolean;
  private readonly debug: boolean;
  private readonly onErrorHook?: ExtBridgeOptions["onError"];
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Map<string, Set<ExtEventListener>>();
  private seq = 0;
  private disposed = false;
  private warnedNoHost = false;

  /** 设置项读写（宿主保留方法 `settings:get` / `settings:set`）。 */
  readonly settings: ExtSettingsApi;

  /** 皮肤（宿主保留方法 `theme:*`）。 */
  readonly theme: ExtThemeApi;

  constructor(options: ExtBridgeOptions = {}) {
    const extId = options.extId ?? readExtIdFromLocation() ?? "";
    if (!extId) {
      throw new Error(
        "无法确定扩展 id：请在 iframe 地址上带 ?ext=<扩展 id>，或显式传入 createExtBridge({ extId })",
      );
    }
    this.extId = extId;
    this.defaultTimeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.strictOrigin = options.strictOrigin ?? true;
    this.debug = options.debug ?? false;
    this.onErrorHook = options.onError;
    this.settings = new ExtSettingsApi(this);
    this.theme = new ExtThemeApi(this);
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.handleMessage);
      document.addEventListener(BRIDGE_EVENT, this.handleCustomEvent);
    }
  }

  /** 消息 `source` 字段（`ext:<扩展 id>`）。 */
  get source(): string {
    return `ext:${this.extId}`;
  }

  /** 是否已 dispose。 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 尚未收到回复的请求数（调试用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 调用宿主 / 扩展引擎方法。
   *
   * 宿主把非保留方法原样转发给扩展引擎的 localhost HTTP（`POST http://127.0.0.1:<port>/<method>`，
   * body 就是 payload）。因此 `method` 里**不要带斜杠前缀**，且必须是引擎认得的路径。
   */
  invoke<T = unknown>(
    method: string,
    payload: unknown = null,
    opts: InvokeOptions = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(toBridgeError("扩展桥已销毁，无法再调用", "EXT_BRIDGE_DISPOSED"));
    }
    if (!method) {
      return Promise.reject(toBridgeError("method 不能为空", "EXT_BRIDGE_BAD_METHOD"));
    }
    const target = this.resolveTarget();
    if (!target) {
      return Promise.reject(toBridgeError("当前环境没有可用的宿主窗口", "EXT_BRIDGE_NO_HOST"));
    }
    const reqId = `r${(++this.seq).toString(36)}-${Date.now().toString(36)}`;
    const timeout = opts.timeout ?? this.defaultTimeout;

    return new Promise<T>((resolve, reject) => {
      const call: PendingCall = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
      };
      if (timeout > 0) {
        call.timer = setTimeout(() => {
          this.pending.delete(reqId);
          const err = toBridgeError(
            `调用 ${method} 超时（${timeout}ms）：宿主未在时限内回复。`,
            "EXT_INVOKE_TIMEOUT",
          );
          this.reportError(err, { method, reqId });
          reject(err);
        }, timeout);
      }
      this.pending.set(reqId, call);
      const message: ExtInvokeMessage = {
        source: this.source,
        type: "invoke",
        reqId,
        method,
        payload,
      };
      try {
        target.postMessage(message, "*");
      } catch (e) {
        this.pending.delete(reqId);
        if (call.timer) clearTimeout(call.timer);
        reject(toBridgeError(`postMessage 失败：${String(e)}`, "EXT_BRIDGE_POST_FAILED"));
      }
    });
  }

  /**
   * 由宿主代执行「打开文件 / 定位文件」。
   *
   * 需要清单里声明 `opener:open-path`；
   * 视频文件带 `ts` 时宿主会优先找 mpv / PotPlayer 精确跳秒（见 Rust `ext_open_impl`）。
   */
  open(path: string, opts: { ts?: number; reveal?: boolean } = {}): Promise<{ ok: true }> {
    return this.invoke<{ ok: true }>(HOST_METHODS.open, {
      path,
      ...(opts.ts !== undefined ? { ts: opts.ts } : {}),
      ...(opts.reveal !== undefined ? { reveal: opts.reveal } : {}),
    });
  }

  /** 在系统文件管理器中定位文件（等价于 `open(path, { reveal: true })`）。 */
  reveal(path: string): Promise<{ ok: true }> {
    return this.invoke<{ ok: true }>(HOST_METHODS.reveal, { path });
  }

  /**
   * 订阅宿主推给本扩展的事件。
   *
   * 支持两种投递方式：
   * - `window.postMessage({ source: "lumiluna-host", type: "<事件名>", payload })`
   *   —— Tauri WebView2 下 `MessageEvent.source` 实测为 `null`，所以这里**不校验来源窗口**，
   *   只按 `source` 字段过滤（与 `invoke-result` 的严格校验区别开）；
   * - `document.dispatchEvent(new CustomEvent("silvermoon:ext-bridge", { detail: { type, payload } }))`
   *   —— 宿主（或扩展自己的其他模块）在本窗口上下文里直接派发时走这条。
   *
   * 返回取消订阅函数。
   */
  on(type: string, listener: ExtEventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => this.off(type, listener);
  }

  /** 取消订阅（`on` 的返回值等价形式）。 */
  off(type: string, listener: ExtEventListener): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(listener);
    if (!set.size) this.listeners.delete(type);
  }

  /**
   * 销毁：移除监听、拒绝所有悬挂请求。扩展窗口关闭 / 热重载前调用可避免残留回调。
   */
  dispose(reason = "扩展桥已销毁"): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("message", this.handleMessage);
      document.removeEventListener(BRIDGE_EVENT, this.handleCustomEvent);
    }
    for (const call of this.pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(toBridgeError(reason, "EXT_BRIDGE_DISPOSED"));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  /** 宿主是否可达（用于优雅降级：纯浏览器预览时没有宿主）。 */
  isHostAvailable(): boolean {
    return this.resolveTarget() !== null;
  }

  // ---- 内部 ----

  private resolveTarget(): Window | null {
    if (typeof window === "undefined") return null;
    const parent = window.parent as Window | null;
    if (parent && parent !== window) return parent;
    // 不在 iframe 里（如作者直接 `vite dev` 打开扩展页面）：退回 window 自己，
    // 并打一次警告，方便区分「宿主没回」和「根本没有宿主」。
    if (!this.warnedNoHost) {
      this.warnedNoHost = true;
      console.warn("[extension-api] 未检测到宿主 iframe，消息将发往当前窗口（开发预览下属正常）。");
    }
    return window;
  }

  private handleMessage = (ev: MessageEvent): void => {
    const m = ev.data as (Partial<HostInvokeResultMessage> & { payload?: unknown }) | null;
    if (!m || typeof m !== "object") return;
    if (m.source !== HOST_SOURCE) return;

    // 事件投递：宿主主动推的事件不带 reqId、type 也不是 invoke-result
    if (m.type !== "invoke-result") {
      if (typeof m.type === "string" && m.type && !m.reqId) this.dispatch(m.type, m.payload);
      return;
    }

    const reqId = m.reqId;
    if (!reqId) return;
    const call = this.pending.get(reqId);
    if (!call) return;
    // 回复必须来自宿主页；不在 iframe 里或 WebView 不给 source 时跳过该校验。
    if (this.strictOrigin && ev.source && ev.source !== window.parent) return;

    this.pending.delete(reqId);
    if (call.timer) clearTimeout(call.timer);
    if (m.ok) {
      call.resolve(m.data);
    } else {
      const err = toBridgeError(m.error, "EXT_INVOKE_FAILED");
      this.reportError(err, { method: call.method, reqId });
      call.reject(err);
    }
  };

  private handleCustomEvent = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ type?: string; payload?: unknown }>).detail;
    if (!detail || typeof detail.type !== "string" || !detail.type) return;
    this.dispatch(detail.type, detail.payload);
  };

  private dispatch(type: string, payload: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        if (this.debug) {
          console.error(`[extension-api] 事件 ${type} 的监听器抛出异常：`, e);
        }
      }
    }
  }

  private reportError(error: ExtBridgeError, context: { method: string; reqId: string }): void {
    if (this.debug) {
      console.error(`[extension-api] ${context.method} 失败：`, error);
    }
    this.onErrorHook?.(error, context);
  }
}

/**
 * 设置项读写。
 *
 * 宿主按 `contributes.settings.schema` 渲染设置界面，并把值按扩展隔离地持久化；
 * 扩展前端用这一个 API 即可读回自己的值（**不需要**再调引擎）。
 */
export class ExtSettingsApi {
  constructor(private readonly bridge: ExtBridge) {}

  /**
   * 读取本扩展的全部设置值。
   *
   * 宿主已经把清单里 `settings.schema[].default` 作为**打底值**合并进来了
   * （扩展升级后新增的设置项会立刻带上自己的默认值），所以正常情况下拿到的是完整对象；
   * 但 schema 里没写 `default` 的键仍会缺席 —— 关键项请给默认值。
   */
  async get<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T> {
    const res = await this.bridge.invoke<{ values?: Record<string, unknown> }>(
      HOST_METHODS.settingsGet,
      null,
    );
    return ((res && res.values) || {}) as T;
  }

  /**
   * 写入设置值（**部分更新**：只覆盖传入的键，未传的键保持原值）。
   *
   * 宿主按扩展 id 独立存储（`<appData>/ext-settings.json` 的一个键），不污染主设置，
   * 卸载扩展时整键清除。
   *
   * 宿主侧不校验键是否在 schema 里、也不校验类型，请自行保证与 schema 一致。
   */
  async set(values: Record<string, unknown>): Promise<void> {
    await this.bridge.invoke<{ ok: true }>(HOST_METHODS.settingsSet, { values });
  }

  /** 读一个键并回退到默认值：`const roots = await settings.getOne("roots", [])`。 */
  async getOne<T>(key: string, fallback: T): Promise<T> {
    const values = await this.get<Record<string, T>>();
    return key in values ? values[key] : fallback;
  }
}

/**
 * 皮肤（`contributes.themes`）。
 *
 * 「装皮肤 = 装扩展」：宿主设置页不再有独立的皮肤入口，
 * 皮肤由扩展声明，存放在扩展目录里，经 `ext_theme_load` 读取。
 */
export class ExtThemeApi {
  constructor(private readonly bridge: ExtBridge) {}

  /**
   * 列出当前**已安装、已启用且兼容**的所有扩展所提供的皮肤（含其他扩展的）。
   *
   * 想只取自己的，按 `extId` 过滤：`themes.filter((t) => t.extId === bridge.extId)`。
   */
  async list(): Promise<ExtThemeEntry[]> {
    const res = await this.bridge.invoke<{ themes?: ExtThemeEntry[] }>(
      HOST_METHODS.themeList,
      null,
    );
    return res && Array.isArray(res.themes) ? res.themes : [];
  }

  /**
   * 应用皮肤（宿主会切到该主题并落盘）。
   *
   * @param themeId 皮肤 id —— 与 `extId` 一起唯一确定一款皮肤（themeId 只保证**扩展内**唯一）。
   * @param extId 皮肤所属扩展。**缺省 = 本扩展自己**；
   *   显式传别的扩展 id 用于**管理器类扩展**（`list()` 是全量的，管理器要能把别人的皮肤也切上去）。
   *   这不是越权：跨扩展 apply 是用户主动装的管理器所为，皮肤本质是 CSS。
   *   但同一个 themeId 可能被多个扩展声明（如都叫 `"sakura"`），跨扩展应用时**务必带上 extId**。
   */
  async apply(themeId: string, extId?: string): Promise<void> {
    await this.bridge.invoke<{ ok: true }>(HOST_METHODS.themeApply, {
      themeId,
      // 缺省不传 extId，由宿主回落到「当前 iframe 的扩展」
      ...(extId ? { extId } : {}),
    });
  }

  /** 恢复内置主题。 */
  async clear(): Promise<void> {
    await this.bridge.invoke<{ ok: true }>(HOST_METHODS.themeClear, null);
  }
}

/**
 * 创建一个桥客户端（推荐用法：模块顶层建一个，全局共用）。
 * 未传 `extId` 时从 iframe 的 `?ext=` 读取。
 */
export function createExtBridge(options: ExtBridgeOptions = {}): ExtBridge {
  return new ExtBridge(options);
}

let shared: ExtBridge | null = null;

/**
 * 取进程内共享的桥实例（首次调用时按默认参数创建）。
 *
 * 注意它**不吞异常**：拿不到扩展 id 时每次调用都会抛，
 * 想在非宿主环境里优雅降级，请改用 `createExtBridge` 并自行 try/catch。
 */
export function getExtBridge(): ExtBridge {
  if (!shared) shared = createExtBridge();
  return shared;
}

/** 重置 {@link getExtBridge} 缓存的实例（测试用）。 */
export function resetExtBridge(): void {
  shared?.dispose();
  shared = null;
}
