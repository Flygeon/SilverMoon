/**
 * `@tauri-apps/plugin-fs` 的替身。
 *
 * 业务代码只用三个：`readFile`（读 EPUB/PDF/词库）、`writeFile`（下载皮肤包）、
 * `writeTextFile`（导出音效预设）。全部经主进程的 Node `fs` 执行，
 * 因此不受渲染进程沙箱限制。
 */
import { callBridge } from "./bridge";

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  return new Uint8Array(0);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // 分块拼接，避免超长参数导致栈溢出
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * 读取整个文件。
 *
 * 与 Tauri 一致返回 `Uint8Array`。优先走二进制通道；若宿主环境不允许
 * TypedArray 跨隔离世界传递，则回退到 base64 通道（结果一致，只是多一次编解码）。
 */
export async function readFile(path: string): Promise<Uint8Array> {
  try {
    return toUint8(await callBridge<unknown>("fs", { op: "readFile", path }));
  } catch (error) {
    if (!(error instanceof Error) && typeof error !== "string") throw error;
    const base64 = await callBridge<string>("fs", { op: "readFileBase64", path });
    return fromBase64(base64);
  }
}

/** 写入二进制文件 */
export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  try {
    await callBridge("fs", { op: "writeFile", path, data });
  } catch {
    await callBridge("fs", { op: "writeFileBase64", path, data: toBase64(data) });
  }
}

/** 读取文本文件 */
export async function readTextFile(path: string): Promise<string> {
  return callBridge<string>("fs", { op: "readTextFile", path });
}

/** 写入文本文件 */
export async function writeTextFile(path: string, contents: string): Promise<void> {
  await callBridge("fs", { op: "writeTextFile", path, contents });
}

/** 是否存在 */
export async function exists(path: string): Promise<boolean> {
  return callBridge<boolean>("fs", { op: "exists", path });
}

/** 建目录（可递归） */
export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await callBridge("fs", { op: "mkdir", path, recursive: options?.recursive ?? false });
}

/** 删除文件 */
export async function remove(path: string, options?: { recursive?: boolean }): Promise<void> {
  await callBridge("fs", { op: "remove", path, recursive: options?.recursive ?? false });
}

/** 复制文件 */
export async function copyFile(from: string, to: string): Promise<void> {
  await callBridge("fs", { op: "copyFile", from, to });
}

/** 文件元信息 */
export async function stat(path: string): Promise<{
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number | null;
}> {
  return callBridge("fs", { op: "stat", path });
}

/** 目录项 */
export async function readDir(
  path: string,
): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]> {
  return callBridge("fs", { op: "readDir", path });
}

/** 重命名 / 移动 */
export async function rename(from: string, to: string): Promise<void> {
  await callBridge("fs", { op: "rename", from, to });
}
