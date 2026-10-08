/**
 * 后端命令调用与本地文件 URL。
 *
 * 渲染进程调用后端有且只有这一条路径：`invoke(命令名, 参数)` →
 * `@tauri-apps/api/core` 的 invoke → Rust 命令。
 * 参数键用 camelCase，与后端命令形参的映射（`file_id` → `fileId`）
 * 由 Tauri 的 `#[tauri::command]` 负责，调用方无需关心。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { invokeBatchCommands, invokeCommand, type BatchItemResult } from "./bridge";

/** 调用后端命令。失败时以**原始错误字符串**拒绝。 */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(cmd, args);
}

/**
 * 一次往返调用多条后端命令。
 *
 * Tauri 没有批量通道，改由渲染进程并发发起；语义不变——只有整条通道失败
 * 才 reject，单条失败是结果数组里的 `{ ok: false }`。
 * 用于把「每项一条命令」的 O(n) 扇出压成一次并发往返（如按可视区批量取缩略图）。
 */
export function invokeBatch<T = unknown>(
  calls: { cmd: string; args?: Record<string, unknown> }[],
): Promise<BatchItemResult<T>[]> {
  return invokeBatchCommands<T>(calls);
}

/**
 * 本地文件路径 → 可被 `<img>` / `<video>` / `<iframe>` / CSS `url()` 直接消费的 URL。
 *
 * 走 Tauri 的 `asset:` 协议（Windows 上是 `http://asset.localhost/…`），
 * 由 `tauri.conf.json` 的 `app.security.assetProtocol` 授权磁盘访问，支持 Range 请求
 * （音视频拖动进度条必需）。
 *
 * 返回值满足皮肤加载器里 `^(https?:|data:|asset:|blob:)` 的幂等白名单判断，
 * 因此重复包装是安全的。
 */
export function toAssetUrl(filePath: string, protocol = "asset"): string {
  if (!filePath) return "";
  // 已是 URL 则原样返回，避免二次包装
  if (/^(https?:|data:|blob:|asset:|app:)/i.test(filePath)) return filePath;

  return convertFileSrc(filePath, protocol);
}
