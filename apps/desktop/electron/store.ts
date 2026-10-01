/**
 * 键值存储：应用数据目录下的整文件 JSON。
 *
 * 原项目三个 store（`settings.json` / `audio-effects.json` / `bangumi.json`）都落在
 * `app_data_dir()` 下，这里沿用同一位置，保证迁移后设置与原数据完全接得上。
 *
 * 写盘是**显式**的（渲染进程调 `save()`），另外在进程退出前做一次兜底落盘，
 * 避免「改了设置但没点保存就直接退出」丢数据。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { log } from "./log";

interface StoreFile {
  data: Record<string, unknown>;
  dirty: boolean;
}

const files = new Map<string, StoreFile>();
let dataRoot = "";

/** 指定 store 根目录（应用数据目录）。 */
export function initStore(root: string): void {
  dataRoot = root;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

/**
 * 解析 store 文件路径。
 *
 * 只取文件名部分：渲染进程传来的 `file` 作为 key，不允许它影响目录层级。
 */
function resolveFile(file: string): string {
  const safe = path.basename(file || "store.json");
  return path.join(dataRoot, safe);
}

function load(file: string): StoreFile {
  const key = resolveFile(file);
  const cached = files.get(key);
  if (cached) return cached;

  let entry: StoreFile = { data: {}, dirty: false };
  try {
    if (existsSync(key)) {
      const raw = readFileSync(key, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          entry = { data: parsed as Record<string, unknown>, dirty: false };
        }
      }
    }
  } catch (error) {
    // 文件损坏时不让应用起不来：退化成空 store，并保留原文件供排查
    log.error(`读取 store ${key} 失败，将使用空数据：`, error);
  }
  files.set(key, entry);
  return entry;
}

/** 原子写盘（临时文件 + rename），避免断电/崩溃写出半截 JSON。 */
function persist(file: string): void {
  const key = resolveFile(file);
  const entry = files.get(key);
  if (!entry) return;
  const tmp = `${key}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry.data, null, 2), "utf8");
    renameSync(tmp, key);
    entry.dirty = false;
  } catch (error) {
    log.error(`写入 store ${key} 失败：`, error);
  }
}

/** 进程退出前把所有脏 store 落盘。 */
export function flushAllStores(): void {
  for (const [key, entry] of files) {
    if (!entry.dirty) continue;
    try {
      writeFileSync(key, JSON.stringify(entry.data, null, 2), "utf8");
      entry.dirty = false;
    } catch (error) {
      log.error(`退出前落盘 ${key} 失败：`, error);
    }
  }
}

/** 处理来自渲染进程的 store 操作。 */
export async function handleStore(payload: Record<string, unknown>): Promise<unknown> {
  const file = String(payload.file ?? "store.json");
  const op = String(payload.op ?? "");
  const entry = load(file);
  const key = payload.key === undefined ? undefined : String(payload.key);

  switch (op) {
    case "get": {
      if (key === undefined) return null;
      // 键不存在一律返回 null，调用方无需区分「没有这个键」和「值是 null」
      return Object.prototype.hasOwnProperty.call(entry.data, key) ? entry.data[key] : null;
    }
    case "set": {
      if (key === undefined) throw new Error("store.set 缺少 key");
      entry.data[key] = payload.value ?? null;
      entry.dirty = true;
      return null;
    }
    case "delete": {
      if (key === undefined) return false;
      const existed = Object.prototype.hasOwnProperty.call(entry.data, key);
      delete entry.data[key];
      if (existed) entry.dirty = true;
      return existed;
    }
    case "has":
      return key !== undefined && Object.prototype.hasOwnProperty.call(entry.data, key);
    case "keys":
      return Object.keys(entry.data);
    case "values":
      return Object.values(entry.data);
    case "entries":
      return Object.entries(entry.data);
    case "length":
      return Object.keys(entry.data).length;
    case "clear":
      entry.data = {};
      entry.dirty = true;
      return null;
    case "reset":
      entry.data = {};
      entry.dirty = true;
      persist(file);
      return null;
    case "reload": {
      files.delete(resolveFile(file));
      load(file);
      return null;
    }
    case "save":
      persist(file);
      return null;
    case "close":
      if (entry.dirty) persist(file);
      files.delete(resolveFile(file));
      return null;
    case "path":
      return resolveFile(file);
    default:
      throw new Error(`未知的 store 操作：${op}`);
  }
}
