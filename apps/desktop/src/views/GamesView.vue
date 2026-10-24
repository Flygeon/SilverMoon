<script setup lang="ts">
/**
 * 游戏（左侧导航 → 游戏）。
 *
 * 职责：未登录时出登录卡（复用 components/SteamLoginPanel.vue），已登录时出顶栏 + 游戏库网格，
 * 点卡片打开详情对话框（商店元信息来自 op:"appDetails"）。
 *
 * 链路：本视图 → stores/steam.ts → capabilities.steam({ op, ... })
 *       → callBridge("steam", payload) → electron/ipc.ts 的 steam 通道
 *       → electron/steam/（HTTPS WebAPI：认证 / IPlayerService 游戏库 / 商店 appdetails）。
 *
 * 约定：
 * - 图片一律 loading="lazy"，失败改用 Material 图标占位（**不用 emoji**）；
 * - 颜色只用 M3 令牌（--md-sys-color-*），不写死 Steam 绿（深色主题下会脏）；
 * - 所有请求都有 loading / 错误提示，不允许静默失败。
 */
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EmptyState from "@/components/EmptyState.vue";
import SteamLoginPanel from "@/components/SteamLoginPanel.vue";
import { useSettingsStore } from "@/stores/settings";
import { useSteamStore, type SteamSort } from "@/stores/steam";
import { translate } from "@shared/i18n";
import type { SteamGame } from "@shared/types";

const settings = useSettingsStore();
const steam = useSteamStore();
const t = (key: string) => translate(settings.lang, key);

// ---------------------------------------------------------------- 工具栏状态
const keyword = ref("");
const sortBy = ref<SteamSort>("recent");

/** 排序选项（按钮组用，保持顺序稳定） */
const SORTS: { value: SteamSort; labelKey: string; icon: string }[] = [
  { value: "recent", labelKey: "games.sortRecent", icon: "schedule" },
  { value: "name", labelKey: "games.sortName", icon: "sort_by_alpha" },
  { value: "playtime", labelKey: "games.sortPlaytime", icon: "timelapse" },
];

/** 头图 / 头像加载失败的集合（URL → true），失败后换占位图标 */
const brokenImages = ref<Record<string, boolean>>({});

function markBroken(url: string | null | undefined): void {
  if (!url) return;
  brokenImages.value = { ...brokenImages.value, [url]: true };
}

function isBroken(url: string | null | undefined): boolean {
  return !!url && !!brokenImages.value[url];
}

/** 游戏卡片的头图：优先 headerUrl，其次 appId 拼官方 CDN（与宿主同源策略一致） */
function coverOf(game: SteamGame): string {
  return game.headerUrl || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appId}/header.jpg`;
}

// ---------------------------------------------------------------- 格式化
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 分钟 → 「共 X 小时」（不足 1 小时给分钟，避免全是 0 小时） */
function hoursText(minutes?: number | null): string {
  const m = minutes ?? 0;
  if (m <= 0) return t("games.playtimeNone");
  const hours = m / 60;
  if (hours < 1) return t("games.minutes").replace("{n}", String(Math.max(1, Math.round(m))));
  const text = hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1).replace(/\.0$/, "");
  return t("games.playtimeTotal").replace("{n}", text);
}

/** 分钟 → 「最近 X 小时」；0 / null 返回空串（不占位） */
function recentText(minutes?: number | null): string {
  const m = minutes ?? 0;
  if (m <= 0) return "";
  const hours = m / 60;
  const text = hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1).replace(/\.0$/, "");
  return t("games.playtimeRecent").replace("{n}", text);
}

/** 毫秒时间戳 → 相对时间（最近游玩） */
function relativeTime(ms?: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return t("games.neverPlayed");
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("games.justNow");
  if (min < 60) return t("games.minutesAgo").replace("{n}", String(min));
  const hour = Math.floor(min / 60);
  if (hour < 24) return t("games.hoursAgo").replace("{n}", String(hour));
  const day = Math.floor(hour / 24);
  if (day < 30) return t("games.daysAgo").replace("{n}", String(day));
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 缓存时间 → 「更新于 MM-DD HH:mm」 */
function cacheText(ms?: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const stamp = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return t("games.cachedAt").replace("{time}", stamp);
}

/** 顶栏总时长（小时，整数） */
const totalHours = computed(() => Math.round(steam.totalPlaytimeMinutes / 60));

// ---------------------------------------------------------------- 过滤 + 排序
/** 按关键词过滤后、再按当前排序规则排好的列表 */
const visibleGames = computed<SteamGame[]>(() => {
  const q = keyword.value.trim().toLowerCase();
  const list = q ? steam.games.filter((g) => g.name.toLowerCase().includes(q)) : [...steam.games];
  switch (sortBy.value) {
    case "name":
      return list.sort((a, b) =>
        a.name.localeCompare(b.name, settings.lang === "zh" ? "zh" : "en"),
      );
    case "playtime":
      return list.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
    case "recent":
    default:
      // 最近游玩的排前面；没玩过的（null）沉底，同一档按总时长排
      return list.sort((a, b) => {
        const r = (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0);
        if (r !== 0) return r;
        return b.playtimeMinutes - a.playtimeMinutes;
      });
  }
});

const hasFilter = computed(() => keyword.value.trim().length > 0);

// ---------------------------------------------------------------- 详情对话框
/** m3e-dialog 没有 v-model，只能拿实例调 show()/hide() */
interface M3eDialog extends HTMLElement {
  show(): Promise<void>;
  hide(returnValue?: string): Promise<void>;
}
const detailDialog = ref<M3eDialog | null>(null);
/** 当前打开详情的游戏 */
const activeGame = ref<SteamGame | null>(null);

const activeDetails = computed(() => {
  if (!activeGame.value) return null;
  return steam.details[String(activeGame.value.appId)] ?? null;
});

async function openDetails(game: SteamGame): Promise<void> {
  activeGame.value = game;
  // 先开弹窗再拉数据，避免等待期间界面毫无反馈
  await detailDialog.value?.show();
  if (!steam.details[String(game.appId)]) void steam.fetchDetails(game.appId);
}

function closeDetails(): void {
  void detailDialog.value?.hide();
}

const detailCover = computed<string>(() => {
  if (!activeGame.value) return "";
  const appId = activeGame.value.appId;
  return (
    activeDetails.value?.headerImage ||
    activeDetails.value?.capsuleImage ||
    activeGame.value.headerUrl ||
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`
  );
});

/** 弹窗完全关闭（含 Esc / 点遮罩）后兜底清状态 */
function onDetailsClosed(): void {
  activeGame.value = null;
  steam.clearDetails();
}

/** 详情里重试（失败后） */
function retryDetails(): void {
  if (!activeGame.value) return;
  steam.clearDetails();
  void steam.fetchDetails(activeGame.value.appId);
}

/** 在 Steam 商店打开该游戏（走系统浏览器，应用内不开远程页） */
function openStore(): void {
  if (!activeGame.value) return;
  const id = activeGame.value.appId;
  void import("@/ipc/opener")
    .then((m) => m.openUrl(`https://store.steampowered.com/app/${id}`))
    .catch(() => {});
}

// ---------------------------------------------------------------- 生命周期
let loadedOnce = false;

async function bootstrap(): Promise<void> {
  if (loadedOnce) return;
  loadedOnce = true;
  await steam.subscribe();
  await steam.load();
}

onMounted(() => {
  void bootstrap();
});

// keep-alive 页面切回来时补一次登录态：会话可能在别处被改（或刚刚过期）
onActivated(() => {
  if (!loadedOnce) {
    void bootstrap();
    return;
  }
  // 已有数据就不打扰：只刷新登录态，避免每次切页都重拉几百款游戏
  void steam.loadStatus();
});

onBeforeUnmount(() => {
  steam.unsubscribe();
});

/** 登录成功：面板 emit 后兜底把库拉起来（store 内部通常已经拉过） */
function onLoggedIn(): void {
  if (!steam.games.length) void steam.loadLibrary();
}

// 错误条上的「重试」按语义分流：未登录时重连，已登录时刷库
function retry(): void {
  if (steam.loggedIn) void steam.refresh();
  else void steam.reconnect();
}

// 退出登录后清空筛选，避免残留关键词让人以为库空了
watch(
  () => steam.loggedIn,
  (ok) => {
    if (!ok) keyword.value = "";
  },
);

/** 首屏加载中（还没拿到登录态） */
const booting = computed(() => !steam.statusLoaded && steam.statusLoading);
/** 库为空且没有过滤条件 —— 区分「真空库」与「搜索无结果」 */
const libraryEmpty = computed(
  () => steam.libraryLoaded && !steam.libraryLoading && !steam.games.length,
);
</script>
<template>
  <div class="games-view">
    <!-- ============================ 首屏加载 ============================ -->
    <div v-if="booting" class="boot-block">
      <m3e-loading-indicator class="lm-loading" />
      <span>{{ t("games.loading") }}</span>
    </div>

    <!-- ============================ 未登录：登录卡 ============================ -->
    <div v-else-if="!steam.loggedIn" class="login-wrap">
      <m3e-card class="login-card" variant="filled">
        <div class="login-head">
          <span class="login-logo material-symbols-outlined">sports_esports</span>
          <h2 class="login-title">{{ t("games.loginTitle") }}</h2>
          <p class="login-desc">{{ t("games.loginDesc") }}</p>
        </div>

        <!-- 登录态失效（hasSession 但未登入）时先提示重连 -->
        <div v-if="steam.needsReconnect" class="bar warn" role="status">
          <span class="material-symbols-outlined">info</span>
          <span>{{ t("games.reconnectHint") }}</span>
        </div>

        <SteamLoginPanel @logged-in="onLoggedIn" />
      </m3e-card>
    </div>

    <!-- ============================ 已登录：顶栏 + 库 ============================ -->
    <template v-else>
      <!-- 顶栏：头像 + 昵称 + 游戏数 + 刷新 + 退出 -->
      <header class="games-header">
        <div class="account">
          <div class="avatar-wrap">
            <img
              v-if="steam.status.avatarUrl && !isBroken(steam.status.avatarUrl)"
              :src="steam.status.avatarUrl"
              class="avatar"
              alt=""
              loading="lazy"
              decoding="async"
              @error="markBroken(steam.status.avatarUrl)"
            />
            <span v-else class="material-symbols-outlined avatar-fallback">account_circle</span>
          </div>
          <div class="account-text">
            <div class="account-name">{{ steam.displayName || t("games.title") }}</div>
            <div class="account-meta tabular-nums">
              <span>{{
                t("games.gameCount").replace("{n}", String(steam.total || steam.games.length))
              }}</span>
              <span v-if="totalHours > 0" class="dot">·</span>
              <span v-if="totalHours > 0">
                {{ t("games.totalPlaytime").replace("{n}", String(totalHours)) }}
              </span>
              <span v-if="steam.cachedAt" class="dot">·</span>
              <span v-if="steam.cachedAt" class="cache-time">{{ cacheText(steam.cachedAt) }}</span>
            </div>
          </div>
        </div>

        <div class="header-actions">
          <m3e-button
            variant="tonal"
            size="small"
            :disabled="steam.libraryLoading"
            @click="steam.refresh()"
          >
            <span slot="icon" class="material-symbols-outlined">refresh</span>
            {{ steam.libraryLoading ? t("games.refreshing") : t("games.refresh") }}
          </m3e-button>
          <m3e-button variant="text" size="small" @click="steam.logout()">
            <span slot="icon" class="material-symbols-outlined">logout</span>
            {{ t("games.logout") }}
          </m3e-button>
        </div>
      </header>

      <!-- 宿主降级提示（如「登录态已失效，显示上次缓存」） -->
      <div v-if="steam.warning" class="bar warn" role="status">
        <span class="material-symbols-outlined">info</span>
        <span>{{ steam.warning }}</span>
      </div>

      <!-- 错误条：可重试 -->
      <div v-if="steam.error" class="bar error" role="alert">
        <span class="material-symbols-outlined">error</span>
        <span class="bar-text">{{ steam.error }}</span>
        <m3e-button variant="text" size="small" @click="retry">
          {{ t("games.retry") }}
        </m3e-button>
      </div>

      <!-- 工具栏：搜索 + 排序 -->
      <div class="toolbar">
        <m3e-form-field class="search-field" variant="filled">
          <input
            v-model="keyword"
            type="search"
            :placeholder="t('games.searchPlaceholder')"
            spellcheck="false"
          />
          <span slot="leading-icon" class="material-symbols-outlined field-icon">search</span>
        </m3e-form-field>
        <m3e-button-group class="sort-group" :aria-label="t('games.sort')">
          <m3e-button
            v-for="s in SORTS"
            :key="s.value"
            shape="round"
            size="medium"
            type="button"
            :variant="sortBy === s.value ? 'filled' : 'tonal'"
            @click="sortBy = s.value"
          >
            <span slot="icon" class="material-symbols-outlined sort-icon">{{ s.icon }}</span>
            {{ t(s.labelKey) }}
          </m3e-button>
        </m3e-button-group>
      </div>

      <!-- 加载态：骨架屏 -->
      <div v-if="steam.libraryLoading && !steam.games.length" class="grid">
        <div v-for="n in 8" :key="n" class="card skeleton-card">
          <div class="lm-skeleton card-cover"></div>
          <div class="card-body">
            <div class="lm-skeleton line wide"></div>
            <div class="lm-skeleton line"></div>
          </div>
        </div>
      </div>

      <!-- 搜索无结果 -->
      <EmptyState
        v-else-if="hasFilter && !visibleGames.length"
        variant="search"
        :title="t('games.emptySearchTitle')"
        :description="t('games.emptySearchHint')"
        :action-label="t('games.retry')"
        @action="keyword = ''"
      />

      <!-- 真空库 -->
      <EmptyState
        v-else-if="libraryEmpty"
        variant="empty"
        icon="sports_esports"
        :title="t('games.emptyTitle')"
        :description="t('games.emptyHint')"
        :action-label="t('games.refresh')"
        @action="steam.refresh()"
      />

      <!-- 库加载失败且无任何缓存 -->
      <EmptyState
        v-else-if="steam.error && !steam.games.length"
        variant="error"
        :title="t('games.errorTitle')"
        :description="steam.error"
        :action-label="t('games.retry')"
        @action="retry"
      />

      <!-- 游戏库网格 -->
      <div v-else class="grid">
        <button
          v-for="game in visibleGames"
          :key="game.appId"
          class="card game-card"
          :title="game.name"
          @click="openDetails(game)"
        >
          <div class="card-cover">
            <img
              v-if="!isBroken(coverOf(game))"
              :src="coverOf(game)"
              class="cover-img"
              :alt="game.name"
              loading="lazy"
              decoding="async"
              @error="markBroken(coverOf(game))"
            />
            <span v-else class="material-symbols-outlined cover-fallback">sports_esports</span>
          </div>
          <div class="card-body">
            <div class="game-name">{{ game.name }}</div>
            <div class="game-meta">
              <span class="playtime tabular-nums">{{ hoursText(game.playtimeMinutes) }}</span>
              <span v-if="recentText(game.playtimeRecentMinutes)" class="recent tabular-nums">
                {{ recentText(game.playtimeRecentMinutes) }}
              </span>
            </div>
            <div class="game-last">
              <span class="material-symbols-outlined last-icon">schedule</span>
              <span>{{
                game.lastPlayedAt
                  ? t("games.lastPlayed").replace("{time}", relativeTime(game.lastPlayedAt))
                  : t("games.neverPlayed")
              }}</span>
            </div>
          </div>
        </button>
      </div>

      <!-- 刷新时的轻量指示（已有数据，不整屏骨架） -->
      <div v-if="steam.libraryLoading && steam.games.length" class="refreshing-row">
        <m3e-loading-indicator class="inline-loading" />
        <span>{{ t("games.refreshing") }}</span>
      </div>
    </template>

    <!-- ============================ 详情对话框 ============================ -->
    <m3e-dialog
      ref="detailDialog"
      class="detail-dialog"
      @cancel="closeDetails"
      @closed="onDetailsClosed"
    >
      <span slot="header">{{ activeGame?.name || t("games.details") }}</span>
      <div v-if="activeGame" class="detail-body">
        <!-- 封面 -->
        <div class="detail-cover">
          <img
            v-if="detailCover && !isBroken(detailCover)"
            :src="detailCover"
            :alt="activeGame.name"
            loading="lazy"
            decoding="async"
            @error="markBroken(detailCover)"
          />
          <span v-else class="material-symbols-outlined cover-fallback">sports_esports</span>
        </div>

        <!-- 基础统计（来自库，永远可用） -->
        <div class="detail-stats tabular-nums">
          <div class="stat">
            <span class="material-symbols-outlined stat-icon">timelapse</span>
            <span>{{ hoursText(activeGame.playtimeMinutes) }}</span>
          </div>
          <div v-if="recentText(activeGame.playtimeRecentMinutes)" class="stat">
            <span class="material-symbols-outlined stat-icon">update</span>
            <span>{{ recentText(activeGame.playtimeRecentMinutes) }}</span>
          </div>
        </div>

        <!-- 商店详情：加载中 / 失败 / 成功 -->
        <div v-if="steam.detailsLoading && !activeDetails" class="detail-loading">
          <m3e-loading-indicator class="lm-loading" />
          <span>{{ t("games.detailsLoading") }}</span>
        </div>

        <div v-else-if="steam.detailsError && !activeDetails" class="bar error">
          <span class="material-symbols-outlined">error</span>
          <span class="bar-text">{{ t("games.detailsFailed") }}</span>
          <m3e-button variant="text" size="small" @click="retryDetails">
            {{ t("games.retry") }}
          </m3e-button>
        </div>

        <template v-else-if="activeDetails">
          <p v-if="activeDetails.shortDescription" class="detail-desc">
            {{ activeDetails.shortDescription }}
          </p>
          <p v-else class="detail-desc muted">{{ t("games.noDescription") }}</p>

          <div v-if="activeDetails.genres?.length" class="detail-row">
            <span class="row-label">{{ t("games.genres") }}</span>
            <div class="chips">
              <m3e-assist-chip v-for="g in activeDetails.genres" :key="g" class="chip">
                {{ g }}
              </m3e-assist-chip>
            </div>
          </div>

          <div v-if="activeDetails.releaseDate" class="detail-row">
            <span class="row-label">{{ t("games.releaseDate") }}</span>
            <span class="row-value">{{ activeDetails.releaseDate }}</span>
          </div>

          <div class="detail-row">
            <span class="row-label">{{ t("games.price") }}</span>
            <span class="row-value price">
              {{ activeDetails.isFree ? t("games.free") : activeDetails.priceText || "—" }}
            </span>
          </div>
        </template>
      </div>

      <div slot="actions" end>
        <m3e-button variant="text" size="small" @click="openStore">
          <span slot="icon" class="material-symbols-outlined">open_in_new</span>
          {{ t("games.openStore") }}
        </m3e-button>
        <m3e-button variant="filled" size="small" @click="closeDetails">
          {{ t("games.close") }}
        </m3e-button>
      </div>
    </m3e-dialog>
  </div>
</template>

<style scoped>
.games-view {
  max-width: 1280px;
  margin: 0 auto;
  padding-bottom: 24px;
}

/* ---- 首屏 ---- */
.boot-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 320px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
}

/* ---- 登录卡 ---- */
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 220px);
  padding: 24px 0;
}
.login-card {
  width: min(520px, 100%);
  padding: 28px 24px 24px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-low);
}
.login-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  text-align: center;
}
.login-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-size: 30px;
}
.login-title {
  margin: 4px 0 0;
  font-size: var(--md-sys-typescale-headline-small-size);
  font-weight: var(--md-sys-typescale-headline-small-weight);
  color: var(--md-sys-color-on-surface);
}
.login-desc {
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- 提示条 ---- */
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
.bar.warn {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.bar.error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}

/* ---- 顶栏 ---- */
.games-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 16px;
  margin-bottom: 14px;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}
.account {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.avatar-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
}
.avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-fallback {
  font-size: 30px;
  color: var(--md-sys-color-on-surface-variant);
}
.account-text {
  min-width: 0;
}
.account-name {
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.account-meta .dot {
  opacity: 0.6;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---- 工具栏 ---- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.search-field {
  flex: 1;
  min-width: 220px;
  --m3e-form-field-container-height: 40px;
}
.search-field input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  outline: none;
}
.field-icon {
  font-size: 20px;
  color: var(--md-sys-color-on-surface-variant);
}
.sort-group {
  --m3e-connected-button-group-spacing: 3px;
  --m3e-connected-button-group-medium-inner-shape: 8px;
  --m3e-connected-button-group-medium-inner-pressed-shape: 8px;
  --m3e-button-medium-container-height: 36px;
  --m3e-button-medium-label-text-font-size: var(--md-sys-typescale-label-large-size);
  --m3e-button-icon-size: 18px;
  --m3e-button-icon-label-space: 8px;
  display: inline-flex;
}
.sort-icon {
  font-size: 18px;
  line-height: 1;
}

/* ---- 网格 ---- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 20px 16px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  border: none;
  border-radius: var(--lm-shape-card, 16px);
  background: var(--md-sys-color-surface-container-low);
  color: inherit;
  font-family: inherit;
  text-align: left;
  overflow: hidden;
  cursor: pointer;
  outline: none;
  transition:
    transform 220ms var(--md-sys-motion-spring-soft, var(--md-sys-motion-spring-spatial)),
    box-shadow 220ms var(--md-sys-motion-spring-effects-fast);
}
.card:hover {
  transform: translateY(-4px);
  box-shadow: var(--md-elevation-2);
}
.card:active {
  transform: translateY(-1px) scale(0.995);
}
.card:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 3px;
}
.skeleton-card {
  cursor: default;
}
.skeleton-card:hover {
  transform: none;
  box-shadow: none;
}

/* 16:9 头图（Steam header.jpg 是 460×215，接近 2.14:1，这里裁切成 16:9 更统一） */
.card-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline);
  overflow: hidden;
}
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-fallback {
  font-size: 40px;
}
.card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px 14px;
  min-width: 0;
}
.game-name {
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.recent {
  color: var(--md-sys-color-primary);
}
.game-last {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.last-icon {
  font-size: 14px;
  opacity: 0.8;
}

/* 骨架屏的行 */
.line {
  height: 12px;
  border-radius: 6px;
}
.line.wide {
  width: 72%;
  height: 14px;
}
.line:not(.wide) {
  width: 48%;
}

/* ---- 刷新提示 ---- */
.refreshing-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 0 4px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.inline-loading {
  --m3e-loading-indicator-size: 18px;
}

/* ---- 详情对话框 ---- */
.detail-dialog {
  --m3e-dialog-min-width: min(560px, 92vw);
}
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 560px;
  text-align: left;
}
.detail-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline);
  overflow: hidden;
}
.detail-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.detail-stats {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.stat-icon {
  font-size: 18px;
}
.detail-desc {
  margin: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.65;
  color: var(--md-sys-color-on-surface);
}
.detail-desc.muted {
  color: var(--md-sys-color-on-surface-variant);
}
.detail-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: var(--md-sys-typescale-body-medium-size);
}
.row-label {
  flex-shrink: 0;
  width: 64px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 24px;
}
.row-value {
  color: var(--md-sys-color-on-surface);
  line-height: 24px;
}
.row-value.price {
  color: var(--md-sys-color-primary);
  font-weight: 600;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  --m3e-filter-chip-container-height: 28px;
}
.detail-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 64px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}

@media (max-width: 640px) {
  .games-header {
    align-items: flex-start;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .card {
    transition: none;
  }
}
</style>
