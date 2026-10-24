/**
 * **CM 登录凭据**的独立存储。
 *
 * ## 为什么要和网页登录的 session 分开
 *
 * 两者拿到的 token **受众不同**（实测见 doc/LOG.md）：
 *
 * | 来源 | 用途 | 能登 CM |
 * |---|---|---|
 * | 网页扫码（`electron/steam/protocol.ts`） | 游戏库 / 详情 / 成就（WebAPI） | ❌ |
 * | CM 扫码（此处，来自 `Authentication.BeginAuthSessionViaQR` over CM） | CM logon → 下载 | ✅ |
 *
 * 网页 token 传给 CM 会被 Steam 回 `invalid credentials`，所以下载必须用这里存的。
 * 分成两个文件而不是塞进同一个 session：语义不同、失效时机不同，
 * 混在一起会让"我明明登录了为什么下载说没登录"变得无解。
 *
 * ## 安全
 *
 * refresh_token 等同密码，与 session 一样走 safeStorage 加密落盘
 * （`writeEncryptedFile` / `readEncryptedFile`），绝不写成明文。
 */
import { existsSync } from "node:fs";

import { readEncryptedFile, removeFile, writeEncryptedFile } from "../secure-store";

/** 落盘文件名（在应用数据目录下） */
export const CM_TOKEN_FILE = "steam-cm.json";

export interface CmTokenRecord {
  /** Steam 账号名（CM logon 需要它与 token 匹配） */
  accountName: string;
  /** CM 侧扫码得到的 refresh_token（`iss=steam`，可登 CM） */
  refreshToken: string;
  /** 保存时间（毫秒），仅用于展示/排查 */
  savedAt: number;
}

/** 读取已保存的 CM 凭据；文件不存在或解密失败都返回 null。 */
export function readCmToken(filePath: string): CmTokenRecord | null {
  if (!existsSync(filePath)) return null;
  const text = readEncryptedFile(filePath);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<CmTokenRecord>;
    const accountName = String(parsed.accountName ?? "");
    const refreshToken = String(parsed.refreshToken ?? "");
    if (!accountName || !refreshToken) return null;
    return {
      accountName,
      refreshToken,
      savedAt: Number(parsed.savedAt ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

/** 保存 CM 凭据（覆盖写）。 */
export function writeCmToken(filePath: string, record: CmTokenRecord): void {
  writeEncryptedFile(filePath, JSON.stringify(record));
}

/** 清除 CM 凭据（退出登录时调用）。 */
export function clearCmToken(filePath: string): void {
  removeFile(filePath);
}
