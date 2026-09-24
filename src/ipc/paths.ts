/**
 * 应用目录与路径拼接。
 *
 * `appDataDir()` 必须与后端解析出的目录**完全一致**，否则扩展的
 * `web/<dist>/index.html` 会找不到 —— 两侧都从同一个环境变量取值，
 * 主进程在启动后端时注入。
 */
import { callBridge } from "./bridge";

/** 应用数据目录（结尾不带分隔符；调用方自行 join） */
export async function appDataDir(): Promise<string> {
  return callBridge<string>("path", { op: "appDataDir" });
}

/** 应用缓存目录 */
export async function appCacheDir(): Promise<string> {
  return callBridge<string>("path", { op: "appCacheDir" });
}

/** 应用配置目录 */
export async function appConfigDir(): Promise<string> {
  return callBridge<string>("path", { op: "appConfigDir" });
}

/** 应用日志目录 */
export async function appLogDir(): Promise<string> {
  return callBridge<string>("path", { op: "appLogDir" });
}

/** 用户主目录 */
export async function homeDir(): Promise<string> {
  return callBridge<string>("path", { op: "homeDir" });
}

/** 临时目录 */
export async function tempDir(): Promise<string> {
  return callBridge<string>("path", { op: "tempDir" });
}

/** 拼接路径片段（语义与 Node 的 `path.join` 一致，由主进程执行） */
export async function join(...paths: string[]): Promise<string> {
  return callBridge<string>("path", { op: "join", paths });
}

/** 规范化路径 */
export async function normalize(path: string): Promise<string> {
  return callBridge<string>("path", { op: "normalize", path });
}

/** 目录分隔符（同步，来自当前平台常量） */
export const sep: string = (window.__SILVERMOON__?.platform ?? "win32") === "win32" ? "\\" : "/";

/** 父目录 */
export async function dirname(path: string): Promise<string> {
  return callBridge<string>("path", { op: "dirname", path });
}

/** 文件名 */
export async function basename(path: string, ext?: string): Promise<string> {
  return callBridge<string>("path", { op: "basename", path, ext: ext ?? null });
}

/** 扩展名 */
export async function extname(path: string): Promise<string> {
  return callBridge<string>("path", { op: "extname", path });
}
