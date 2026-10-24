/**
 * Steam 相关设置的持久化（安装目录、自定义库目录）。
 *
 * ## 为什么单独一个文件
 *
 * `settings.json` 是渲染层的大对象（几十个设置项），主进程只关心「Steam 装在哪」。
 * 放这里而不是塞进 settings：主进程在**界面还没起来**时就要能读它
 * （例如导入/启动前解析库），走渲染层的 store 通道既慢又绕。
 *
 * 文件内容**不是凭据**（只有路径），因此用明文 JSON —— 与 `theme-hint.json` 同理。
 * 但为了与其它数据文件风格一致，仍然放在应用数据目录下。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

import { discoverSteamRoot } from "./local";

/**
 * 可注入的日志器。
 *
 * 不直接 `import { log } from "../log"`：那样会把本模块绑死在 Electron 上，
 * 验证脚本（不加载 Electron）就无法 import 它。与 protocol.ts 同一处理。
 */
export interface SteamSettingsOptions {
  log?: (message: string, ...detail: unknown[]) => void;
}

let logger: SteamSettingsOptions["log"] = undefined;

/** 宿主启动时注入真实 logger（见 electron/steam/index.ts）。 */
export function setSettingsLogger(fn: SteamSettingsOptions["log"]): void {
  logger = fn;
}

export interface SteamSettings {
  /** 用户手动添加的库/安装根目录（可多个）。 */
  customRoots: string[];
}

const FILE_NAME = "steam-settings.json";

function settingsPath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/** 读设置；不存在或损坏都返回空设置。 */
export function readSteamSettings(dataDir: string): SteamSettings {
  if (!dataDir) return { customRoots: [] };
  const file = settingsPath(dataDir);
  if (!existsSync(file)) return { customRoots: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SteamSettings> | null;
    const roots = Array.isArray(parsed?.customRoots)
      ? parsed.customRoots.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      : [];
    return { customRoots: roots };
  } catch (error) {
    logger?.("[steam] 读取 steam-settings.json 失败，按空设置处理", error);
    return { customRoots: [] };
  }
}

/** 写设置（原子替换）。 */
export function writeSteamSettings(dataDir: string, settings: SteamSettings): void {
  if (!dataDir) return;
  const file = settingsPath(dataDir);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (error) {
    logger?.("[steam] 写入 steam-settings.json 失败", error);
  }
}

/** 汇总给前端的设置状态（含自动识别的结果）。 */
export interface SteamSettingsState {
  steamRoot?: string | null;
  customRoots: string[];
  /** 是否自动识别到了（而不是靠用户手动添加） */
  detected: boolean;
}

export function steamSettingsState(dataDir: string): SteamSettingsState {
  const settings = readSteamSettings(dataDir);
  const { root } = discoverSteamRoot(settings.customRoots);
  return {
    steamRoot: root,
    customRoots: settings.customRoots,
    detected: Boolean(root),
  };
}

/** 更新设置（只合并传入的字段）。 */
export function updateSteamSettings(
  dataDir: string,
  patch: Partial<SteamSettings>,
): SteamSettingsState {
  const current = readSteamSettings(dataDir);
  const next: SteamSettings = {
    customRoots: patch.customRoots ?? current.customRoots,
  };
  // 去重 + 去空
  const seen = new Set<string>();
  next.customRoots = next.customRoots.filter((r) => {
    const key = r.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  writeSteamSettings(dataDir, next);
  return steamSettingsState(dataDir);
}
