<script setup lang="ts">
/**
 * UP 主主页（全屏浮层）。
 *
 * 从视频详情页点头像 / 名字进入：顶部是 UP 主名片（头像 / 昵称 / 签名 / 关注按钮 /
 * 粉丝·投稿数），下方直接铺开该 UP 的投稿视频网格，可滚动加载。
 *
 * 与 BilibiliVideoView 一样，显示与否由 store 的 `userMid` 决定，关闭直接改 store。
 */
import { computed, onBeforeUnmount, onMounted } from "vue";
import BilibiliCard from "@/components/BilibiliCard.vue";
import EmptyState from "@/components/EmptyState.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { biliCount } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const card = computed(() => bili.userCard);
const busy = computed(() => bili.userStatus === "loading");

function close(): void {
  bili.closeUser();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && !document.fullscreenElement) close();
}

function openInBrowser(): void {
  if (bili.userMid) void capabilities.openUrl(`https://space.bilibili.com/${bili.userMid}`);
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="user-view">
    <header class="head lm-glass">
      <button class="head-btn" type="button" :title="t('bili.close')" @click="close">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <span class="head-title" :title="card?.name || ''">{{
        card?.name || t("bili.userHome")
      }}</span>
      <span class="spacer" />
      <button class="head-btn" type="button" :title="t('bili.openBrowser')" @click="openInBrowser">
        <span class="material-symbols-outlined">open_in_new</span>
      </button>
    </header>

    <div class="content">
      <div v-if="busy && !card" class="state-block">
        <m3e-loading-indicator class="lm-loading" />
        <span>{{ t("bili.loading") }}</span>
      </div>

      <EmptyState
        v-else-if="bili.userStatus === 'error'"
        variant="error"
        :title="t('bili.userFailed')"
        :description="bili.userError"
        :action-label="t('bili.retry')"
        @action="bili.openUser(bili.userMid)"
      />

      <template v-else-if="card">
        <section class="profile">
          <span class="avatar">
            <img v-if="card.face" :src="card.face" alt="" referrerpolicy="no-referrer" />
            <span v-else class="material-symbols-outlined">person</span>
          </span>
          <div class="info">
            <div class="name-row">
              <h2 class="name" :title="card.name">{{ card.name }}</h2>
              <span v-if="card.vip" class="badge vip">{{ t("bili.vip") }}</span>
              <span v-if="card.level" class="badge">Lv{{ card.level }}</span>
              <span v-if="card.official" class="badge official" :title="card.official">{{
                card.official
              }}</span>
            </div>
            <p v-if="card.sign" class="sign" :title="card.sign">{{ card.sign }}</p>
            <div class="stats">
              <span class="stat">
                <strong class="tabular-nums">{{ biliCount(card.fans) }}</strong>
                {{ t("bili.fans") }}
              </span>
              <span class="stat">
                <strong class="tabular-nums">{{
                  biliCount(card.archives || bili.userTotal)
                }}</strong>
                {{ t("bili.videosUnit") }}
              </span>
              <span v-if="card.likes" class="stat">
                <strong class="tabular-nums">{{ biliCount(card.likes) }}</strong>
                {{ t("bili.likesUnit") }}
              </span>
            </div>
          </div>
          <m3e-button
            variant="filled"
            size="small"
            :disabled="bili.userFollowBusy"
            @click="bili.toggleUserFollow()"
          >
            <span slot="icon" class="material-symbols-outlined">{{
              bili.userFollowed ? "check" : "add"
            }}</span>
            {{ bili.userFollowed ? t("bili.followed") : t("bili.follow") }}
          </m3e-button>
        </section>

        <div v-if="bili.userVideos.length" class="grid">
          <BilibiliCard
            v-for="v in bili.userVideos"
            :key="v.bvid + v.aid"
            :video="v"
            @open="bili.openVideo($event)"
          />
        </div>

        <div v-if="bili.userVideos.length" class="more-row">
          <m3e-button
            v-if="!bili.userEnd"
            variant="tonal"
            size="small"
            :disabled="bili.userLoadingMore"
            @click="bili.loadMoreUserVideos()"
          >
            <span slot="icon" class="material-symbols-outlined">expand_more</span>
            {{ bili.userLoadingMore ? t("bili.loading") : t("bili.loadMore") }}
          </m3e-button>
          <span v-else class="end">{{ t("bili.noMore") }}</span>
        </div>

        <div v-else-if="busy" class="state-block">
          <m3e-loading-indicator class="lm-loading" />
          <span>{{ t("bili.loading") }}</span>
        </div>

        <p v-else class="state-block">{{ t("bili.noUserVideos") }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.user-view {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: flex;
  flex-direction: column;
  background: var(--md-sys-color-surface);
  animation: bili-user-in 200ms var(--md-sys-motion-spring-effects-fast);
}
@keyframes bili-user-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--lm-hairline);
  -webkit-app-region: drag;
}
.head-title {
  min-width: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head .spacer {
  flex: 1;
}
.head-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.head-btn:hover {
  background: var(--md-sys-color-surface-container-high);
}
.head-btn .material-symbols-outlined {
  font-size: 20px;
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px 22px 40px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.profile {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 22px;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  flex-wrap: wrap;
}
.avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar .material-symbols-outlined {
  font-size: 48px;
}
.info {
  flex: 1;
  min-width: 0;
}
.name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.name {
  margin: 0;
  font-size: var(--md-sys-typescale-headline-small-size);
  font-weight: 600;
}
.badge {
  padding: 1px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
}
.badge.vip {
  background: color-mix(in srgb, var(--md-sys-color-tertiary) 24%, transparent);
  color: var(--md-sys-color-tertiary);
}
.badge.official {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.sign {
  margin: 6px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 10px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.stat strong {
  color: var(--md-sys-color-on-surface);
  font-weight: 600;
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
.end {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-outline);
}
.state-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 200px;
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
}
</style>
