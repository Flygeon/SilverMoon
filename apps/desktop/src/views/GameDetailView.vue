<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import SteamLoginPanel from "@/components/SteamLoginPanel.vue";
import { useSteamStore } from "@/stores/steam";
import { formatSize } from "@/utils/format";
import { capabilities, isDesktop } from "@/capabilities";
import {
  GAME_HERO_VT_NAME,
  activeCoverUrl,
  beginCoverFlight,
  endCoverFlight,
  findCardCover,
  runViewTransition,
} from "@/utils/gameHeroTransition";
import { translate } from "@shared/i18n";
import type { SteamAchievement } from "@shared/types";

const props = defineProps<{
  appId: string;
}>();

const router = useRouter();
const settings = useSettingsStore();
const steam = useSteamStore();
const t = (key: string) => translate(settings.lang, key);

const numericAppId = computed(() => {
  const n = Number(props.appId);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
});

const invalidAppId = computed(() => Number.isNaN(numericAppId.value));

const actionBusy = ref(false);
const showDepotPanel = ref(false);
const toast = ref("");
let toastTimer: number | null = null;

function notify(message: string): void {
  toast.value = message;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ""), 3200);
}

const brokenImages = ref<Record<string, boolean>>({});

function markBroken(url: string | null | undefined): void {
  if (!url) return;
  brokenImages.value = { ...brokenImages.value, [url]: true };
}

function isBroken(url: string | null | undefined): boolean {
  return !!url && !!brokenImages.value[url];
}

const detail = computed(() => steam.detail);
const appDetails = computed(() => detail.value?.details ?? null);
const local = computed(() => detail.value?.local ?? null);
const achievements = computed(() => detail.value?.achievements ?? null);

const installed = computed(() => {
  if (local.value) return local.value;
  const id = numericAppId.value;
  if (Number.isNaN(id)) return null;
  return steam.installedOf(id);
});

const isInstalled = computed(() => !!installed.value);
const coverFromGrid = computed<string>(() => {
  const url = activeCoverUrl.value;
  return typeof url === "string" ? url : "";
});

const heroImage = computed<string>(() => {
  const fromGrid = coverFromGrid.value;
  if (fromGrid) return fromGrid;

  const fromStore = appDetails.value?.headerImage ?? "";
  if (fromStore) return fromStore;

  const id = numericAppId.value;
  if (Number.isFinite(id) && id > 0) {
    return `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`;
  }

  return appDetails.value?.backgroundImage ?? "";
});

const title = computed(
  () => appDetails.value?.name || installed.value?.name || t("games.detail.title"),
);

const screenshots = computed<string[]>(() => appDetails.value?.screenshots ?? []);

const achievementPercent = computed(() => {
  const a = achievements.value;
  if (!a || !a.total) return 0;
  return Math.round((a.unlocked / a.total) * 100);
});

const showAchievements = computed(() => {
  const a = achievements.value;
  return !!a && a.available && a.achievements.length > 0;
});

const unlockedAchievements = computed<SteamAchievement[]>(() =>
  (achievements.value?.achievements ?? []).filter((a) => a.unlocked),
);

const ICON_WALL_TOTAL = 5;

const iconWallLimit = computed(() => {
  const unlocked = unlockedAchievements.value.length;
  return unlocked > ICON_WALL_TOTAL ? ICON_WALL_TOTAL - 1 : unlocked;
});

const iconWall = computed(() => unlockedAchievements.value.slice(0, iconWallLimit.value));
const iconOverflow = computed(() =>
  Math.max(0, unlockedAchievements.value.length - iconWallLimit.value),
);

const lockedCount = computed(() => {
  const a = achievements.value;
  if (!a) return 0;
  return Math.max(0, a.total - a.unlocked);
});

interface DlcCard {
  appId: number;
  name: string;
  image: string;
}

const dlcCards = ref<DlcCard[]>([]);
const dlcTotalCount = ref(0);
const dlcLoading = ref(false);
let dlcLoadedFor = 0;

const DLC_MAX_TOTAL = 5;

const dlcLimit = computed(() =>
  dlcCards.value.length > DLC_MAX_TOTAL ? DLC_MAX_TOTAL - 1 : dlcCards.value.length,
);
const visibleDlc = computed(() => dlcCards.value.slice(0, dlcLimit.value));
const dlcOverflow = computed(() => Math.max(0, dlcTotalCount.value - dlcLimit.value));

const showExtra = computed(() => dlcCards.value.length > 0);

async function loadDlc(ids: number[]): Promise<void> {
  const appId = numericAppId.value;
  if (Number.isNaN(appId)) return;
  const wanted = ids.filter((n) => Number.isFinite(n) && n > 0);
  if (!wanted.length) {
    dlcCards.value = [];
    dlcTotalCount.value = 0;
    return;
  }
  dlcLoading.value = true;
  dlcLoadedFor = appId;
  try {
    const prefetch = wanted.slice(0, DLC_MAX_TOTAL + 1);
    const map = await steam.fetchDetailsBatch(prefetch);
    const cards: DlcCard[] = [];
    for (const id of prefetch) {
      const meta = map[String(id)];
      if (!meta?.name) continue;
      cards.push({
        appId: id,
        name: meta.name,
        image: meta.headerImage || meta.capsuleImage || "",
      });
    }
    if (dlcLoadedFor === appId) {
      dlcCards.value = cards;
      dlcTotalCount.value = wanted.length;
    }
  } finally {
    dlcLoading.value = false;
  }
}

async function openDlc(id: number): Promise<void> {
  const res = await steam.install(id);
  if (res.ok) return;
  try {
    await capabilities.openUrl("https://store.steampowered.com/app/" + id + "/");
  } catch {
    notify(res.message || t("games.detail.actionFailed"));
  }
}

async function viewAllAchievements(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  const steamId = steam.status.steamId;
  const url = steamId
    ? "https://steamcommunity.com/profiles/" + steamId + "/stats/" + id + "/achievements/"
    : "https://steamcommunity.com/stats/" + id + "/achievements/";
  try {
    await capabilities.openUrl(url);
  } catch {
    notify(t("games.detail.actionFailed"));
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function hoursText(minutes?: number | null): string {
  const m = minutes ?? 0;
  if (m <= 0) return t("games.playtimeNone");
  const hours = m / 60;
  if (hours < 1) return t("games.minutes").replace("{n}", String(Math.max(1, Math.round(m))));
  const text = hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1).replace(/\.0$/, "");
  return t("games.playtimeTotal").replace("{n}", text);
}

function relativeTime(ms?: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return t("games.justNow");
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("games.justNow");
  if (min < 60) return t("games.minutesAgo").replace("{n}", String(min));
  const hour = Math.floor(min / 60);
  if (hour < 24) return t("games.hoursAgo").replace("{n}", String(hour));
  const day = Math.floor(hour / 24);
  if (day < 30) return t("games.daysAgo").replace("{n}", String(day));
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function sizeText(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  return formatSize(bytes);
}

const playtime = computed<string>(() => {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return "";
  const g = steam.games.find((x) => x.appId === id);
  return g ? hoursText(g.playtimeMinutes) : "";
});

const lastPlayed = computed<string>(() => {
  const at = installed.value?.lastPlayedAt ?? null;
  return at ? relativeTime(at) : "";
});

const priceText = computed<string>(() => {
  const d = appDetails.value;
  if (!d) return "—";
  if (d.isFree) return t("games.free");
  return d.priceText || "—";
});

async function goBack(): Promise<void> {
  const id = numericAppId.value;
  if (!Number.isNaN(id)) {
    beginCoverFlight(id, heroImage.value || null, findCardCover(id));
  }
  const navigate = () => {
    if (window.history.length > 1) router.back();
    else void router.push("/games");
  };
  await runViewTransition({
    navigate,
    cleanup: endCoverFlight,
  });
}

async function primaryAction(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id) || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const res = isInstalled.value ? await steam.launch(id) : await steam.install(id);
    if (!res.ok) notify(res.message || t("games.detail.actionFailed"));
    else if (res.message) notify(res.message);
  } finally {
    actionBusy.value = false;
  }
}

async function openInSteam(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  const res = await steam.install(id);
  if (!res.ok) notify(res.message || t("games.detail.actionFailed"));
}

async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    notify(t("games.detail.copied"));
  } catch {
    notify(t("games.detail.copyFailed"));
  }
}

const installPath = computed<string>(() => {
  const g = installed.value;
  if (!g) return "";
  if (!g.installDir) return g.libraryPath;
  const sep = g.libraryPath.includes("\\") ? "\\" : "/";
  return [g.libraryPath, "steamapps", "common", g.installDir].join(sep);
});

const downloadingThis = computed(() => {
  const id = numericAppId.value;
  if (Number.isNaN(id) || !steam.downloadBusy) return false;
  return steam.downloadAppId === id;
});

const showDownloadPanel = computed(
  () =>
    downloadingThis.value || (!!steam.downloadError && steam.downloadAppId === numericAppId.value),
);

const currentFileName = computed<string>(() => {
  const file = steam.downloadProgress?.currentFile ?? "";
  if (!file) return "";
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || file;
});

const progressBytesText = computed<string>(() => {
  const { done, total } = steam.downloadBytes;
  if (!total) return t("games.detail.downloadBytesOnly").replace("{done}", sizeText(done));
  return t("games.detail.downloadBytes")
    .replace("{done}", sizeText(done))
    .replace("{total}", sizeText(total));
});

const progressDepotText = computed<string>(() => {
  const progress = steam.downloadProgress;
  if (!progress || !progress.depotsTotal) return "";
  return t("games.detail.downloadDepots")
    .replace("{done}", String(Math.min(progress.depotsDone, progress.depotsTotal)))
    .replace("{total}", String(progress.depotsTotal));
});

const needLogin = computed(() => steam.statusLoaded && !steam.loggedIn);

const suggestedInstallDir = computed<string>(() => {
  const settings = steam.steamSettings;
  const root =
    settings?.customRoots?.[0] ||
    settings?.steamRoot ||
    steam.localLibrary?.steamRoot ||
    steam.installedOf(numericAppId.value)?.libraryPath ||
    "";
  if (!root) return "";
  const name =
    installed.value?.installDir ||
    (appDetails.value?.name || "").replace(/[<>:"/\\|?*]+/g, "").trim() ||
    "SilverMoonGame";
  const sep = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), "steamapps", "common", name].join(sep);
});

async function runDownload(installDir: string): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id) || actionBusy.value || steam.downloadBusy) return;
  actionBusy.value = true;
  steam.resetDownload();
  try {
    const res = await steam.download(id, installDir);
    if (!res.ok) {
      if (res.needCmLogin) {
        pendingInstallDir = installDir;
        void steam.loadStatus();
        showLoginPanel.value = true;
        return;
      }
      notify(res.error || t("games.detail.downloadFailed"));
      return;
    }
    pendingInstallDir = null;
    notify(t("games.detail.downloadDone").replace("{size}", sizeText(res.bytesWritten) || "—"));
    showDepotPanel.value = false;
  } finally {
    actionBusy.value = false;
  }
}

async function startInstall(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id) || actionBusy.value || steam.downloadBusy) return;

  if (!steam.statusLoaded) await steam.loadStatus();
  if (!steam.loggedIn) {
    pendingInstallDir = null; // 还没选目录，登录成功后重新走一遍选目录
    showLoginPanel.value = true;
    return;
  }

  let installDir: string | null = null;
  try {
    installDir = await capabilities.pickDirectory({
      title: t("games.detail.downloadChooseDir"),
      defaultPath: suggestedInstallDir.value || undefined,
    });
  } catch {
    installDir = null;
  }
  if (!installDir && !isDesktop) {
    installDir = suggestedInstallDir.value || "C:/SteamLibrary/steamapps/common/SilverMoonDemo";
  }
  if (!installDir) return; // 用户取消：安静退出

  await runDownload(installDir);
}

async function retryInstall(): Promise<void> {
  steam.resetDownload();
  await startInstall();
}

const showLoginPanel = ref(false);
let pendingInstallDir: string | null = null;

const downloadTitleKey = computed(() => {
  if (steam.downloadNeedCmLogin) return "games.detail.loginNeeded";
  if (steam.downloadError) return "games.detail.downloadFailed";
  return "games.detail.downloading";
});

const downloadTitleIcon = computed(() => {
  if (steam.downloadNeedCmLogin) return "login";
  return steam.downloadError ? "error" : "download";
});

function openQrLogin(): void {
  showLoginPanel.value = true;
}

function closeLoginPanel(): void {
  showLoginPanel.value = false;
}

async function onCmLoggedIn(): Promise<void> {
  showLoginPanel.value = false;
  const dir = pendingInstallDir;
  pendingInstallDir = null;
  if (dir) await runDownload(dir);
  else await startInstall();
}

async function toggleDepotPanel(): Promise<void> {
  showDepotPanel.value = !showDepotPanel.value;
  if (!showDepotPanel.value) return;
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  if (steam.depots.length && !steam.depotsError) return;
  await steam.fetchDepots(id);
}

function depotPercent(depotId: number): number {
  const fraction = steam.depotFractions[depotId] ?? 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

async function retry(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  steam.clearDetail();
  dlcCards.value = [];
  dlcTotalCount.value = 0;
  dlcLoadedFor = 0;
  await Promise.all([steam.openDetail(id), steam.loadLocalLibrary()]);
}

async function bootstrap(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  const jobs: Promise<unknown>[] = [steam.openDetail(id)];
  if (!steam.localLibrary) jobs.push(steam.loadLocalLibrary());
  if (!steam.steamSettings) jobs.push(steam.loadSteamSettings());
  await Promise.all(jobs);
}

watch(
  () => appDetails.value?.dlc,
  (ids) => {
    const appId = numericAppId.value;
    if (Number.isNaN(appId)) return;
    if (!ids?.length) {
      dlcCards.value = [];
      dlcTotalCount.value = 0;
      return;
    }
    if (dlcLoadedFor === appId && dlcCards.value.length) return;
    void loadDlc(ids);
  },
);

onMounted(() => {
  void bootstrap();
  void steam.subscribeDownload();
});

onUnmounted(() => {
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = null;
  steam.stopCmPolling();
});

watch(
  () => props.appId,
  () => {
    steam.clearDetail();
    dlcCards.value = [];
    dlcTotalCount.value = 0;
    dlcLoadedFor = 0;
    void bootstrap();
  },
);
</script>

<template>
  <div
    class="detail-view"
    :style="{
      '--lm-game-hero-vt': GAME_HERO_VT_NAME,
      '--lm-game-hero-vt-duration': 'var(--md-sys-motion-duration-spring-spatial)',
      '--lm-game-hero-vt-easing': 'var(--md-sys-motion-spring-spatial)',
    }"
  >
    <div v-if="invalidAppId" class="bar error" role="alert">
      <span class="material-symbols-outlined">error</span>
      <span class="bar-text">{{ t("games.detail.invalidId") }}</span>
      <m3e-button variant="text" size="small" @click="goBack">
        {{ t("games.detail.back") }}
      </m3e-button>
    </div>

    <template v-else>
      <div v-if="steam.detailLoading && !detail && !heroImage" class="hero-skeleton">
        <div class="lm-skeleton skeleton-hero"></div>
        <div class="skeleton-bar">
          <div class="lm-skeleton line wide"></div>
          <div class="lm-skeleton line"></div>
        </div>
      </div>

      <div v-else-if="steam.detailError && !detail && !heroImage" class="bar error" role="alert">
        <span class="material-symbols-outlined">error</span>
        <span class="bar-text">{{ steam.detailError || t("games.detail.loadFailed") }}</span>
        <m3e-button variant="text" size="small" @click="retry">
          {{ t("games.retry") }}
        </m3e-button>
      </div>

      <template v-else>
        <section class="hero">
          <div class="hero-media">
            <img
              v-if="heroImage && !isBroken(heroImage)"
              :src="heroImage"
              class="hero-img"
              :alt="title"
              decoding="async"
              @error="markBroken(heroImage)"
            />
            <span v-else class="material-symbols-outlined hero-fallback">sports_esports</span>
            <div class="hero-scrim"></div>
          </div>

          <div class="hero-content">
            <m3e-icon-button class="hero-back" :title="t('games.detail.back')" @click="goBack">
              <span class="material-symbols-outlined">arrow_back</span>
            </m3e-icon-button>

            <div class="hero-text">
              <h1 class="hero-title">{{ title }}</h1>
              <div v-if="appDetails?.genres?.length" class="hero-chips">
                <m3e-assist-chip v-for="g in appDetails.genres" :key="g" class="genre-chip">
                  {{ g }}
                </m3e-assist-chip>
              </div>
            </div>
          </div>
        </section>

        <div v-if="steam.detailError" class="bar error" role="alert">
          <span class="material-symbols-outlined">error</span>
          <span class="bar-text">{{ steam.detailError }}</span>
          <m3e-button variant="text" size="small" @click="retry">
            {{ t("games.retry") }}
          </m3e-button>
        </div>

        <section class="action-bar">
          <div class="action-main">
            <m3e-button v-if="downloadingThis" variant="filled" disabled @click="() => {}">
              <span slot="icon" class="material-symbols-outlined">downloading</span>
              {{ t("games.detail.downloading") }}
            </m3e-button>
            <m3e-button
              v-else-if="isInstalled"
              variant="filled"
              :disabled="actionBusy"
              @click="primaryAction"
            >
              <span slot="icon" class="material-symbols-outlined">play_arrow</span>
              {{ t("games.detail.play") }}
            </m3e-button>
            <m3e-button
              v-else
              variant="filled"
              :disabled="actionBusy || steam.downloadBusy"
              @click="startInstall"
            >
              <span slot="icon" class="material-symbols-outlined">download</span>
              {{ t("games.detail.install") }}
            </m3e-button>

            <template v-if="isInstalled">
              <span class="installed-tag">
                <span class="material-symbols-outlined tag-icon">check_circle</span>
                {{ t("games.detail.installed") }}
              </span>
              <span class="meta-text tabular-nums">
                {{ t("games.detail.sizeOnDisk") }} {{ sizeText(installed?.sizeOnDisk) }}
              </span>
              <button
                v-if="installPath"
                type="button"
                class="path-chip"
                :title="installPath"
                @click="copyText(installPath)"
              >
                <span class="material-symbols-outlined path-icon">folder</span>
                <span class="path-text">{{ installPath }}</span>
                <span class="material-symbols-outlined path-icon">content_copy</span>
              </button>
            </template>
          </div>

          <div class="action-side">
            <m3e-icon-button :title="t('games.detail.openInSteam')" @click="openInSteam">
              <span class="material-symbols-outlined">open_in_new</span>
            </m3e-icon-button>
            <m3e-icon-button :title="t('games.detail.copyLink')" @click="copyText(heroImage)">
              <span class="material-symbols-outlined">link</span>
            </m3e-icon-button>
          </div>
        </section>

        <div v-if="needLogin && !isInstalled" class="bar info" role="status">
          <span class="material-symbols-outlined">login</span>
          <span class="bar-text">{{ t("games.detail.downloadNeedLogin") }}</span>
          <m3e-button variant="text" size="small" @click="openQrLogin">
            {{ t("games.detail.openQrLogin") }}
          </m3e-button>
        </div>

        <section v-if="showDownloadPanel" class="download-panel">
          <div class="download-head">
            <span class="download-title">
              <span class="material-symbols-outlined download-icon">{{ downloadTitleIcon }}</span>
              {{ t(downloadTitleKey) }}
            </span>
            <span v-if="!steam.downloadError" class="download-percent tabular-nums">
              {{ steam.downloadPercent }}%
            </span>
          </div>

          <div v-if="steam.downloadError" class="download-error" role="alert">
            <span class="download-error-text">{{ steam.downloadError }}</span>
            <div class="download-error-actions">
              <m3e-button variant="text" size="small" @click="retryInstall">
                {{ t("games.detail.downloadRetry") }}
              </m3e-button>
              <m3e-button variant="text" size="small" @click="openInSteam">
                {{ t("games.detail.installViaSteam") }}
              </m3e-button>
            </div>
          </div>

          <template v-else>
            <m3e-linear-progress-indicator
              class="download-bar"
              variant="wavy"
              :max="100"
              :value="steam.downloadPercent"
            />
            <div class="download-meta">
              <span class="download-file" :title="steam.downloadProgress?.currentFile || ''">
                {{
                  steam.downloadProgress?.currentFile
                    ? t("games.detail.downloadCurrentFile").replace("{file}", currentFileName)
                    : t("games.detail.downloadPrepare")
                }}
              </span>
              <span class="download-bytes tabular-nums">{{ progressBytesText }}</span>
              <span v-if="progressDepotText" class="download-depots tabular-nums">
                {{ progressDepotText }}
              </span>
            </div>
          </template>

          <button type="button" class="depot-toggle" @click="toggleDepotPanel">
            <span class="material-symbols-outlined depot-toggle-icon">
              {{ showDepotPanel ? "expand_less" : "expand_more" }}
            </span>
            {{ t("games.detail.downloadDepotsTitle") }}
            <span v-if="steam.depots.length" class="depot-count tabular-nums">
              {{ steam.depots.length }}
            </span>
          </button>

          <div v-if="showDepotPanel" class="depot-body">
            <div v-if="steam.depotsLoading" class="side-loading">
              <m3e-loading-indicator class="inline-loading" />
            </div>
            <div v-else-if="steam.depotsError" class="depot-error">
              {{ t("games.detail.downloadDepotsFailed") }}：{{ steam.depotsError }}
            </div>
            <div v-else-if="!steam.depots.length" class="depot-error">
              {{ t("games.detail.downloadNoDepots") }}
            </div>
            <ul v-else class="depot-list">
              <li v-for="depot in steam.depots" :key="depot.depotId" class="depot-row">
                <span class="depot-id tabular-nums">#{{ depot.depotId }}</span>
                <m3e-linear-progress-indicator
                  class="depot-bar"
                  :max="100"
                  :value="depotPercent(depot.depotId)"
                />
                <span class="depot-pct tabular-nums">{{ depotPercent(depot.depotId) }}%</span>
              </li>
            </ul>
          </div>
        </section>

        <section v-if="showLoginPanel" class="login-panel" aria-live="polite">
          <div class="login-panel-head">
            <span class="login-panel-title">
              <span class="material-symbols-outlined login-panel-icon">login</span>
              {{ t("games.detail.loginNeeded") }}
            </span>
            <m3e-icon-button :title="t('games.close')" @click="closeLoginPanel">
              <span class="material-symbols-outlined">close</span>
            </m3e-icon-button>
          </div>
          <SteamLoginPanel @logged-in="onCmLoggedIn" />
        </section>

        <div v-if="toast" class="bar info" role="status">
          <span class="material-symbols-outlined">info</span>
          <span class="bar-text">{{ toast }}</span>
        </div>

        <div class="columns">
          <main class="col-main">
            <m3e-card class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.about") }}</h2>
                <div v-if="steam.detailLoading && !appDetails" class="about-skeleton">
                  <div class="lm-skeleton line wide"></div>
                  <div class="lm-skeleton line"></div>
                </div>
                <p v-else-if="appDetails?.shortDescription" class="about-text">
                  {{ appDetails.shortDescription }}
                </p>
                <p v-else class="about-text muted">{{ t("games.noDescription") }}</p>
              </div>
            </m3e-card>

            <m3e-card v-if="steam.detailLoading && !appDetails" class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.screenshots") }}</h2>
                <div class="shot-wall">
                  <div v-for="n in 4" :key="'shot-skeleton-' + n" class="shot">
                    <div class="lm-skeleton shot-skeleton"></div>
                  </div>
                </div>
              </div>
            </m3e-card>

            <m3e-card v-else-if="screenshots.length" class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.screenshots") }}</h2>
                <div class="shot-wall">
                  <div v-for="(src, i) in screenshots" :key="src + i" class="shot">
                    <img
                      v-if="!isBroken(src)"
                      :src="src"
                      class="shot-img"
                      :alt="title"
                      loading="lazy"
                      decoding="async"
                      @error="markBroken(src)"
                    />
                    <span v-else class="material-symbols-outlined shot-fallback">image</span>
                  </div>
                </div>
              </div>
            </m3e-card>
          </main>

          <aside class="col-side">
            <m3e-card v-if="showExtra" class="block" variant="filled">
              <div slot="content">
                <div class="block-head">
                  <h2 class="block-title">{{ t("games.detail.extra") }}</h2>
                  <span class="block-count tabular-nums">{{ dlcTotalCount }}</span>
                </div>

                <div class="dlc-list">
                  <button
                    v-for="dlc in visibleDlc"
                    :key="dlc.appId"
                    type="button"
                    class="dlc-item"
                    :title="dlc.name"
                    @click="openDlc(dlc.appId)"
                  >
                    <span class="dlc-thumb">
                      <img
                        v-if="dlc.image && !isBroken(dlc.image)"
                        :src="dlc.image"
                        class="dlc-img"
                        :alt="dlc.name"
                        loading="lazy"
                        decoding="async"
                        @error="markBroken(dlc.image)"
                      />
                      <span v-else class="material-symbols-outlined dlc-fallback">extension</span>
                    </span>
                    <span class="dlc-name">{{ dlc.name }}</span>
                  </button>

                  <button
                    v-if="dlcOverflow > 0"
                    type="button"
                    class="dlc-item dlc-more"
                    :title="t('games.detail.extra')"
                    @click="openInSteam"
                  >
                    <span class="dlc-thumb">
                      <span class="dlc-more-text tabular-nums"> +{{ dlcOverflow }} </span>
                    </span>
                    <span class="dlc-name">{{ t("games.detail.extra") }}</span>
                  </button>
                </div>

                <div v-if="dlcLoading" class="side-loading">
                  <m3e-loading-indicator class="inline-loading" />
                </div>
              </div>
            </m3e-card>

            <m3e-card v-if="showAchievements" class="block" variant="filled">
              <div slot="content">
                <div class="block-head">
                  <h2 class="block-title">{{ t("games.detail.achievements") }}</h2>
                  <m3e-button variant="text" size="small" @click="viewAllAchievements">
                    {{ t("games.detail.viewAchievements") }}
                  </m3e-button>
                </div>

                <div class="ach-progress-row">
                  <m3e-linear-progress-indicator
                    class="ach-bar"
                    :max="100"
                    :value="achievementPercent"
                  />
                  <span class="ach-percent tabular-nums">{{ achievementPercent }}%</span>
                </div>
                <p class="ach-count tabular-nums">
                  {{
                    t("games.detail.unlockedCount")
                      .replace("{n}", String(achievements?.unlocked ?? 0))
                      .replace("{total}", String(achievements?.total ?? 0))
                      .replace("{percent}", String(achievementPercent))
                  }}
                </p>

                <div class="ach-wall">
                  <button
                    v-for="a in iconWall"
                    :key="a.apiName"
                    type="button"
                    class="ach-tile"
                    :title="a.name"
                    @click="viewAllAchievements"
                  >
                    <img
                      v-if="a.icon && !isBroken(a.icon)"
                      :src="a.icon"
                      class="ach-tile-img"
                      :alt="a.name"
                      loading="lazy"
                      decoding="async"
                      @error="markBroken(a.icon)"
                    />
                    <span v-else class="material-symbols-outlined ach-tile-fallback">
                      emoji_events
                    </span>
                  </button>

                  <button
                    v-if="iconOverflow > 0"
                    type="button"
                    class="ach-tile ach-tile-more"
                    :title="t('games.detail.viewAchievements')"
                    @click="viewAllAchievements"
                  >
                    <span class="ach-more-text tabular-nums">
                      {{ t("games.detail.moreCount").replace("{n}", String(iconOverflow)) }}
                    </span>
                  </button>

                  <span v-if="!unlockedAchievements.length" class="ach-wall-empty">
                    <span class="material-symbols-outlined">lock</span>
                  </span>
                </div>

                <div v-if="lockedCount > 0" class="ach-locked">
                  <span class="ach-locked-title">{{ t("games.detail.lockedTitle") }}</span>
                  <span class="ach-locked-count tabular-nums">×{{ lockedCount }}</span>
                  <span class="ach-locked-hint">{{ t("games.detail.lockedHint") }}</span>
                </div>
              </div>
            </m3e-card>

            <m3e-card v-if="steam.detailLoading && !detail" class="block" variant="filled">
              <div slot="content">
                <div class="block-head">
                  <div class="lm-skeleton line wide"></div>
                </div>
                <div class="side-skeleton">
                  <div v-for="n in 3" :key="'side-skeleton-' + n" class="lm-skeleton line"></div>
                </div>
              </div>
            </m3e-card>

            <m3e-card class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.info") }}</h2>
                <dl class="info-list">
                  <div class="info-row">
                    <dt>{{ t("games.detail.needSpace") }}</dt>
                    <dd class="tabular-nums">
                      {{ isInstalled ? sizeText(installed?.sizeOnDisk) : "—" }}
                    </dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.detail.lastPlayed") }}</dt>
                    <dd>{{ lastPlayed || t("games.neverPlayed") }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.detail.playtime") }}</dt>
                    <dd class="tabular-nums">{{ playtime || t("games.playtimeNone") }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.releaseDate") }}</dt>
                    <dd>{{ appDetails?.releaseDate || "—" }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.genres") }}</dt>
                    <dd>{{ appDetails?.genres?.join(" · ") || "—" }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.price") }}</dt>
                    <dd class="price">{{ priceText }}</dd>
                  </div>
                  <div v-if="appDetails?.developers?.length" class="info-row">
                    <dt>{{ t("games.detail.developer") }}</dt>
                    <dd>{{ appDetails.developers.join(" · ") }}</dd>
                  </div>
                  <div v-if="appDetails?.publishers?.length" class="info-row">
                    <dt>{{ t("games.detail.publisher") }}</dt>
                    <dd>{{ appDetails.publishers.join(" · ") }}</dd>
                  </div>
                </dl>
              </div>
            </m3e-card>
          </aside>
        </div>
      </template>
    </template>
  </div>
</template>
<style scoped>
.detail-view {
  max-width: 1280px;
  margin: 0 auto;
  padding-bottom: 32px;
  view-transition-name: game-detail-page;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.5;
}
.bar .material-symbols-outlined {
  font-size: 18px;
  flex-shrink: 0;
}
.bar-text {
  flex: 1;
  min-width: 0;
}
.bar.error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.bar.info {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.hero-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.skeleton-hero {
  width: 100%;
  aspect-ratio: 21 / 9;
  border-radius: var(--md-sys-shape-corner-large);
  view-transition-name: game-cover;
}
.skeleton-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 4px;
}
.line {
  height: 12px;
  border-radius: 6px;
}
.line.wide {
  width: 52%;
  height: 18px;
}
.line:not(.wide) {
  width: 30%;
}

.hero {
  position: relative;
  margin-bottom: 16px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
}
.hero-media {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 21 / 9;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline);
  view-transition-name: game-cover;
}
.hero-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.hero-fallback {
  font-size: 64px;
}
.hero-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    transparent 38%,
    var(--md-sys-color-scrim) 100%
  );
  opacity: 0.82;
  pointer-events: none;
}
.hero-content {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 16px 20px;
}
.hero-back {
  flex-shrink: 0;
  color: var(--md-sys-color-on-surface);
}
.hero-text {
  min-width: 0;
  flex: 1;
}
.hero-title {
  margin: 0;
  font-size: var(--md-sys-typescale-display-small-size);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: var(--md-sys-typescale-display-small-tracking);
  color: #fff;
  text-shadow:
    0 1px 3px rgba(0, 0, 0, 0.9),
    0 2px 18px rgba(0, 0, 0, 0.75);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.genre-chip {
  --m3e-assist-chip-container-height: 28px;
}

.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}
.action-main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.action-side {
  display: flex;
  align-items: center;
  gap: 4px;
}
.installed-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-size: var(--md-sys-typescale-label-medium-size);
}
.tag-icon {
  font-size: 16px;
}
.meta-text {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.path-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 420px;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  cursor: pointer;
}
.path-chip:hover {
  background: var(--md-sys-color-surface-container-high);
}
.path-chip:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.path-icon {
  font-size: 16px;
  flex-shrink: 0;
}
.path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  margin-bottom: 16px;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}
.download-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.download-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  color: var(--md-sys-color-on-surface);
}
.download-icon {
  font-size: 20px;
  flex-shrink: 0;
  color: var(--md-sys-color-primary);
}
.download-percent {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-label-large-size);
  color: var(--md-sys-color-primary);
}
.download-bar {
  --m3e-linear-progress-indicator-thickness: 6px;
}
.download-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.download-file {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--md-sys-color-on-surface);
}
.download-bytes,
.download-depots {
  flex-shrink: 0;
}
.download-error-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.download-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.5;
}
.download-error-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.depot-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 4px 8px 4px 4px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-medium-size);
  cursor: pointer;
}
.depot-toggle:hover {
  background: var(--md-sys-color-surface-container-high);
}
.depot-toggle:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.depot-toggle-icon {
  font-size: 20px;
}
.depot-count {
  padding: 0 6px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-size: var(--md-sys-typescale-label-small-size);
}
.depot-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.depot-error {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.depot-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.depot-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.depot-id {
  flex-shrink: 0;
  width: 88px;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.depot-bar {
  flex: 1;
  min-width: 0;
  --m3e-linear-progress-indicator-thickness: 4px;
}
.depot-pct {
  flex-shrink: 0;
  width: 40px;
  text-align: right;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.login-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 16px;
  border-radius: var(--md-sys-shape-corner-large);
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}
.login-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.login-panel-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  color: var(--md-sys-color-on-surface);
}
.login-panel-icon {
  font-size: 20px;
  flex-shrink: 0;
  color: var(--md-sys-color-primary);
}

.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  align-items: start;
}
.col-main,
.col-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.block {
  border-radius: var(--md-sys-shape-corner-large);
}
.block-title {
  margin: 0 0 10px;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  color: var(--md-sys-color-on-surface);
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.block-head .block-title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.block-count {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.about-skeleton {
  display: grid;
  gap: 8px;
  padding: 4px 0;
}

.about-text {
  margin: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.7;
  color: var(--md-sys-color-on-surface);
  white-space: pre-line;
}
.about-text.muted {
  color: var(--md-sys-color-on-surface-variant);
}

.shot-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.shot {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 9;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-outline);
  overflow: hidden;
}
.shot-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.shot-fallback {
  font-size: 28px;
}
.shot-skeleton {
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.dlc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dlc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px;
  min-width: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.dlc-item:hover {
  background: var(--md-sys-color-surface-container-high);
}
.dlc-item:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.dlc-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 88px;
  aspect-ratio: 16 / 9;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-outline);
  overflow: hidden;
}
.dlc-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dlc-fallback {
  font-size: 22px;
}
.dlc-name {
  min-width: 0;
  flex: 1;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dlc-more .dlc-thumb {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.dlc-more-text {
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
}
.dlc-more .dlc-name {
  color: var(--md-sys-color-on-surface-variant);
}

.ach-progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.ach-bar {
  flex: 1;
  min-width: 0;
}
.ach-percent {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-count {
  margin: 0 0 10px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-wall {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.ach-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  overflow: hidden;
}
.ach-tile:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.ach-tile-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ach-tile-fallback {
  font-size: 24px;
}
.ach-tile-more {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.ach-more-text {
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
}
.ach-wall-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline-variant);
}
.ach-wall-empty .material-symbols-outlined {
  font-size: 22px;
}
.ach-locked {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}
.ach-locked-title {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-locked-count {
  font-size: var(--md-sys-typescale-label-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-locked-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-outline);
  text-align: right;
}
.side-loading {
  display: flex;
  justify-content: center;
  padding: 6px 0 2px;
}
.side-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}
.inline-loading {
  --m3e-loading-indicator-size: 18px;
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}
.info-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.info-row dt {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.info-row dd {
  margin: 0;
  text-align: right;
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
}
.info-row dd.price {
  color: var(--md-sys-color-primary);
  font-weight: 600;
}

@media (max-width: 900px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
  .hero-media {
    aspect-ratio: 16 / 9;
  }
  .path-chip {
    max-width: 100%;
  }
}
@media (max-width: 600px) {
  .hero-content {
    padding: 12px 14px;
  }
  .hero-title {
    font-size: var(--md-sys-typescale-title-large-size);
  }
  .shot-wall {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .dlc-item,
  .ach-tile {
    transition: none;
  }
}
</style>
