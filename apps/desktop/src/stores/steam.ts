// @m3e/web 无关：纯状态层。
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { capabilities, isDesktop } from "@/capabilities";
import { listen, type UnlistenFn } from "@/ipc/events";
import type {
  SteamAppDetails,
  SteamAuthState,
  SteamGame,
  SteamLibrary,
  SteamQrChallenge,
  SteamStatus,
} from "@shared/types";

/** 游戏库排序方式：最近游玩 / 名称 / 总时长 */
export type SteamSort = "recent" | "name" | "playtime";

/** 一次「状态 + 库」的完整刷新结果，供视图决定要不要显示错误态 */
interface LoadOptions {
  /** 强制绕过磁盘缓存重新拉库（refresh 按钮 / 重连） */
  refresh?: boolean;
  /** 只拉登录态，不动游戏库（登录成功后调用，避免多打一次大接口） */
  statusOnly?: boolean;
}

/**
 * Steam 状态层。
 *
 * 链路：组件 → 本 store → `capabilities.steam({ op, ... })`
 *       → `callBridge("steam", payload)` → electron/ipc.ts 的 steam 通道
 *       → electron/steam/（HTTPS WebAPI：认证 / 库 / 商店）。
 *
 * 三条约定（与项目其它 store 一致）：
 * - **组件不直接调 capabilities**：所有请求都从这里发出，loading / error 也在这里收敛，
 *   避免每个组件各写一套 try/catch 与状态字段；
 * - **登录态是进程级共享的**：主进程只有一个 Steam 单例，前后端都按「同一份登录态」
 *   设计，因此这里不做多账号切换；
 * - **失败不静默**：`status`/`library` 的错误都落在 `error` 上，由视图呈现并可重试。
 */
export const useSteamStore = defineStore("steam", () => {
  // ---- 登录态 ----
  const status = ref<SteamStatus>({ loggedIn: false, hasSession: false });
  /** 是否已经拉过一次 status（用于「首屏还没拉到」与「确实未登录」的区分） */
  const statusLoaded = ref(false);
  const statusLoading = ref(false);

  // ---- 游戏库 ----
  const games = ref<SteamGame[]>([]);
  const total = ref(0);
  const cachedAt = ref<number | null>(null);
  /** 宿主给的降级提示（例如「登录态已失效，显示上次缓存」） */
  const warning = ref<string | null>(null);
  const libraryLoaded = ref(false);
  const libraryLoading = ref(false);

  // ---- 登录流程 ----
  const authState = ref<SteamAuthState>({ state: "idle" });
  /** 登录/验证码提交这类**主动动作**的 loading（与轮询无关，避免轮询把按钮闪成加载态） */
  const authBusy = ref(false);
  /** 二维码挑战（challengeUrl + 轮询间隔），null 表示没在扫码 */
  const qr = ref<SteamQrChallenge | null>(null);

  // ---- 详情 ----
  /** appId → 商店详情；同一个 appId 只拉一次 */
  const details = ref<Record<string, SteamAppDetails>>({});
  const detailsLoading = ref(false);
  const detailsError = ref("");

  // ---- 公共错误 ----
  const error = ref("");

  /** 是否已登录（顶栏、库、详情都看它） */
  const loggedIn = computed(() => status.value.loggedIn);
  /** 有会话但没登进去 —— 提供「重连」入口 */
  const needsReconnect = computed(
    () => statusLoaded.value && !status.value.loggedIn && status.value.hasSession,
  );
  /** 顶栏展示名：昵称优先，其次账号名 */
  const displayName = computed(() => status.value.personaName || status.value.accountName || "");
  /** 全库总时长（分钟） */
  const totalPlaytimeMinutes = computed(() =>
    games.value.reduce((sum, g) => sum + (g.playtimeMinutes || 0), 0),
  );

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // ---- 事件订阅：宿主推送登录状态变化 ----
  let unlisten: UnlistenFn | null = null;
  let listening = false;

  /**
   * 订阅 `steam:auth`（宿主在登录状态变化时推送）。
   *
   * 幂等：多次调用只挂一个监听器；浏览器预览没有宿主事件，静默跳过。
   */
  async function subscribe(): Promise<void> {
    if (listening || !isDesktop) return;
    listening = true;
    try {
      unlisten = await listen<SteamAuthState>("steam:auth", (event) => {
        const next = event.payload;
        if (!next || typeof next !== "object") return;
        authState.value = next;
        if (next.status) status.value = next.status;
        if (next.state === "authenticated") {
          statusLoaded.value = true;
          void loadLibrary();
        }
      });
    } catch {
      // 宿主未提供该事件时不影响主流程（登录仍可用 op 轮询推进）
      listening = false;
    }
  }

  /** 取消订阅（视图卸载时可调；store 常驻，一般不必要） */
  function unsubscribe(): void {
    unlisten?.();
    unlisten = null;
    listening = false;
  }

  // ---- 动作：登录态 ----

  /** 只拉登录态。返回最新 status，失败时把错误写进 error 并返回已知值。 */
  async function loadStatus(): Promise<SteamStatus> {
    statusLoading.value = true;
    try {
      const next = await capabilities.steam<SteamStatus>({ op: "status" });
      status.value = next;
      statusLoaded.value = true;
      return next;
    } catch (e) {
      error.value = messageOf(e);
      statusLoaded.value = true;
      return status.value;
    } finally {
      statusLoading.value = false;
    }
  }

  /** 拉游戏库。`refresh` 时带 refresh 参数绕过宿主磁盘缓存。 */
  async function loadLibrary(refresh = false): Promise<void> {
    libraryLoading.value = true;
    error.value = "";
    try {
      const lib = await capabilities.steam<SteamLibrary>(
        refresh ? { op: "refreshLibrary" } : { op: "library", refresh: false },
      );
      games.value = lib.games ?? [];
      total.value = lib.total ?? games.value.length;
      cachedAt.value = lib.cachedAt ?? null;
      warning.value = lib.warning ?? null;
      libraryLoaded.value = true;
      // 库能拉通说明登录态有效；顺手同步一次状态，省一次 status 调用
      if (!status.value.loggedIn) {
        status.value = { ...status.value, loggedIn: true };
      }
    } catch (e) {
      error.value = messageOf(e);
      libraryLoaded.value = true;
    } finally {
      libraryLoading.value = false;
    }
  }

  /**
   * 首屏加载：先拿登录态，已登录再拉库。
   *
   * 顺序不能反：未登录时拉库在真实宿主会抛「尚未登录」，白留一条错误提示。
   */
  async function load(options: LoadOptions = {}): Promise<void> {
    error.value = "";
    await loadStatus();
    if (status.value.loggedIn && !options.statusOnly) {
      await loadLibrary(options.refresh ?? false);
    }
  }

  /** 顶栏刷新按钮：强制重拉库（登录态失效时先提示重连） */
  async function refresh(): Promise<void> {
    if (!status.value.loggedIn) {
      // 没登录时「刷新」等价于重连：先刷新状态看能不能恢复会话
      await reconnect();
      return;
    }
    await loadLibrary(true);
  }

  /**
   * 重连：会话存在但 token 过期时用。
   *
   * 先重新读 status（宿主会自动用 refresh_token 换 access_token），
   * 换出来了再拉库；换不出来就把错误留在 error 上。
   */
  async function reconnect(): Promise<void> {
    await loadStatus();
    if (status.value.loggedIn) {
      await loadLibrary(true);
      return;
    }
    if (!error.value) error.value = "会话仍不可用，请重新登录";
  }

  /** 退出登录：宿主删会话 + 清内存态 */
  async function logout(): Promise<void> {
    authBusy.value = true;
    error.value = "";
    try {
      await capabilities.steam<null>({ op: "logout" });
      games.value = [];
      total.value = 0;
      cachedAt.value = null;
      warning.value = null;
      libraryLoaded.value = false;
      details.value = {};
      authState.value = { state: "idle" };
      qr.value = null;
      // 退出后仍保留 hasSession 语义由宿主决定（删了会话就是 false）
      status.value = { loggedIn: false, hasSession: status.value.hasSession };
      await loadStatus();
    } catch (e) {
      error.value = messageOf(e);
    } finally {
      authBusy.value = false;
    }
  }

  // ---- 动作：登录流程 ----

  /** 方式一：开始扫码。返回 challengeUrl + interval（秒）。 */
  async function startQr(): Promise<SteamQrChallenge | null> {
    authBusy.value = true;
    error.value = "";
    try {
      const res = await capabilities.steam<SteamQrChallenge>({ op: "loginQrStart" });
      qr.value = res;
      authState.value = {
        state: "pending",
        message: res.message ?? null,
      };
      return res;
    } catch (e) {
      error.value = messageOf(e);
      qr.value = null;
      authState.value = { state: "failed", message: error.value };
      return null;
    } finally {
      authBusy.value = false;
    }
  }

  /**
   * 轮询一次扫码结果。
   *
   * **不设 authBusy**：轮询是后台动作，若共用 loading 会让二维码区不停闪。
   * 返回 true 表示流程已结束（成功或失败），调用方据此停表。
   */
  async function pollQr(): Promise<boolean> {
    try {
      const next = await capabilities.steam<SteamAuthState>({ op: "loginPoll" });
      authState.value = next;
      if (next.state === "authenticated") {
        qr.value = null;
        if (next.status) status.value = next.status;
        statusLoaded.value = true;
        await loadLibrary();
        return true;
      }
      if (next.state === "failed") {
        error.value = next.message || "登录失败";
        return true;
      }
      if (next.state === "guard") return false; // 扫码流程一般不会进 guard，留着兜底
      return false;
    } catch (e) {
      error.value = messageOf(e);
      authState.value = { state: "failed", message: error.value };
      return true;
    }
  }

  /** 方式二：账号密码登录。可能直接成功，也可能返回 guard。 */
  async function login(accountName: string, password: string): Promise<SteamAuthState> {
    authBusy.value = true;
    error.value = "";
    try {
      const next = await capabilities.steam<SteamAuthState>({
        op: "loginCredentials",
        accountName,
        password,
      });
      authState.value = next;
      if (next.state === "failed") error.value = next.message || "登录失败";
      if (next.state === "authenticated") {
        if (next.status) status.value = next.status;
        statusLoaded.value = true;
        await loadLibrary();
      }
      return next;
    } catch (e) {
      error.value = messageOf(e);
      const failed: SteamAuthState = { state: "failed", message: error.value };
      authState.value = failed;
      return failed;
    } finally {
      authBusy.value = false;
    }
  }

  /** 提交 Steam Guard 验证码（邮箱码 / 手机令牌） */
  async function submitGuard(code: string, codeType: "email" | "device"): Promise<SteamAuthState> {
    authBusy.value = true;
    error.value = "";
    try {
      const next = await capabilities.steam<SteamAuthState>({
        op: "submitGuard",
        code,
        codeType,
      });
      authState.value = next;
      if (next.state === "failed") error.value = next.message || "验证码校验失败";
      if (next.state === "authenticated") {
        if (next.status) status.value = next.status;
        statusLoaded.value = true;
        await loadLibrary();
      }
      return next;
    } catch (e) {
      error.value = messageOf(e);
      const failed: SteamAuthState = { state: "failed", message: error.value };
      authState.value = failed;
      return failed;
    } finally {
      authBusy.value = false;
    }
  }

  /** 方式三：恢复已保存的会话（宿主读 status 时会自动刷新 token） */
  async function resumeSession(): Promise<void> {
    await reconnect();
  }

  /** 取消登录：通知宿主清掉 pending，再复位前端流程状态 */
  async function cancelLogin(): Promise<void> {
    qr.value = null;
    authState.value = { state: "idle" };
    try {
      await capabilities.steam<null>({ op: "cancelLogin" });
    } catch {
      // 取消失败没有用户可做的补救动作，只复位前端即可
    }
  }

  // ---- 动作：商店详情 ----

  /** 取一款游戏的商店详情（已缓存则不重复请求） */
  async function fetchDetails(appId: number): Promise<SteamAppDetails | null> {
    const key = String(appId);
    const cached = details.value[key];
    if (cached) return cached;
    detailsLoading.value = true;
    detailsError.value = "";
    try {
      const res = await capabilities.steam<Record<string, SteamAppDetails>>({
        op: "appDetails",
        appIds: [appId],
      });
      const hit = res?.[key] ?? null;
      if (hit) details.value = { ...details.value, [key]: hit };
      return hit;
    } catch (e) {
      detailsError.value = messageOf(e);
      return null;
    } finally {
      detailsLoading.value = false;
    }
  }

  /** 清空详情缓存（退出登录、或用户手动重试时用） */
  function clearDetails(): void {
    details.value = {};
    detailsError.value = "";
  }

  return {
    // 状态
    status,
    statusLoaded,
    statusLoading,
    games,
    total,
    cachedAt,
    warning,
    libraryLoaded,
    libraryLoading,
    authState,
    authBusy,
    qr,
    details,
    detailsLoading,
    detailsError,
    error,
    // 派生
    loggedIn,
    needsReconnect,
    displayName,
    totalPlaytimeMinutes,
    // 动作
    subscribe,
    unsubscribe,
    load,
    loadStatus,
    loadLibrary,
    refresh,
    reconnect,
    logout,
    startQr,
    pollQr,
    login,
    submitGuard,
    resumeSession,
    cancelLogin,
    fetchDetails,
    clearDetails,
  };
});
