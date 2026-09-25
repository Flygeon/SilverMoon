/**
 * 后端命令调用与本地文件 URL。
 *
 * 渲染进程调用后端有且只有这一条路径：`invoke(命令名, 参数)` →
 * preload 桥 → Electron 主进程 → 后端进程的 `POST /cmd`。
 *
 * 参数键用 camelCase，与后端命令形参的映射（`file_id` ← `fileId`）由
 * `backend/crates/silvermoon-ipc` 的命令宏负责，调用方无需关心。
 */
import { invokeBatchCommands, invokeCommand, type BatchItemResult } from "./bridge";

/** 调用后端命令。失败时以**原始错误字符串**拒绝。 */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(cmd, args);
}

/**
 * 一次往返调用多条后端命令。
 *
 * 只有整条通道失败才 reject；单条失败是结果数组里的 `{ ok: false }`。
 * 用于把"每项一条命令"的 O(n) 扇出压成一次往返（如按可视区批量取缩略图）。
 */
export function invokeBatch<T = unknown>(
  calls: { cmd: string; args?: Record<string, unknown> }[],
): Promise<BatchItemResult<T>[]> {
  return invokeBatchCommands<T>(calls);
}

/**
 * 本地文件路径 → 可被 `<img>` / `<video>` / `<iframe>` / CSS `url()` 直接消费的 URL。
 *
 * 生成的 `asset://localhost/<path>` 由 Electron 主进程的 `asset:` 协议处理器映射到
 * 磁盘文件，并支持 Range 请求（音视频拖动进度）。
 *
 * 返回串以 `asset:` 开头，满足皮肤加载器里 `^(https?:|data:|asset:|blob:)` 的
 * 幂等白名单判断。
 */
export function toAssetUrl(filePath: string, protocol = "asset"): string {
  if (!filePath) return "";
  // 已是 URL 则原样返回，避免二次包装
  if (/^(https?:|data:|blob:|asset:|app:)/i.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${protocol}://localhost/${encoded}`;
}
