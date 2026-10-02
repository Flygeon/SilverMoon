<script setup lang="ts">
/**
 * 「我的」面板（B 站子选项卡内的第三个页签）。
 *
 * 布局按需求落地：
 * - 顶部账号卡（保持原有信息密度）；
 * - 账号卡下方是**两个 Hero 菜单**（我的历史 / 我的收藏），样式对齐项目里
 *   `NowPlayingFeed` 的 `feed-hero`（M3 Expressive 卡片：圆圈图标 + 标题 + 描述 + 圆形按钮）；
 * - 再往下**直接铺开「我的投稿」视频卡片网格**，不再套第二层菜单 —— 打开这一页
 *   就能看到自己的投稿。
 *
 * 历史 / 收藏是详情列表，点 Hero 后在本面板内切换视图（带返回），
 * 不新开路由，也不额外弹窗。
 */
import { computed, ref, watch } from "vue";
import BilibiliCard from "@/components/BilibiliCard.vue";
import EmptyState from "@/components/EmptyState.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { biliCount, type BiliVideo } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

const emit = defineEmits<{
  (e: "open", video: BiliVideo): void;
  (e: "login"): void;
}>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

/** 当前打开的详情视图；null 表示停在「我的」主页 */
const view = ref<"history" | "favorites" | null>(null);

const mySubtitle = computed(() =>
  bili.myVideos.length
    ? t("bili.myVideosHint").replace("{n}", biliCount(bili.myTotal || bili.myVideos.length))
    : t("bili.emptyHintShort"),
);
const historySubtitle = computed(() =>
  bili.history.length
    ? t("bili.historyHint").replace("{n}", biliCount(bili.history.length))
    : t("bili.myHistoryHint"),
);
const favSubtitle = computed(() =>
  bili.favVideos.length
    ? t("bili.favoritesHint").replace("{n}", biliCount(bili.favVideos.length))
    : t("bili.myFavoritesHint"),
);

function openView(target: "history" | "favorites"): void {
  view.value = target;
  if (target === "history" && bili.historyStatus === "idle") void bili.loadHistory(true);
  if (target === "favorites") {
    if (!bili.favFolders.length) void bili.loadFavFolders();
    // idle = 还没拉过；error = 上次失败，重进时再试一次
    if (bili.favStatus === "idle" || bili.favStatus === "error") void bili.loadFavorites(true);
  }
}

function back(): void {
  view.value = null;
}

/**
 * 切换收藏夹。
 *
 * 先把列表清空并置 loading，再拉新夹：否则上一个夹的内容会短暂留在屏幕上，
 * 用户会以为「切了但没变」。
 */
function switchFolder(id: string | number): void {
  const mediaId = Number(id);
  if (mediaId === bili.favMediaId) return;
  bili.favVideos = [];
  bili.favEnd = false;
  void bili.loadFavorites(true, mediaId);
}

/** 收藏加载失败重试：收藏夹列表本身也可能没拉到，一起重来。 */
async function retryFavorites(): Promise<void> {
  await bili.loadFavFolders();
  await bili.loadFavorites(true);
}

/** 登录成功后自动装载投稿与收藏夹（历史按需）。 */
watch(
  () => bili.account.isLogin,
  (loggedIn) => {
    if (loggedIn) void bili.loadMine();
  },
  { immediate: true },
);
</script>

<template>
  <div class="mine">
    <!-- ============ 未登录 ============ -->
    <div v-if="!bili.account.isLogin" class="account-empty">
      <span class="avatar big">
        <span class="material-symbols-outlined">account_circle</span>
      </span>
      <h3>{{ t("bili.notLoggedIn") }}</h3>
      <p class="hint">{{ t("bili.loginHint") }}</p>
      <m3e-button variant="filled" @click="emit('login')">
        <span slot="icon" class="material-symbols-outlined">qr_code_2</span>
        {{ t("bili.scanLogin") }}
      </m3e-button>
    </div>

    <template v-else>
      <!-- ============ 账号卡 ============ -->
      <div class="account-card">
        <div class="account-head">
          <span class="avatar big">
            <img
              v-if="bili.account.face"
              :src="bili.account.face"
              alt=""
              referrerpolicy="no-referrer"
            />
            <span v-else class="material-symbols-outlined">account_circle</span>
          </span>
          <div class="account-info">
            <div class="account-name" :title="bili.account.name">{{ bili.account.name }}</div>
            <div class="account-meta">
              <span class="pill">{{ t("bili.level") }} Lv{{ bili.account.level }}</span>
              <span v-if="bili.account.vip" class="pill vip">{{ t("bili.vip") }}</span>
              <span class="pill">{{ biliCount(bili.account.coins) }} {{ t("bili.coins") }}</span>
              <span v-if="bili.myTotal" class="pill"
                >{{ biliCount(bili.myTotal) }}{{ t("bili.videosUnit") }}</span
              >
            </div>
          </div>
          <div class="account-actions">
            <m3e-button variant="tonal" size="small" @click="emit('login')">
              <span slot="icon" class="material-symbols-outlined">sync</span>
              {{ t("bili.relogin") }}
            </m3e-button>
            <m3e-button variant="text" size="small" @click="bili.logout()">
              <span slot="icon" class="material-symbols-outlined">logout</span>
              {{ t("bili.logout") }}
            </m3e-button>
          </div>
        </div>
      </div>

      <!-- ============ 主页：Hero 菜单 + 直出的投稿 ============ -->
      <template v-if="!view">
        <div class="feed-hero-row">
          <button class="feed-hero" type="button" @click="openView('history')">
            <span class="hero-icon material-symbols-outlined">history</span>
            <div class="hero-main">
              <h3 class="hero-title">{{ t("bili.myHistory") }}</h3>
              <p class="hero-desc">{{ historySubtitle }}</p>
            </div>
            <span class="hero-play material-symbols-outlined">chevron_right</span>
          </button>

          <button class="feed-hero" type="button" @click="openView('favorites')">
            <span class="hero-icon material-symbols-outlined">collections_bookmark</span>
            <div class="hero-main">
              <h3 class="hero-title">{{ t("bili.myFavorites") }}</h3>
              <p class="hero-desc">{{ favSubtitle }}</p>
            </div>
            <span class="hero-play material-symbols-outlined">chevron_right</span>
          </button>
        </div>

        <section class="section">
          <div class="section-head">
            <h3 class="section-title">{{ t("bili.myVideos") }}</h3>
            <span class="section-sub">{{ mySubtitle }}</span>
          </div>

          <div v-if="bili.myVideos.length" class="grid">
            <BilibiliCard
              v-for="v in bili.myVideos"
              :key="v.bvid + v.aid"
              :video="v"
              @open="emit('open', $event)"
            />
          </div>

          <div v-if="bili.myVideos.length" class="more-row">
            <m3e-button
              v-if="!bili.myEnd"
              variant="tonal"
              size="small"
              :disabled="bili.myLoadingMore"
              @click="bili.loadMoreMyVideos()"
            >
              <span slot="icon" class="material-symbols-outlined">expand_more</span>
              {{ bili.myLoadingMore ? t("bili.loading") : t("bili.loadMore") }}
            </m3e-button>
          </div>

          <div v-else-if="bili.myStatus === 'loading'" class="state-block">
            <m3e-loading-indicator class="lm-loading" />
            <span>{{ t("bili.loading") }}</span>
          </div>

          <EmptyState
            v-else-if="bili.myStatus === 'error'"
            variant="error"
            :title="t('bili.myVideosFailed')"
            :description="bili.myError"
            :action-label="t('bili.retry')"
            @action="bili.loadMyVideos(true)"
          />

          <p v-else class="state-block">{{ t("bili.noMyVideos") }}</p>
        </section>
      </template>

      <!-- ============ 我的历史 ============ -->
      <section v-else-if="view === 'history'" class="section">
        <div class="section-head">
          <m3e-icon-button size="small" @click="back">
            <span class="material-symbols-outlined">arrow_back</span>
          </m3e-icon-button>
          <h3 class="section-title">{{ t("bili.myHistory") }}</h3>
          <span class="section-sub">{{ historySubtitle }}</span>
        </div>

        <div v-if="bili.history.length" class="grid">
          <BilibiliCard
            v-for="v in bili.history"
            :key="v.bvid + v.aid"
            :video="v"
            @open="emit('open', $event)"
          />
        </div>

        <div v-if="bili.history.length" class="more-row">
          <m3e-button
            v-if="!bili.historyEnd"
            variant="tonal"
            size="small"
            :disabled="bili.historyLoadingMore"
            @click="bili.loadMoreHistory()"
          >
            <span slot="icon" class="material-symbols-outlined">expand_more</span>
            {{ bili.historyLoadingMore ? t("bili.loading") : t("bili.loadMore") }}
          </m3e-button>
        </div>

        <div v-else-if="bili.historyStatus === 'loading'" class="state-block">
          <m3e-loading-indicator class="lm-loading" />
          <span>{{ t("bili.loading") }}</span>
        </div>

        <EmptyState
          v-else-if="bili.historyStatus === 'error'"
          variant="error"
          :title="t('bili.historyFailed')"
          :description="bili.historyError"
          :action-label="t('bili.retry')"
          @action="bili.loadHistory(true)"
        />

        <p v-else class="state-block">{{ t("bili.noHistory") }}</p>
      </section>

      <!-- ============ 我的收藏 ============ -->
      <section v-else class="section">
        <div class="section-head">
          <m3e-icon-button size="small" @click="back">
            <span class="material-symbols-outlined">arrow_back</span>
          </m3e-icon-button>
          <h3 class="section-title">{{ t("bili.myFavorites") }}</h3>
          <span class="section-sub">{{ favSubtitle }}</span>
        </div>

        <!-- 收藏夹选择：多收藏夹时给一排 chip。
             注意 @click.prevent 不是可有可无：m3e-filter-chip 的 handleClick 开头是
             「if (e.defaultPrevented) return;」，不 preventDefault 它会自己把 selected
             翻转，而 Vue 的 @click 先执行 → 第一下被翻回未选中，必须点两次才切过去 -->
        <div v-if="bili.favFolders.length > 1" class="folders">
          <m3e-filter-chip
            v-for="f in bili.favFolders"
            :key="f.id"
            class="chip"
            :selected="f.id === bili.favMediaId"
            @click.prevent="switchFolder(f.id)"
          >
            {{ f.title }}（{{ biliCount(f.mediaCount) }}）
          </m3e-filter-chip>
        </div>

        <div v-if="bili.favVideos.length" class="grid">
          <BilibiliCard
            v-for="v in bili.favVideos"
            :key="v.bvid + v.aid"
            :video="v"
            @open="emit('open', $event)"
          />
        </div>

        <div v-if="bili.favVideos.length" class="more-row">
          <m3e-button
            v-if="!bili.favEnd"
            variant="tonal"
            size="small"
            :disabled="bili.favLoadingMore"
            @click="bili.loadMoreFavorites()"
          >
            <span slot="icon" class="material-symbols-outlined">expand_more</span>
            {{ bili.favLoadingMore ? t("bili.loading") : t("bili.loadMore") }}
          </m3e-button>
        </div>

        <div v-else-if="bili.favStatus === 'loading'" class="state-block">
          <m3e-loading-indicator class="lm-loading" />
          <span>{{ t("bili.loading") }}</span>
        </div>

        <EmptyState
          v-else-if="bili.favStatus === 'error'"
          variant="error"
          :title="t('bili.favoritesFailed')"
          :description="bili.favError"
          :action-label="t('bili.retry')"
          @action="retryFavorites"
        />

        <p v-else class="state-block">{{ t("bili.noFavorites") }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.mine {
  display: flex;
  flex-direction: column;
  gap: 18px;
  animation: lm-rise 320ms var(--md-sys-motion-spring-spatial) both;
}

/* ---- 账号 ---- */
.account-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 56px 24px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  text-align: center;
}
.account-empty h3 {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.hint {
  margin: 0;
  max-width: 420px;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}

.account-card {
  padding: 18px 20px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}
.account-head {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.avatar.big {
  width: 64px;
  height: 64px;
}
.avatar.big .material-symbols-outlined {
  font-size: 40px;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.account-info {
  flex: 1;
  min-width: 0;
}
.account-name {
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.pill {
  padding: 2px 10px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-size: var(--md-sys-typescale-label-small-size);
}
.pill.vip {
  background: color-mix(in srgb, var(--md-sys-color-tertiary) 24%, transparent);
  color: var(--md-sys-color-tertiary);
}
.account-actions {
  display: flex;
  gap: 8px;
}

/* ---- Hero（对齐 NowPlayingFeed 的 feed-hero）---- */
.feed-hero-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.feed-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border: none;
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    transform 220ms var(--md-sys-motion-spring-spatial-fast),
    box-shadow 180ms;
}
.feed-hero:hover {
  transform: translateY(-2px);
  box-shadow: var(--md-elevation-2);
}
.feed-hero:active {
  transform: scale(0.98);
}
.hero-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  font-size: 26px;
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.hero-main {
  flex: 1;
  min-width: 0;
}
.hero-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.hero-desc {
  margin: 4px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-play {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 22px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

/* ---- 区块 ---- */
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.section-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.section-sub {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 20px 16px;
}
.more-row {
  display: flex;
  justify-content: center;
  padding: 12px 0;
}
.folders {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.folders .chip {
  --m3e-chip-container-height: 32px;
}
.state-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 160px;
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
}
</style>
