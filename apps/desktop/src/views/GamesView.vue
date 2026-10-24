<script setup lang="ts">
/**
 * 游戏（左侧导航 → 游戏）。
 *
 * 职责：未登录时出登录卡（复用 components/SteamLoginPanel.vue），已登录时出顶栏 + 游戏库网格，
 * 点卡片跳独立详情页（views/GameDetailView.vue，路由 /games/:appId）。
 *
 * 另有「已安装」维度：本地库（op:"localLibrary"，读本机 vdf/acf，不需要登录）
 * 与账号游戏库并行拉取，卡片据此打徽标、工具栏据此筛「全部 / 已安装」。
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
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import EmptyState from "@/components/EmptyState.vue";
import SteamLoginPanel from "@/components/SteamLoginPanel.vue";
import { useSettingsStore } from "@/stores/settings";
import { useSteamStore, type SteamSort } from "@/stores/steam";
import {
  GAME_HERO_VT_NAME,
  activeCoverAppId,
  beginCoverFlight,
  endCoverFlight,
  runViewTransition,
} from "@/utils/gameHeroTransition";
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
/** 按关键词 + 安装筛选过滤后、再按当前排序规则排好的列表 */
const visibleGames = computed<SteamGame[]>(() => {
  const q = keyword.value.trim().toLowerCase();
  let base = steam.games;
  // 先过「已安装」这一档：本地库为空（没装 Steam / 扫描失败）时该档必然为空，
  // 与其显示一张空网格，不如让它落到下面的 EmptyState 分支里说明原因
  if (installFilter.value === "installed") {
    base = base.filter((g) => installedIds.value.has(g.appId));
  }
  const list = q ? base.filter((g) => g.name.toLowerCase().includes(q)) : [...base];
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

// ---------------------------------------------------------------- 详情页跳转（hero 飞行）
//
// 详情已从「m3e-dialog 浮窗」改成独立路由页（/games/:appId）。
// 好处：可回退、可收藏、可刷新，详情页还能铺满整屏做 hero 大图；
// 代价是卡片点击不再就地展开 —— 于是用 View Transition 让「卡片放大飞进详情页」
// 补上这段连续感（返回时反向飞回，见 GameDetailView 的 goBack）。
//
// 怎么飞：被点卡片的封面挂 view-transition-name，详情页 hero 图挂**同一个**
// 名字，浏览器在路由切换前后各拍一张快照并自动补间。细节与兜底见
// utils/gameHeroTransition.ts 的长注释。

const router = useRouter();

/**
 * 点卡片 → 进详情页（appId 当路由参数，详情页用 props 收）。
 *
 * ⚠️ 必须先 `await nextTick()` 再起飞。
 *
 * View Transition 拍「旧快照」的时刻，是它自己的更新任务里 —— 而
 * `activeCoverAppId.value = ...` 触发的重渲染要走 Vue 的 microtask 调度。
 * 不等这一拍，旧快照里的卡片**还没挂上** `view-transition-name`，
 * 浏览器就找不到可补间的元素，整次过渡退化成干巴巴的淡入 ——
 * 表现就是「点卡片没有飞行动画」，而且不报任何错。
 */
async function openDetails(game: SteamGame): Promise<void> {
  activeCoverAppId.value = game.appId;
  // 把卡片**当前这张图**交给详情页：它不用等商店接口就有图，
  // 补间从第一帧到最后一帧都是同一张，不会「飞过去一个空框」。
  beginCoverFlight(game.appId, coverOf(game) || game.headerUrl || null);
  // 等这张卡片把过渡名真正写进 DOM（否则旧快照里没有它）。
  // ⚠️ 这是**一帧内**的同步收尾，不是等网络 —— 不会造成点击卡顿。
  await nextTick();
  await runViewTransition({
    // 只导航，**不等详情页数据**（等就是几百毫秒的卡死，用户已经反馈过）
    navigate: () => router.push("/games/" + game.appId),
    cleanup: endCoverFlight,
  });
}

// ---------------------------------------------------------------- 本地库
//
// 本地库（本机装了什么）与游戏库（账号买了什么）是两条独立链路：
// 前者读 libraryfolders.vdf / appmanifest_*.acf、**不需要登录**，后者走 WebAPI。
// 这里只用它做「已安装」徽标与「全部 / 已安装」筛选。

/** 安装筛选：全部 / 仅已安装 */
type InstallFilter = "all" | "installed";
const installFilter = ref<InstallFilter>("all");

const INSTALL_FILTERS: { value: InstallFilter; labelKey: string; icon: string }[] = [
  { value: "all", labelKey: "games.filterAll", icon: "apps" },
  { value: "installed", labelKey: "games.filterInstalled", icon: "download_done" },
];

/** 本机已安装的 appId 集合（卡片判徽标用它，避免每张卡各做一次 find） */
const installedIds = computed(
  () => new Set((steam.localLibrary?.installed ?? []).map((g) => g.appId)),
);

function isInstalled(appId: number): boolean {
  return installedIds.value.has(appId);
}

/** 「已安装」筛到空时给的解释：扫描失败 / 真的没装（两者不可混为一谈） */
const localHint = computed(
  () => steam.localError || steam.localLibrary?.warning || t("games.emptyInstalledHint"),
);

// ---------------------------------------------------------------- 生命周期
let loadedOnce = false;

async function bootstrap(): Promise<void> {
  if (loadedOnce) return;
  loadedOnce = true;
  await steam.subscribe();
  // 本地库与账号库**并行**：前者读本机 vdf/acf、不需要登录，
  // 串行会让「已安装」徽标晚一整轮登录+库请求才出现。
  await Promise.all([steam.load(), steam.loadLocalLibrary()]);
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
  <!--
    整页挂 `games-grid-page`：进入详情时这一页整体淡出（封面另有一份补间，
    见 .card-cover 上的 view-transition-name），避免两页叠在一起。
    返回时同一条过渡反放 —— 详见 styles 里 ::view-transition-* 规则。
  -->
  <div class="games-view" style="view-transition-name: games-grid-page">
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
        <!-- 安装筛选：全部 / 已安装（本地库为空时该档必然空，但不能静默空白） -->
        <m3e-button-group class="filter-group" :aria-label="t('games.filterLabel')">
          <m3e-button
            v-for="f in INSTALL_FILTERS"
            :key="f.value"
            shape="round"
            size="medium"
            type="button"
            :variant="installFilter === f.value ? 'filled' : 'text'"
            @click="installFilter = f.value"
          >
            <span slot="icon" class="material-symbols-outlined sort-icon">{{ f.icon }}</span>
            {{ t(f.labelKey) }}
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

      <!-- 「已安装」筛选无结果：先于关键词无结果判断 —— 这样本地库为空时 -->
      <!-- 说明的是「本机没装（或没扫到）」而不是「换个关键词试试」，后者会误导 -->
      <EmptyState
        v-else-if="installFilter === 'installed' && !visibleGames.length && !hasFilter"
        variant="empty"
        icon="download_done"
        :title="t('games.emptyInstalledTitle')"
        :description="localHint"
        :action-label="t('games.filterAll')"
        @action="installFilter = 'all'"
      />

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
          <!--
            封面挂 view-transition-name：只有被点的那一张挂（名字全局唯一），
            浏览器据此把「卡片封面」与「详情页 hero」补间成一次飞行。
          -->
          <div
            class="card-cover"
            :style="
              activeCoverAppId === game.appId
                ? 'view-transition-name: ' + GAME_HERO_VT_NAME
                : undefined
            "
          >
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
            <!-- 已安装徽标：本地库（本机 vdf/acf）命中才出现，与登录态无关 -->
            <span v-if="isInstalled(game.appId)" class="installed-badge">
              <span class="material-symbols-outlined badge-icon">check_circle</span>
              {{ t("games.installedBadge") }}
            </span>
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

/* ---- 安装筛选 ---- */
.filter-group {
  --m3e-connected-button-group-spacing: 3px;
  --m3e-connected-button-group-medium-inner-shape: 8px;
  --m3e-connected-button-group-medium-inner-pressed-shape: 8px;
  --m3e-button-medium-container-height: 36px;
  --m3e-button-medium-label-text-font-size: var(--md-sys-typescale-label-large-size);
  --m3e-button-icon-size: 18px;
  --m3e-button-icon-label-space: 8px;
  display: inline-flex;
}

/* ---- 已安装徽标（压在封面上，右下角）---- */
.installed-badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px 3px 6px;
  border-radius: var(--md-sys-shape-corner-full);
  /* 压在任意封面上，用反色板保证对比度，不依赖封面本身的明暗 */
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: 1.4;
  pointer-events: none;
}
.badge-icon {
  font-size: 14px;
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
