/**
 * 在线「列表详情」的 **持久化** 缓存（IndexedDB）。
 *
 * ## 它解决什么
 *
 * 在线音乐里点开任何歌单/榜单（网易云歌单、云盘、酷狗排行、每日推荐、
 * 我的歌单…）都会走 `MusicView.vue` 的 `openDetailAsync()`：立即切到详情页并
 * 显示骨架，然后 `await` 一次网络请求。问题是这些请求的缓存**全都是纯内存的**：
 *
 * - `utils/meting.ts` 的 `TtlCache`（15 分钟）
 * - `MusicView.vue` 的 `playlistCache`（进程内 Map）
 * - `stores/netease.ts` 的 `playlistCache`（仅"我的歌单"的元数据）
 * - `rankListCache`（酷狗榜单卡片）
 *
 * 进程一退出全部消失，于是**每次重启后第一次点歌单都要重新转圈**——哪怕昨天
 * 刚打开过。这里补上磁盘那一层，做成「先给旧数据、再后台刷新」。
 *
 * ## 为什么放在 openDetailAsync 这一层
 *
 * 歌单详情有 5 条以上互不相同的取数路径（meting / 网易云 Rust 命令 / 酷狗三个
 * 命令）。在每条路径里各加一次缓存既啰嗦又容易漏。而这些路径最终都汇聚到
 * `openDetailAsync(title, loader)`——**在汇聚点缓存**，一次覆盖全部，
 * 且新增数据源时自动受益。
 *
 * ## 键怎么定
 *
 * 调用方给一个稳定的 cacheKey（不含标题，标题可能被用户重命名）。
 * 见 `MusicView.vue` 各调用点：`meting:netease:playlist:3778678`、
 * `kugou:rank:123`、`netease:cloud` 等。
 *
 * ## 三级读取
 *
 * ```text
 *   L1 内存 Map（本模块，进程内最快）
 *     ↓ 未命中
 *   L2 IndexedDB（本模块，跨重启）
 *     ↓ 未命中 / 未知
 *   L3 网络（各调用方的 loader）
 * ```
 *
 * L2 命中且已过新鲜期时，**先用旧数据返回**，同时在后台跑 loader 刷新
 * （stale-while-revalidate）——所以重启后第一次点也是秒开。
 *
 * ## 为什么用独立数据库
 *
 * `lumiluna` 库被 wordCache / loudnessCache 共用，两者都显式写了「版本号必须
 * 一致，否则第二个 openDb 会触发 onupgradeneeded 挡住对方」
 * （见 loudnessCache.ts:20）。往公共库加 store 要动版本号，风险不划算；
 * 因此沿用 autoMixAnalysis / webdav 的做法——**独占一个库**。
 */
import type { OnlineSong } from "@shared/types";

const DB_NAME = "lumiluna-online-lists";
const STORE = "lists";
/** 结构版本：`songs` 的字段变了就 +1，旧条目会被当作未命中。 */
const VERSION = 1;
/** 条目上限：单条可能几百首，不能无限堆。 */
const MAX_ENTRIES = 60;
/** 新鲜期：这段时间内直接吃缓存，不做后台刷新。 */
export const FRESH_MS = 30 * 60 * 1000;
/**
 * 最长保留：更老的条目直接当未命中。
 *
 * 榜单/歌单会变，但「离线也能看到上次的内容」比「一定是当下最新」更重要；
 * 新鲜度由 FRESH_MS 之后的**后台刷新**保证。
 */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface Entry {
  v: number;
  at: number;
  songs: OnlineSong[];
}

/** L1：进程内缓存（避免同一会话里反复读 IndexedDB）。 */
const memory = new Map<string, { songs: OnlineSong[]; at: number }>();

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // 打开失败要能重试：清掉被拒绝的 promise，下次重新 open
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/**
 * 读缓存（L1 → L2）。
 *
 * 返回 `null` 表示「没有可用数据」；返回数据时附带 `ageMs`，让调用方决定
 * 要不要后台刷新。空列表按未命中处理（空歌单没有展示价值，反而会让用户
 * 以为歌单真的空了）。
 */
export async function listCacheGet(
  key: string,
): Promise<{ songs: OnlineSong[]; ageMs: number } | null> {
  // L1
  const mem = memory.get(key);
  if (mem) {
    const ageMs = Date.now() - mem.at;
    if (ageMs < MAX_AGE_MS) return { songs: mem.songs, ageMs };
    memory.delete(key);
  }

  // L2
  try {
    const db = await openDb();
    const entry = await new Promise<Entry | undefined>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Entry | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!entry || entry.v !== VERSION || !Array.isArray(entry.songs)) return null;
    if (entry.songs.length === 0) return null;
    const ageMs = Date.now() - entry.at;
    if (ageMs >= MAX_AGE_MS) return null;
    // 回填 L1
    memory.set(key, { songs: entry.songs, at: entry.at });
    return { songs: entry.songs, ageMs };
  } catch {
    // 隐私模式 / 配额不足 / 库损坏都不该影响播放，静默降级到网络
    return null;
  }
}

/** 写缓存（L1 + L2）。 */
export async function listCacheSet(key: string, songs: OnlineSong[]): Promise<void> {
  const at = Date.now();
  memory.set(key, { songs, at });
  try {
    const db = await openDb();
    await evictIfNeeded(db);
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ v: VERSION, at, songs } satisfies Entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* 缓存失败不阻塞主流程 */
  }
}

/** 清空全部缓存（设置页「清空缓存」/ 强制刷新用）。 */
export async function listCacheClear(): Promise<void> {
  memory.clear();
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* 失败静默 */
  }
}

/** 超出上限时按写入时间删掉最老的若干条，给新条目腾位置。 */
async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  // 一个只读事务里同时拿 keys 与 values：`tx.oncomplete` 时两者都已填充完毕，
  // 不必各自判断 readyState（那样容易写出竞态）。
  const rows = await new Promise<{ key: string; at: number }[]>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const keys: string[] = [];
    const values: Entry[] = [];
    store.getAllKeys().onsuccess = (e) => {
      keys.push(...((e.target as IDBRequest).result ?? []).map(String));
    };
    store.getAll().onsuccess = (e) => {
      values.push(...(((e.target as IDBRequest).result ?? []) as Entry[]));
    };
    tx.oncomplete = () => resolve(keys.map((k, i) => ({ key: k, at: values[i]?.at ?? 0 })));
    tx.onerror = () => resolve([]);
  });

  if (rows.length < MAX_ENTRIES) return;

  // 按写入时间升序，删够腾出一个位置即可
  const oldest = rows.sort((a, b) => a.at - b.at).slice(0, rows.length - MAX_ENTRIES + 1);

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const { key } of oldest) tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
