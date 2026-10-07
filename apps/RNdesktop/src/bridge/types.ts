/**
 * 渲染进程 ↔ 宿主（Electron 主进程 / RN 原生宿主）与 Rust 侧车的**协议契约**。
 *
 * 这里只放类型与常量，不放实现 —— 目的是让上层 UI / 状态层在**宿主还没接好**
 * 的时候也能通过类型检查并跑通 mock，等原生桥落地后无需改动调用方。
 *
 * 与 `apps/desktop` 的既有约定保持一致（见 apps/desktop/src/ipc/bridge.ts）：
 *
 * 1. 业务错误**不做成 rejected promise**，而是返回 `{ ok: false, error }`，
 *    由 bridge 层转成 `Promise.reject(error)`，保证 reject 值就是原始字符串
 *    （`[WENKU8_LOGIN_CANCELLED] ...` 这类靠字符串前缀判断的协议依赖它）。
 * 2. `invoke` / `invokeBatch` 打的是 **Rust 侧车命令表**（`POST /cmd`），
 *    `call` 打的是**宿主能力**（窗口 / 文件 / 对话框 / 存储 / 托盘 …）。
 */

/** 宿主统一回复格式。 */
export interface BridgeReply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** 批量命令中单条的结果：逐条独立成败，不影响其它条。 */
export interface BatchItemResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** 一次批量调用里的单条命令。 */
export interface CommandCall {
  cmd: string;
  args?: unknown;
}

/**
 * 宿主桥。RN 桌面端由**原生模块**（Windows: C++/WinRT TurboModule；
 * macOS: Objective-C++ TurboModule）实现同名方法后注入。
 */
export interface SilverMoonHostBridge {
  /** 当前窗口标识：`main` / `desktop-lyrics` / `extension` / … */
  readonly label: string;
  /** 进程平台：`windows` / `macos` / `linux`（RN 用 `Platform.OS` 的叫法）。 */
  readonly platform: string;
  /** 宿主版本，用于「后端 / 前端版本不一致」的诊断提示。 */
  readonly hostVersion: string;
  /** 调用 Rust 侧车命令。 */
  invoke<T = unknown>(cmd: string, args: unknown): Promise<BridgeReply<T>>;
  /** 一次往返执行多条命令（逐条独立成败）。 */
  invokeBatch(calls: CommandCall[]): Promise<BridgeReply<BatchItemResult[]>>;
  /** 通用宿主能力调用（窗口 / 文件 / 对话框 / 存储 / 托盘 / 热键 …）。 */
  call<T = unknown>(channel: string, payload: unknown): Promise<BridgeReply<T>>;
  /** 跨窗口派发事件。 */
  emitTo(label: string, event: string, payload: unknown): Promise<void>;
  /** 订阅侧车推送的事件（SSE 事件的 RN 侧镜像），返回取消订阅函数。 */
  subscribe(event: string, listener: (payload: unknown) => void): () => void;
  /** 本地文件 URL 前缀；桌面端为 `undefined`，此时走宿主资源协议。 */
  readonly assetBase?: string;
}

/** 宿主能力通道名（`call` 的第一个参数）—— 只登记骨架阶段已定下的通道。 */
export const HostChannel = {
  /** 宿主 / 侧车存活探测，用于标题栏的连接状态指示灯。 */
  Ping: 'host:ping',
  /** 应用信息：版本、构建号、平台。 */
  AppInfo: 'app:info',
  /** 窗口控制：最小化 / 最大化 / 关闭 / 置顶。 */
  Window: 'window:control',
  /** 系统文件对话框。 */
  Dialog: 'dialog:open',
  /** 本地持久化（设置 / 布局记忆）。 */
  Store: 'store:kv',
  /** 用系统默认程序打开路径或 URL。 */
  Opener: 'opener:open',
} as const;

export type HostChannelName = (typeof HostChannel)[keyof typeof HostChannel];

/** 连接状态：标题栏指示灯与设置页诊断共用。 */
export type BridgeStatus = 'connecting' | 'connected' | 'mock' | 'unavailable';

/** 宿主不可用时的错误前缀，便于 UI 识别「没在宿主里跑」。 */
export const HOST_UNAVAILABLE = '[HOST_UNAVAILABLE]';
