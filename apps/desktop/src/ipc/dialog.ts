/**
 * 文件对话框与消息框。
 *
 * Tauri 版走 @tauri-apps/plugin-dialog。返回类型约定与 Electron 版一致：
 * multiple: false 时是 string | null，取消为 null。
 */
import {
  ask as tauriAsk,
  confirm as tauriConfirm,
  message as tauriMessage,
  open as tauriOpen,
  save as tauriSave,
} from "@tauri-apps/plugin-dialog";

/** 文件过滤器 */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** open 的选项 */
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
  multiple?: boolean;
  directory?: boolean;
  recursive?: boolean;
  canCreateDirectories?: boolean;
}

/** save 的选项 */
export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
  canCreateDirectories?: boolean;
}

/**
 * 打开文件 / 目录选择器。
 *
 * - multiple: false（或不传）→ string | null
 * - multiple: true → string[] | null
 */
export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  const result = await tauriOpen({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
    multiple: options.multiple ?? false,
    directory: options.directory ?? false,
    recursive: options.recursive,
    canCreateDirectories: options.canCreateDirectories,
  });
  return (result as string | string[] | null) ?? null;
}

/** 打开保存对话框，返回目标路径（取消为 null）。 */
export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const result = await tauriSave({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
    canCreateDirectories: options.canCreateDirectories,
  });
  return result ?? null;
}

/** 消息框 */
export async function message(
  text: string,
  options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  await tauriMessage(text, { title: options?.title, kind: options?.kind });
}

/** 确认框 */
export async function confirm(text: string, options?: { title?: string }): Promise<boolean> {
  return tauriConfirm(text, { title: options?.title });
}

/** 询问框（是 / 否） */
export async function ask(text: string, options?: { title?: string }): Promise<boolean> {
  return tauriAsk(text, { title: options?.title });
}
