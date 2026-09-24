/**
 * `@tauri-apps/plugin-store` 的替身。
 *
 * 三个 `LazyStore` 实例（`settings.json` / `audio-effects.json` / `bangumi.json`）
 * 落盘在应用数据目录下，与 Rust 侧车的 `app_data_dir()` 同一处，
 * 因此设置、皮肤、扩展数据都不会因为迁移而丢失。
 *
 * 主进程侧用一个 `StoreFile` 实现：整文件 JSON 读写 + 串行化写盘。
 */
import { callBridge } from "./bridge";

/** 存储实例。 */
export class LazyStore {
  /** 落盘文件名（构造参数） */
  readonly path: string;

  constructor(path: string, _options?: unknown) {
    this.path = path;
  }

  /**
   * 读取一个键。
   *
   * 与 Tauri 一致：**文件不存在或键不存在都返回 `null`**（调用方均做了判空）。
   */
  async get<T>(key: string): Promise<T | null> {
    const value = await callBridge<T | null>("store", { op: "get", file: this.path, key });
    return value ?? null;
  }

  /** 写入一个键（不落盘，需再 `save()`） */
  async set(key: string, value: unknown): Promise<void> {
    await callBridge("store", { op: "set", file: this.path, key, value });
  }

  /** 删除一个键 */
  async delete(key: string): Promise<boolean> {
    return callBridge<boolean>("store", { op: "delete", file: this.path, key });
  }

  /** 键是否存在 */
  async has(key: string): Promise<boolean> {
    return callBridge<boolean>("store", { op: "has", file: this.path, key });
  }

  /** 全部键 */
  async keys(): Promise<string[]> {
    return callBridge<string[]>("store", { op: "keys", file: this.path });
  }

  /** 全部值 */
  async values(): Promise<unknown[]> {
    return callBridge<unknown[]>("store", { op: "values", file: this.path });
  }

  /** 全部键值对 */
  async entries(): Promise<[string, unknown][]> {
    return callBridge<[string, unknown][]>("store", { op: "entries", file: this.path });
  }

  /** 长度 */
  async length(): Promise<number> {
    return callBridge<number>("store", { op: "length", file: this.path });
  }

  /** 清空 */
  async clear(): Promise<void> {
    await callBridge("store", { op: "clear", file: this.path });
  }

  /** 重置为初始状态（清空 + 立即落盘） */
  async reset(): Promise<void> {
    await callBridge("store", { op: "reset", file: this.path });
  }

  /** 丢弃未保存的改动 */
  async reload(): Promise<void> {
    await callBridge("store", { op: "reload", file: this.path });
  }

  /** 落盘 */
  async save(): Promise<void> {
    await callBridge("store", { op: "save", file: this.path });
  }

  /** 关闭（无资源需要释放，保留接口） */
  async close(): Promise<void> {
    await callBridge("store", { op: "close", file: this.path });
  }
}

/** 便捷工厂，语义同 `new LazyStore(path)`。 */
export function load(path: string, options?: unknown): LazyStore {
  return new LazyStore(path, options);
}

/** 存储文件在磁盘上的路径 */
export async function resolveStorePath(file: string): Promise<string> {
  return callBridge<string>("store", { op: "path", file });
}
