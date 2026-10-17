/**
 * 番茄（番茄小说 / fqnovel）内容源的取数与归一化。
 *
 * 数据来自独立的 `silvermoon-fqapi` sidecar（stdio 行 JSON），字段名与
 * SilverMoon 内部的 `Novel*` 类型完全不同，所以这里做一层映射：
 *
 * | SilverMoon   | 番茄上游            |
 * |--------------|---------------------|
 * | `aid`        | `book_id`           |
 * | `imageUrl`   | `thumb_url`         |
 * | `introduce`  | `abstract`          |
 * | `tags`       | `category` / `tags` |
 * | `cid`        | `item_id`           |
 *
 * 归一化放在渲染层而不是 sidecar 里，因为它服务的是**这个前端**的形状；
 * sidecar 保持「上游原样 + 少量必要清洗」，两类消费者（小说 / 短剧 / 漫画）
 * 各取所需。
 */
import { capabilities } from "@/capabilities";
import type { NovelCover, NovelDetail, NovelChapter, NovelVolume } from "@shared/types";

/** 上游搜索里的单条记录（只列出用到的字段）。 */
interface RawSearchItem {
  book_id?: string | number;
  title?: string;
  /** 推荐/榜接口的书名用这个字段（搜索接口用 title） */
  book_name?: string;
  author?: string;
  thumb_url?: string;
  abstract?: string;
  category?: string;
  creation_status?: string | number;
  score?: string;
  tags?: string;
  word_number?: string | number;
  last_chapter_title?: string;
}

interface RawSearchData {
  ret_data?: RawSearchItem[];
  offset?: number;
  has_more?: boolean;
  search_id?: string;
}

interface RawBookDetail {
  book_id?: string | number;
  book_name?: string;
  author?: string;
  abstract?: string;
  thumb_url?: string;
  category?: string;
  tags?: string[];
  creation_status?: string | number;
  word_number?: string | number;
  last_chapter_title?: string;
  score?: string;
}

interface RawDirectoryItem {
  item_id?: string | number;
  title?: string;
  volume_name?: string;
  is_vip?: boolean;
}

interface RawDirectoryData {
  /** 扁平章节表（常见） */
  item_data_list?: RawDirectoryItem[];
  /** 分组章节表（部分书有） */
  volume_list?: {
    volume_name?: string;
    chapter_list?: RawDirectoryItem[];
  }[];
  book_info?: RawBookDetail;
}

/** sidecar 的响应包装。 */
interface SidecarFrame<T> {
  id?: number;
  status?: number;
  body?: { code?: number; data?: T; message?: string };
  error?: string;
}

/**
 * 剥掉 sidecar 的传输层包装，拿到上游业务体。
 *
 * 上游惯用 HTTP 200 + `code` 字段表达业务错误，必须在这里判掉，
 * 否则前端会拿到一个「成功但空」的结果。
 */
function unwrap<T>(frame: SidecarFrame<T>): T {
  if (frame.error) throw new Error(frame.error);
  const body = frame.body;
  if (!body) throw new Error("番茄内容源返回空响应");
  if (typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
    throw new Error(body.message || `上游返回错误码 ${body.code}`);
  }
  return body.data as T;
}

function toStr(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

/**
 * 剥掉上游的关键词高亮标记。
 *
 * 搜索接口返回的标题**自带 `<em>`**（如 `"<em>剑来</em>仙<em>剑</em>"`），
 * 那是给网页渲染用的。直接塞进 UI 会连标签一起显示出来。
 */
function stripHighlight(s: string): string {
  return s
    .replace(/<\/?em>/gi, "")
    .replace(/<\/?strong>/gi, "")
    .trim();
}

/**
 * 上游的 `tags` 是**逗号分隔的字符串**（如 `"东方仙侠,玄幻,武侠"`），不是数组。
 *
 * 踩过的坑：当成数组展开会把每个字符各占一项，界面上出现
 * `悬疑脑洞,/悬/疑/脑/洞` 这种荒谬的分类行。这里按逗号切分并去重去空。
 */
function splitTags(raw: unknown): string[] {
  const list: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) list.push(...splitTags(item));
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[,，、|]/)) {
      const t = part.trim();
      if (t) list.push(t);
    }
  }
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

/** 上游封面走 CDN，带鉴权参数，`<img>` 直接引用即可（不需要 Referer 伪装）。 */
function coverUrl(raw: string | undefined): string {
  const u = (raw ?? "").trim();
  if (!u) return "";
  // 上游偶尔给 protocol-relative
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}

function itemToCover(item: RawSearchItem): NovelCover {
  // 搜索接口给 `title`，推荐/榜接口给 `book_name` —— 两者都要认，
  // 否则推荐流整页「（无标题）」。
  const rawTitle = item.title ?? item.book_name ?? "";
  return {
    aid: toStr(item.book_id),
    title: stripHighlight(toStr(rawTitle)) || "（无标题）",
    imageUrl: coverUrl(item.thumb_url),
    author: stripHighlight(toStr(item.author)) || null,
  };
}

/** 搜索。返回列表 + 是否还有下一页（上游用 offset 游标）。 */
export async function fqapiSearch(
  keyword: string,
  offset = "",
): Promise<{ covers: NovelCover[]; hasMore: boolean; nextOffset: string }> {
  const query = new URLSearchParams({ query: keyword });
  if (offset) query.set("offset", offset);
  const frame = await capabilities.fqapi<SidecarFrame<RawSearchData>>({
    path: "/api/v1/search/fanqie",
    query: query.toString(),
  });
  const data = unwrap(frame);
  const items = data?.ret_data ?? [];
  return {
    covers: items.map(itemToCover).filter((c) => c.aid),
    hasMore: !!data?.has_more,
    nextOffset: toStr(data?.offset),
  };
}

/** 书籍详情。 */
export async function fqapiDetail(bookId: string): Promise<NovelDetail> {
  const frame = await capabilities.fqapi<SidecarFrame<RawBookDetail>>({
    path: `/api/v1/books/${encodeURIComponent(bookId)}`,
  });
  const d = unwrap(frame);
  const statusRaw = toStr(d?.creation_status);
  // category 是单个分类，tags 是逗号串；合并去重后作为标签。
  // 顺序：先分类，再标签 —— 分类更有信息量，放前面。
  const tags = splitTags([d?.category, d?.tags]);
  return {
    aid: bookId,
    title: stripHighlight(toStr(d?.book_name)) || "（无标题）",
    author: stripHighlight(toStr(d?.author)),
    // 上游 creation_status：0 = 连载中，1 = 已完结（与本项目其余源口径一致）
    status: statusRaw === "1" ? "已完结" : "连载中",
    finUpdate: (d?.last_chapter_title ?? "").trim(),
    imgUrl: coverUrl(d?.thumb_url),
    introduce: (d?.abstract ?? "").trim(),
    tags,
    heat: toStr(d?.word_number),
    trending: (d?.score ?? "").trim(),
  };
}

/**
 * 目录。上游有两种形状：扁平 `item_data_list`，或分组 `volume_list`。
 * 这里统一成 `NovelVolume[]`（无分组时给一个空标题的单卷）。
 */
export async function fqapiCatalogue(bookId: string): Promise<NovelVolume[]> {
  const frame = await capabilities.fqapi<SidecarFrame<RawDirectoryData>>({
    path: `/api/v1/books/${encodeURIComponent(bookId)}/directory`,
  });
  const data = unwrap(frame);

  const mapChapters = (list: RawDirectoryItem[] | undefined): NovelChapter[] =>
    (list ?? [])
      .map((c) => ({ cid: toStr(c.item_id), title: (c.title ?? "").trim() || "（无标题）" }))
      .filter((c) => c.cid);

  if (data?.volume_list?.length) {
    return data.volume_list
      .map((v) => ({
        title: (v.volume_name ?? "").trim(),
        chapters: mapChapters(v.chapter_list),
      }))
      .filter((v) => v.chapters.length > 0);
  }

  const flat = mapChapters(data?.item_data_list);
  return flat.length ? [{ title: "", chapters: flat }] : [];
}

/**
 * 章节正文。
 *
 * `op: "chapter"` 由 sidecar 直接返回**已解析成段落**的正文 —— 上游给的是
 * HTML 富文本，解析在 Rust 侧完成（规则与原项目 chapter_text_formatter
 * 一致），前端拿到的就是可直接渲染的 `paragraphs`。
 */
export async function fqapiContent(
  itemId: string,
): Promise<{ text: string; images: string[]; paragraphs: string[] }> {
  const res = await capabilities.fqapiChapter(itemId);
  const paragraphs = res?.paragraphs ?? [];
  return {
    // BookReader 吃的是纯文本；段落之间用空行分开，与「上下滚动」排版一致。
    text: paragraphs.join("\n\n"),
    images: [],
    paragraphs,
  };
}

/** 自检：排障用（设置页/开发工具可以调）。 */
export async function fqapiSelftest(): Promise<unknown> {
  return capabilities.fqapiSelftest();
}

// ---------------------------------------------------------------------------
// 推荐流 / 排行榜
//
// 两者共用同一种「模块 → 书」形状：
//   cell_data[]            ← 模块，cell_name 就是标题（「排行榜」「猜你喜欢」）
//     .cell_data[]         ← 条目，真正的内容在第 0 项上
//       .book_data[]       ← 书（1 本/条，偶尔为空）
// 区别只在于外层的字段名：推荐在 tab_item["0"]，榜在 cell_view。
// ---------------------------------------------------------------------------

/** 推荐流里的一个模块（如「排行榜」「猜你喜欢」）。 */
export interface FqapiFeedSection {
  title: string;
  books: NovelCover[];
}

interface RawCellItem {
  book_data?: RawSearchItem[];
}

interface RawCell {
  cell_name?: string;
  cell_data?: RawCellItem[];
}

interface RawHomepageData {
  tab_item?: Record<
    string,
    { cell_data?: RawCell[]; has_more?: boolean; next_offset?: number | string }
  >;
}

interface RawRankData {
  cell_view?: RawCell;
  has_more?: boolean;
  next_offset?: number | string;
}

/** 把一个 cell 里的书全部摊平（每个条目通常 1 本，空条目直接跳过）。 */
function booksOfCell(cell: RawCell): NovelCover[] {
  const out: NovelCover[] = [];
  for (const item of cell.cell_data ?? []) {
    for (const book of item.book_data ?? []) {
      const cover = itemToCover(book);
      if (cover.aid) out.push(cover);
    }
  }
  return out;
}

/**
 * 首页推荐流。
 *
 * `tab` 是上游的频道下标（`tab_item` 的 key）：0 = 推荐，1 = 小说……，
 * 与响应里的 9 个频道一一对应。这里只取「有内容模块」的那些。
 */
export async function fqapiFeed(
  tab = "0",
  offset = "",
): Promise<{ sections: FqapiFeedSection[]; hasMore: boolean; nextOffset: string }> {
  const query = new URLSearchParams();
  if (offset) query.set("offset", offset);
  const frame = await capabilities.fqapi<SidecarFrame<RawHomepageData>>({
    path: "/api/v1/recommend/homepage",
    query: query.toString(),
  });
  const data = unwrap(frame);
  const tabData = data?.tab_item?.[tab];
  const sections: FqapiFeedSection[] = [];
  for (const cell of tabData?.cell_data ?? []) {
    const books = booksOfCell(cell);
    if (books.length) sections.push({ title: cell.cell_name?.trim() || "推荐", books });
  }
  return {
    sections,
    hasMore: !!tabData?.has_more,
    nextOffset: toStr(tabData?.next_offset),
  };
}

/**
 * 排行榜。
 *
 * `rankId` 就是首页「排行榜」模块的 `cell_id_str`（18 位数字串）。
 * 不传时用内置的默认榜 —— 上游的男女频总榜，入口稳定。
 */
export async function fqapiRank(
  rankId = "7098235271900037133",
  offset = "",
): Promise<{ title: string; books: NovelCover[]; hasMore: boolean; nextOffset: string }> {
  const query = new URLSearchParams();
  if (offset) query.set("offset", offset);
  const frame = await capabilities.fqapi<SidecarFrame<RawRankData>>({
    path: `/api/v1/rank/${encodeURIComponent(rankId)}`,
    query: query.toString(),
  });
  const data = unwrap(frame);
  const cell = data?.cell_view;
  return {
    title: cell?.cell_name?.trim() || "排行榜",
    books: cell ? booksOfCell(cell) : [],
    hasMore: !!data?.has_more,
    nextOffset: toStr(data?.next_offset),
  };
}
