/**
 * 画作的文件层。
 *
 * 存储位置：<应用数据目录>/drawings/*.png —— 与 settings.json 同一个应用数据目录，
 * 纯渲染进程 + Electron 主进程的 fs 通道即可完成，**不需要动 Rust 侧**。
 *
 * 不维护清单文件：显示名取文件名、时间取 mtime、体积取 size。
 * 画布尺寸也不在这里读——列表只为拿尺寸把每张图整读一遍（几十张就是上百 MB）
 * 不划算，改由卡片 <img> 加载后的 naturalWidth/naturalHeight 顺带得到。
 */
import { appDataDir, join } from "@/ipc/paths";
import { mkdir, readDir, readFile, remove, rename, stat, writeFile } from "@/ipc/fs";
import type { Drawing } from "./types";

/** 画作目录名（位于应用数据目录下） */
const DIR_NAME = "drawings";

let cachedDir: string | null = null;

/** 画作目录绝对路径；不存在则创建 */
export async function drawingsDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const dir = await join(await appDataDir(), DIR_NAME);
  await mkdir(dir, { recursive: true });
  cachedDir = dir;
  return dir;
}

/** 画作文件路径（按 id 拼，不依赖已列出的条目） */
export async function drawingPath(id: string): Promise<string> {
  return join(await drawingsDir(), id + ".png");
}

function stripExt(name: string): string {
  return name.replace(/\.png$/i, "");
}

/** 列出全部画作，按修改时间倒序（最近画的排最前）。只做 readDir + stat，不读文件内容。 */
export async function listDrawings(): Promise<Drawing[]> {
  const dir = await drawingsDir();
  let entries: { name: string; isFile: boolean; isDirectory: boolean }[] = [];
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }

  const out: Drawing[] = [];
  for (const f of entries) {
    if (!f.isFile || !f.name.toLowerCase().endsWith(".png")) continue;
    const path = await join(dir, f.name);
    try {
      const info = await stat(path);
      out.push({
        id: stripExt(f.name),
        path,
        name: stripExt(f.name),
        size: info.size,
        mtime: info.mtime ?? 0,
      });
    } catch {
      /* 单个文件读不了就跳过，不影响整份列表 */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 写入/覆盖一张画作，返回落盘后的元信息 */
export async function writeDrawing(id: string, png: Uint8Array): Promise<Drawing> {
  const path = await drawingPath(id);
  await writeFile(path, png);
  const info = await stat(path);
  return { id, path, name: id, size: info.size, mtime: info.mtime ?? Date.now() };
}

/** 删除一张画作 */
export async function deleteDrawing(id: string): Promise<void> {
  await remove(await drawingPath(id));
}

/**
 * 读取画作尺寸。
 *
 * 只解析 PNG 的 IHDR 头：签名 8 字节 + 块长度 4 + "IHDR" 4 + 宽 4 + 高 4（后两个大端）。
 * fs 通道没有分段读接口，这里会把整文件读进来再截头部——每次打开编辑器只读一张，可以接受。
 */
export async function readDrawingSize(id: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(await drawingPath(id));
  const isPng =
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  if (!isPng) return { width: 0, height: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

/** 重命名（改文件名，扩展名不变） */
export async function renameDrawing(from: string, to: string): Promise<void> {
  const dir = await drawingsDir();
  await rename(await join(dir, from + ".png"), await join(dir, to + ".png"));
}
