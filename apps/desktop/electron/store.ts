/**
 * 键值存储：应用数据目录下的整文件 JSON。
 *
 * 原项目三个 store（`settings.json` / `audio-effects.json` / `bangumi.json`）都落在
 * `app_data_dir()` 下，这里沿用同一位置，保证迁移后设置与原数据完全接得上。
 *
 * 写盘是**显式**的（渲染进程调 `save()`），另外在进程退出前做一次兜底落盘，
 * 避免「改了设置但没点保存就直接退出」丢数据。
 *
 * ## 全部落盘文件都加密
 *
 * 这些文件里有真实凭据：`settings.json` 存 WebDAV 密码、Bangumi / Pixiv token、
 * 弹弹 AppSecret；`bilibili.json` 存 SESSDATA 等 cookie。历史上它们是明文 JSON，
 * 任何能读数据目录的人都能直接冒用账号（见 `secure-store.ts` 的说明）。
 *
 * 现在读写统一走 `readEncryptedFile` / `writeEncryptedFile`：
 * - 首次读到**历史明文**时会就地加密写回（用户升级后无需任何操作）；
 * - 加密不可用时降级为 `plain` 信封，并在日志里显式告警，绝不静默。
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { log } from "./log";
import { readEncryptedFile, writeEncryptedFile } from "./secure-store";
import { writeThemeHint } from "./theme-hint";

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
      // 自动识别信封 / 历史明文；明文会被就地加密写回（一次性迁移）
      const raw = readEncryptedFile(key);
      if (raw && raw.trim()) {
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

/** 原子写盘（先写加密信封到临时文件，再 rename），避免断电/崩溃写出半截文件。 */
function persist(file: string): void {
  const key = resolveFile(file);
  const entry = files.get(key);
  if (!entry) return;
  try {
    writeEncryptedFile(key, JSON.stringify(entry.data, null, 2));
    entry.dirty = false;
  } catch (error) {
    log.error(`写入 store ${key} 失败：`, error);
  }
  // settings.json 被整体加密后，启动器（Rust，明文 JSON 解析）读不到 theme 了；
  // 这里顺手把「最终明暗」写成明文提示文件给它用。见 electron/theme-hint.ts。
  if (path.basename(key) === "settings.json") {
    syncThemeHint(entry.data);
  }
}

/**
 * 把 settings 里的主题偏好同步成启动器可读的明文提示。
 *
 * `theme` 的三个取值与渲染层一致：`light` / `dark` / `system`。
 * `system` 时主进程没有可靠的亮暗来源（那是渲染层的 matchMedia），
 * 因此**不写提示**，让启动器按它自己读到的系统设置判断 —— 与改动前的行为一致。
 * 单模式皮肤会锁定明暗，但那份状态在皮肤文档里，启动器原本也没有考虑，不在此扩展。
 */
function syncThemeHint(data: Record<string, unknown>): void {
  const settings = data.settings as Record<string, unknown> | undefined;
  const raw = settings?.theme;
  if (raw === "dark") writeThemeHint(dataRoot, true);
  else if (raw === "light") writeThemeHint(dataRoot, false);
}

/**
 * 进程退出前把所有脏 store 落盘。
 *
 * 复用 `persist()`（临时文件 + rename 的原子写）而不是直接 `writeFileSync`：
 * 退出路径最容易被打断（关机、强杀、崩溃），直写会留下半截 JSON，下次启动被判为
 * 损坏并退化成空 store —— 等于把用户的设置静默丢掉。
 */
export function flushAllStores(): void {
  for (const [key, entry] of files) {
    if (!entry.dirty) continue;
    persist(key);
  }
}

/**
 * 同步读取某个 store 的键值（主进程启动期用）。
 *
 * 渲染进程还没加载时就要应用网络代理，不能走异步 IPC；store 本身就是
 * 「整文件 JSON + 内存缓存」，直接读缓存即可。
 */
export function readStoreValue(file: string, key: string): unknown {
  return load(file).data[key] ?? null;
}

/** 处理来自渲染进程的 store 操作。 */ export async function handleStore(
  payload: Record<string, unknown>,
): Promise<unknown> {
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
