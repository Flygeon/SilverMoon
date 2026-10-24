/**
 * 给**启动器**（splash）用的主题提示文件。
 *
 * ## 为什么需要它
 *
 * 启动器是 Rust + Win32 的原生程序，在 Electron 起来**之前**就要画出首屏，
 * 因此必须自己判断深浅色。它原来直接读 `settings.json` 的 `settings.theme`。
 *
 * 但 `settings.json` 现在整体被 `safeStorage` 加密（见 `secure-store.ts`：
 * 里面存着 WebDAV 密码、Bangumi / Pixiv token 等凭据），文件内容变成
 * `{"__smEnc":"v1","data":"..."}`。启动器用明文 JSON 解析，拿不到 `settings.theme`，
 * 只能回退到系统亮色 —— 于是**无论用户选深色还是浅色，启动器永远白底**。
 *
 * 让启动器去复刻 Chromium 的 OSCrypt（v10 信封 + DPAPI）既繁琐又脆弱：
 * 那是一层会随 Chromium 版本变化的实现细节。更稳的做法是**由主进程把结论写出来**：
 * 主题不是凭据，单独落一个明文小文件完全没有泄露风险。
 *
 * ## 文件契约（必须与 `splash/src/prefs.rs` 保持一致）
 *
 * ```json
 * { "dark": true }
 * ```
 *
 * 启动器读不到 / 解析失败时回退系统亮暗，行为与之前一致。
 */
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";

import { log } from "./log";

/** 文件名（放在应用数据目录下，与 settings.json 同级）。 */
export const THEME_HINT_FILE = "theme-hint.json";

/**
 * 写入当前生效的明暗。
 *
 * 用「临时文件 + rename」原子替换：启动器可能在任意时刻读它，
 * 读到半个文件会解析失败并回退（可接受），但让这种情况尽量不发生更好。
 */
export function writeThemeHint(dataDir: string, dark: boolean): void {
  if (!dataDir) return;
  const target = path.join(dataDir, THEME_HINT_FILE);
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ dark }), "utf8");
    renameSync(tmp, target);
  } catch (error) {
    // 写不出提示只是「下次启动首屏颜色可能不对」，绝不能让设置保存失败
    log.warn("[theme] 写入启动器主题提示失败：", error);
  }
}
