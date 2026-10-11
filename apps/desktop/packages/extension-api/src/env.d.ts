/**
 * 由 Vite 插件（@silvermoon/extension-api/vite）注入的编译期常量。
 *
 * 未接入该插件时这两个标识符不存在；请用 `typeof __EXT_ID__ !== "undefined"` 守卫，
 * 或让 tsconfig 的 `include` 覆盖到本文件（本包的 `tsconfig.json` 已包含 `src/`）。
 */

/** 当前扩展 id（`manifest.json` 的 `id`，或插件选项里显式给的 `extId`）。 */
declare const __EXT_ID__: string;

/** 宿主扩展 API 版本（当前 `2.0.0`），与 `EXT_API_VERSION` 同源。 */
declare const __EXT_API_VERSION__: string;
