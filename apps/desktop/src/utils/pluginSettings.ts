/**
 * 每个插件自己的设置存储。
 *
 * 扩展通过桥方法 `settings:get` / `settings:set` 读写，宿主把它落在
 * `<appData>/ext-settings.json` 的 **一个键**（键名 = 扩展 id）下，
 * 与主设置（settings.json）彻底分开 —— 扩展的键不该污染主设置、
 * 卸载扩展时也只需删掉那一个键。
 *
 * 默认值来自 manifest 的 `contributes.settings.schema[].default`，
 * 读取时与已存值合并：扩展升级后新增的设置项能立刻拿到自己的默认值。
 */
import { JsonStore } from "@/ipc/store";

const store = new JsonStore("ext-settings.json");

/** schema 里的一项（扩展自解释的开放 JSON，这里只取用得上的字段） */
interface SchemaField {
  key?: unknown;
  default?: unknown;
}

/** 从 manifest 的 settings.schema 里抽出默认值 */
export function defaultsFrom(manifest: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const schema = (manifest as { contributes?: { settings?: { schema?: unknown } } })?.contributes
    ?.settings?.schema;
  if (!Array.isArray(schema)) return out;
  for (const raw of schema) {
    const field = raw as SchemaField;
    if (typeof field?.key !== "string" || field.key === "") continue;
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** 读某扩展的全部设置（默认值打底，已存值覆盖） */
export async function getExtSettings(
  extId: string,
  defaults: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const stored = (await store.get<Record<string, unknown>>(extId)) ?? {};
  return { ...defaults, ...stored };
}

/** 写入某扩展的部分设置（合并，不覆盖其它键） */
export async function setExtSettings(
  extId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const stored = (await store.get<Record<string, unknown>>(extId)) ?? {};
  await store.set(extId, { ...stored, ...values });
  await store.save();
}

/** 扩展卸载时清掉它的设置 */
export async function clearExtSettings(extId: string): Promise<void> {
  await store.delete(extId);
  await store.save();
}
