<script setup lang="ts">
/**
 * 视频详情页右栏「相关推荐」。
 *
 * 用**行式**卡片（封面在左、文案在右）而不是 `BilibiliCard` 那套网格卡片：
 * 右栏只有 300 多像素宽，网格卡片会把 16:9 封面撑成很小一块、标题挤成一条，
 * 一屏看不了几条。观感对齐参考项目横向卡片（VideoCardH）。
 *
 * 封面来自 i0.hdslb.com，防盗链 Referer 由主进程统一补（electron/net-headers.ts）。
 */
import { useSettingsStore } from "@/stores/settings";
import { biliCount, biliDuration, type BiliVideo } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

defineProps<{ videos: BiliVideo[]; status: string }>();
const emit = defineEmits<{ (e: "open", video: BiliVideo): void }>();

const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);
</script>

<template>
  <section class="related">
    <h3 class="head">
      <span class="material-symbols-outlined">playlist_play</span>
      {{ t("bili.related") }}
    </h3>

    <div v-if="status === 'loading' && !videos.length" class="state">
      <m3e-loading-indicator class="lm-loading" />
      <span>{{ t("bili.loading") }}</span>
    </div>

    <p v-else-if="!videos.length" class="state">{{ t("bili.noRelated") }}</p>

    <ul v-else class="list">
      <li v-for="v in videos" :key="v.bvid">
        <button class="row" type="button" :title="v.title" @click="emit('open', v)">
          <span class="thumb">
            <img
              v-if="v.cover"
              :src="v.cover"
              :alt="v.title"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
            <span v-else class="material-symbols-outlined placeholder">smart_display</span>
            <span v-if="v.duration > 0" class="duration tabular-nums">{{
              biliDuration(v.duration)
            }}</span>
          </span>
          <span class="info">
            <span class="name">{{ v.title }}</span>
            <span class="up">{{ v.ownerName || t("bili.unknownUp") }}</span>
            <span class="stats tabular-nums">
              <span class="stat">
                <span class="material-symbols-outlined">play_arrow</span>{{ biliCount(v.view) }}
              </span>
              <span class="stat">
                <span class="material-symbols-outlined">subtitles</span>{{ biliCount(v.danmaku) }}
              </span>
            </span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.related {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
  color: var(--md-sys-color-on-surface);
}
.head .material-symbols-outlined {
  font-size: 18px;
  color: var(--md-sys-color-primary);
}

.state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  gap: 10px;
  width: 100%;
  padding: 6px;
  border: none;
  border-radius: var(--lm-shape-card-inner);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.row:hover {
  background: var(--md-sys-color-surface-container-high);
}
.row:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: -2px;
}
.row:active {
  background: var(--md-sys-color-surface-container-highest);
}

.thumb {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 132px;
  aspect-ratio: 16 / 9;
  border-radius: var(--lm-shape-card-inner);
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  color: var(--md-sys-color-outline);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.placeholder {
  font-size: 26px;
}
.duration {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 0 5px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
}

.info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--md-sys-typescale-body-small-size);
  font-weight: 500;
  line-height: 1.35;
}
.up {
  font-size: 11.5px;
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stats {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.stat .material-symbols-outlined {
  font-size: 13px;
}
</style>
