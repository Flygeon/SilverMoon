/**
 * 凭据加密层（`safeStorage`）。
 *
 * ## 为什么需要它
 *
 * 早期实现把登录态直接以明文 JSON 落在应用数据目录（`kugou.json` /
 * `netease.json` / `pixiv.json` / `bilibili.json` / `settings.json` 里的
 * WebDAV 密码、Bangumi / Pixiv token 等）。任何拿到该目录读权限的人
 * （同步盘、备份、恶意软件、远程协助）都能直接冒用账号。
 *
 * 现在统一改为**整文件加密**：
 * - Windows 走 DPAPI（`safeStorage` 绑定当前用户账户）；
 * - macOS 走 Keychain；
 * - Linux 走 libsecret / KWallet。
 *
 * 密钥由操作系统托管，应用自身不落任何密钥文件。
 *
 * ## 文件格式
 *
 * 加密后是一个 JSON 信封，便于「先判别、再解密」以及版本演进：
 *
 * ```json
 * { "__smEnc": "v1", "data": "<base64 密文>" }
 * ```
 *
 * `__smEnc` 为 `"plain"` 表示系统加密不可用时的降级形态（见 `encryptText`）。
 * 读取端看到没有 `__smEnc` 的普通 JSON 时按**历史明文**处理，并在读入的同时
 * 就地加密写回 —— 这就是「旧数据自动迁移」，用户升级后无需任何操作。
 */
import { safeStorage } from "electron";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { log } from "./log";

/** 当前密文格式版本。变更算法时递增，读端按版本分流。 */
const ENVELOPE_VERSION = "v1";

interface Envelope {
  __smEnc: string;
  data: string;
}

/** 判断文本是否是本模块写出的信封。 */
function parseEnvelope(text: string): Envelope | null {
  const trimmed = text.trim();
  // 快速排除：正常 JSON 对象都以 `{` 开头，这里不做全量解析，避免大文件浪费
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<Envelope> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.__smEnc !== "string") return null;
    if (typeof parsed.data !== "string") return null;
    return { __smEnc: parsed.__smEnc, data: parsed.data };
  } catch {
    return null;
  }
}

/**
 * 系统加密是否可用。
 *
 * Linux 上没有 keyring（headless / 精简发行版）时会返回 false，此时只能降级；
 * 降级**必须显式记录**，不能静默写明文让人误以为已加密。
 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 明文 → 信封 JSON 文本。加密不可用时降级为 `plain` 并告警。 */
export function encryptText(plain: string): string {
  if (!encryptionAvailable()) {
    // 降级仍写成信封（标记 plain），这样「是否加密」在文件里是可见的，
    // 而不是让用户误以为已经安全。
    log.warn("[secure] 系统加密不可用，凭据将以明文（plain 信封）保存");
    return JSON.stringify({ __smEnc: "plain", data: plain } satisfies Envelope);
  }
  const cipher = safeStorage.encryptString(plain);
  return JSON.stringify({
    __smEnc: ENVELOPE_VERSION,
    data: cipher.toString("base64"),
  } satisfies Envelope);
}

/** 信封 JSON 文本 → 明文；无法解密（换机 / 密钥丢失 / 损坏）时返回 null。 */
export function decryptText(text: string): string | null {
  const envelope = parseEnvelope(text);
  if (!envelope) return null;
  if (envelope.__smEnc === "plain") return envelope.data;
  try {
    return safeStorage.decryptString(Buffer.from(envelope.data, "base64"));
  } catch (error) {
    log.error("[secure] 解密失败（可能更换了系统账户或凭据文件已损坏）：", error);
    return null;
  }
}

/** 原子写：临时文件 + rename，避免断电写出半截信封。 */
export function writeEncryptedFile(filePath: string, plain: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, encryptText(plain), "utf8");
  renameSync(tmp, filePath);
}

/**
 * 读取并解密文件。
 *
 * - 文件不存在 → `null`；
 * - 加密信封 → 解密；
 * - **历史明文** → 返回原文，同时就地加密写回（自动迁移）。
 */
export function readEncryptedFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    log.error(`[secure] 读取 ${path.basename(filePath)} 失败：`, error);
    return null;
  }
  if (!raw.trim()) return null;

  const decrypted = decryptText(raw);
  if (decrypted !== null) return decrypted;

  // 不是信封 → 历史明文。返回内容，并立刻加密覆盖（迁移只发生一次）。
  try {
    writeEncryptedFile(filePath, raw);
    log.info(`[secure] 已把 ${path.basename(filePath)} 从明文迁移为加密存储`);
  } catch (error) {
    log.error(`[secure] 迁移 ${path.basename(filePath)} 失败：`, error);
  }
  return raw;
}

/** 删除文件（不存在视为成功）。 */
export function removeFile(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (error) {
    log.warn(`[secure] 删除 ${path.basename(filePath)} 失败：`, error);
  }
}
