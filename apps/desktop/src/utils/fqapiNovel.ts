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
  author?: string;
  thumb_url?: string;
  abstract?: string;
  category?: string;
  creation_status?: string | number;
  score?: string;
  tags?: string[];
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

/** 上游封面走 CDN，带鉴权参数，`<img>` 直接引用即可（不需要 Referer 伪装）。 */
function coverUrl(raw: string | undefined): string {
  const u = (raw ?? "").trim();
  if (!u) return "";
  // 上游偶尔给 protocol-relative
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}

function itemToCover(item: RawSearchItem): NovelCover {
  return {
    aid: toStr(item.book_id),
    title: (item.title ?? "").trim() || "（无标题）",
    imageUrl: coverUrl(item.thumb_url),
    author: (item.author ?? "").trim() || null,
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
  return {
    aid: bookId,
    title: (d?.book_name ?? "").trim() || "（无标题）",
    author: (d?.author ?? "").trim(),
    // 上游 creation_status：0 = 连载中，1 = 已完结（与本项目其余源口径一致）
    status: statusRaw === "1" ? "已完结" : "连载中",
    finUpdate: (d?.last_chapter_title ?? "").trim(),
    imgUrl: coverUrl(d?.thumb_url),
    introduce: (d?.abstract ?? "").trim(),
    tags: [...(d?.category ? [d.category] : []), ...(d?.tags ?? [])].filter(Boolean),
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
