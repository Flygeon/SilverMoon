/**
 * `webUtils.getPathForFile()` 的兼容取路径。
 *
 * `webUtils` 是 Electron 29 引入的（当时 `File.path` 被移除）。Electron 22 上
 * `require("electron").webUtils === undefined`（已实测），但 **`File.path` 还在**，
 * 所以拖放功能在两个版本上都能工作，只是取法不同。
 *
 * 刻意不引 undici / node 内置：本模块会被打进 **preload.cjs**，
 * preload 上下文里塞网络栈既没必要也拖慢窗口创建。
 */
import * as electron from "electron";

/** 与 `webUtils.getPathForFile` 同签名；取不到时返回空串。 */
export function getPathForFile(file: File): string {
  const utils = (electron as { webUtils?: { getPathForFile?: (f: File) => string } }).webUtils;
  if (utils && typeof utils.getPathForFile === "function") {
    return utils.getPathForFile(file);
  }
  // Electron 22 老路径：File 上还挂着真实路径
  return (file as unknown as { path?: string }).path ?? "";
}
