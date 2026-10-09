/**
 * 首屏列表的本地缓存（localStorage）。
 *
 * ## 为什么需要
 *
 * library.refresh() 首屏要等 listFiles + countFiles **两次 IPC 往返**
 * （实测约 600ms），这段时间网格是骨头屏。把上一次的首屏数据留在本地，
 * 启动时**同步**读回，网格立刻就有真实内容；随后的刷新交给
 * library.refresh 既有的 stale-while-revalidate 原地替换。
 *
 * ## 为什么是 localStorage 而不是 IndexedDB
 *
 * IndexedDB 是异步的：读出来至少要等一个事务往返，首帧根本来不及用上。
 * 这里的数据量很小（一页 = PAGE_SIZE 条，实测几十 KB），同步读的代价可接受。
 * 应用其它缓存（词库、在线歌词、封面）仍然走 IndexedDB，与此不冲突。
 *
 * ## 容量与降级
 *
 * - 只存**首屏那一页**，不存全库（全库可能有几万条）；
 * - 写入超限（QuotaExceededError）时静默放弃并清掉旧值；
 * - 读取解析失败一律当作没有缓存。
 * 三条都是「缓存可以失效，但不能影响功能」。
 */
import type { MediaEntry } from "@shared/types";

const KEY = "silvermoon:firstscreen:v1";
/** 单次写入上限：超过就不缓存，避免把 localStorage 撑爆拖累其它功能。 */
const MAX_BYTES = 1_500_000;

interface CachedType {
  /** 写入时间（毫秒时间戳），仅用于诊断 */
  at: number;
  /** 该类型的总条数（工具栏显示用） */
  total: number;
  entries: MediaEntry[];
}

type CachedMap = Record<string, CachedType>;

/** 进程内镜像：避免同一会话里反复 JSON.parse。 */
let memory: CachedMap | null = null;

function read(): CachedMap {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    memory = parsed && typeof parsed === "object" ? (parsed as CachedMap) : {};
  } catch {
    memory = {};
  }
  return memory;
}

/** 取某类型的首屏缓存；没有或不合法返回 null。 */
export function firstScreenGet(type: string): { entries: MediaEntry[]; total: number } | null {
  const hit = read()[type];
  if (!hit || !Array.isArray(hit.entries) || hit.entries.length === 0) return null;
  const total = typeof hit.total === "number" ? hit.total : hit.entries.length;
  return { entries: hit.entries, total };
}

/** 写入某类型的首屏缓存（失败静默）。 */
export function firstScreenSet(type: string, entries: MediaEntry[], total: number): void {
  if (entries.length === 0) return;
  const map = read();
  map[type] = { at: Date.now(), total, entries };
  persist(map);
}

/** 清空全部首屏缓存（媒体库被清空 / 换库时用）。 */
export function firstScreenClear(): void {
  memory = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

function persist(map: CachedMap): void {
  let text: string;
  try {
    text = JSON.stringify(map);
  } catch {
    return;
  }
  if (text.length > MAX_BYTES) {
    // 太大就整体放弃缓存：宁可每次等一次往返，也不要撑爆 localStorage
    // 影响别的功能（配额是**按源**共享的）。
    firstScreenClear();
    return;
  }
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* 配额不足 / 隐私模式：放弃缓存，不影响功能 */
  }
}
