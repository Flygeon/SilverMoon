/**
 * 图层持久化：sidecar JSON。
 *
 * PNG 是拍平后的成品，图层结构单独存在 `<id>.layers.json`
 *（与 PNG 同目录）。每层存 `leafer.toJSON()` 的结果，外加名字与可见性。
 *
 * 打开画作时：sidecar 存在且合法 → 按层重建；
 * 不存在或损坏 → 回退到旧逻辑（整张 PNG 当底图，见 DrawingBoard 的 backdrop）。
 */
import { join } from "@/ipc/paths";
import { readFile, remove, rename, writeFile } from "@/ipc/fs";
import { drawingsDir } from "./files";

/** 单层落盘形态 */
export interface LayerFileData {
  name: string;
  visible: boolean;
  /** leafer.toJSON() 的原始结果 */
  data: unknown;
}

export interface DrawingLayersFile {
  version: 1;
  layers: LayerFileData[];
}

/** sidecar 路径（按画作 id 拼，不依赖已列出的条目） */
export async function layersPath(id: string): Promise<string> {
  return join(await drawingsDir(), id + ".layers.json");
}

/** 写 sidecar；失败抛给调用方处理 */
export async function writeLayers(id: string, file: DrawingLayersFile): Promise<void> {
  await writeFile(await layersPath(id), new TextEncoder().encode(JSON.stringify(file)));
}

/**
 * 校验 sidecar 的原始 JSON 形态。
 *
 * 不存在、解析失败、版本号不对、层数据形态不对 → 全部返回 null，
 * 调用方回退到底图模式。坏一半的 sidecar 不值得抢救：要么整份可信，要么不用。
 * 纯函数，可单测。
 */
export function parseLayersFile(parsed: unknown): DrawingLayersFile | null {
  const p = parsed as Partial<DrawingLayersFile> | null;
  if (!p || p.version !== 1 || !Array.isArray(p.layers) || !p.layers.length) return null;
  for (const l of p.layers) {
    if (!l || typeof l.name !== "string" || typeof l.visible !== "boolean") return null;
  }
  return p as DrawingLayersFile;
}

/** 读 sidecar；失败/损坏返回 null */
export async function readLayers(id: string): Promise<DrawingLayersFile | null> {
  try {
    const bytes = await readFile(await layersPath(id));
    return parseLayersFile(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** 删 sidecar；文件不存在也算成功 */
export async function removeLayers(id: string): Promise<void> {
  try {
    await remove(await layersPath(id));
  } catch {
    /* 老画作本来就没有 sidecar，忽略 */
  }
}

/** 重命名 sidecar；没有就跳过 */
export async function renameLayers(from: string, to: string): Promise<void> {
  try {
    await rename(await layersPath(from), await layersPath(to));
  } catch {
    /* 忽略 */
  }
}
