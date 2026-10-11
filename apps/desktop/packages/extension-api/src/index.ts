/// <reference path="./env.d.ts" />
/**
 * 银月（SilverMoon）扩展作者 SDK。
 *
 * 三条入口，按需引入：
 * - 运行时（扩展的 web UI 里）：`createExtBridge` / `getExtBridge`；
 * - 构建期（扩展包里的 `vite.config.ts`）：`@silvermoon/extension-api/vite`；
 * - 类型（`manifest.json` 的 schema、引擎调用契约）：本文件导出的全部类型。
 *
 * ```ts
 * import { createExtBridge } from "@silvermoon/extension-api";
 * ```
 */

// ---- manifest 契约（与宿主 Rust ExtManifest 逐字段对齐）----
export { EXT_API_VERSION, PERM_INVOKE, PERM_OPEN, defineManifest } from "./manifest";
export type {
  ActivationEvent,
  ExtContributes,
  ExtEngine,
  ExtHotkey,
  ExtManifest,
  ExtSettings,
  ExtThemeContrib,
  ExtThemeEntry,
  ExtThemeLoadResult,
  ExtTrayItem,
  ExtWeb,
  ExtWindowContrib,
  ExtensionPermission,
  KnownPermission,
  SettingField,
  SettingFieldType,
} from "./manifest";

// ---- 宿主 iframe 桥 ----
export {
  BRIDGE_EVENT,
  DEFAULT_TIMEOUT,
  EXT_ID_PARAM,
  ExtBridge,
  ExtSettingsApi,
  ExtThemeApi,
  HOST_METHODS,
  HOST_SOURCE,
  createExtBridge,
  getExtBridge,
  readExtIdFromLocation,
  readRouteFromLocation,
  resetExtBridge,
  toAssetHtmlUrl,
  toBridgeError,
} from "./bridge";
export type {
  ExtBridgeError,
  ExtBridgeOptions,
  ExtEventListener,
  ExtInvokeMessage,
  HostInvokeResultMessage,
  HostMethod,
  InvokeOptions,
} from "./bridge";

// 注意：`@silvermoon/extension-api/vite` **不在**这里再导出一次 ——
// 它依赖 node 内置模块，扩展的浏览器产物 import 它会需要 polyfill，因此单独一个入口。
