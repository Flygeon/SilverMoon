// @m3e/web 无关：纯状态层。
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { capabilities, isDesktop } from "@/capabilities";
import { listen, type UnlistenFn } from "@/ipc/events";
import type {
  SteamAchievements,
  SteamActionResult,
  SteamAppDetails,
  SteamAuthState,
  SteamDepotInfo,
  SteamDownloadOutcome,
  SteamDownloadProgress,
  SteamGame,
  SteamGameDetail,
  SteamInstalledGame,
  SteamLibrary,
  SteamLocalLibrary,
  SteamQrChallenge,
  SteamSettings,
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

  // ---- 本地库（不需要登录）----
  //
  // 与上面的 games 是**两条独立链路**：games 来自 WebAPI（要登录、有游玩时长），
  // local 来自本机 vdf/acf（不要登录、有磁盘占用与安装路径）。
  // 因此这里单独一套 loading/error，互不覆盖。
  const localLibrary = ref<SteamLocalLibrary | null>(null);
  const localLoading = ref(false);
  const localError = ref("");

  // ---- 详情（详情页一次 gameDetail 拿全）----
  const detail = ref<SteamGameDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref("");

  // ---- Steam 目录设置 ----
  const steamSettings = ref<SteamSettings | null>(null);

  // ---- 下载（阻塞命令 + 事件进度）----
  //
  // download 命令要等所有 depot 落盘才返回（可能几分钟），进度**只能**来自
  // `steam:download` 事件。所以这里的职责是：先挂订阅、再发命令、把事件写进
  // downloadProgress，并保证同一时刻只有一个任务（后端也只有一份 CM 会话）。
  /** 当前进度（null = 没有在下载；成功后保留最后一帧，便于视图显示 100%） */
  const downloadProgress = ref<SteamDownloadProgress | null>(null);
  /** 是否有一个下载任务在跑（按钮置灰 + 面板展开都看它） */
  const downloadBusy = ref(false);
  /** 下载失败原因（后端给的可读中文原文，原样展示，不做二次翻译） */
  const downloadError = ref("");
  /** 正在下载的 appId（详情页据此判断「这个进度条是不是我的」） */
  const downloadAppId = ref<number | null>(null);
  /** depot 列表（下载面板用；op:"appDepots"） */
  const depots = ref<SteamDepotInfo[]>([]);
  const depotsLoading = ref(false);
  const depotsError = ref("");
  /** 每个 depot 的完成度（0~1），事件驱动的累积值；key = depotId */
  const depotFractions = ref<Record<number, number>>({});

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

  /**
   * 总进度百分比（0~100，整数）。
   *
   * 为什么不是简单的「字节 / 总字节」：宿主的进度事件只给**当前 depot**的
   * 字节数（depotDone / depotTotal），没有全局总字节 —— 各 depot 体积能差
   * 几个数量级，把当前 depot 的字节比例直接当总进度会让进度条反复回跳。
   *
   * 所以按「已完成 depot 个数 + 当前 depot 的字节比例」折算：
   * 每个 depot 占 1/depotsTotal，当前这个再按自身字节比例填充。
   * 事件里 depotTotal 为 0（宿主还没算出体积）时，这一段按 0 计，
   * 进度条表现为「按 depot 个数跳台阶」，不会卡死也不倒退。
   */
  const downloadPercent = computed<number>(() => {
    const progress = downloadProgress.value;
    if (!progress || !progress.depotsTotal) return 0;
    const total = progress.depotsTotal;
    const finished = Math.min(progress.depotsDone, total);
    const fraction =
      progress.depotTotal > 0 ? Math.min(1, progress.depotDone / progress.depotTotal) : 0;
    const ratio = (finished + fraction) / total;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  });

  /** 当前 depot 的已下载 / 总字节（未知总量时 total 为 0，视图据此省略分母） */
  const downloadBytes = computed<{ done: number; total: number }>(() => {
    const progress = downloadProgress.value;
    return {
      done: progress?.depotDone ?? 0,
      total: progress?.depotTotal ?? 0,
    };
  });

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

  // ---- 事件订阅：下载进度 ----
  //
  // 与上面的 steam:auth 分开一段自己的 unlisten，理由：两条事件的订阅时机
  // 不同（登录态进页面就订，下载只在真正开始下载前才需要），共用一个
  // unlisten 会让「取消下载订阅」顺手把登录态推送也断掉。
  let downloadUnlisten: UnlistenFn | null = null;
  let downloadListening = false;

  /**
   * 订阅 `steam:download`（宿主/后端在下载过程中持续推送）。
   *
   * **幂等**：多次调用只挂一个监听器，重复调用直接返回 —— 视图在每次点「安装」
   * 前都可以放心再调一次，不会攒出 N 个监听器把同一帧写 N 遍。
   *
   * 浏览器预览没有宿主事件通道，这里静默跳过（mock 的假进度在 download() 里走）。
   */
  async function subscribeDownload(): Promise<void> {
    if (downloadListening || !isDesktop) return;
    downloadListening = true;
    try {
      downloadUnlisten = await listen<SteamDownloadProgress>("steam:download", (event) => {
        const next = event.payload;
        if (!next || typeof next !== "object") return;
        downloadProgress.value = next;
        // 逐 depot 的完成度：depotDone/depotTotal 给的是**当前** depot，
        // 已完成的那些直接记 1（depotsDone 之前的都算完）。
        const fractions = { ...depotFractions.value };
        if (next.depotTotal > 0) {
          fractions[next.depotId] = Math.min(1, next.depotDone / next.depotTotal);
        }
        depotFractions.value = fractions;
      });
    } catch {
      // 宿主未提供该事件时不影响主流程（download 仍会正常返回结果）
      downloadListening = false;
    }
  }

  /** 取消下载订阅（目前视图不会主动断，store 常驻；留给测试与极端场景） */
  function unsubscribeDownload(): void {
    downloadUnlisten?.();
    downloadUnlisten = null;
    downloadListening = false;
  }

  /** 清掉上一次下载的进度 / 错误（重试或换了游戏时调，避免显示别人的进度条） */
  function resetDownload(): void {
    downloadProgress.value = null;
    downloadError.value = "";
    downloadAppId.value = null;
    depotFractions.value = {};
  }

  /**
   * 浏览器预览的假进度演示。
   *
   * mock 的 download 会立刻返回成功，没有事件可推，界面就会「点一下直接跳成功」，
   * 完全看不出下载中的样子。这里在预览环境自己走一段 1.6s 的假进度，把
   * 「进度条 + 当前文件 + depot 计数」这套 UI 走一遍，**只影响预览**：
   * 真实桌面端走的是后端事件，不会进这里。
   */
  async function runMockProgress(appId: number): Promise<void> {
    const total = 3;
    const fileNames = ["game/data.bin", "game/assets.pak", "game/engine.dll", "game/audio.ogg"];
    let tick = 0;
    downloadAppId.value = appId;
    // 必须**等假进度走完**再让 download() resolve：mock 的命令是瞬间返回的，
    // 若不等，downloadBusy 立刻变回 false，面板当场消失，进度条一帧都看不到。
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        tick += 1;
        const step = Math.floor(tick / 6);
        const withinDepot = ((tick % 6) + 1) / 6;
        const depotsDone = Math.min(total - 1, step);
        downloadProgress.value = {
          depotId: 1000 + depotsDone,
          depotDone: Math.round(withinDepot * 512 * 1024 * 1024),
          depotTotal: 512 * 1024 * 1024,
          depotsDone,
          depotsTotal: total,
          currentFile: fileNames[tick % fileNames.length],
        };
        if (tick >= 6 * total) {
          // 收尾：补一帧全完成，让进度条明确走到 100% 再退出
          window.clearInterval(timer);
          downloadProgress.value = {
            depotId: 1000 + total,
            depotDone: 512 * 1024 * 1024,
            depotTotal: 512 * 1024 * 1024,
            depotsDone: total,
            depotsTotal: total,
            currentFile: "",
          };
          resolve();
        }
      }, 260);
    });
  }

  // ---- 动作：下载 ----

  /**
   * 查 depot 列表（下载面板用）。
   *
   * 失败时宿主返回 `{ ok:false, error }` 而不是抛错，所以这里要按
   * `Array.isArray` 判别两种形态 —— 直接当数组遍历会得到一个「看着有值、
   * 实际是错误对象」的幽灵列表。
   */
  async function fetchDepots(appId: number): Promise<SteamDepotInfo[]> {
    depotsLoading.value = true;
    depotsError.value = "";
    try {
      const res = await capabilities.steamAppDepots(appId);
      if (Array.isArray(res)) {
        depots.value = res;
        return res;
      }
      depots.value = [];
      depotsError.value = res?.error || "未能获取 depot 列表";
      return [];
    } catch (e) {
      depots.value = [];
      depotsError.value = messageOf(e);
      return [];
    } finally {
      depotsLoading.value = false;
    }
  }

  /**
   * 下载一款游戏到指定目录。**阻塞** —— 直到全部 depot 落盘才返回。
   *
   * 时序不能错：**先订阅事件、再发命令**。反过来的话，宿主在订阅生效前推的
   * 头几帧进度就丢了，进度条会从中间开始。
   *
   * 返回值语义（与后端一致，不做二次包装）：
   * - `{ ok:true }`：已全部写入，顺手重扫本地库，卡片/详情页切到「开始游戏」；
   * - `{ ok:false, error }`：error 是后端写好的可读中文原文，直接展示。
   */
  async function download(appId: number, installDir: string): Promise<SteamDownloadOutcome> {
    // 同一时刻只允许一个下载任务：后端只有一份 CM 会话，并发下发只会互相踩
    if (downloadBusy.value) {
      return { ok: false, bytesWritten: 0, depots: 0, error: "已有下载任务在进行中" };
    }
    downloadBusy.value = true;
    downloadError.value = "";
    downloadAppId.value = appId;
    downloadProgress.value = null;
    depotFractions.value = {};

    // 先订阅再发命令（见上面的注释）
    await subscribeDownload();
    // 预览环境没有事件通道，自己走一段假进度，好让 UI 看得见
    // （必须 await：mock 命令瞬间返回，不等的话面板会立刻收起）
    if (!isDesktop) await runMockProgress(appId);

    try {
      const res = await capabilities.steamDownload(appId, installDir);
      if (res && res.ok) {
        // 下载完成后本地库的 acf 才更新，必须**强制重扫**，否则详情页仍按旧数据
        // 判断安装状态，卡片也不会出现「已安装」徽标。
        await loadLocalLibrary();
        // 详情页的 local 字段来自 openDetail，同步刷新一次让它切到「开始游戏」
        const detailId = detail.value?.appId;
        if (detailId === appId) await openDetail(appId);
        return res;
      }
      downloadError.value = res?.error || "下载失败";
      return res;
    } catch (e) {
      // 命令本身抛错（宿主崩溃 / 通道断开）也要落到 downloadError，由视图展示重试
      downloadError.value = messageOf(e);
      return { ok: false, bytesWritten: 0, depots: 0, error: downloadError.value };
    } finally {
      downloadBusy.value = false;
    }
  }

  /**
   * 取消下载。
   *
   * ⚠️ 后端没有取消 op：download 是阻塞命令，宿主侧也没有 kill 通道。因此
   * 前端**不能**真的中止下载，只能复位界面状态。视图里按钮呈「不可点」的
   * 下载中态，而不是给一个「取消」按钮骗用户点 —— 点了也不会停下磁盘写入。
   */
  function cancelDownload(): void {
    resetDownload();
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

  /**
   * 批量取商店详情（**DLC 名单用**）。
   *
   * 与 `fetchDetails` 的差别：
   * - 一次传多个 appId，宿主按 20 个一组打 `appdetails`，省往返；
   * - 命中缓存的直接复用，只对缺的补请求；
   * - 失败**不写 detailsError**：DLC 只是详情页的补充区块，整块消失比整页报错合理。
   *
   * 返回「本次拿到的那些」（key 是 appId 字符串），调用方自行按自己的顺序排列。
   */
  async function fetchDetailsBatch(appIds: number[]): Promise<Record<string, SteamAppDetails>> {
    const wanted = appIds.filter((n) => Number.isFinite(n) && n > 0);
    if (!wanted.length) return {};

    const hit: Record<string, SteamAppDetails> = {};
    const missing: number[] = [];
    for (const id of wanted) {
      const key = String(id);
      const cached = details.value[key];
      if (cached) hit[key] = cached;
      else if (!missing.includes(id)) missing.push(id);
    }
    if (!missing.length) return hit;

    try {
      const res = await capabilities.steam<Record<string, SteamAppDetails>>({
        op: "appDetails",
        appIds: missing,
      });
      if (res && typeof res === "object") {
        // 只有带名字的条目才值得写进缓存与返回：宿主对「已下架 / 地区不可见」的
        // appid 也会给一条残缺记录，拿它去渲染会得到一张没有名字的空卡片。
        const fresh: Record<string, SteamAppDetails> = {};
        for (const [key, value] of Object.entries(res)) {
          if (!value || !value.name) continue;
          fresh[key] = value;
        }
        if (Object.keys(fresh).length) details.value = { ...details.value, ...fresh };
        Object.assign(hit, fresh);
      }
    } catch {
      // DLC 元信息拿不到就不显示，不打扰用户（主内容已经齐了）
    }
    return hit;
  }

  /** 清空详情缓存（退出登录、或用户手动重试时用） */
  function clearDetails(): void {
    details.value = {};
    detailsError.value = "";
  }

  // ---- 动作：本地库（不依赖登录态）----

  /**
   * 拉本机已安装游戏。
   *
   * **不需要登录**：即使未登录也照拉，卡片上的「已安装」徽标与详情页的操作栏都靠它。
   * 失败只写 localError，不污染上层 error —— 登录态与本地库是两件事。
   */
  async function loadLocalLibrary(): Promise<void> {
    localLoading.value = true;
    localError.value = "";
    try {
      localLibrary.value = await capabilities.steam<SteamLocalLibrary>({ op: "localLibrary" });
    } catch (e) {
      localError.value = messageOf(e);
    } finally {
      localLoading.value = false;
    }
  }

  /** 本地库里是否装了这款（卡片徽标、详情页操作栏共用这一条判断） */
  function installedOf(appId: number): SteamInstalledGame | null {
    return localLibrary.value?.installed.find((g) => g.appId === appId) ?? null;
  }

  // ---- 动作：详情页 ----

  /**
   * 打开详情：**只发一个 gameDetail 请求**（商店元信息 + 本地安装 + 成就一次拿全）。
   *
   * 换 appId 时清掉上一款的数据，避免详情页在加载期间先闪一下别的游戏的海报。
   */
  async function openDetail(appId: number): Promise<void> {
    if (detail.value?.appId !== appId) detail.value = null;
    detailLoading.value = true;
    detailError.value = "";
    try {
      const res = await capabilities.steam<SteamGameDetail>({ op: "gameDetail", appId });
      // 只要仍是当前这款就写入（用户可能已经点返回又进了另一款）
      if (res && res.appId === appId) detail.value = res;
      else if (res && !res.appId) detail.value = { ...res, appId };
      // 顺手把本地安装信息同步进本地库缓存，卡片徽标无需再等一次 localLibrary
      syncLocalFromDetail(appId, res?.local ?? null);
    } catch (e) {
      detailError.value = messageOf(e);
    } finally {
      detailLoading.value = false;
    }
  }

  /** 把详情里的 local 并回本地库缓存（已存在则替换，不存在则忽略） */
  function syncLocalFromDetail(appId: number, local: SteamInstalledGame | null): void {
    if (!local || !localLibrary.value) return;
    const list = localLibrary.value.installed;
    const idx = list.findIndex((g) => g.appId === appId);
    if (idx < 0) return;
    const next = [...list];
    next[idx] = local;
    localLibrary.value = { ...localLibrary.value, installed: next };
  }

  /** 清空详情（离开详情页时调，避免下次进来先看到旧数据） */
  function clearDetail(): void {
    detail.value = null;
    detailError.value = "";
  }

  /** 启动游戏：失败时把宿主给的 message 抛给调用方（视图据此提示），不写 detailError */
  async function launch(appId: number): Promise<SteamActionResult> {
    try {
      return await capabilities.steam<SteamActionResult>({ op: "launchGame", appId });
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
  }

  /** 未安装时的「安装」：唤起 Steam 客户端由它接管下载 */
  async function install(appId: number): Promise<SteamActionResult> {
    try {
      return await capabilities.steam<SteamActionResult>({ op: "openInSteam", appId });
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
  }

  /**
   * 单独拉成就（详情页一般用不上：openDetail 已经带回来了）。
   *
   * 保留这个动作是为了「成就接口临时失败后原地重试」，不必整页重拉。
   */
  async function loadAchievements(appId: number): Promise<SteamAchievements | null> {
    try {
      const res = await capabilities.steam<SteamAchievements>({ op: "achievements", appId });
      if (detail.value?.appId === appId) detail.value = { ...detail.value, achievements: res };
      if (!res.available) detailError.value = "";
      return res;
    } catch (e) {
      detailError.value = messageOf(e);
      return null;
    }
  }

  // ---- 动作：Steam 目录设置 ----

  /** 读 Steam 目录设置（自动识别结果 + 自定义库目录） */
  async function loadSteamSettings(): Promise<SteamSettings | null> {
    try {
      steamSettings.value = await capabilities.steam<SteamSettings>({ op: "steamSettings" });
      return steamSettings.value;
    } catch (e) {
      localError.value = messageOf(e);
      return null;
    }
  }

  /** 保存 Steam 目录设置（写盘后以宿主返回值为准，避免前端与磁盘不一致） */
  async function saveSteamSettings(customRoots?: string[]): Promise<SteamSettings | null> {
    try {
      const payload: { op: string; customRoots?: string[] } = { op: "setSteamSettings" };
      if (customRoots) payload.customRoots = customRoots;
      steamSettings.value = await capabilities.steam<SteamSettings>(payload);
      // 库目录变了，本地库要重扫，否则详情页仍按旧库路径判断安装状态
      await loadLocalLibrary();
      return steamSettings.value;
    } catch (e) {
      localError.value = messageOf(e);
      return null;
    }
  }

  /** 打开目录选择对话框；取消返回 null（不要当成失败报错） */
  async function pickSteamRoot(): Promise<string | null> {
    try {
      const res = await capabilities.steam<{ path?: string | null }>({ op: "pickSteamRoot" });
      return res?.path ?? null;
    } catch (e) {
      localError.value = messageOf(e);
      return null;
    }
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
    localLibrary,
    localLoading,
    localError,
    detail,
    detailLoading,
    detailError,
    steamSettings,
    downloadProgress,
    downloadBusy,
    downloadError,
    downloadAppId,
    depots,
    depotsLoading,
    depotsError,
    depotFractions,
    error,
    // 派生
    loggedIn,
    needsReconnect,
    displayName,
    totalPlaytimeMinutes,
    downloadPercent,
    downloadBytes,
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
    fetchDetailsBatch,
    clearDetails,
    loadLocalLibrary,
    installedOf,
    openDetail,
    clearDetail,
    launch,
    install,
    loadAchievements,
    loadSteamSettings,
    saveSteamSettings,
    pickSteamRoot,
    fetchDepots,
    download,
    cancelDownload,
    resetDownload,
    subscribeDownload,
    unsubscribeDownload,
  };
});
