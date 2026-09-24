/**
 * `@tauri-apps/api/app` 的替身。
 *
 * 业务代码只在 `stores/skins.ts` 里动态导入 `getVersion`，用于皮肤
 * `minAppVersion` 校验；取不到时会回退到构建期常量 `__APP_VERSION__`。
 */
import { callBridge } from "../bridge";

/** 应用版本号（来自 `silvermoon.config.json`，与 package.json 同源） */
export async function getVersion(): Promise<string> {
  return callBridge<string>("app", { op: "version" });
}

/** 应用名 */
export async function getName(): Promise<string> {
  return callBridge<string>("app", { op: "name" });
}

/** Tauri 版本号（兼容占位） */
export async function getTauriVersion(): Promise<string> {
  return "2.0.0";
}

/** 退出应用 */
export async function exit(code = 0): Promise<void> {
  await callBridge("app", { op: "exit", code });
}
