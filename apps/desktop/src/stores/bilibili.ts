/**
 * B 站（Bilibili）状态。
 *
 * 与在线音乐同构：一个 store + 一个 utils 归一化层（`utils/bilibili.ts`）。
 * 视频页的「B站」子选项卡共用这一份状态，因此切到「本地 / 动漫」再切回来时，
 * 登录态、推荐流、搜索词、正在看的视频都不会丢（配合 KeepAlive 的 DOM 缓存）。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { isDesktop } from "@/capabilities";
import { biliLog, biliLoginLogReset, biliLogSection } from "@/utils/biliLog";
import {
  BILI_ANONYMOUS,
  type BiliAccount,
  type BiliDetail,
  type BiliPlayUrl,
  type BiliQrStatus,
  type BiliVideo,
  biliApplyCookies,
  biliDanmaku,
  biliIsLoggedIn,
  biliLogout,
  biliNav,
  biliPlayUrl,
  biliQrGenerate,
  biliQrPoll,
  biliRecommend,
  biliSearch,
  biliVideoDetail,
} from "@/utils/bilibili";
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
      biliLog(`账号校验通过：${account.value.name || "（无昵称）"} mid=${account.value.mid}`);
    } catch (e) {
      account.value = { ...BILI_ANONYMOUS };
      accountError.value = cleanError(e);
      biliLog(`账号校验失败：${accountError.value}`);
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
    // 每开一次二维码就重开一份日志，复制/落盘拿到的正好是一条完整会话
    biliLoginLogReset();
    biliLogSection("B 站扫码登录 · 开始");
    biliLog(
      `环境：isDesktop=${isDesktop} lang=${navigator.language} 起始登录态=${
        account.value.isLogin ? "已登录" : "未登录"
      } UA=${navigator.userAgent}`,
    );
    try {
      const r = await biliQrGenerate();
      qrContent.value = r.url;
      qrKey = r.key;
    } catch (e) {
      loginError.value = `获取二维码失败：${cleanError(e)}`;
      biliLog(`申请二维码失败：${loginError.value}`);
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
        biliLogSection("服务端已确认扫码 · 开始校验登录态");
        await loadAccount();
        biliLog(`校验条①立即验：isLogin=${account.value.isLogin}`);
        if (!account.value.isLogin) {
          // 上游偶尔延迟下发凭据，再给一次机会
          await new Promise((r) => setTimeout(r, 600));
          await loadAccount();
          biliLog(`校验条②延迟 600ms 再验：isLogin=${account.value.isLogin}`);
        }
        if (!account.value.isLogin && s.alt) {
          // 凭据还有另一种编码形态（跳转链的 `,` ↔ cookie 的 `%2C`），哪种才是服务端
          // 认的形态只有 nav 说了算 —— 换上另一种再验一次，避免把可用会话判成失败。
          await biliApplyCookies(s.alt);
          await loadAccount();
          biliLog(`校验条③换成跳转链原形态再验：isLogin=${account.value.isLogin}`);
        }
        if (!account.value.isLogin) {
          // 带上上游原话（-101 / -352 …），否则这一条永远只有「获取失败」，无从下手
          loginError.value = accountError.value
            ? `已授权，但账号信息获取失败：${accountError.value}`
            : "已授权，但账号信息获取失败，请重新登录";
          biliLogSection(`登录失败 · ${loginError.value}`);
          return true;
        }
        notice.value = `欢迎回来，${account.value.name || "B 站用户"}`;
        biliLogSection(
          `登录成功 · ${account.value.name || "（无昵称）"} mid=${account.value.mid} Lv${account.value.level}`,
        );
        return true;
      }
      if (s.code === 86038) {
        qrStatusText.value = "二维码已过期，请点击刷新";
        biliLog("二维码已过期（86038），停止轮询");
        return true;
      }
      qrStatusText.value =
        s.code === 86090 ? "已扫码，请在手机上确认" : "请使用「哔哩哔哩」App 扫描二维码";
    } catch (e) {
      pollFailures += 1;
      biliLog(`轮询异常（第 ${pollFailures} 次）：${cleanError(e)}`);
      if (pollFailures >= 4) {
        loginError.value = `网络异常：${cleanError(e)}`;
        biliLogSection(`登录中断 · ${loginError.value}`);
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
      if (p.quality) activeQn.value = p.quality;
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
    activeQn.value = 80;
    try {
      const d = await biliVideoDetail(video.bvid);
      if (token !== openToken) return;
      detail.value = d;
      activeCid.value = d.parts.length ? d.parts[0].cid : d.cid || video.cid;
      detailStatus.value = "ready";
      await resolvePlay(token);
    } catch (e) {
      if (token !== openToken) return;
      playError.value = cleanError(e);
      detailStatus.value = "error";
    }
  }

  async function selectQuality(qn: number): Promise<void> {
    if (qn === activeQn.value && play.value) return;
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
  };
});
