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
  biliHeartbeat,
  biliHistory,
  biliIsLoggedIn,
  biliLikeReply,
  biliLastPlay,
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
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";
import type { ArtDanmu } from "@/utils/danmaku";

export type BiliStatus = "idle" | "loading" | "ready" | "error";

function cleanError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/^Error:\s*/, "");
}

/**
 * 取词：store 里也有用户可见文案（notice / 错误提示）。
 *
 * 硬编码中文会让 EN 界面破功（项目里其他 store 也是这么取词的，
 * 见 stores/player.ts 的 translate(useSettingsStore().lang, …)）。
 */
function t(key: string, vars?: Record<string, string>): string {
  let s = translate(useSettingsStore().lang, key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
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
      const next = await biliNav();
      // 换号（或从匿名变登录）：旧账号的收藏夹 / 投稿 / 历史都不能留
      if (next.mid !== account.value.mid) resetAccountData();
      account.value = next;
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
      if (!list.length) searchError.value = t("bili.searchEmptyResult");
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
      // 刻意不置 searchEnd：一次瞬时抖动就把后续分页永久关掉，用户再也翻不了页；
      // 「到底」只能由服务端契约（空页 / isEnd）决定。
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
        notice.value = t("bili.loggedInAs", { name: account.value.name || t("bili.biliUser") });
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

  /** 清空所有「跟着账号走」的数据（退出登录 / 换号时调用）。 */
  function resetAccountData(): void {
    // 收藏夹 id 是账号私有的：不清掉的话，换号后 loadFavorites 会拿旧 id 去查
    favFolders.value = [];
    favMediaId.value = 0;
    favVideos.value = [];
    favStatus.value = "idle";
    favError.value = "";
    favPage.value = 1;
    favEnd.value = false;
    myVideos.value = [];
    myStatus.value = "idle";
    myError.value = "";
    myPage.value = 1;
    myEnd.value = false;
    myTotal.value = 0;
    history.value = [];
    historyStatus.value = "idle";
    historyError.value = "";
    historyCursor.value = { max: 0, viewAt: 0 };
    historyEnd.value = false;
  }

  async function logout(): Promise<void> {
    await biliLogout();
    account.value = { ...BILI_ANONYMOUS };
    resetAccountData();
    notice.value = t("bili.loggedOut");
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
  /**
   * 同一视频内的取流序号。
   *
   * `openToken` 只在「换视频」时变化，区分不了「同一视频连续切两次清晰度」：
   * 两个 playurl 并发时后发的可能先回，先发的后回就会覆盖界面上的清晰度。
   */
  let playToken = 0;

  // ---- 续播 / 进度上报 ----
  /** 这条视频要起播的位置（秒）；0 表示从头播 */
  const resumeAt = ref(0);
  /**
   * 进度上报节流。
   *
   * 上游对 heartbeat 有频控（实测短时间高频会回 -799），所以按 15s 一次上报；
   * 暂停 / 关闭浮层 / 切分 P 时再补一次，保证「退出前看到哪」不丢。
   */
  let heartbeatTimer: number | null = null;
  let lastReported = -1;

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      window.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** 立即上报一次当前进度（失败静默：它只是锦上添花，不该弹错打扰观看）。 */
  function reportProgress(seconds: number): void {
    // 用户可关闭观看记录（对标 PiliPlus 的 historyPause）
    if (!useSettingsStore().biliHistoryEnabled) return;
    const v = current.value;
    const cid = activeCid.value;
    // 用 cookie 判定而非 account.isLogin：-101 清凭据后 account 要等下次 nav
    // 才更新，这段时间会出现「界面显示已登录、实际发必败请求」的不一致。
    if (!v || !cid || !biliIsLoggedIn()) return;
    const t = Math.floor(seconds);
    if (t <= 0) return;
    lastReported = t;
    void biliHeartbeat(v.bvid, cid, t).catch(() => {
      // 风控 / 网络问题都吞掉：上报失败不影响播放
    });
  }

  /** 播放中按时长节流上报。 */
  function tickProgress(seconds: number): void {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = window.setTimeout(() => {
      heartbeatTimer = null;
    }, 15000);
    // 与上次上报相差太小就不发（避免同一秒重复打）。
    // lastReported < 0 表示本次会话还没报过 —— 必须发，不能因 |t-(-1)| 太小被吃掉。
    if (lastReported >= 0 && Math.abs(Math.floor(seconds) - lastReported) < 5) return;
    reportProgress(seconds);
  }

  /**
   * 打开视频时读取「上次看到」，供播放器起播定位。
   *
   * 两个要点：
   * - 上游给的是「上次看到的分 P」（`last_play_cid`）。多分 P 的视频若只顾时间轴，
   *   会拿 P1 的 cid 去 seek 到「P2 的第 10 分钟」，位置完全是错的。所以这里会先用
   *   `last.cid` 反查并预选该分 P，反查不到就干脆不 seek。
   * - 已看到 95% 以上视为看完，从头播（否则一进来就贴着结尾）。
   */
  async function loadResumePoint(bvid: string, cid: string): Promise<void> {
    resumeAt.value = 0;
    if (!useSettingsStore().biliHistoryEnabled || !cid) return;
    if (!biliIsLoggedIn()) return;
    try {
      const last = await biliLastPlay(bvid, cid);
      if (last.seconds <= 5) return;

      // 上游记录了另一个分 P → 先切过去，再按那一分 P 的时长判断是否看完
      const parts = detail.value?.parts ?? [];
      if (last.cid && last.cid !== cid && parts.length) {
        const target = parts.find((p) => p.cid === last.cid);
        if (target) {
          activeCid.value = target.cid;
          const total = target.duration || 0;
          if (!total || last.seconds < total * 0.95) resumeAt.value = last.seconds;
          return;
        }
        // 反查不到（分 P 被删 / 数据不同步）：宁可从头播，也不要跳错位置
        return;
      }

      const total = detail.value?.duration ?? current.value?.duration ?? 0;
      if (!total || last.seconds < total * 0.95) resumeAt.value = last.seconds;
    } catch (e) {
      // 读不到进度就从 0 播，但留一条日志便于排查（续播静默失效最难查）
      console.warn("[bilibili] 读取续播点失败：", e);
    }
  }

  async function resolvePlay(token: number, qn?: number): Promise<void> {
    const v = current.value;
    if (!v) return;
    const myPlay = ++playToken;
    if (!activeCid.value) {
      playError.value = "该视频缺少 cid，无法解析播放地址";
      playStatus.value = "error";
      return;
    }
    playStatus.value = "loading";
    playError.value = "";
    try {
      const p = await biliPlayUrl(v.bvid, activeCid.value, qn ?? activeQn.value);
      // 两次校验：换视频（openToken）与同一视频内重复取流（playToken）都要拦
      if (token !== openToken || myPlay !== playToken) return;
      play.value = p;
      // 用户没手动选过 → 直接落到最高档，避免被上游的默认 quality 拖回 720P
      if (!qualityPinned.value && p.qualities.length) {
        activeQn.value = p.qualities[0];
      } else if (p.quality) {
        activeQn.value = p.quality;
      }
      playStatus.value = "ready";
    } catch (e) {
      if (token !== openToken || myPlay !== playToken) return;
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
    resumeAt.value = 0;
    lastReported = -1;
    stopHeartbeat();
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
      // 续播点必须**先于**取流拿到：mountDash 起播时要一次性给对 startTime，
      // 若并行则可能在播放器已挂载后才返回，表现为「从头开始播」。
      // 时长判断要 detail，所以这一步只能排在这里（详情已在上面 await 过）。
      await loadResumePoint(video.bvid, activeCid.value);
      if (token !== openToken) return;
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

  async function selectPart(cid: string, playedSeconds = 0): Promise<void> {
    if (cid === activeCid.value) return;
    const token = openToken;
    // 切分 P 前先上报旧分 P 的进度，否则那一段的观看记录会丢
    if (playedSeconds > 0) reportProgress(playedSeconds);
    activeCid.value = cid;
    resumeAt.value = 0;
    lastReported = -1;
    // 必须先拿到续播点再取流：resolvePlay 会让 play.value 变化，播放器随即挂载
    // 并读 resumeAt；排在后面的话写回的值没人消费，切分 P 的断点必然丢失。
    await loadResumePoint(current.value?.bvid ?? "", cid);
    if (token !== openToken) return;
    await resolvePlay(openToken);
  }

  function closeVideo(playedSeconds = 0): void {
    // 关闭前补报一次：这是「退出时看到哪」唯一的落点
    if (playedSeconds > 0) reportProgress(playedSeconds);
    stopHeartbeat();
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
      notice.value = `${t("bili.replyLoadFailed")}：${cleanError(e)}`;
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

  /**
   * 给评论点赞 / 取消点赞。
   *
   * 先本地乐观更新（点赞数 ±1、状态取反），失败再回滚 —— 评论点赞是高频轻操作，
   * 等一个来回再变色会让手感很钝。
   */
  async function toggleReplyLike(r: BiliReply): Promise<void> {
    const aid = commentAid();
    if (!aid) return;
    const key = `reply-like-${r.rpid}`;
    if (acting.value[key]) return;
    const next = !r.liked;
    acting.value = { ...acting.value, [key]: true };
    // 乐观更新：一级评论与楼中楼共用同一条记录（按 rpid 找）
    applyReplyLike(r.rpid, next);
    try {
      await biliLikeReply(aid, r.rpid, next);
    } catch (e) {
      applyReplyLike(r.rpid, !next);
      notice.value = cleanError(e);
    } finally {
      const busy = { ...acting.value };
      delete busy[key];
      acting.value = busy;
    }
  }

  /** 就地改某条评论的点赞态与计数（一级列表与楼中楼都覆盖）。 */
  function applyReplyLike(rpid: string, liked: boolean): void {
    const patch = (list: BiliReply[]): BiliReply[] =>
      list.map((x) =>
        x.rpid === rpid
          ? { ...x, liked, like: Math.max(0, x.like + (liked ? 1 : -1)) }
          : { ...x, replies: x.replies.length ? patch(x.replies) : x.replies },
      );
    replies.value = patch(replies.value);
    const subs = { ...subReplies.value };
    let touched = false;
    for (const [k, v] of Object.entries(subs)) {
      subs[k] = patch(v);
      if (subs[k] !== v) touched = true;
    }
    if (touched) subReplies.value = subs;
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
      notice.value = t("bili.coinAlready");
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
      notice.value = t("bili.noFavFolder");
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
      notice.value = t("bili.linkCopied");
    } catch {
      notice.value = url;
    }
  }

  // ---- 弹幕（按 cid 缓存）----
  /**
   * 弹幕缓存：按 cid 存，**带 LRU 上限**。
   *
   * 单个视频的弹幕可能有几千条，看几十个视频不动上限就会累积到几十 MB。
   * Map 保持插入序，超限时删最旧的一条即可（简单 LRU 近似，够用）。
   */
  const danmakuCache = new Map<string, ArtDanmu[]>();
  const DANMAKU_CACHE_MAX = 8;
  const danmakuLoading = new Map<string, Promise<ArtDanmu[]>>();

  function cacheDanmaku(cid: string, items: ArtDanmu[]): void {
    // 重新插入以把它挪到 Map 末尾（最近使用）
    danmakuCache.delete(cid);
    danmakuCache.set(cid, items);
    while (danmakuCache.size > DANMAKU_CACHE_MAX) {
      const oldest = danmakuCache.keys().next().value;
      if (oldest === undefined) break;
      danmakuCache.delete(oldest);
    }
  }

  async function loadDanmaku(cid: string): Promise<ArtDanmu[]> {
    if (!cid) return [];
    const cached = danmakuCache.get(cid);
    if (cached) {
      // 命中即刷新 LRU 顺序
      cacheDanmaku(cid, cached);
      return cached;
    }
    const inflight = danmakuLoading.get(cid);
    if (inflight) return inflight;
    const task = biliDanmaku(cid)
      .then((items) => {
        // 只在真拿到弹幕时写缓存：拉取失败也会返回 []，若把它缓存下来，
        // 这个 cid 就永久变成「没有弹幕」，重开弹幕也救不回来。
        if (items.length) cacheDanmaku(cid, items);
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
      // 拉到 0 个收藏夹也要落到 ready，否则界面会永远停在 loading
      if (favStatus.value === "idle") favStatus.value = "ready";
    } catch (e) {
      // 必须置 error：否则 favStatus 永远停在 idle，而 loadFavorites 在
      // 「没有 favMediaId」时会直接 return，于是错误被伪装成「这个收藏夹是空的」，
      // MinePanel 里的 error EmptyState 也就永远不可达。
      favError.value = cleanError(e);
      favStatus.value = "error";
    }
  }

  async function loadFavorites(refresh = true, mediaId?: number): Promise<void> {
    if (mediaId !== undefined && mediaId !== favMediaId.value) {
      favMediaId.value = mediaId;
      refresh = true;
    }
    if (!favMediaId.value) {
      // 没有可用的收藏夹 id（列表拉取失败 / 账号下确实没有）——给明确错误态，
      // 不能静默 return，否则界面显示「这个收藏夹还是空的」而实际是加载失败。
      favStatus.value = "error";
      if (!favError.value) favError.value = t("bili.noFavFolderShort");
      return;
    }
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

  /**
   * 「我的」页首屏：投稿 + 收藏夹（历史按需加载）。
   *
   * 默认**幂等**：投稿已经有数据就不再重拉。这个页面在子选项卡里被反复挂载
   * （SegmentedTabs 会按 key 重建面板），不守卫的话每次切回来都要发一轮请求，
   * 既慢又容易触发上游风控。需要强制刷新时传 `force`。
   */
  async function loadMine(force = false): Promise<void> {
    if (!account.value.isLogin) return;
    const needMine = force || myStatus.value === "idle" || myStatus.value === "error";
    const needFav = force || (favStatus.value === "idle" && favFolders.value.length === 0);
    await Promise.all([
      needMine ? loadMyVideos(true) : Promise.resolve(),
      needFav ? loadFavFolders() : Promise.resolve(),
    ]);
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
      // 同 loadMoreSearch：出错不等于到底，否则一次网络抖动就再也翻不了页
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
    // 续播 / 进度
    resumeAt,
    tickProgress,
    reportProgress,
    stopHeartbeat,
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
    toggleReplyLike,
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
