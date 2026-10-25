/**
 * Steam 能力的宿主适配层。
 *
 * 把 `./protocol` 的纯协议实现接到 Electron 上：
 * - 网络用 **Electron `net.fetch`**（Chromium 网络栈），因此遵守「设置 → 网络」的
 *   代理配置。这是必需的：Node 全局 `fetch`（undici）**不读**系统代理，也不吃
 *   `session.setProxy` —— 项目里已经因为这个原因把所有抓取改成了 `net.fetch`
 *   （见 electron/net-proxy.ts 顶部注释）。
 * - 存储用 `./secure-store`（`safeStorage`：Windows DPAPI / macOS Keychain /
 *   Linux libsecret），refresh_token 与游戏库缓存都以加密信封落盘。
 *
 * ## 为什么 Steam 协议在 Node 侧而不是 Rust 后端
 *
 * 本机没有 MSVC 链接器，Rust 后端连 `cargo check` 都无法执行（build script 也要
 * 链接），只能等 CI（约 20 分钟一轮）。而 Steam 的 CM WebSocket 在本机被网络重置，
 * 能用的只有纯 HTTPS WebAPI —— 两条路能拿到的能力集合相同，Node 侧却可以当场
 * 验证（`npm run verify:steam` 真打 Steam 接口）。详见 `doc/LOG.md`。
 */
import { net } from "electron";
import path from "node:path";

import { log } from "../log";
import { readEncryptedFile, writeEncryptedFile, removeFile } from "../secure-store";
import { existsSync } from "node:fs";
import { findInstalled, type SteamInstalledGame } from "./local";
import { readSteamSettings, setSettingsLogger } from "./settings";

// settings 模块不直接依赖 Electron 的 log（保持可被验证脚本 import），这里注入
setSettingsLogger((message, ...detail) => log.warn(message, ...detail));
import type { SteamAchievements, SteamAppDetails } from "./protocol";
import { SteamProtocol, SteamError, type SteamAuthState, type SteamStorage } from "./protocol";

export * from "./protocol";
export * from "./local";
export * from "./launch";
export * from "./settings";

/** `safeStorage` 加密的存储适配器。 */
function secureStorage(): SteamStorage {
  return {
    read(file) {
      return readEncryptedFile(file);
    },
    write(file, text) {
      writeEncryptedFile(file, text);
    },
    remove(file) {
      removeFile(file);
    },
    exists(file) {
      return existsSync(file);
    },
  };
}

let instance: SteamProtocol | null = null;

/** 取得（或创建）Steam 协议单例。登录态是进程级的，多窗口共享。 */
export function getSteam(dataDir: string): SteamProtocol {
  if (!instance) {
    instance = new SteamProtocol({
      // 会话与库缓存都放数据根目录，与 Rust 侧 app_data_dir() 同处
      sessionFile: path.join(dataDir, "steam-session.json"),
      libraryFile: path.join(dataDir, "steam-library.json"),
      storage: secureStorage(),
      // 关键：用 Chromium 网络栈，代理设置才生效
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        net.fetch(typeof input === "string" ? input : String(input), init)) as typeof fetch,
      log: (message, ...detail) => log.warn(message, ...detail),
    });
    log.info("[steam] 协议层已初始化");
  }
  return instance;
}

/**
 * 详情页的一次性聚合：商店详情 + 本地安装信息 + 成就，并行拉取。
 *
 * 为什么在宿主侧聚合而不是让前端发三次：详情页每次进入都要这三份数据，
 * 三次往返会让首屏明显变慢；且三者中任何一份失败都不应拖垮整页，
 * 所以这里各自降级、永不整体失败。
 */
export async function getGameDetail(
  steam: SteamProtocol,
  dataDir: string,
  appId: number,
): Promise<{
  appId: number;
  details: SteamAppDetails | null;
  local: SteamInstalledGame | null;
  achievements: SteamAchievements | null;
}> {
  const settings = readSteamSettings(dataDir);
  const [details, local, achievements] = await Promise.all([
    steam
      .fetchAppDetails([appId])
      .then((r) => r[String(appId)] ?? null)
      .catch(() => null),
    Promise.resolve(findInstalled(appId, settings.customRoots, dataDir)),
    steam.fetchAchievements(appId).catch(() => null),
  ]);
  return { appId, details, local, achievements };
}

/** 主动发起登录时的统一状态包装：异常转成 `failed` 状态，避免前端拿到裸 reject。 */
export async function guardAuth(run: () => Promise<SteamAuthState>): Promise<SteamAuthState> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SteamError) {
      return { state: "failed", message: error.message };
    }
    const message = (error as Error)?.message ?? String(error);
    log.warn("[steam] 登录流程异常：", message);
    return { state: "failed", message: `登录失败：${message}` };
  }
}
