/**
 * 在线歌曲的「写音乐标签」本地旁路文件（纯 Node / Electron 主进程用）。
 *
 * 与主进程 `electron/tags.ts` 共用同一套目录约定，因此放在这里避免两边各写一份 sha1 逻辑：
 * - 用户为**在线歌曲**应用标签时，歌词文本落 `userData/music-tags/lyrics/<sha1(key)>.txt`
 *   （原生格式支持读写歌词，但**在线歌曲没有文件可写**，所以单独存一份旁路文件）。
 * - 同时把「写入前」的平台歌词快照存进 `local-backup`，让在线歌曲也有「还原默认」可回退。
 *
 * 这个模块只依赖 node 内置模块，`scripts/verify-music-tags.mjs` 可以直接测它。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 在 Electron / Node 下都成立的 sha1 十六进制摘要。 */
export function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 标签缓存根目录下的子目录名。 */
export const TAGS_DIR = "music-tags";
export const LYRICS_DIR = "lyrics";
export const COVER_DIR = "covers";
export const BACKUP_DIR = "local-backup";
export const INDEX_FILE = "index.json";

/** 保证目录存在并返回。 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原子写文本：先写 .tmp 再 rename，避免半截 JSON 被后续启动读到。 */
export function writeTextAtomic(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, file);
}

/** 读 UTF-8 文本；不存在 / 读失败返回 null（调用方自行回退）。 */
export function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 静默删除文件 / 目录。 */
export function removeQuietly(target: string): boolean {
  try {
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 旁路歌词文件路径（按在线歌曲的合并 key 哈希）。 */
export function lyricsPathFor(root: string, key: string): string {
  return path.join(root, TAGS_DIR, LYRICS_DIR, `${sha1(key)}.txt`);
}

/**
 * 读取某首歌「上次写标签时保存的歌词」。
 * @param root 应用数据根目录（Electron 下为 `app.getPath("userData")`）
 * @param key 歌曲合并 key（`${server ?? "netease"}:${id}`）
 */
export function writeLyricsSidecar(root: string, key: string, lyrics: string): void {
  const file = lyricsPathFor(root, key);
  if (lyrics) writeTextAtomic(file, lyrics);
  else removeQuietly(file);
}

/** 读旁路歌词；无则 null。 */
export function readLyricsSidecar(root: string, key: string): string | null {
  return readTextOrNull(lyricsPathFor(root, key));
}

/** 备份文件路径（本地文件按路径哈希，在线歌曲按 key 哈希）。 */
export function backupPathFor(root: string, id: string): string {
  return path.join(root, TAGS_DIR, BACKUP_DIR, `${sha1(id)}.json`);
}

/** 仅当备份不存在时写入（保留最原始的「写入前」快照）。返回是否新建。 */
export function createBackupIfAbsent(root: string, id: string, payload: unknown): boolean {
  const file = backupPathFor(root, id);
  if (existsSync(file)) return false;
  writeTextAtomic(file, JSON.stringify(payload, null, 2));
  return true;
}

/** 读备份；无则 null。 */
export function readBackup<T>(root: string, id: string): T | null {
  const text = readTextOrNull(backupPathFor(root, id));
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
