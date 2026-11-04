<script setup lang="ts">
/**
 * 在线音乐信息流 / 歌单根列表的共用歌单卡片（网易云 / 酷狗共用）。
 *
 * 为什么集中到这里：此前网易云用 .playlist-card、酷狗用 .pl-card，
 * 两套命名、两套尺寸、两套 hover 写法，同一个「歌单」在两个平台下长得不一样。
 * 现在统一成官方 m3e-card：封面 header 槽 + 文字 content 槽，
 * 取色与 MediaCardShell / MusicView 的 .song-card 同源（--lm-card-surface）。
 */
import CachedCover from "@/components/CachedCover.vue";

withDefaults(
  defineProps<{
    name: string;
    /** 封面地址；留空则显示占位图标 */
    cover?: string;
    /** 副标题：数量 / 简介 / 播放量等 */
    subtitle?: string;
    /** 无封面时的占位图标 */
    icon?: string;
  }>(),
  { cover: "", subtitle: "", icon: "queue_music" },
);
defineEmits<{ open: [] }>();
</script>

<template>
  <m3e-card
    class="feed-playlist-card"
    variant="filled"
    actionable
    :aria-label="name"
    @click="$emit('open')"
  >
    <div slot="header" class="cover">
      <CachedCover v-if="cover" :url="cover" :alt="name" />
      <span v-else class="material-symbols-outlined placeholder">{{ icon }}</span>
      <slot name="cover-overlay" />
    </div>
    <div slot="content" class="meta">
      <div class="name" :title="name">{{ name }}</div>
      <div v-if="subtitle" class="sub" :title="subtitle">{{ subtitle }}</div>
    </div>
  </m3e-card>
</template>

<style scoped>
.feed-playlist-card {
  --m3e-card-padding: 0;
  --m3e-card-shape: var(--lm-shape-card);
  --m3e-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-hover-state-layer-color: var(--lm-card-surface-hover);
  --m3e-filled-card-hover-state-layer-opacity: 0.5;
  display: block;
  width: 100%;
  overflow: hidden;
  border-radius: var(--lm-shape-card);
  transition: transform var(--lm-motion-card) var(--md-sys-motion-spring-soft);
}
.feed-playlist-card:hover {
  transform: translateY(-4px);
}
.feed-playlist-card:active {
  transform: translateY(-1px);
}
@media (prefers-reduced-motion: reduce) {
  .feed-playlist-card,
  .feed-playlist-card:hover,
  .feed-playlist-card:active {
    transform: none;
    transition: none;
  }
}

.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--lm-media-placeholder-surface);
  color: var(--lm-media-placeholder-color);
}
.cover :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.placeholder {
  font-size: 40px;
  opacity: 0.7;
}

.meta {
  padding: var(--lm-space-8) var(--lm-space-12) var(--lm-space-12);
  min-width: 0;
}
.name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  line-height: 1.35;
  color: var(--md-sys-color-on-surface);
}
.sub {
  margin-top: var(--lm-space-2);
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
