/**
 * 交给系统处理：用默认程序打开文件、在文件管理器中定位、打开外部链接。
 */
import { callBridge } from "./bridge";

/** 用系统默认程序打开文件或目录 */
export async function openPath(path: string, openWith?: string): Promise<void> {
  await callBridge("opener", { op: "openPath", path, openWith: openWith ?? null });
}

/** 用默认浏览器打开 URL */
export async function openUrl(url: string, openWith?: string): Promise<void> {
  await callBridge("opener", { op: "openUrl", url, openWith: openWith ?? null });
}

/** 在文件管理器里定位该文件 */
export async function revealItemInDir(path: string): Promise<void> {
  await callBridge("opener", { op: "reveal", path });
}
