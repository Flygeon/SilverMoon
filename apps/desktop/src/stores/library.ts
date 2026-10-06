import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { UnlistenFn } from "@/ipc/events";
import { capabilities, isDesktop } from "@/capabilities";
import { useSettingsStore } from "@/stores/settings";
import { useDesktopStore, WAKE_REASON } from "@/stores/desktop";
import { markBoot } from "@/utils/bootTiming";
import type { ListQuery, MediaEntry, ScanProgress } from "@shared/types";

export type SortKey = NonNullable<ListQuery["sortBy"]>;

/** 缩略图内存缓存上限，防止大图库把渲染进程撑爆 */
const THUMB_CACHE_LIMIT = 1200;

/**
 * 单次批量取缩略图的条目数。
 *
 * 太小则省下的往返有限，太大则单批响应变慢（Rust 侧批内顺序生成封面）。
 * 配合 `loadThumbnails` 的并发批数，一次滚动大约同时生成 3×16 张。
 */
const THUMB_BATCH = 16;

/**
 * 单页条目数。
 *
 * 首屏只拉这么多，其余由 `fillRemaining` 在后台分页补齐。
 * 一次拉全库时，几千条的 JSON 会在 Electron **主进程线程**上一次性
 * `JSON.stringify` / `JSON.parse`，期间窗口事件（拖拽、缩放、焦点、菜单）
 * 全部排队——表现为"点一下卡一下"。拆成多次小往返后单次阻塞时间大幅下降，
 * 首屏也更快可见。
 */
const PAGE_SIZE = 400;

export const useLibraryStore = defineStore("library", () => {
  /**
   * 按类型缓存列表。
   *
   * ## 为什么是 `shallowRef` 而不是 `ref`
   *
   * `ref` 对对象是**深响应**：`fillRemaining` 会把**全库**条目都塞进来，
   * 于是每个 `MediaEntry`、每个数组都被 Proxy 包一层。5 万条曲库下这是实打实的
   * 内存与 CPU 开销（滚动/筛选时每次字段访问都要过 Proxy）—— 而列表根本不需要
   * 逐字段响应。同文件的 `thumbCache` 早就因为同样的理由用了 `shallowRef`。
   *
   * ## ⚠️ 因此必须遵守的不变量
   *
   * **所有写入都要「替换外层对象」**，例如：
   *
   * ~~~ts
   * entriesByType.value = { ...entriesByType.value, [type]: next };
   * ~~~
   *
   * 只就地改数组/字段（`list.push(...)`、`entry.favorite = x`）**不会触发更新**。
   * 确需就地改字段时，改完必须再替换一次外层对象（见 `toggleFavorite`）。
   * 若哪天真需要原地触发，用 `triggerRef(entriesByType)`。
   */
  const entriesByType = shallowRef<Record<string, MediaEntry[]>>({});
  const counts = ref<Record<string, number>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  // 缩略图不需要深响应，用 shallowRef + 版本号手动触发，避免大对象 proxy 开销
  const thumbCache = shallowRef<Map<string, string>>(new Map());
  const thumbVersion = ref(0);

  const scanning = ref(false);
  const progress = ref<ScanProgress | null>(null);
  const currentJobId = ref<string | null>(null);
  let unlistenScan: UnlistenFn | null = null;

  // ---- 视图状态（搜索/排序，各类型共用）----
  const search = ref("");
  const sortBy = ref<SortKey>("name");
  const sortDesc = ref(false);

  function getThumb(id: string): string | undefined {
    void thumbVersion.value; // 建立依赖，缓存更新时重新求值
    return thumbCache.value.get(id);
  }

  function setThumb(id: string, url: string) {
    const cache = thumbCache.value;
    if (cache.size >= THUMB_CACHE_LIMIT) {
      // Map 保持插入序，删最早的一批
      const drop = Math.floor(THUMB_CACHE_LIMIT * 0.2);
      let i = 0;
      for (const key of cache.keys()) {
        if (i++ >= drop) break;
        cache.delete(key);
      }
    }
    cache.set(id, url);
    thumbVersion.value++;
  }

  function entries(type: string): MediaEntry[] {
    return entriesByType.value[type] ?? [];
  }

  /** 正在后台重查的类型数（已有数据、正在静默刷新）。>0 时列表轻微压暗，不闪骨架屏。 */
  const pendingRefreshes = ref(0);
  const refreshing = computed(() => pendingRefreshes.value > 0);

  /** 每个类型最近一次请求的序号，用于丢弃过期响应（快速改搜索词时会并发多次查询）。 */
  const requestSeq: Record<string, number> = {};

  /** 各类型在当前过滤条件下的总数（后端 count_files），用于展示真实条数。 */
  const totals = ref<Record<string, number>>({});

  /** 某类型的总数；尚未取到或未加载时退化为已加载条数。 */
  function totalFor(type: string): number {
    return totals.value[type] ?? entriesByType.value[type]?.length ?? 0;
  }

  /**
   * 拉取某类型列表。搜索、排序、体积过滤都下推到 SQL，不在前端做。
   *
   * 采用 stale-while-revalidate：**只有该类型还没有任何缓存时才置 `loading`**
   * （此时 MediaGrid 渲染骨架屏）；已有数据时保留旧列表、后台重查、回来原地替换。
   * 否则每次搜索/排序都是"白一下 + 等一次完整往返 + 重新拉缩略图"。
   */
  async function refresh(type: string) {
    const hasCache = (entriesByType.value[type]?.length ?? 0) > 0;
    if (hasCache) pendingRefreshes.value++;
    else loading.value = true;
    error.value = null;

    const seq = (requestSeq[type] = (requestSeq[type] ?? 0) + 1);
    const query: ListQuery = {
      type,
      search: search.value || undefined,
      sortBy: sortBy.value,
      desc: sortDesc.value,
      minSize: minSizeBytes(),
    };

    let firstPageOk = false;
    try {
      // 首屏只取一页；总数并行取回，让工具栏立刻显示真实条数
      const [first, total] = await Promise.all([
        capabilities.listFiles({ ...query, limit: PAGE_SIZE, offset: 0 }),
        capabilities.countFiles(query),
      ]);
      // 已有更新的请求在跑，丢弃本次结果，避免旧响应覆盖新列表
      if (requestSeq[type] !== seq) return;
      entriesByType.value = { ...entriesByType.value, [type]: first };
      totals.value = { ...totals.value, [type]: total };
      firstPageOk = true;
      // 首页数据到位 = 列表即将渲染出真实内容（首屏可见的关键节点）
      markBoot(`${type} 首屏数据到位`);
    } catch (e) {
      if (requestSeq[type] !== seq) return;
      error.value = String(e);
      entriesByType.value = { ...entriesByType.value, [type]: [] };
    } finally {
      if (hasCache) pendingRefreshes.value = Math.max(0, pendingRefreshes.value - 1);
      if (requestSeq[type] === seq) loading.value = false;
    }

    // 首屏已可见，剩余分页在后台补齐——不阻塞交互，也不改变 entries() 的最终内容
    if (firstPageOk && requestSeq[type] === seq) void fillRemaining(type, query, seq);
  }

  /**
   * 后台把剩余分页补齐。
   *
   * 关键是**不改变 `entries(type)` 的最终语义**（仍然收敛到全量），
   * 只是把"一次大 payload"摊成多次小往返，从而把主进程的单次阻塞时间压下来。
   * 查询条件变化时靠 `requestSeq` 立刻放弃这一轮。
   */
  async function fillRemaining(type: string, query: ListQuery, seq: number) {
    for (let offset = PAGE_SIZE; ; offset += PAGE_SIZE) {
      if (requestSeq[type] !== seq) return;
      let page: MediaEntry[];
      try {
        page = await capabilities.listFiles({ ...query, limit: PAGE_SIZE, offset });
      } catch {
        return; // 补齐失败不报错：首屏数据已经可用
      }
      if (requestSeq[type] !== seq) return;
      if (!page.length) return;

      const existing = entriesByType.value[type] ?? [];
      // 补齐期间可能刚扫描过，按 id 去重，避免重复卡片
      const seen = new Set(existing.map((e) => e.id));
      const merged = existing.concat(page.filter((e) => !seen.has(e.id)));
      entriesByType.value = { ...entriesByType.value, [type]: merged };

      if (page.length < PAGE_SIZE) return;
      // 让出事件循环，避免连续补齐长时间占住微任务队列
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** 设置里的 MB 阈值换算成字节 */
  function minSizeBytes(): number {
    const mb = useSettingsStore().minFileSizeMb;
    return mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
  }

  async function refreshCounts() {
    try {
      counts.value = await capabilities.libraryCounts(minSizeBytes());
    } catch {
      /* 角标失败不影响主流程 */
    }
  }

  /**
   * 按需加载缩略图（供虚拟滚动只请求可视区）。
   *
   * 两条路径，按代价从低到高：
   * 1. **列表已带出缓存路径**（`entry.thumbPath`）——直接拼 asset://，零命令。
   *    库热起来之后这是绝大多数条目走的路。
   * 2. **未命中项**——经批量通道一次补齐（见 `capabilities.getThumbnails`）。
   *    逐张发命令时滚动一屏就是几十次进程往返，这是滚动卡顿的主要来源。
   */
  async function loadThumbnails(ids: string[], concurrency = 3) {
    const pending = ids.filter((id) => id && !thumbCache.value.has(id));
    if (!pending.length) return;

    // 建一次 id -> entry 索引：既要读列表带出的 thumbPath，也要在 PDF 兜底时拿条目。
    // （原先每条都遍历全部列表，是 O(n·m)。）
    const byId = new Map<string, MediaEntry>();
    for (const list of Object.values(entriesByType.value)) {
      for (const entry of list) byId.set(entry.id, entry);
    }

    const misses: string[] = [];
    for (const id of pending) {
      const cachedPath = byId.get(id)?.thumbPath;
      if (cachedPath) setThumb(id, capabilities.thumbUrl(cachedPath));
      else misses.push(id);
    }
    if (!misses.length) return;

    // 分块：批量通道单批内部是顺序执行的，分块 + 少量并发能保留生成时的并行度
    const chunks: string[][] = [];
    for (let i = 0; i < misses.length; i += THUMB_BATCH) {
      chunks.push(misses.slice(i, i + THUMB_BATCH));
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        try {
          const urls = await capabilities.getThumbnails(chunk, 320);
          for (let i = 0; i < chunk.length; i++) {
            const url = urls[i];
            if (url) setThumb(chunk[i], url);
          }
        } catch {
          /* 单批失败不影响其它批 */
        }
        // 批量也拿不到封面时，PDF 用 pdf.js 渲染首页补上
        for (const id of chunk) {
          if (thumbCache.value.has(id)) continue;
          const entry = byId.get(id);
          if (entry?.ext.toLowerCase() === "pdf") {
            const generated = await generatePdfCover(entry);
            if (generated) setThumb(id, generated);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  }

  /** 用 pdf.js 渲染 PDF 首页作为封面，并回存到后端磁盘缓存 */
  async function generatePdfCover(entry: MediaEntry): Promise<string | null> {
    if (!isDesktop) return null;
    try {
      const cached = await capabilities.thumbnailCachePath(entry.id, 320);
      if (cached) return cached;

      const { readFile } = await import("@/ipc/fs");
      const { renderPdfCover, toArrayBuffer } = await import("@/utils/pdf");
      const bytes = await readFile(entry.path);
      const jpeg = await renderPdfCover(toArrayBuffer(bytes), 320);
      if (!jpeg) return null;
      return await capabilities.saveThumbnail(entry.id, jpeg, 320);
    } catch {
      return null;
    }
  }

  /** 扫描完成后所有缓存都失效 */
  function invalidate() {
    entriesByType.value = {};
    totals.value = {};
    thumbCache.value = new Map();
    thumbVersion.value++;
  }

  async function startScan(dirs?: string[]) {
    if (scanning.value) return;
    const settings = useSettingsStore();
    const scanDirs = dirs?.length ? dirs : settings.scanDirs;
    const mode = settings.scanMode;
    /*
     * 只有白名单模式才要求非空目录。
     *
     * 黑名单模式的 scanDirs 是「排除项」，空列表完全合法 —— 那就是
     * 「全局扫描且不排除任何目录」。此前这里不分模式一律拦下，于是设置页
     * 写着「不选择目录则全局扫描」、实际却连扫都扫不了（界面与实现不一致）。
     */
    if (mode === "whitelist" && !scanDirs.length) {
      error.value = "empty-dirs";
      return;
    }

    scanning.value = true;
    error.value = null;
    progress.value = null;

    // 全库扫描可能跑很久（大库几十分钟），期间阻止系统自动挂起。
    // 失败静默：Wayland 平铺 WM 上可能没有 ScreenSaver 服务，不能因此中断扫描。
    void useDesktopStore().keepAwake(WAKE_REASON.scan, "system");

    // 事件驱动进度，替代旧的 500ms 轮询
    unlistenScan?.();
    unlistenScan = await capabilities.onScanProgress((p) => {
      if (p.jobId !== currentJobId.value) return;
      progress.value = p;
      if (p.stage === "done" || p.stage === "cancelled" || p.stage === "error") {
        void finishScan(p);
      }
    });

    try {
      const { jobId } = await capabilities.scanStart({ dirs: scanDirs, mode });
      currentJobId.value = jobId;
      // 浏览器 mock 无事件通道，回落到一次性查询
      await pollIfNoEvents(jobId);
    } catch (e) {
      error.value = String(e);
      scanning.value = false;
      unlistenScan?.();
      unlistenScan = null;
    }
  }

  /** mock / 事件缺失场景的兜底：任务已是终态时直接收尾 */
  async function pollIfNoEvents(jobId: string) {
    const status = await capabilities.scanStatus(jobId);
    if (status && ["done", "cancelled", "error"].includes(status.stage)) {
      progress.value = status;
      await finishScan(status);
    }
  }

  async function finishScan(p: ScanProgress) {
    scanning.value = false;
    currentJobId.value = null;
    unlistenScan?.();
    unlistenScan = null;
    // 扫描结束，撤销防休眠理由（集合里还有别的理由时不会真正释放锁）
    void useDesktopStore().allowSleep(WAKE_REASON.scan);
    if (p.stage === "error") {
      error.value = p.error ?? "scan-failed";
      // 窗口收进托盘 / 切到别的工作区时应用内提示看不到，走系统通知
      void useDesktopStore().notify("媒体库扫描失败", p.error ?? "未知错误", { urgency: 1 });
      return;
    }
    invalidate();
    await refreshCounts();
    // 后台完成的回执：新增/更新条目数
    void useDesktopStore().notify(
      "媒体库扫描完成",
      `新增 ${p.added} · 更新 ${p.updated} · 移除 ${p.removed}`,
      { urgency: 0 },
    );
  }

  async function cancelScan() {
    if (currentJobId.value) {
      await capabilities.scanCancel(currentJobId.value);
    }
  }

  /**
   * 单条条目的乐观更新（写标签等「原地改一个文件」的场景）。
   *
   * 为什么需要它：后端 `get_metadata` 优先读 SQLite 的 media_metadata 缓存，
   * 只有缓存缺失才重新解析文件；因此写完标签再 `refresh` 拉回来的仍是旧值，
   * 用户会看到「文件写成功了、列表没变」。这里先把内存条目换成新字段让 UI 立刻正确，
   * 再由调用方触发一次后台重扫把 DB 补正。
   *
   * `patch` 里值为 `undefined` 的键会被忽略——调用方用 undefined 表达「该项保持原值」
   * （例如封面 mode 为 keep 时不该把 `hasCover` 擦成 undefined）。
   */
  function patchEntry(fileId: string, patch: Partial<MediaEntry>): void {
    const clean: Partial<MediaEntry> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) clean[key as keyof MediaEntry] = value as never;
    }
    if (!Object.keys(clean).length) return;

    let hit = false;
    const next: Record<string, MediaEntry[]> = {};
    for (const [type, list] of Object.entries(entriesByType.value)) {
      let changed = false;
      const patched = list.map((entry) => {
        if (entry.id !== fileId) return entry;
        changed = true;
        hit = true;
        // 整体替换（而不是就地改字段）以便触发响应式，与 refresh 里合并页数据的写法一致
        return { ...entry, ...clean };
      });
      next[type] = changed ? patched : list;
    }
    if (!hit) return; // 该条目不在当前列表里（被过滤掉了）→ 静默返回
    entriesByType.value = next;
  }

  async function toggleFavorite(entry: MediaEntry) {
    const next = await capabilities.toggleFavorite(entry.id);
    // 就地更新所有列表里的同一条目
    for (const list of Object.values(entriesByType.value)) {
      const hit = list.find((e) => e.id === entry.id);
      if (hit) hit.favorite = next;
    }
    // ⚠️ 这一行**不能删**：entriesByType 是 shallowRef，就地改 `favorite` 不会触发更新，
    // 必须替换外层对象才能让列表重渲染（见 entriesByType 的注释）。
    entriesByType.value = { ...entriesByType.value };
  }

  const scanLabel = computed(() => {
    const p = progress.value;
    if (!p) return "";
    if (p.stage === "enumerate") return `正在枚举 ${p.done}`;
    if (p.stage === "store") return `正在入库 ${p.done}/${p.total}`;
    if (p.stage === "parse") return `正在解析 ${p.done}/${p.total}`;
    return "";
  });

  return {
    entriesByType,
    counts,
    loading,
    refreshing,
    error,
    scanning,
    progress,
    scanLabel,
    search,
    sortBy,
    sortDesc,
    entries,
    totalFor,
    getThumb,
    refresh,
    refreshCounts,
    loadThumbnails,
    invalidate,
    patchEntry,
    startScan,
    cancelScan,
    toggleFavorite,
  };
});
