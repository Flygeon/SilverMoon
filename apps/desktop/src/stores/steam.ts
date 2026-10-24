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
  SteamOwnedGame,
  SteamQrChallenge,
  SteamSettings,
  SteamStatus,
} from "@shared/types";

export type SteamSort = "recent" | "name" | "playtime";

export interface CmLogin {
  hasToken: boolean;
  accountName: string;
  qrUrl: string;
  qrBusy: boolean;
  qrError: string;
  statusText: string;
}

interface LoadOptions {
  refresh?: boolean;
  statusOnly?: boolean;
}

export const useSteamStore = defineStore("steam", () => {
  const status = ref<SteamStatus>({ loggedIn: false, hasSession: false });
  const statusLoaded = ref(false);
  const statusLoading = ref(false);

  const games = ref<SteamGame[]>([]);
  const total = ref(0);
  const cachedAt = ref<number | null>(null);
  const warning = ref<string | null>(null);
  const libraryLoaded = ref(false);
  const libraryLoading = ref(false);
  const librarySource = ref<"cm" | "webapi" | "">("");

  const authState = ref<SteamAuthState>({ state: "idle" });
  const authBusy = ref(false);
  const qr = ref<SteamQrChallenge | null>(null);

  const cmLogin = ref<CmLogin>({
    hasToken: false,
    accountName: "",
    qrUrl: "",
    qrBusy: false,
    qrError: "",
    statusText: "",
  });
  let cmClientId = "";
  let cmRequestId = "";
  let cmTimer: number | null = null;
  let cmPolling = false;
  let cmGeneration = 0;

  const details = ref<Record<string, SteamAppDetails>>({});
  const detailsLoading = ref(false);
  const detailsError = ref("");

  const localLibrary = ref<SteamLocalLibrary | null>(null);
  const localLoading = ref(false);
  const localError = ref("");

  const detail = ref<SteamGameDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref("");

  const steamSettings = ref<SteamSettings | null>(null);

  const downloadProgress = ref<SteamDownloadProgress | null>(null);
  const downloadBusy = ref(false);
  const downloadError = ref("");
  const downloadNeedCmLogin = ref(false);
  const downloadAppId = ref<number | null>(null);
  const depots = ref<SteamDepotInfo[]>([]);
  const depotsLoading = ref(false);
  const depotsError = ref("");
  const depotFractions = ref<Record<number, number>>({});

  const error = ref("");

  const loggedIn = computed(() => status.value.loggedIn);
  const displayName = computed(() => status.value.personaName || status.value.accountName || "");
  const totalPlaytimeMinutes = computed(() =>
    games.value.reduce((sum, g) => sum + (g.playtimeMinutes || 0), 0),
  );

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

  let unlisten: UnlistenFn | null = null;
  let listening = false;

  async function subscribe(): Promise<void> {
    if (listening || !isDesktop) return;
    listening = true;
    try {
      unlisten = await listen<SteamAuthState>("steam:auth", (event) => {
        const next = event.payload;
        if (!next || typeof next !== "object") return;
        authState.value = next;
      });
    } catch {
      listening = false;
    }
  }

  function unsubscribe(): void {
    unlisten?.();
    unlisten = null;
    listening = false;
  }

  let downloadUnlisten: UnlistenFn | null = null;
  let downloadListening = false;

  let pendingProgress: SteamDownloadProgress | null = null;
  let progressFrame: number | null = null;

  function commitProgress(): void {
    progressFrame = null;
    const next = pendingProgress;
    pendingProgress = null;
    if (!next) return;
    downloadProgress.value = next;
    const fractions = { ...depotFractions.value };
    if (next.depotTotal > 0) {
      fractions[next.depotId] = Math.min(1, next.depotDone / next.depotTotal);
    }
    depotFractions.value = fractions;
  }

  function cancelPendingProgress(): void {
    if (progressFrame !== null) {
      cancelAnimationFrame(progressFrame);
      progressFrame = null;
    }
    pendingProgress = null;
  }

  async function subscribeDownload(): Promise<void> {
    if (downloadListening || !isDesktop) return;
    downloadListening = true;
    try {
      downloadUnlisten = await listen<SteamDownloadProgress>("steam:download", (event) => {
        const next = event.payload;
        if (!next || typeof next !== "object") return;
        pendingProgress = next;
        if (progressFrame === null) {
          progressFrame = requestAnimationFrame(commitProgress);
        }
      });
    } catch {
      downloadListening = false;
    }
  }

  function unsubscribeDownload(): void {
    downloadUnlisten?.();
    downloadUnlisten = null;
    downloadListening = false;
  }

  function resetDownload(): void {
    cancelPendingProgress();
    downloadProgress.value = null;
    downloadError.value = "";
    downloadAppId.value = null;
    depotFractions.value = {};
    downloadNeedCmLogin.value = false;
  }

  async function runMockProgress(appId: number): Promise<void> {
    const total = 3;
    const fileNames = ["game/data.bin", "game/assets.pak", "game/engine.dll", "game/audio.ogg"];
    let tick = 0;
    downloadAppId.value = appId;
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

  async function download(appId: number, installDir: string): Promise<SteamDownloadOutcome> {
    if (downloadBusy.value) {
      return { ok: false, bytesWritten: 0, depots: 0, error: "已有下载任务在进行中" };
    }
    downloadBusy.value = true;
    downloadError.value = "";
    downloadAppId.value = appId;
    cancelPendingProgress();
    downloadProgress.value = null;
    depotFractions.value = {};

    await subscribeDownload();
    if (!isDesktop) await runMockProgress(appId);

    try {
      const res = await capabilities.steamDownload(appId, installDir);
      downloadNeedCmLogin.value = Boolean(res && !res.ok && res.needCmLogin);
      if (res && res.ok) {
        downloadNeedCmLogin.value = false;
        await loadLocalLibrary();
        const detailId = detail.value?.appId;
        if (detailId === appId) await openDetail(appId);
        return res;
      }
      downloadError.value = res?.error || "下载失败";
      return res;
    } catch (e) {
      downloadError.value = messageOf(e);
      return { ok: false, bytesWritten: 0, depots: 0, error: downloadError.value };
    } finally {
      downloadBusy.value = false;
    }
  }

  function cancelDownload(): void {
    resetDownload();
  }

  function syncStatusFromCm(): void {
    const account = cmLogin.value.accountName || null;
    const profile = playerProfile.value;
    status.value = {
      loggedIn: cmLogin.value.hasToken,
      accountName: account,
      personaName: profile?.personaName || account,
      steamId: profile?.steamId || null,
      avatarUrl: profile?.avatarHash
        ? `https://avatars.steamstatic.com/${profile.avatarHash}_full.jpg`
        : null,
      hasSession: cmLogin.value.hasToken,
    };
  }

  const playerProfile = ref<{
    personaName: string;
    avatarHash: string;
    steamId: string | null;
  } | null>(null);
  let profileAccount = "";

  async function loadPlayerProfile(force = false): Promise<void> {
    if (!cmLogin.value.hasToken) {
      playerProfile.value = null;
      profileAccount = "";
      return;
    }
    if (!force && playerProfile.value && profileAccount === cmLogin.value.accountName) {
      return;
    }
    try {
      const res = await capabilities.steamPlayerSummary();
      const personaName = String(res?.personaName ?? "").trim();
      if (!personaName) {
        playerProfile.value = null;
        return;
      }
      playerProfile.value = {
        personaName,
        avatarHash: String(res?.avatarHash ?? ""),
        steamId: null,
      };
      profileAccount = cmLogin.value.accountName;
    } catch {
      playerProfile.value = null;
      profileAccount = "";
    }
  }

  async function loadStatus(): Promise<SteamStatus> {
    statusLoading.value = true;
    try {
      await loadCmLoginStatus();
      await loadPlayerProfile();
      syncStatusFromCm();
      statusLoaded.value = true;
      return status.value;
    } catch (e) {
      error.value = messageOf(e);
      statusLoaded.value = true;
      return status.value;
    } finally {
      statusLoading.value = false;
    }
  }

  function mapOwnedGame(g: SteamOwnedGame): SteamGame {
    const iconHash = g.iconHash || "";
    return {
      appId: g.appId,
      name: g.name || `App ${g.appId}`,
      playtimeMinutes: g.playtimeMinutes ?? 0,
      playtimeRecentMinutes: g.playtimeTwoWeeksMinutes ?? null,
      lastPlayedAt: null,
      iconUrl: iconHash
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appId}/${iconHash}.jpg`
        : null,
      headerUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${g.appId}/header.jpg`,
    };
  }

  async function loadLibrary(refresh = false): Promise<void> {
    libraryLoading.value = true;
    error.value = "";
    let cmFailure = "";
    try {
      if (cmLogin.value.hasToken) {
        try {
          const owned = await capabilities.steamOwnedGames();
          games.value = (owned ?? []).map(mapOwnedGame);
          total.value = games.value.length;
          cachedAt.value = Date.now();
          warning.value = null;
          librarySource.value = "cm";
          libraryLoaded.value = true;
          if (!status.value.loggedIn) syncStatusFromCm();
          return;
        } catch (e) {
          cmFailure = messageOf(e);
        }
      }

      try {
        const lib = await capabilities.steam<SteamLibrary>(
          refresh ? { op: "refreshLibrary" } : { op: "library", refresh: false },
        );
        games.value = lib.games ?? [];
        total.value = lib.total ?? games.value.length;
        cachedAt.value = lib.cachedAt ?? null;
        warning.value = lib.warning ?? null;
        librarySource.value = "webapi";
        libraryLoaded.value = true;
        if (!status.value.loggedIn) status.value = { ...status.value, loggedIn: true };
        return;
      } catch (e) {
        games.value = [];
        total.value = 0;
        cachedAt.value = null;
        warning.value = null;
        librarySource.value = "";
        libraryLoaded.value = true;
        error.value = cmLogin.value.hasToken ? cmFailure || messageOf(e) : "";
      }
    } finally {
      libraryLoading.value = false;
    }
  }

  async function load(options: LoadOptions = {}): Promise<void> {
    error.value = "";
    await loadStatus();
    if (status.value.loggedIn && !options.statusOnly) {
      await loadLibrary(options.refresh ?? false);
    }
  }

  async function refresh(): Promise<void> {
    await loadStatus();
    if (!status.value.loggedIn) return; // 未扫码：界面出登录卡，不报错
    await loadLibrary(true);
  }

  async function reconnect(): Promise<void> {
    await loadStatus();
    if (status.value.loggedIn) await loadLibrary(true);
  }

  async function logout(): Promise<void> {
    authBusy.value = true;
    error.value = "";
    try {
      await capabilities.cmLogout();
      try {
        await capabilities.steam<null>({ op: "logout" });
      } catch {
        /* 忽略 */
      }
      games.value = [];
      total.value = 0;
      cachedAt.value = null;
      warning.value = null;
      libraryLoaded.value = false;
      librarySource.value = "";
      details.value = {};
      authState.value = { state: "idle" };
      qr.value = null;
      cmGeneration += 1;
      stopCmPolling();
      cmClientId = "";
      cmRequestId = "";
      cmLogin.value = {
        hasToken: false,
        accountName: "",
        qrUrl: "",
        qrBusy: false,
        qrError: "",
        statusText: "",
      };
      playerProfile.value = null;
      profileAccount = "";
      status.value = { loggedIn: false, hasSession: false };
    } catch (e) {
      error.value = messageOf(e);
    } finally {
      authBusy.value = false;
    }
  }

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

  async function resumeSession(): Promise<void> {
    await reconnect();
  }

  async function cancelLogin(): Promise<void> {
    qr.value = null;
    authState.value = { state: "idle" };
    try {
      await capabilities.steam<null>({ op: "cancelLogin" });
    } catch {
      /* 忽略 */
    }
  }

  async function loadCmLoginStatus(): Promise<void> {
    try {
      const res = await capabilities.cmLoginStatus();
      cmLogin.value = {
        ...cmLogin.value,
        hasToken: Boolean(res?.hasToken),
        accountName: res?.accountName ?? "",
      };
    } catch (e) {
      cmLogin.value = { ...cmLogin.value, qrError: messageOf(e) };
    }
  }

  async function beginCmLogin(): Promise<void> {
    const generation = ++cmGeneration;
    stopCmPolling();
    cmClientId = "";
    cmRequestId = "";
    cmLogin.value = {
      ...cmLogin.value,
      qrBusy: true,
      qrError: "",
      qrUrl: "",
      statusText: "waiting",
    };
    try {
      const res = await capabilities.cmBeginQr();
      if (generation !== cmGeneration) return;
      if (!res || res.error || !res.challengeUrl) {
        throw new Error(res?.error || "发起扫码登录失败");
      }
      cmClientId = res.clientId;
      cmRequestId = res.requestId;
      const { default: QRCode } = await import("qrcode");
      const dataUrl = await QRCode.toDataURL(res.challengeUrl, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
      });
      if (generation !== cmGeneration) return;
      cmLogin.value = { ...cmLogin.value, qrUrl: dataUrl, statusText: "waiting" };
      startCmPolling(res.interval);
    } catch (e) {
      if (generation === cmGeneration) {
        cmLogin.value = {
          ...cmLogin.value,
          qrUrl: "",
          qrError: messageOf(e),
          statusText: "error",
        };
      }
    } finally {
      if (generation === cmGeneration) {
        cmLogin.value = { ...cmLogin.value, qrBusy: false };
      }
    }
  }

  function startCmPolling(intervalSeconds: number): void {
    stopCmPolling();
    if (!cmClientId) return;
    const ms = Math.max(1000, (intervalSeconds || 5) * 1000);
    cmTimer = window.setInterval(() => void cmTick(), ms);
    void cmTick();
  }

  function stopCmPolling(): void {
    if (cmTimer !== null) {
      window.clearInterval(cmTimer);
      cmTimer = null;
    }
  }

  async function cmTick(): Promise<void> {
    if (cmPolling || !cmClientId) return;
    cmPolling = true;
    try {
      const res = await capabilities.cmPollQr(cmClientId, cmRequestId);
      if (res?.error) {
        stopCmPolling();
        cmLogin.value = { ...cmLogin.value, qrError: res.error, statusText: "error" };
        return;
      }
      if (res?.status === "authorized") {
        stopCmPolling();
        cmClientId = "";
        cmRequestId = "";
        await loadCmLoginStatus();
        cmLogin.value = {
          ...cmLogin.value,
          hasToken: true,
          accountName: res.accountName || cmLogin.value.accountName,
          qrUrl: "",
          qrError: "",
          statusText: "success",
        };
        await loadPlayerProfile(true);
        syncStatusFromCm();
        statusLoaded.value = true;
        void loadLibrary();
        return;
      }
      cmLogin.value = {
        ...cmLogin.value,
        statusText: res?.status === "scanned" ? "scanned" : "waiting",
      };
    } catch (e) {
      stopCmPolling();
      cmLogin.value = { ...cmLogin.value, qrError: messageOf(e), statusText: "error" };
    } finally {
      cmPolling = false;
    }
  }

  function resetCmLogin(): void {
    cmGeneration += 1;
    stopCmPolling();
    cmClientId = "";
    cmRequestId = "";
    cmLogin.value = {
      ...cmLogin.value,
      qrUrl: "",
      qrBusy: false,
      qrError: "",
      statusText: "",
    };
  }

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
        const fresh: Record<string, SteamAppDetails> = {};
        for (const [key, value] of Object.entries(res)) {
          if (!value || !value.name) continue;
          fresh[key] = value;
        }
        if (Object.keys(fresh).length) details.value = { ...details.value, ...fresh };
        Object.assign(hit, fresh);
      }
    } catch {
      /* 忽略 */
    }
    return hit;
  }

  function clearDetails(): void {
    details.value = {};
    detailsError.value = "";
  }

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

  function installedOf(appId: number): SteamInstalledGame | null {
    return localLibrary.value?.installed.find((g) => g.appId === appId) ?? null;
  }

  async function openDetail(appId: number): Promise<void> {
    if (detail.value?.appId !== appId) detail.value = null;
    detailLoading.value = true;
    detailError.value = "";
    try {
      const res = await capabilities.steam<SteamGameDetail>({ op: "gameDetail", appId });
      if (res && res.appId === appId) detail.value = res;
      else if (res && !res.appId) detail.value = { ...res, appId };
      syncLocalFromDetail(appId, res?.local ?? null);
    } catch (e) {
      detailError.value = messageOf(e);
    } finally {
      detailLoading.value = false;
    }
  }

  function syncLocalFromDetail(appId: number, local: SteamInstalledGame | null): void {
    if (!local || !localLibrary.value) return;
    const list = localLibrary.value.installed;
    const idx = list.findIndex((g) => g.appId === appId);
    if (idx < 0) return;
    const next = [...list];
    next[idx] = local;
    localLibrary.value = { ...localLibrary.value, installed: next };
  }

  function clearDetail(): void {
    detail.value = null;
    detailError.value = "";
  }

  async function launch(appId: number): Promise<SteamActionResult> {
    try {
      return await capabilities.steam<SteamActionResult>({ op: "launchGame", appId });
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
  }

  async function install(appId: number): Promise<SteamActionResult> {
    try {
      return await capabilities.steam<SteamActionResult>({ op: "openInSteam", appId });
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
  }

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

  async function loadSteamSettings(): Promise<SteamSettings | null> {
    try {
      steamSettings.value = await capabilities.steam<SteamSettings>({ op: "steamSettings" });
      return steamSettings.value;
    } catch (e) {
      localError.value = messageOf(e);
      return null;
    }
  }

  async function saveSteamSettings(customRoots?: string[]): Promise<SteamSettings | null> {
    try {
      const payload: { op: string; customRoots?: string[] } = { op: "setSteamSettings" };
      if (customRoots) payload.customRoots = customRoots;
      steamSettings.value = await capabilities.steam<SteamSettings>(payload);
      await loadLocalLibrary();
      return steamSettings.value;
    } catch (e) {
      localError.value = messageOf(e);
      return null;
    }
  }

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
    status,
    statusLoaded,
    statusLoading,
    games,
    total,
    cachedAt,
    warning,
    libraryLoaded,
    libraryLoading,
    librarySource,
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
    downloadNeedCmLogin,
    downloadAppId,
    depots,
    depotsLoading,
    depotsError,
    depotFractions,
    error,
    loggedIn,
    displayName,
    totalPlaytimeMinutes,
    downloadPercent,
    downloadBytes,
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
    cmLogin,
    loadCmLoginStatus,
    beginCmLogin,
    startCmPolling,
    stopCmPolling,
    resetCmLogin,
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
