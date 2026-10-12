/**
 * 阅读器书签：localStorage 持久化，按 bookId 分组。
 *
 * - 在线小说（NovelReader / BookReader text 模式）：bookId = novel aid，locator = 章节 cid（text 模式带页码 `cid:xxx#pN`）
 * - 本地 EPUB：bookId = 文件 path，locator = epubjs CFI
 * - 本地 PDF：bookId = 文件 path，locator = `page:N`
 */
export interface Bookmark {
  id: string;
  bookId: string;
  /** 定位：章节 cid / CFI / page:N / cid:xxx#pN */
  locator: string;
  /** 章节标题或位置描述 */
  title: string;
  createdAt: number;
}

const STORAGE_KEY = "silvermoon.bookmarks.v1";

function loadAll(): Record<string, Bookmark[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    // 只保留形状合法的书签，防脏数据
    const out: Record<string, Bookmark[]> = {};
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) {
        out[k] = (v as Bookmark[]).filter(
          (b) => b && typeof b.id === "string" && typeof b.locator === "string",
        );
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, Bookmark[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* 配额满或隐私模式：静默丢弃 */
  }
}

/** 本书书签，按创建时间倒序 */
export function getBookmarks(bookId: string): Bookmark[] {
  const list = loadAll()[bookId] ?? [];
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 添加书签。同一 locator 只保留一条（重复添加时刷新到顶部），
 * 避免同一章节/位置堆出多条重复书签。
 */
export function addBookmark(bookId: string, data: { locator: string; title: string }): Bookmark {
  const all = loadAll();
  const list = all[bookId] ?? [];
  const now = Date.now();
  const existing = list.find((b) => b.locator === data.locator);
  if (existing) {
    existing.title = data.title || existing.title;
    existing.createdAt = now;
    saveAll(all);
    return existing;
  }
  const bm: Bookmark = {
    id: crypto.randomUUID(),
    bookId,
    locator: data.locator,
    title: data.title,
    createdAt: now,
  };
  list.push(bm);
  all[bookId] = list;
  saveAll(all);
  return bm;
}

export function removeBookmark(bookId: string, id: string): void {
  const all = loadAll();
  const list = all[bookId];
  if (!list) return;
  all[bookId] = list.filter((b) => b.id !== id);
  saveAll(all);
}

/** 按定位删除（用于"已加书签再点一次取消"） */
export function removeBookmarkAt(bookId: string, locator: string): void {
  const all = loadAll();
  const list = all[bookId];
  if (!list) return;
  all[bookId] = list.filter((b) => b.locator !== locator);
  saveAll(all);
}

export function hasBookmark(bookId: string, locator: string): boolean {
  const list = loadAll()[bookId];
  return !!list?.some((b) => b.locator === locator);
}

/** 书签时间展示：今天显示 HH:mm，昨天显示"昨天 HH:mm"，更早显示 M-d HH:mm */
export function formatBookmarkTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
