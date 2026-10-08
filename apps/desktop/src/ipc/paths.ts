/**
 * 应用目录与路径拼接。
 *
 * Tauri 版走插件命令（host_path，见 src-tauri/src/commands/host.rs），
 * 解析规则与 Rust 侧 app.path().app_data_dir() 完全一致 —— 扩展的
 * web/<dist>/index.html 依赖两侧同源，不能各算各的。
 *
 * 目录口径与 Electron 版保持一致（都是 <appData>/<identifier>）：
 * Electron 侧曾显式用 identifier 而非 productName 命名，Tauri 的 app_data_dir()
 * 同样以 identifier 为末级目录，因此老数据无需搬迁。
 */
import { invokeRaw } from "./bridge";

async function pathOp<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  return invokeRaw<T>("host_path", { op, ...extra });
}

/** 应用数据目录（结尾不带分隔符；调用方自行 join） */
export async function appDataDir(): Promise<string> {
  return pathOp<string>("appDataDir");
}

/** 应用缓存目录 */
export async function appCacheDir(): Promise<string> {
  return pathOp<string>("appCacheDir");
}

/** 应用配置目录 */
export async function appConfigDir(): Promise<string> {
  return pathOp<string>("appConfigDir");
}

/** 应用日志目录 */
export async function appLogDir(): Promise<string> {
  return pathOp<string>("appLogDir");
}

/** 用户主目录 */
export async function homeDir(): Promise<string> {
  return pathOp<string>("homeDir");
}

/** 临时目录 */
export async function tempDir(): Promise<string> {
  return pathOp<string>("tempDir");
}

/** 拼接路径片段（语义与 Node 的 path.join 一致，由 Rust 侧执行） */
export async function join(...paths: string[]): Promise<string> {
  return pathOp<string>("join", { paths });
}

/** 规范化路径 */
export async function normalize(path: string): Promise<string> {
  return pathOp<string>("normalize", { path });
}

/** 目录分隔符（同步，来自当前平台常量） */
export const sep: string =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "\\" : "/";

/** 父目录 */
export async function dirname(path: string): Promise<string> {
  return pathOp<string>("dirname", { path });
}

/** 文件名 */
export async function basename(path: string, ext?: string): Promise<string> {
  return pathOp<string>("basename", { path, ext: ext ?? null });
}

/** 扩展名 */
export async function extname(path: string): Promise<string> {
  return pathOp<string>("extname", { path });
}
