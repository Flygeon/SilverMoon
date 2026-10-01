/**
 * B 站（Bilibili）状态。
 *
 * 与在线音乐同构：一个 store + 一个 utils 归一化层（`utils/bilibili.ts`）。
 * 视频页的「B站」子选项卡共用这一份状态，因此切到「本地 / 动漫」再切回来时，
 * 登录态、推荐流、搜索词、正在看的视频都不会丢（配合 KeepAlive 的 DOM 缓存）。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  BILI_ANONYMOUS,
  BILI_RELATION_NONE,
  BILI_REPLY_HOT,
  type BiliAccount,
  type BiliDetail,
  type BiliPlayUrl,
  type BiliQrStatus,
  type BiliRelation,
  type BiliReply,
  type BiliReplySort,
  type BiliUserCard,
  type BiliVideo,
  biliAddReply,
  biliApplyCookies,
  biliCoin,
  biliDanmaku,
  biliFavFolders,
  biliFavFoldersAll,
  biliFavResources,
  biliFavorite,
  biliFollow,
  biliHistory,
  biliIsLoggedIn,
  biliLike,
  biliLogout,
  biliNav,
  biliPlayUrl,
  biliQrGenerate,
  biliQrPoll,
  biliRecommend,
  biliRelation,
  biliRelated,
  biliReplies,
  biliReplyReplies,
  biliSearch,
  biliUserCard,
  biliUserRelation,
  biliUserVideos,
  biliVideoDetail,
} from "@/utils/bilibili";
import { JsonStore } from "@/ipc/store";
import type { ArtDanmu } from "@/utils/danmaku";

export type BiliStatus = "idle" | "loading" | "ready" | "error";

function cleanError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/^Error:\s*/, "");
}

export const useBiliStore = defineStore("bilibili", () => {
  /** 全局提示（登录成功 / 退出等） */
  const notice = ref("");
  function clearNotice(): void {
    notice.value = "";
  }

  // ---------------------------------------------------------------- 账号
  const account = ref<BiliAccount>({ ...BILI_ANONYMOUS });
  const accountLoaded = ref(false);
  const accountLoading = ref(false);
  /** 最近一次账号查询的失败原因（登录流程要把上游原话带给用户） */
  const accountError = ref("");

  async function loadAccount(): Promise<void> {
    accountLoading.value = true;
    try {
      account.value = await biliNav();
      accountError.value = "";
    } catch (e) {
      account.value = { ...BILI_ANONYMOUS };
      accountError.value = cleanError(e);
      console.warn("[bilibili] 账号获取失败：", e);
    }
    accountLoaded.value = true;
    accountLoading.value = false;
  }

  // ---------------------------------------------------------------- 推荐流
  const feed = ref<BiliVideo[]>([]);
  const feedStatus = ref<BiliStatus>("idle");
  const feedLoadingMore = ref(false);
  const feedError = ref("");
  const freshIdx = ref(0);
  let feedToken = 0;

  async function loadFeed(refresh = false): Promise<void> {
    if (feedStatus.value === "loading") return;
    const token = refresh ? ++feedToken : feedToken;
    if (refresh) {
      freshIdx.value = 0;
      feedError.value = "";
    }
    if (!feed.value.length || refresh) feedStatus.value = "loading";
    try {
      const list = await biliRecommend(freshIdx.value, 20);
      if (token !== feedToken) return;
      feed.value = refresh ? list : [...feed.value, ...list];
      freshIdx.value += 1;
      feedError.value = "";
      feedStatus.value = "ready";
    } catch (e) {
      if (token !== feedToken) return;
      feedError.value = cleanError(e);
      feedStatus.value = feed.value.length ? "ready" : "error";
    }
  }

  async function loadMoreFeed(): Promise<void> {
    if (feedStatus.value === "loading" || feedLoadingMore.value || !feed.value.length) return;
    feedLoadingMore.value = true;
    const token = feedToken;
    try {
      const list = await biliRecommend(freshIdx.value, 20);
      if (token !== feedToken) return;
      feed.value = [...feed.value, ...list];
      freshIdx.value += 1;
    } catch (e) {
      if (token !== feedToken) return;
      feedError.value = cleanError(e);
    }
    feedLoadingMore.value = false;
  }

  // ---------------------------------------------------------------- 搜索
  const keyword = ref("");
  const results = ref<BiliVideo[]>([]);
  const searchStatus = ref<BiliStatus>("idle");
  const searchLoadingMore = ref(false);
  const searchError = ref("");
  const searchPage = ref(1);
  const searchEnd = ref(false);
  let searchToken = 0;

  // ---- 搜索历史（本地持久化，与「B站」同一个 JSON 存储但独立键）----
  const historyStore = new JsonStore("bilibili.json");
  const SEARCH_HISTORY_KEY = "searchHistory";
  const SEARCH_HISTORY_MAX = 30;
  const searchHistory = ref<string[]>([]);
  let searchHistoryLoaded = false;

  async function loadSearchHistory(): Promise<void> {
    if (searchHistoryLoaded) return;
    searchHistoryLoaded = true;
    try {
      const saved = await historyStore.get<string[]>(SEARCH_HISTORY_KEY);
      if (Array.isArray(saved)) searchHistory.value = saved.filter((s) => !!s && !!s.trim());
    } catch {
      searchHistory.value = [];
    }
  }

  async function persistSearchHistory(): Promise<void> {
    try {
      await historyStore.set(SEARCH_HISTORY_KEY, searchHistory.value);
      await historyStore.save();
    } catch {
      // 存储不可用时静默：本次会话仍可用
    }
  }

  /** 记一条搜索词（去重后置顶，超出上限截断）。 */
  async function rememberSearch(word: string): Promise<void> {
    const w = word.trim();
    if (!w) return;
    searchHistory.value = [w, ...searchHistory.value.filter((x) => x !== w)].slice(
      0,
      SEARCH_HISTORY_MAX,
    );
    await persistSearchHistory();
  }

  async function removeSearchHistory(word: string): Promise<void> {
    searchHistory.value = searchHistory.value.filter((x) => x !== word);
    await persistSearchHistory();
  }

  async function clearSearchHistory(): Promise<void> {
    searchHistory.value = [];
    await persistSearchHistory();
  }

  async function search(kw: string): Promise<void> {
    const word = kw.trim();
    keyword.value = word;
    if (!word) {
      results.value = [];
      searchStatus.value = "idle";
      searchError.value = "";
      return;
    }
    const token = ++searchToken;
    searchStatus.value = "loading";
    searchError.value = "";
    searchPage.value = 1;
    searchEnd.value = false;
    try {
      const list = await biliSearch(word, 1);
      if (token !== searchToken) return;
      results.value = list;
      searchPage.value = 2;
      searchEnd.value = list.length === 0;
      searchStatus.value = "ready";
      if (!list.length) searchError.value = "没有找到相关视频";
      // 只在真的有结果时记历史：搜空的词留在历史里没有回访价值
      if (list.length) void rememberSearch(word);
    } catch (e) {
      if (token !== searchToken) return;
      results.value = [];
      searchError.value = cleanError(e);
      searchStatus.value = "error";
    }
  }

  async function loadMoreSearch(): Promise<void> {
    if (searchStatus.value === "loading" || searchLoadingMore.value || searchEnd.value) return;
    if (!keyword.value) return;
    const token = searchToken;
    searchLoadingMore.value = true;
    try {
      const list = await biliSearch(keyword.value, searchPage.value);
      if (token !== searchToken) return;
      if (!list.length) {
        searchEnd.value = true;
      } else {
        results.value = [...results.value, ...list];
        searchPage.value += 1;
      }
    } catch (e) {
      if (token !== searchToken) return;
      searchError.value = cleanError(e);
      searchEnd.value = true;
    }
    searchLoadingMore.value = false;
  }

  // ---------------------------------------------------------------- 扫码登录
  let qrKey = "";
  let pollFailures = 0;
  const qrContent = ref<string | null>(null);
  const qrStatus = ref<BiliQrStatus | null>(null);
  const startingQr = ref(false);
  const loginError = ref("");
  const qrExpired = ref(false);
  const qrStatusText = ref("请使用「哔哩哔哩」App 扫描二维码");

  function resetQr(): void {
    qrKey = "";
    pollFailures = 0;
    qrContent.value = null;
    qrStatus.value = null;
    qrExpired.value = false;
    loginError.value = "";
    qrStatusText.value = "请使用「哔哩哔哩」App 扫描二维码";
  }

  async function startQr(): Promise<void> {
    startingQr.value = true;
    loginError.value = "";
    qrContent.value = null;
    qrStatus.value = null;
    qrExpired.value = false;
    pollFailures = 0;
    try {
      const r = await biliQrGenerate();
      qrContent.value = r.url;
      qrKey = r.key;
    } catch (e) {
      loginError.value = `获取二维码失败：${cleanError(e)}`;
    }
    startingQr.value = false;
  }

  /** 轮询一次；返回 true 表示停止轮询（成功或不可恢复）。 */
  async function pollQr(): Promise<boolean> {
    if (!qrKey) return false;
    try {
      const s = await biliQrPoll(qrKey);
      pollFailures = 0;
      qrStatus.value = s;
      qrExpired.value = s.code === 86038;
      if (s.code === 0) {
        qrStatusText.value = "登录成功";
        await loadAccount();
        if (!account.value.isLogin) {
          // 上游偶尔延迟下发凭据，再给一次机会
          await new Promise((r) => setTimeout(r, 600));
          await loadAccount();
        }
        if (!account.value.isLogin && s.alt) {
          // 凭据还有另一种编码形态（跳转链的 `,` ↔ cookie 的 `%2C`），哪种才是服务端
          // 认的形态只有 nav 说了算 —— 换上另一种再验一次，避免把可用会话判成失败。
          await biliApplyCookies(s.alt);
          await loadAccount();
        }
        if (!account.value.isLogin) {
          // 带上上游原话（-101 / -352 …），否则这一条永远只有「获取失败」，无从下手
          loginError.value = accountError.value
            ? `已授权，但账号信息获取失败：${accountError.value}`
            : "已授权，但账号信息获取失败，请重新登录";
          return true;
        }
        notice.value = `欢迎回来，${account.value.name || "B 站用户"}`;
        return true;
      }
      if (s.code === 86038) {
        qrStatusText.value = "二维码已过期，请点击刷新";
        return true;
      }
      qrStatusText.value =
        s.code === 86090 ? "已扫码，请在手机上确认" : "请使用「哔哩哔哩」App 扫描二维码";
    } catch (e) {
      pollFailures += 1;
      if (pollFailures >= 4) {
        loginError.value = `网络异常：${cleanError(e)}`;
        return true;
      }
    }
    return false;
  }

  async function logout(): Promise<void> {
    await biliLogout();
    account.value = { ...BILI_ANONYMOUS };
    notice.value = "已退出 B 站账号";
    // 退出后推荐流会变回未登录内容，重扫一次
    void loadFeed(true);
  }

  // -------------------------------------------------------- 详情 / 播放
  const current = ref<BiliVideo | null>(null);
  const detail = ref<BiliDetail | null>(null);
  const play = ref<BiliPlayUrl | null>(null);
  const activeCid = ref("");
  const activeQn = ref(80);
  /**
   * 用户是否**手动**选过清晰度。
   *
   * 没选过时默认取上游声明的最高档：上游的 `quality` 字段在未登录预览下会回
   * 720P（dash 里却带着 1080P 轨道），若直接跟随它，界面就还是「最高只有 720P」。
   */
  const qualityPinned = ref(false);
  const detailStatus = ref<BiliStatus>("idle");
  const playStatus = ref<BiliStatus>("idle");
  const playError = ref("");
  let openToken = 0;

  async function resolvePlay(token: number, qn?: number): Promise<void> {
    const v = current.value;
    if (!v) return;
    if (!activeCid.value) {
      playError.value = "该视频缺少 cid，无法解析播放地址";
      playStatus.value = "error";
      return;
    }
    playStatus.value = "loading";
    playError.value = "";
    try {
      const p = await biliPlayUrl(v.bvid, activeCid.value, qn ?? activeQn.value);
      if (token !== openToken) return;
      play.value = p;
      // 用户没手动选过 → 直接落到最高档，避免被上游的默认 quality 拖回 720P
      if (!qualityPinned.value && p.qualities.length) {
        activeQn.value = p.qualities[0];
      } else if (p.quality) {
        activeQn.value = p.quality;
      }
      playStatus.value = "ready";
    } catch (e) {
      if (token !== openToken) return;
      playError.value = cleanError(e);
      playStatus.value = "error";
    }
  }

  async function openVideo(video: BiliVideo): Promise<void> {
    const token = ++openToken;
    current.value = video;
    detail.value = null;
    play.value = null;
    playError.value = "";
    detailStatus.value = "loading";
    playStatus.value = "idle";
    // 新视频重置到手动的「未选」态，重新按最高档起播
    qualityPinned.value = false;
    activeQn.value = 80;
    resetDiscussions();
    // 相关推荐只依赖 bvid，和详情/取流并行，别让它排在后面等
    void loadRelated(video.bvid);
    try {
      const d = await biliVideoDetail(video.bvid);
      if (token !== openToken) return;
      detail.value = d;
      activeCid.value = d.parts.length ? d.parts[0].cid : d.cid || video.cid;
      detailStatus.value = "ready";
      // 评论要拿 UP mid 标「UP 主」标记，所以等详情回来再拉；互动状态同理（要 aid）
      void loadReplies(true);
      void loadRelation();
      await resolvePlay(token);
    } catch (e) {
      if (token !== openToken) return;
      playError.value = cleanError(e);
      detailStatus.value = "error";
    }
  }

  async function selectQuality(qn: number): Promise<void> {
    if (qn === activeQn.value && play.value) return;
    qualityPinned.value = true;
    activeQn.value = qn;
    await resolvePlay(openToken, qn);
  }

  async function selectPart(cid: string): Promise<void> {
    if (cid === activeCid.value) return;
    activeCid.value = cid;
    await resolvePlay(openToken);
  }

  function closeVideo(): void {
    openToken += 1;
    current.value = null;
    detail.value = null;
    play.value = null;
    activeCid.value = "";
    playStatus.value = "idle";
    detailStatus.value = "idle";
    playError.value = "";
    resetDiscussions();
  }

  // -------------------------------------------------------- 评论 / 相关推荐
  const replies = ref<BiliReply[]>([]);
  const replyTotal = ref(0);
  const replySort = ref<BiliReplySort>(BILI_REPLY_HOT);
  const replyStatus = ref<BiliStatus>("idle");
  const replyError = ref("");
  const replyLoadingMore = ref(false);
  const replyEnd = ref(false);
  /** 已展开的楼中楼：rpid → 子回复（有值即展开，不必再维护一套开关） */
  const subReplies = ref<Record<string, BiliReply[]>>({});
  const subBusy = ref<Record<string, boolean>>({});
  const subEnds = ref<Record<string, boolean>>({});
  let replyOffset = "";
  let replyToken = 0;

  const related = ref<BiliVideo[]>([]);
  const relatedStatus = ref<BiliStatus>("idle");
  let relatedToken = 0;

  /** 评论挂在 aid 上：优先取当前推荐条目，其次详情（两者到达顺序不定） */
  function commentAid(): string {
    return current.value?.aid || detail.value?.aid || "";
  }

  /** 标「UP 主」用的 UP mid；详情没回来时先按 0（不标） */
  function upMidOf(): number {
    return detail.value?.owner.mid ?? 0;
  }

  /** 离开/切换视频时清空评论与相关推荐，避免下一条视频先闪一眼上一条的内容 */
  function resetDiscussions(): void {
    replies.value = [];
    replyTotal.value = 0;
    replyStatus.value = "idle";
    replyError.value = "";
    replyLoadingMore.value = false;
    replyEnd.value = false;
    subReplies.value = {};
    subBusy.value = {};
    subEnds.value = {};
    replyOffset = "";
    related.value = [];
    relatedStatus.value = "idle";
    relation.value = null;
    acting.value = {};
  }

  /**
   * 拉评论。`reset` 为真表示重开一轮（首次进入 / 切排序）。
   *
   * 两个细节：置顶评论也会出现在正常列表里，要按 rpid 去重；分页游标是
   * `cursor.pagination_reply.next_offset`，`is_end` 才是权威的到底标志。
   */
  async function loadReplies(reset = true): Promise<void> {
    const aid = commentAid();
    if (!aid) return;
    const token = reset ? ++replyToken : replyToken;
    if (reset) {
      replyStatus.value = "loading";
      replyError.value = "";
      replyEnd.value = false;
      replyOffset = "";
      subReplies.value = {};
      subEnds.value = {};
    }
    try {
      const page = await biliReplies(aid, replySort.value, reset ? "" : replyOffset, upMidOf());
      if (token !== replyToken) return;
      const merged = reset ? [...page.top, ...page.replies] : [...replies.value, ...page.replies];
      const seen = new Set<string>();
      const unique: BiliReply[] = [];
      for (const r of merged) {
        if (seen.has(r.rpid)) continue;
        seen.add(r.rpid);
        unique.push(r);
      }
      replies.value = unique;
      replyTotal.value = page.total || unique.length;
      replyOffset = page.nextOffset;
      replyEnd.value = page.isEnd || !page.nextOffset;
      replyStatus.value = "ready";
    } catch (e) {
      if (token !== replyToken) return;
      replyError.value = cleanError(e);
      replyStatus.value = "error";
    }
  }

  async function loadMoreReplies(): Promise<void> {
    if (replyStatus.value === "loading" || replyLoadingMore.value || replyEnd.value) return;
    replyLoadingMore.value = true;
    try {
      await loadReplies(false);
    } finally {
      replyLoadingMore.value = false;
    }
  }

  async function setReplySort(sort: BiliReplySort): Promise<void> {
    if (sort === replySort.value) return;
    replySort.value = sort;
    replies.value = [];
    await loadReplies(true);
  }

  /** 楼中楼：未展开 → 拉第一页；已展开 → 收起；`more` 为真 → 追加下一页。 */
  async function loadSubReplies(rpid: string, more = false): Promise<void> {
    const aid = commentAid();
    if (!aid || subBusy.value[rpid]) return;
    if (subReplies.value[rpid] && !more) {
      const next = { ...subReplies.value };
      delete next[rpid];
      subReplies.value = next;
      return;
    }
    // 每页 20 条（见 utils 里的 ps），据此推算下一页页码
    const page = more ? Math.floor((subReplies.value[rpid]?.length ?? 0) / 20) + 1 : 1;
    subBusy.value = { ...subBusy.value, [rpid]: true };
    try {
      const r = await biliReplyReplies(aid, rpid, page, upMidOf());
      subReplies.value = {
        ...subReplies.value,
        [rpid]: more ? [...(subReplies.value[rpid] ?? []), ...r.replies] : r.replies,
      };
      subEnds.value = { ...subEnds.value, [rpid]: r.isEnd };
    } catch (e) {
      notice.value = `加载回复失败：${cleanError(e)}`;
    } finally {
      const busy = { ...subBusy.value };
      delete busy[rpid];
      subBusy.value = busy;
    }
  }

  /** 相关推荐（右栏）。失败就静默成空列表：它只是辅助内容，不该挡住播放。 */
  async function loadRelated(bvid: string): Promise<void> {
    const token = ++relatedToken;
    relatedStatus.value = "loading";
    try {
      const list = await biliRelated(bvid);
      if (token !== relatedToken) return;
      related.value = list;
      relatedStatus.value = "ready";
    } catch {
      if (token !== relatedToken) return;
      related.value = [];
      relatedStatus.value = "error";
    }
  }

  // -------------------------------------------------------- 互动（三连 / 关注）
  const relation = ref<BiliRelation | null>(null);
  /** 写操作忙碌标记（like / coin / fav / follow 各自独立，互不禁用） */
  const acting = ref<Record<string, boolean>>({});
  /** 默认收藏夹 id 缓存；id 跟着账号走，换号必须重取 */
  let favFolderId = "";
  let favFolderFor = -1;

  async function loadRelation(): Promise<void> {
    const aid = commentAid();
    if (!aid || !biliIsLoggedIn()) {
      relation.value = null;
      return;
    }
    try {
      relation.value = await biliRelation(aid);
    } catch {
      // 未登录 / 被风控：按钮退回未激活态就行，不必打扰用户
      relation.value = null;
    }
  }

  /** 统一包一层：防重复点击、成败都提示；成功返回 true，调用方据此更新本地状态。 */
  async function act(key: string, run: () => Promise<void>, okMsg: string): Promise<boolean> {
    if (acting.value[key]) return false;
    acting.value = { ...acting.value, [key]: true };
    try {
      await run();
      notice.value = okMsg;
      return true;
    } catch (e) {
      notice.value = cleanError(e);
      return false;
    } finally {
      const busy = { ...acting.value };
      delete busy[key];
      acting.value = busy;
    }
  }

  /**
   * 点互动按钮前先确保拿到最新状态。
   *
   * 这一步不是多余的：本地状态为空时若直接按「未点赞」取反，就会把「取消点赞」
   * 当成「点赞」发出去（反之亦然），而且是不可逆的误操作。
   */
  async function ensureRelation(): Promise<BiliRelation> {
    if (!relation.value) await loadRelation();
    return relation.value ?? BILI_RELATION_NONE;
  }

  function bumpStat(field: "like" | "coin" | "favorite", delta: number): void {
    const d = detail.value;
    if (!d) return;
    detail.value = { ...d, stat: { ...d.stat, [field]: Math.max(0, d.stat[field] + delta) } };
  }

  async function toggleLike(): Promise<void> {
    const aid = commentAid();
    if (!aid) return;
    const rel = await ensureRelation();
    const next = !rel.liked;
    if (!(await act("like", () => biliLike(aid, next), next ? "已点赞" : "已取消点赞"))) return;
    relation.value = { ...rel, liked: next };
    bumpStat("like", next ? 1 : -1);
  }

  async function addCoin(count = 1): Promise<void> {
    const aid = commentAid();
    if (!aid) return;
    const rel = await ensureRelation();
    if (rel.coin >= 2) {
      notice.value = "已经投过两枚硬币了";
      return;
    }
    const add = Math.min(count, 2 - rel.coin);
    if (!(await act("coin", () => biliCoin(aid, add), `已投 ${add} 枚硬币`))) return;
    relation.value = { ...rel, coin: rel.coin + add };
    bumpStat("coin", add);
  }

  /** 收藏到「默认收藏夹」（上游列表的第一项）。要挑收藏夹再展开成分组弹窗。 */
  async function toggleFavorite(): Promise<void> {
    const aid = commentAid();
    if (!aid) return;
    const rel = await ensureRelation();
    if (favFolderFor !== account.value.mid) {
      favFolderId = "";
      favFolderFor = account.value.mid;
    }
    if (!favFolderId) {
      try {
        const folders = await biliFavFolders(account.value.mid);
        favFolderId = folders[0]?.id ?? "";
      } catch (e) {
        notice.value = cleanError(e);
        return;
      }
    }
    if (!favFolderId) {
      notice.value = "账号下没有可用的收藏夹";
      return;
    }
    const next = !rel.favored;
    if (
      !(await act(
        "fav",
        () => biliFavorite(aid, favFolderId, next),
        next ? "已收藏到默认收藏夹" : "已取消收藏",
      ))
    ) {
      return;
    }
    relation.value = { ...rel, favored: next };
    bumpStat("favorite", next ? 1 : -1);
  }

  async function toggleFollow(): Promise<void> {
    const mid = detail.value?.owner.mid ?? 0;
    if (!mid) return;
    const rel = await ensureRelation();
    const next = !rel.followed;
    if (!(await act("follow", () => biliFollow(mid, next), next ? "已关注" : "已取消关注"))) return;
    relation.value = { ...rel, followed: next };
  }

  /** 分享：桌面端最实用的就是把链接复制走（复制不可用就把链接本身显示出来）。 */
  async function shareVideo(): Promise<void> {
    const bvid = detail.value?.bvid || current.value?.bvid;
    if (!bvid) return;
    const url = `https://www.bilibili.com/video/${bvid}`;
    try {
      await navigator.clipboard.writeText(url);
      notice.value = "视频链接已复制";
    } catch {
      notice.value = url;
    }
  }

  // ---- 弹幕（按 cid 缓存）----
  const danmakuCache = new Map<string, ArtDanmu[]>();
  const danmakuLoading = new Map<string, Promise<ArtDanmu[]>>();

  async function loadDanmaku(cid: string): Promise<ArtDanmu[]> {
    if (!cid) return [];
    const cached = danmakuCache.get(cid);
    if (cached) return cached;
    const inflight = danmakuLoading.get(cid);
    if (inflight) return inflight;
    const task = biliDanmaku(cid)
      .then((items) => {
        danmakuCache.set(cid, items);
        return items;
      })
      .finally(() => danmakuLoading.delete(cid));
    danmakuLoading.set(cid, task);
    return task;
  }

  // -------------------------------------------------------- 发表评论
  const replySending = ref(false);

  /**
   * 发表评论 / 回复。
   *
   * 成功后只把新评论插到本地列表头部（并就地 +1 总数），不整页重拉：重拉会把用户
   * 刚打的东西「闪一下」，在长评论区还会丢掉滚动位置。
   */
  async function postReply(message: string, root = "", parent = ""): Promise<boolean> {
    const aid = commentAid();
    if (!aid) return false;
    const text = message.trim();
    if (!text || replySending.value) return false;
    replySending.value = true;
    try {
      await biliAddReply(aid, text, root, parent);
      notice.value = root ? "回复已发送" : "评论已发送";
      // 回复直接刷新当前楼，一级评论只做本地插入
      if (root) {
        // 展开态才有楼中楼列表；未展开时上游预览也不含新回复，统一重拉该楼第一页
        const next = { ...subReplies.value };
        delete next[root];
        subReplies.value = next;
        await loadSubReplies(root);
      } else {
        await loadReplies(true);
      }
      return true;
    } catch (e) {
      notice.value = cleanError(e);
      return false;
    } finally {
      replySending.value = false;
    }
  }

  // -------------------------------------------------------- 我的：历史 / 收藏 / 投稿

  // ---- 历史 ----
  const history = ref<BiliVideo[]>([]);
  const historyStatus = ref<BiliStatus>("idle");
  const historyError = ref("");
  const historyEnd = ref(false);
  const historyLoadingMore = ref(false);
  const historyCursor = ref({ max: 0, viewAt: 0 });
  let historyToken = 0;

  async function loadHistory(refresh = true): Promise<void> {
    const token = refresh ? ++historyToken : historyToken;
    if (refresh) {
      historyStatus.value = "loading";
      historyError.value = "";
      historyEnd.value = false;
      historyCursor.value = { max: 0, viewAt: 0 };
    }
    try {
      const cursor = refresh ? { max: 0, viewAt: 0 } : historyCursor.value;
      const page = await biliHistory(20, cursor.max, cursor.viewAt);
      if (token !== historyToken) return;
      history.value = refresh ? page.videos : [...history.value, ...page.videos];
      historyCursor.value = page.cursor;
      historyEnd.value = page.isEnd;
      historyStatus.value = "ready";
    } catch (e) {
      if (token !== historyToken) return;
      historyError.value = cleanError(e);
      historyStatus.value = history.value.length ? "ready" : "error";
    }
  }

  async function loadMoreHistory(): Promise<void> {
    if (historyStatus.value === "loading" || historyLoadingMore.value || historyEnd.value) return;
    historyLoadingMore.value = true;
    try {
      await loadHistory(false);
    } finally {
      historyLoadingMore.value = false;
    }
  }

  // ---- 收藏 ----
  const favFolders = ref<{ id: number; title: string; mediaCount: number }[]>([]);
  const favMediaId = ref(0);
  const favVideos = ref<BiliVideo[]>([]);
  const favStatus = ref<BiliStatus>("idle");
  const favError = ref("");
  const favEnd = ref(false);
  const favLoadingMore = ref(false);
  const favPage = ref(1);
  let favToken = 0;

  /** 拉收藏夹列表；首次进入「我的」时调用。 */
  async function loadFavFolders(): Promise<void> {
    if (!account.value.mid) return;
    try {
      favFolders.value = await biliFavFoldersAll(account.value.mid);
      if (!favMediaId.value && favFolders.value.length) {
        favMediaId.value = favFolders.value[0].id;
      }
    } catch (e) {
      favError.value = cleanError(e);
    }
  }

  async function loadFavorites(refresh = true, mediaId?: number): Promise<void> {
    if (mediaId !== undefined && mediaId !== favMediaId.value) {
      favMediaId.value = mediaId;
      refresh = true;
    }
    if (!favMediaId.value) return;
    const token = refresh ? ++favToken : favToken;
    if (refresh) {
      favStatus.value = "loading";
      favError.value = "";
      favEnd.value = false;
      favPage.value = 1;
    }
    try {
      const page = refresh ? 1 : favPage.value;
      const res = await biliFavResources(favMediaId.value, page, 20, account.value.mid);
      if (token !== favToken) return;
      favVideos.value = refresh ? res.videos : [...favVideos.value, ...res.videos];
      favPage.value = page + 1;
      favEnd.value = res.isEnd || res.videos.length === 0;
      favStatus.value = "ready";
    } catch (e) {
      if (token !== favToken) return;
      favError.value = cleanError(e);
      favStatus.value = favVideos.value.length ? "ready" : "error";
    }
  }

  async function loadMoreFavorites(): Promise<void> {
    if (favStatus.value === "loading" || favLoadingMore.value || favEnd.value) return;
    favLoadingMore.value = true;
    try {
      await loadFavorites(false);
    } finally {
      favLoadingMore.value = false;
    }
  }

  // ---- 我的投稿 ----
  const myVideos = ref<BiliVideo[]>([]);
  const myStatus = ref<BiliStatus>("idle");
  const myError = ref("");
  const myEnd = ref(false);
  const myLoadingMore = ref(false);
  const myPage = ref(1);
  const myTotal = ref(0);
  let myToken = 0;

  async function loadMyVideos(refresh = true): Promise<void> {
    if (!account.value.mid) return;
    const token = refresh ? ++myToken : myToken;
    if (refresh) {
      myStatus.value = "loading";
      myError.value = "";
      myEnd.value = false;
      myPage.value = 1;
    }
    try {
      const page = refresh ? 1 : myPage.value;
      const res = await biliUserVideos(account.value.mid, page, 30);
      if (token !== myToken) return;
      myVideos.value = refresh ? res.videos : [...myVideos.value, ...res.videos];
      myTotal.value = res.total;
      myPage.value = page + 1;
      myEnd.value = res.isEnd || res.videos.length === 0;
      myStatus.value = "ready";
    } catch (e) {
      if (token !== myToken) return;
      myError.value = cleanError(e);
      myStatus.value = myVideos.value.length ? "ready" : "error";
    }
  }

  async function loadMoreMyVideos(): Promise<void> {
    if (myStatus.value === "loading" || myLoadingMore.value || myEnd.value) return;
    myLoadingMore.value = true;
    try {
      await loadMyVideos(false);
    } finally {
      myLoadingMore.value = false;
    }
  }

  /** 「我的」页首屏：账号信息 + 投稿 + 收藏夹（历史按需加载）。 */
  async function loadMine(): Promise<void> {
    if (!account.value.isLogin) return;
    await Promise.all([loadMyVideos(true), loadFavFolders()]);
  }

  // -------------------------------------------------------- UP 主主页
  const userMid = ref(0);
  const userCard = ref<BiliUserCard | null>(null);
  const userVideos = ref<BiliVideo[]>([]);
  const userStatus = ref<BiliStatus>("idle");
  const userError = ref("");
  const userEnd = ref(false);
  const userLoadingMore = ref(false);
  const userPage = ref(1);
  const userTotal = ref(0);
  let userToken = 0;

  /** 打开 UP 主主页（同时拉名片与首页投稿）。 */
  async function openUser(mid: number): Promise<void> {
    if (!mid) return;
    const token = ++userToken;
    userMid.value = mid;
    userCard.value = null;
    userVideos.value = [];
    userStatus.value = "loading";
    userError.value = "";
    userEnd.value = false;
    userPage.value = 1;
    try {
      const [card, list, followed] = await Promise.all([
        biliUserCard(mid),
        biliUserVideos(mid, 1, 30),
        // 关注状态失败不该拖垮整页：单独 catch 成未关注即可
        biliUserRelation(mid).catch(() => false),
      ]);
      if (token !== userToken) return;
      userCard.value = card;
      userVideos.value = list.videos;
      userTotal.value = list.total;
      userPage.value = 2;
      userEnd.value = list.isEnd;
      userFollowed.value = followed;
      userStatus.value = "ready";
    } catch (e) {
      if (token !== userToken) return;
      userError.value = cleanError(e);
      userStatus.value = "error";
    }
  }

  async function loadMoreUserVideos(): Promise<void> {
    if (!userMid.value || userStatus.value === "loading" || userLoadingMore.value) return;
    if (userEnd.value) return;
    userLoadingMore.value = true;
    const token = userToken;
    try {
      const res = await biliUserVideos(userMid.value, userPage.value, 30);
      if (token !== userToken) return;
      userVideos.value = [...userVideos.value, ...res.videos];
      userPage.value += 1;
      userEnd.value = res.videos.length === 0 || res.isEnd;
    } catch (e) {
      if (token !== userToken) return;
      userError.value = cleanError(e);
      userEnd.value = true;
    } finally {
      userLoadingMore.value = false;
    }
  }

  function closeUser(): void {
    userToken += 1;
    userMid.value = 0;
    userCard.value = null;
    userVideos.value = [];
    userStatus.value = "idle";
    userError.value = "";
  }

  /** UP 主是否已被关注（当前详情页的 relation 只对当前视频的 UP 有效）。 */
  const userFollowed = ref(false);
  const userFollowBusy = ref(false);

  async function toggleUserFollow(): Promise<void> {
    const mid = userMid.value;
    if (!mid || userFollowBusy.value) return;
    userFollowBusy.value = true;
    try {
      const next = !userFollowed.value;
      await biliFollow(mid, next);
      userFollowed.value = next;
      notice.value = next ? "已关注" : "已取消关注";
    } catch (e) {
      notice.value = cleanError(e);
    } finally {
      userFollowBusy.value = false;
    }
  }

  /** 从视频详情里点 UP 头像 / 名字进主页。 */
  function openCurrentUp(): void {
    const mid = detail.value?.owner.mid || current.value?.ownerMid || 0;
    if (mid) void openUser(mid);
  }

  return {
    notice,
    clearNotice,
    // 账号
    account,
    accountLoaded,
    accountLoading,
    loadAccount,
    logout,
    isLoggedIn: () => biliIsLoggedIn(),
    // 推荐
    feed,
    feedStatus,
    feedLoadingMore,
    feedError,
    loadFeed,
    loadMoreFeed,
    // 搜索
    keyword,
    results,
    searchStatus,
    searchLoadingMore,
    searchError,
    searchEnd,
    search,
    loadMoreSearch,
    // 登录
    qrContent,
    qrStatus,
    startingQr,
    loginError,
    qrExpired,
    qrStatusText,
    startQr,
    pollQr,
    resetQr,
    // 详情 / 播放
    current,
    detail,
    play,
    activeCid,
    activeQn,
    detailStatus,
    playStatus,
    playError,
    openVideo,
    selectQuality,
    selectPart,
    closeVideo,
    loadDanmaku,
    // 评论 / 相关推荐
    replies,
    replyTotal,
    replySort,
    replyStatus,
    replyError,
    replyLoadingMore,
    replyEnd,
    subReplies,
    subBusy,
    subEnds,
    loadReplies,
    loadMoreReplies,
    setReplySort,
    loadSubReplies,
    postReply,
    replySending,
    related,
    relatedStatus,
    // 搜索历史
    searchHistory,
    loadSearchHistory,
    rememberSearch,
    removeSearchHistory,
    clearSearchHistory,
    // 我的：历史 / 收藏 / 投稿
    history,
    historyStatus,
    historyError,
    historyEnd,
    historyLoadingMore,
    loadHistory,
    loadMoreHistory,
    favFolders,
    favMediaId,
    favVideos,
    favStatus,
    favError,
    favEnd,
    favLoadingMore,
    loadFavFolders,
    loadFavorites,
    loadMoreFavorites,
    myVideos,
    myStatus,
    myError,
    myEnd,
    myLoadingMore,
    myTotal,
    loadMyVideos,
    loadMoreMyVideos,
    loadMine,
    // UP 主主页
    userMid,
    userCard,
    userVideos,
    userStatus,
    userError,
    userEnd,
    userLoadingMore,
    userTotal,
    userFollowed,
    userFollowBusy,
    openUser,
    loadMoreUserVideos,
    closeUser,
    toggleUserFollow,
    openCurrentUp,
    // 互动
    relation,
    acting,
    loadRelation,
    toggleLike,
    addCoin,
    toggleFavorite,
    toggleFollow,
    shareVideo,
  };
});
