/**
 * 文件读写。
 *
 * Tauri 版直接走 @tauri-apps/plugin-fs；导出名与签名保持不变。
 * readFile 返回 Uint8Array，writeFile 接受 Uint8Array。
 */
import {
  copyFile as tauriCopyFile,
  exists as tauriExists,
  mkdir as tauriMkdir,
  readDir as tauriReadDir,
  readFile as tauriReadFile,
  readTextFile as tauriReadTextFile,
  remove as tauriRemove,
  rename as tauriRename,
  stat as tauriStat,
  writeFile as tauriWriteFile,
  writeTextFile as tauriWriteTextFile,
} from "@tauri-apps/plugin-fs";
import { toBytes } from "./bridge";

/** 读取整个文件（二进制）。 */
export async function readFile(path: string): Promise<Uint8Array> {
  return toBytes(await tauriReadFile(path));
}

/** 写入二进制文件。 */
export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await tauriWriteFile(path, data);
}

/** 读取文本文件 */
export async function readTextFile(path: string): Promise<string> {
  return tauriReadTextFile(path);
}

/** 写入文本文件 */
export async function writeTextFile(path: string, contents: string): Promise<void> {
  await tauriWriteTextFile(path, contents);
}

/** 是否存在 */
export async function exists(path: string): Promise<boolean> {
  return tauriExists(path);
}

/** 建目录（可递归） */
export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await tauriMkdir(path, { recursive: options?.recursive ?? false });
}

/** 删除文件 / 目录 */
export async function remove(path: string, options?: { recursive?: boolean }): Promise<void> {
  await tauriRemove(path, { recursive: options?.recursive ?? false });
}

/** 复制文件 */
export async function copyFile(from: string, to: string): Promise<void> {
  await tauriCopyFile(from, to);
}

/** 文件元信息 */
export async function stat(path: string): Promise<{
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number | null;
}> {
  const info = await tauriStat(path);
  return {
    isFile: info.isFile,
    isDirectory: info.isDirectory,
    size: info.size,
    mtime: info.mtime ? new Date(info.mtime).getTime() : null,
  };
}

/** 目录项 */
export async function readDir(
  path: string,
): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]> {
  const entries = await tauriReadDir(path);
  return entries.map((e) => ({
    name: e.name,
    isFile: e.isFile,
    isDirectory: e.isDirectory,
  }));
}

/** 重命名 / 移动 */
export async function rename(from: string, to: string): Promise<void> {
  await tauriRename(from, to);
}
