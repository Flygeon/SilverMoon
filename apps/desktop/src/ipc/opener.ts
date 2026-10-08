/**
 * 交给系统处理：用默认程序打开文件、在文件管理器中定位、打开外部链接。
 *
 * Tauri 版直接走 `@tauri-apps/plugin-opener`；导出名与签名保持不变，
 * 业务代码无需改动。
 */
import {
  openPath as tauriOpenPath,
  openUrl as tauriOpenUrl,
  revealItemInDir as tauriReveal,
} from "@tauri-apps/plugin-opener";

/** 用系统默认程序打开文件或目录（`openWith` 仅 Windows 有意义，Tauri 未暴露，忽略）。 */
export async function openPath(path: string, _openWith?: string): Promise<void> {
  await tauriOpenPath(path);
}

/** 用默认浏览器打开 URL。 */
export async function openUrl(url: string, _openWith?: string): Promise<void> {
  await tauriOpenUrl(url);
}

/** 在文件管理器里定位该文件。 */
export async function revealItemInDir(path: string): Promise<void> {
  await tauriReveal(path);
}
