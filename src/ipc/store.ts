/**
 * 应用数据存储：应用数据目录下的整文件 JSON 存储。
 *
 * 原来的三个 store（`settings.json` / `audio-effects.json` / `bangumi.json`）
 * 都落在应用数据目录下，位置不变，因此设置、皮肤、扩展数据不会因为这次重构而丢失。
 *
 * 写盘是**显式**的（`save()`），另外主进程在退出前会做一次兜底落盘，
 * 避免「改了设置但没点保存就直接退出」丢数据。
 */
import { callBridge } from "./bridge";

/** JSON 存储句柄。构造参数即落盘文件名。 */
export class JsonStore {
  /** 落盘文件名 */
  readonly path: string;

  constructor(path: string, _options?: unknown) {
    this.path = path;
  }

  /** 读取一个键。文件或键不存在都返回 `null`。 */
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

  /** 条目数 */
  async length(): Promise<number> {
    return callBridge<number>("store", { op: "length", file: this.path });
  }

  /** 清空（不落盘） */
  async clear(): Promise<void> {
    await callBridge("store", { op: "clear", file: this.path });
  }

  /** 清空并立即落盘 */
  async reset(): Promise<void> {
    await callBridge("store", { op: "reset", file: this.path });
  }

  /** 丢弃未保存的改动，从磁盘重读 */
  async reload(): Promise<void> {
    await callBridge("store", { op: "reload", file: this.path });
  }

  /** 落盘 */
  async save(): Promise<void> {
    await callBridge("store", { op: "save", file: this.path });
  }

  /** 落盘并释放句柄 */
  async close(): Promise<void> {
    await callBridge("store", { op: "close", file: this.path });
  }
}

/** 便捷工厂。 */
export function loadStore(path: string, options?: unknown): JsonStore {
  return new JsonStore(path, options);
}

/** 存储文件在磁盘上的绝对路径。 */
export async function resolveStorePath(file: string): Promise<string> {
  return callBridge<string>("store", { op: "path", file });
}
