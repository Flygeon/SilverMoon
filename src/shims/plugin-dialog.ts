/**
 * `@tauri-apps/plugin-dialog` 的替身。
 *
 * 业务代码用到 3 处 `open`（选目录 / 选皮肤包 / 选扩展包）与 2 处 `save`
 * （导出主题、导出音效预设）。返回类型保持 Tauri 的约定：
 * `multiple: false` 时是 `string | null`，取消为 `null`。
 */
import { callBridge } from "./bridge";

/** 文件过滤器 */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** `open` 的选项 */
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
  multiple?: boolean;
  directory?: boolean;
  recursive?: boolean;
  canCreateDirectories?: boolean;
}

/** `save` 的选项 */
export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
  canCreateDirectories?: boolean;
}

/**
 * 打开文件 / 目录选择器。
 *
 * - `multiple: false`（或不传）→ `string | null`
 * - `multiple: true` → `string[] | null`
 */
export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  const result = await callBridge<string | string[] | null>("dialog", {
    op: "open",
    options,
  });
  return result ?? null;
}

/** 打开保存对话框，返回目标路径（取消为 `null`）。 */
export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const result = await callBridge<string | null>("dialog", { op: "save", options });
  return result ?? null;
}

/** 消息框（业务代码未使用，保留接口完整性） */
export async function message(
  message: string,
  options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  await callBridge("dialog", { op: "message", message, options: options ?? {} });
}

/** 确认框 */
export async function confirm(message: string, options?: { title?: string }): Promise<boolean> {
  return callBridge<boolean>("dialog", { op: "confirm", message, options: options ?? {} });
}

/** 询问框（是 / 否） */
export async function ask(message: string, options?: { title?: string }): Promise<boolean> {
  return callBridge<boolean>("dialog", { op: "ask", message, options: options ?? {} });
}
