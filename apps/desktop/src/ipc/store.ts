/**
 * 应用数据存储：应用数据目录下的整文件 JSON 存储。
 *
 * 三份 store（settings.json / audio-effects.json / bangumi.json）都落在应用数据
 * 目录下，位置不变，因此设置、皮肤、扩展数据不会因为这次重构而丢失。
 *
 * Tauri 版走 @tauri-apps/plugin-store。与 Electron 版的语义差异只有一处需要留意：
 * 插件的 `save()` 才落盘，`set()` 只改内存 —— 这与 Electron 版完全一致
 * （Electron 版同样是显式 `save()` + 退出前兜底落盘）。
 *
 * ⚠️ 插件默认把文件放在 `app_data_dir()` 下，与 Rust 侧 `app.path().app_data_dir()`
 * 同源，故 `resolveStorePath()` 的返回可用于诊断。
 */
import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * 把任意值转成 JSON 安全的纯对象。
 *
 * 渲染进程里的设置值大多是 Vue 响应式 Proxy（`ref().value` 的数组 / 对象）。
 * Tauri 走 serde/JSON，Proxy 本身无碍，但 `undefined` / `Map` / `Set` 会静默丢数据，
 * 所以仍在 IPC 边界统一降级成 JSON 快照——store 落盘本来就是 JSON，语义等价、无损。
 */
function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    // 极端情况下（数据本身含循环引用 / 函数）退回原值，交由上层 catch 兜底告警
    return value;
  }
}

/**
 * JSON 存储句柄。构造参数即落盘文件名。
 *
 * 每个实例持有一个 `LazyStore`（插件会按路径缓存），方法签名与 Electron 版一致。
 */
export class JsonStore {
  /** 落盘文件名 */
  readonly path: string;
  private readonly store: LazyStore;

  constructor(path: string, options?: unknown) {
    this.path = path;
    void options;
    // autoSave: 关闭显式 save —— 与 Electron 版「显式 save + 退出兜底」一致，
    // 避免每次 set 都触发一次磁盘写（设置项改动很密集）。
    this.store = new LazyStore(path, { autoSave: false });
  }

  /** 读取一个键。文件或键不存在都返回 `null`。 */
  async get<T>(key: string): Promise<T | null> {
    const value = await this.store.get<T>(key);
    return value ?? null;
  }

  /** 写入一个键（不落盘，需再 `save()`） */
  async set(key: string, value: unknown): Promise<void> {
    await this.store.set(key, toJsonSafe(value));
  }

  /** 删除一个键 */
  async delete(key: string): Promise<boolean> {
    const existed = await this.store.has(key);
    await this.store.delete(key);
    return existed;
  }

  /** 键是否存在 */
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  /** 全部键 */
  async keys(): Promise<string[]> {
    return this.store.keys();
  }

  /** 全部值 */
  async values(): Promise<unknown[]> {
    return this.store.values();
  }

  /** 全部键值对 */
  async entries(): Promise<[string, unknown][]> {
    return this.store.entries();
  }

  /** 条目数 */
  async length(): Promise<number> {
    const keys = await this.store.keys();
    return keys.length;
  }

  /** 清空（不落盘） */
  async clear(): Promise<void> {
    await this.store.clear();
  }

  /** 清空并立即落盘 */
  async reset(): Promise<void> {
    await this.store.clear();
    await this.store.save();
  }

  /** 丢弃未保存的改动，从磁盘重读 */
  async reload(): Promise<void> {
    await this.store.reload();
  }

  /** 落盘 */
  async save(): Promise<void> {
    await this.store.save();
  }

  /** 落盘并释放句柄 */
  async close(): Promise<void> {
    await this.store.save();
    await this.store.close();
  }
}

/** 便捷工厂。 */
export function loadStore(path: string, options?: unknown): JsonStore {
  return new JsonStore(path, options);
}

/**
 * 存储文件在磁盘上的绝对路径。
 *
 * 插件未暴露该能力，这里按 Tauri 的约定（`<app_data_dir>/<file>`）拼出，
 * 仅用于诊断展示。
 */
export async function resolveStorePath(file: string): Promise<string> {
  const { appDataDir, join } = await import("./paths");
  return join(await appDataDir(), file);
}
