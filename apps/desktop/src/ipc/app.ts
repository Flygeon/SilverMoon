/**
 * 应用元信息与退出。
 *
 * 版本号来自 `src-tauri/silvermoon.config.json`（与 `tauri.conf.json` 同源），
 * 由 Tauri 在编译期烘焙，`@tauri-apps/api/app` 的 `getVersion()` 读取。
 * 前端皮肤校验用它做 `minAppVersion` 判断。
 */
import { getName as tauriGetName, getVersion as tauriGetVersion } from "@tauri-apps/api/app";
import { invokeRaw } from "./bridge";

/** 应用版本号。 */
export async function getVersion(): Promise<string> {
  return tauriGetVersion();
}

/** 应用名。 */
export async function getName(): Promise<string> {
  return tauriGetName();
}

/**
 * 宿主版本号，用于诊断上报。
 *
 * Electron 版是 `process.versions.electron`；Tauri 下返回 Tauri 框架版本
 * （由 Rust 侧 `tauri::VERSION` 提供）。
 */
export async function getHostVersion(): Promise<string> {
  return invokeRaw<string>("host_version");
}

/** 退出应用。 */
export async function exit(code = 0): Promise<void> {
  await invokeRaw("host_app_exit", { code });
}

/**
 * 清空在线封面磁盘缓存，返回释放的字节数。
 * 非桌面环境（浏览器预览）下返回 0。
 */
export async function clearCoverCache(): Promise<number> {
  const freed = await invokeRaw<number | null>("host_clear_cover_cache");
  return freed ?? 0;
}
