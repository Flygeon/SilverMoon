/**
 * B 站观看进度的**本地**存档（localStorage）。
 *
 * ## 为什么需要它
 *
 * 项目原先只依赖服务端 `last_play`（`biliLastPlay`）续播，而那条链路有两个
 * 硬性前提：**已登录** + 接口没被风控。未登录、登录过期、或 /x/player/v2
 * 被 -352 拦掉时，续播会静默失效 —— 用户看到的就是「每次进来都从头播」。
 *
 * 这里用本地存档兜底：
 * - 与服务端进度取**较大值**合并（两边都可能是更靠后的真实进度）；
 * - 以 `bvid + cid` 为键，多分 P 视频每个分 P 各存一份；
 * - 额外记录「每个视频最后看的是哪个分 P」，下次进入多分 P 视频能直接切回去。
 *
 * ## 为什么是 localStorage
 *
 * 进度只是一个「秒数 + 时间戳」的小表（上限 300 条），没有检索需求，
 * 也不值得为它单开一张表 / 走一次 IPC。读写都在渲染进程同步完成；
 * 写失败（隐私模式 / 配额满）一律静默降级，不能影响播放。
 */

/** 单条进度记录：秒数 + 最后更新时间（ms）。 */
interface ProgressEntry {
  /** 播放到的秒数 */
  s: number;
  /** 最后写入时间戳，用于淘汰旧记录 */
  at: number;
}

/** 整张存档表。 */
interface ProgressStore {
  /** 版本号：将来结构变更时直接丢弃旧数据，避免解析出脏值 */
  v: 1;
  /** bvid → 最后观看的 cid */
  last: Record<string, string>;
  /** `${bvid}\u0000${cid}` → 进度 */
  items: Record<string, ProgressEntry>;
}

const STORAGE_KEY = "silvermoon:biliProgress";
/** 最多保留多少条视频进度（超出按最后更新时间淘汰） */
const MAX_ENTRIES = 300;
/** 超过该时长的记录视为过期（90 天） */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function emptyStore(): ProgressStore {
  return { v: 1, last: {}, items: {} };
}

function entryKey(bvid: string, cid: string): string {
  return `${bvid}\u0000${cid}`;
}

/** 读存档；任何异常（无 localStorage / JSON 损坏 / 结构不符）都当作空表。 */
function readStore(): ProgressStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<ProgressStore> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.items !== "object") return emptyStore();
    return {
      v: 1,
      last: parsed.last && typeof parsed.last === "object" ? { ...parsed.last } : {},
      items: parsed.items && typeof parsed.items === "object" ? { ...parsed.items } : {},
    };
  } catch {
    return emptyStore();
  }
}

/** 写存档；配额满 / 隐私模式静默失败（只影响续播，不影响播放）。 */
function writeStore(store: ProgressStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 忽略：进度是锦上添花 */
  }
}

/** 丢弃过期与被挤出上限的记录，避免存档无限膨胀。 */
function prune(store: ProgressStore): void {
  const now = Date.now();
  const rows = Object.entries(store.items);
  for (const [key, entry] of rows) {
    if (!entry || typeof entry.s !== "number" || !Number.isFinite(entry.s)) {
      delete store.items[key];
      continue;
    }
    if (now - entry.at > MAX_AGE_MS) delete store.items[key];
  }
  const rest = Object.entries(store.items);
  if (rest.length <= MAX_ENTRIES) return;
  rest.sort((a, b) => b[1].at - a[1].at);
  for (const [key] of rest.slice(MAX_ENTRIES)) delete store.items[key];
}

/** 读取某个分 P 的本地进度（秒）；没有记录返回 0。 */
export function getLocalProgress(bvid: string, cid: string): number {
  if (!bvid || !cid) return 0;
  const entry = readStore().items[entryKey(bvid, cid)];
  const seconds = entry?.s;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** 读取该视频最后观看的分 P cid；没有记录返回空串。 */
export function getLastCid(bvid: string): string {
  if (!bvid) return "";
  const cid = readStore().last[bvid];
  return typeof cid === "string" ? cid : "";
}

/**
 * 写入一个分 P 的本地进度。
 *
 * 秒数 <= 0 不写（刚打开就上报 0 会把上一次的续播点清掉）。写成功返回 true，
 * 便于调用方在需要时判断（当前调用方都忽略返回值）。
 */
export function saveLocalProgress(bvid: string, cid: string, seconds: number): boolean {
  if (!bvid || !cid) return false;
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  const store = readStore();
  store.items[entryKey(bvid, cid)] = { s: Math.floor(seconds), at: Date.now() };
  store.last[bvid] = cid;
  prune(store);
  writeStore(store);
  return true;
}

/** 清掉某个视频的全部本地进度（「从头播放」类操作可调用）。 */
export function clearLocalProgress(bvid: string): void {
  if (!bvid) return;
  const store = readStore();
  for (const key of Object.keys(store.items)) {
    if (key.startsWith(`${bvid}\u0000`)) delete store.items[key];
  }
  delete store.last[bvid];
  writeStore(store);
}
