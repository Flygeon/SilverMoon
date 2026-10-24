/**
 * 启动游戏 / 唤起 Steam 客户端。
 *
 * ## 为什么用 `steam://` 而不是直接跑 exe
 *
 * 直接 `spawn` 游戏的 exe 会**绕过 Steam**：Steamworks 初始化失败、成就与云存档
 * 不记录、需要 Steam 在线的游戏直接闪退。正确做法是交给 Steam 客户端自己拉起：
 *
 * - `steam://rungameid/<appid>` —— 启动已安装游戏（Steam 负责带上 overlay、成就、云存档）
 * - `steam://install/<appid>`   —— 打开安装对话框
 * - `steam://store/<appid>`     —— 打开商店页
 *
 * 参考实现 `DroidDeck参考/frontend/GameLaunchLink.kt` 同样用
 * `steam://rungameid/<id>` 启动。
 *
 * ## 本应用不做「自己下载」的原因
 *
 * 见 `local.ts` 顶部注释：DroidDeck 能下载是因为它跑的是**官方客户端**；
 * 自行实现 depot 协议需要 CM 长连接，而实测本机 CM WebSocket 被重置。
 * 所以「安装」按钮的行为是**唤起 Steam 客户端**，由 Valve 的代码完成下载。
 */
import { execFile } from "node:child_process";

import { log } from "../log";

/** 允许的 Steam URL 动作（白名单，避免拼出任意 URI）。 */
export type SteamUrlAction = "rungameid" | "install" | "store" | "run";

export interface LaunchResult {
  ok: boolean;
  message?: string | null;
}

/** 校验 appid：必须是正整数，否则不拼 URL。 */
function isValidAppId(appId: unknown): appId is number {
  return typeof appId === "number" && Number.isInteger(appId) && appId > 0 && appId < 1e10;
}

/**
 * 用系统默认处理程序打开一个 `steam://` URL。
 *
 * Windows 用 `cmd /c start`（`start` 是 cmd 内建命令，不能直接 execFile）；
 * macOS 用 `open`；Linux 用 `xdg-open`。
 *
 * 一律 `windowsHide` 且不继承 stdio：这些命令会立刻返回，等待它们没有意义。
 */
function openSteamUrl(url: string): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const onDone = (error: Error | null) => {
      if (error) {
        // 最常见：系统没装 Steam（没有 steam:// 关联）
        const code = (error as { code?: string }).code ?? "";
        log.warn(`[steam] 打开 ${url} 失败：${code || error.message}`);
        resolve({
          ok: false,
          message: "无法唤起 Steam 客户端，请确认已安装 Steam 并已登录",
        });
        return;
      }
      resolve({ ok: true, message: null });
    };

    try {
      if (process.platform === "win32") {
        execFile("cmd", ["/c", "start", "", url], { windowsHide: true, timeout: 10_000 }, onDone);
      } else if (process.platform === "darwin") {
        execFile("open", [url], { windowsHide: true, timeout: 10_000 }, onDone);
      } else {
        execFile("xdg-open", [url], { windowsHide: true, timeout: 10_000 }, onDone);
      }
    } catch (error) {
      onDone(error as Error);
    }
  });
}

/** 启动已安装的游戏。 */
export async function launchGame(appId: number): Promise<LaunchResult> {
  if (!isValidAppId(appId)) return { ok: false, message: "无效的 AppID" };
  return openSteamUrl(`steam://rungameid/${appId}`);
}

/** 唤起 Steam 客户端打开安装对话框（下载交给官方客户端）。 */
export async function installGame(appId: number): Promise<LaunchResult> {
  if (!isValidAppId(appId)) return { ok: false, message: "无效的 AppID" };
  return openSteamUrl(`steam://install/${appId}`);
}

/** 打开商店页（未登录 / 未购买时用）。 */
export async function openStorePage(appId: number): Promise<LaunchResult> {
  if (!isValidAppId(appId)) return { ok: false, message: "无效的 AppID" };
  return openSteamUrl(`steam://store/${appId}`);
}

/**
 * 统一入口：按动作分发。
 *
 * `openInSteam` 的语义是「让 Steam 处理这件事」：已安装就启动，否则打开安装。
 * 前端不需要自己判断，避免两边判定不一致。
 */
export async function openInSteam(appId: number, installed: boolean): Promise<LaunchResult> {
  return installed ? launchGame(appId) : installGame(appId);
}
