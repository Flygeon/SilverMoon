<script setup lang="ts">
/**
 * 现在就听 / 信息流：私人 FM、每日推荐、为你推荐（推荐歌单）。
 * 参考参考项目 home 页的 feed 排列，UI 使用 SilverMoon MD3 token。
 */
import { computed, onMounted, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import FeedHeroCard from "@/components/FeedHeroCard.vue";
import FeedPlaylistCard from "@/components/FeedPlaylistCard.vue";
import { toOnlineSongs } from "@/utils/netease";
import { translate } from "@shared/i18n";
import type { NeteaseRecommendPlaylist, NeteaseSong, OnlineSong } from "@shared/types";

const settings = useSettingsStore();

const emit = defineEmits<{
  (e: "play-songs", songs: OnlineSong[], index: number): void;
  (e: "open-playlist", id: number, name: string): void;
}>();

function t(key: string) {
  return translate(settings.lang, key);
}

// ---- 状态 ----
const status = ref<"loading" | "ready" | "error">("loading");
const error = ref("");
const recommendPlaylists = ref<NeteaseRecommendPlaylist[]>([]);
const dailySongs = ref<NeteaseSong[]>([]);
const fmSongs = ref<NeteaseSong[]>([]);
const fmLoading = ref(false);
const dailyLoading = ref(false);

function formatPlayCount(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

async function loadAll() {
  status.value = "loading";
  error.value = "";
  try {
    const [playlists, daily, fm] = await Promise.all([
      capabilities.neteaseRecommendPlaylists(20),
      capabilities.neteaseDailyRecommendSongs().catch(() => []),
      capabilities.neteasePersonalFm().catch(() => []),
    ]);
    recommendPlaylists.value = Array.isArray(playlists) ? playlists : [];
    dailySongs.value = Array.isArray(daily) ? daily : [];
    fmSongs.value = Array.isArray(fm) ? fm : [];
    status.value = "ready";
  } catch (e) {
    status.value = "error";
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function playDaily() {
  if (dailyLoading.value || !dailySongs.value.length) return;
  dailyLoading.value = true;
  try {
    const songs = await toOnlineSongs(dailySongs.value);
    emit("play-songs", songs, 0);
  } finally {
    dailyLoading.value = false;
  }
}

async function playFm() {
  if (fmLoading.value || !fmSongs.value.length) return;
  fmLoading.value = true;
  try {
    const songs = await toOnlineSongs(fmSongs.value);
    emit("play-songs", songs, 0);
  } finally {
    fmLoading.value = false;
  }
}

function openPlaylist(item: NeteaseRecommendPlaylist) {
  emit("open-playlist", item.id, item.name);
}

const dailySubtitle = computed(() =>
  dailySongs.value.length ? t("homeFeed.dailyHint") : t("homeFeed.empty"),
);
const fmSubtitle = computed(() =>
  fmSongs.value.length ? t("homeFeed.fmHint") : t("homeFeed.empty"),
);

onMounted(loadAll);
</script>

<template>
  <div class="home-feed">
    <div v-if="status === 'loading'" class="feed-loading">
      <m3e-loading-indicator class="lm-loading" />
      {{ t("online.loading") }}
    </div>
    <p v-else-if="status === 'error'" class="feed-error">
      <span class="material-symbols-outlined">error</span>
      {{ error }}
      <m3e-button variant="text" size="small" @click="loadAll">{{ t("actions.retry") }}</m3e-button>
    </p>

    <template v-else>
      <!-- 私人 FM / 每日推荐：与酷狗共用同一套 Hero 卡 -->
      <section class="feed-section">
        <div class="feed-hero-row">
          <FeedHeroCard
            :title="t('homeFeed.personalFm')"
            :description="fmSubtitle"
            icon="radio"
            @play="playFm"
          />
          <FeedHeroCard
            :title="t('homeFeed.dailyRecommend')"
            :description="dailySubtitle"
            icon="event_available"
            @play="playDaily"
          />
        </div>
      </section>

      <!-- 为你推荐（推荐歌单） -->
      <section v-if="recommendPlaylists.length" class="feed-section">
        <div class="feed-section-head">
          <h3 class="feed-section-title">{{ t("homeFeed.forYou") }}</h3>
          <span class="feed-section-sub"
            >{{ recommendPlaylists.length }} {{ t("homeFeed.playlists") }}</span
          >
        </div>
        <div class="playlist-grid">
          <FeedPlaylistCard
            v-for="p in recommendPlaylists"
            :key="p.id"
            :name="p.name"
            :cover="p.picUrl"
            :subtitle="p.copywriter || ''"
            @open="openPlaylist(p)"
          >
            <template #cover-overlay>
              <span v-if="p.playCount > 0" class="playlist-count">
                <span class="material-symbols-outlined">play_circle</span>
                {{ formatPlayCount(p.playCount) }}
              </span>
            </template>
          </FeedPlaylistCard>
        </div>
      </section>

      <div
        v-if="!recommendPlaylists.length && !dailySongs.length && !fmSongs.length"
        class="feed-empty"
      >
        {{ t("homeFeed.empty") }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.home-feed {
  display: flex;
  flex-direction: column;
  gap: 24px;
  animation: lm-rise 340ms var(--md-sys-motion-spring-spatial) both;
}
.feed-loading,
.feed-error,
.feed-empty {
  padding: 40px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.feed-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--md-sys-color-error);
}
.feed-error .material-symbols-outlined {
  font-size: 20px;
}
.feed-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.feed-hero-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

/*
 * Hero 卡与歌单卡片的样式已收进共用组件
 * （FeedHeroCard.vue / FeedPlaylistCard.vue），这里不再保留重复定义。
 */
.feed-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.feed-section-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.feed-section-sub {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
}
/* 播放量角标：由 FeedPlaylistCard 的 cover-overlay 插槽渲染 */
.playlist-count {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.playlist-count .material-symbols-outlined {
  font-size: 13px;
}
</style>
