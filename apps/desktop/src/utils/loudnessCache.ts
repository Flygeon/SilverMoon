/**
 * 响度测量的 IndexedDB 缓存。
 *
 * 沿用逐字缓存那套（`lumiluna` 库、独立 object store、`v` 版本号 + 失败即降级），
 * 差别只在于 value 极小（一个数字）所以不存在逐字缓存那种"无上限增长"的问题。
 * key = `local:<fileId>` / `online:<id>`，与 wordCache 的语义保持一致。
 */
import type { LoudnessSource } from "./loudnessAnalysis";

const DB_NAME = "lumiluna";
const STORE = "loudness";
/** 结构版本：将来测量方法变了就 +1，旧缓存自然失效（不会被误用）。 */
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // ⚠️ 这里的版本号必须与 wordCache 保持一致，否则第二个 openDb 会触发
    // onupgradeneeded 并可能挡住对方的 store 创建。两者都只在 "store 不存在时" 建。
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 缓存 key：本地用 fileId，在线用服务端+id（与 wordCache 同构）。 */
export function cacheKeyFor(key: string, source: LoudnessSource): string {
  if (source.kind === "local") return `local:${source.filePath ?? key}`;
  return `online:${key}`;
}

export async function loudnessCacheGet(cacheKey: string): Promise<number | null> {
  try {
    const db = await openDb();
    return await new Promise<number | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(cacheKey);
      req.onsuccess = () => {
        const data = req.result;
        if (data && data.v === VERSION && typeof data.lufs === "number") {
          resolve(data.lufs as number);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function loudnessCacheSet(cacheKey: string, lufs: number): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ v: VERSION, lufs }, cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 缓存失败不阻塞主流程 */
  }
}
