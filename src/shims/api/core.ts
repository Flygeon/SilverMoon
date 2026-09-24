/**
 * `@tauri-apps/api/core` 的替身。
 *
 * 只实现业务代码真正用到的两个导出：
 * - `invoke` —— 转发到 Rust 侧车命令服务
 * - `convertFileSrc` —— 把本地路径转成 `asset://` URL，由 Electron 自定义协议代理
 */
import { invokeCommand } from "../bridge";

/**
 * 调用 Rust 侧车命令。
 *
 * 与 Tauri 的语义差异：Tauri 的 `args` 键是 camelCase 且会被自动映射到 Rust 的
 * snake_case 形参。这里保持**同样的键名约定**——由兼容层的 `#[command]` 宏在
 * Rust 侧完成映射，所以调用方无需改动。
 */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(cmd, args);
}

/**
 * 本地文件路径 → 可被 `<img>` / `<video>` / `<iframe>` / CSS `url()` 直接消费的 URL。
 *
 * 生成的 `asset://localhost/<path>` 由 Electron 主进程的 `asset:` 协议处理器
 * 映射到磁盘文件，并支持 Range 请求（音视频拖动进度）。
 *
 * 返回串以 `asset:` 开头，满足皮肤加载器里 `^(https?:|data:|asset:|blob:)` 的
 * 幂等白名单判断。
 */
export function convertFileSrc(filePath: string, protocol = "asset"): string {
  if (!filePath) return "";
  // 已是 URL 则原样返回，避免二次包装
  if (/^(https?:|data:|blob:|asset:|app:)/i.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${protocol}://localhost/${encoded}`;
}
