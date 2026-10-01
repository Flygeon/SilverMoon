<script setup lang="ts">
/**
 * B 站视频卡片（16:9 封面 + 时长角标 + 标题 + UP 主 + 播放/弹幕数）。
 *
 * 与 AnimeCard 同一套观感骨架：透明按钮容器、封面走 --lm-shape-card 圆角 +
 * 发丝描边、hover 上浮。封面来自 i0.hdslb.com，防盗链 Referer 由主进程
 * webRequest 统一补（见 electron/net-headers.ts）。
 */
import { biliCount, biliDuration, type BiliVideo } from "@/utils/bilibili";

defineProps<{ video: BiliVideo }>();
defineEmits<{ (e: "open", video: BiliVideo): void }>();
</script>

<template>
  <button class="bili-card" @click="$emit('open', video)">
    <div class="cover">
      <img
        v-if="video.cover"
        :src="video.cover"
        :alt="video.title"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
      />
      <span v-else class="material-symbols-outlined placeholder">smart_display</span>
      <span v-if="video.duration > 0" class="duration tabular-nums">{{
        biliDuration(video.duration)
      }}</span>
      <span v-if="video.reason" class="reason">{{ video.reason }}</span>
    </div>

    <div class="meta">
      <div class="title" :title="video.title">{{ video.title }}</div>
      <div class="up" :title="video.ownerName">
        <span class="material-symbols-outlined">person</span>
        <span class="up-name">{{ video.ownerName || "未知 UP 主" }}</span>
      </div>
      <div class="stats tabular-nums">
        <span class="stat">
          <span class="material-symbols-outlined">play_arrow</span>{{ biliCount(video.view) }}
        </span>
        <span class="stat">
          <span class="material-symbols-outlined">subtitles</span>{{ biliCount(video.danmaku) }}
        </span>
      </div>
    </div>
  </button>
</template>

<style scoped>
.bili-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
}
.bili-card:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 4px;
  border-radius: var(--lm-shape-card);
}

.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--lm-shape-card);
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  color: var(--md-sys-color-outline);
  transition:
    transform 220ms var(--md-sys-motion-spring-soft, var(--md-sys-motion-spring-spatial)),
    box-shadow 220ms var(--md-sys-motion-spring-effects-fast);
}
.bili-card:hover .cover {
  transform: translateY(-4px) scale(1.015);
  box-shadow:
    var(--md-elevation-3),
    inset 0 0 0 1px var(--lm-hairline);
}
.bili-card:active .cover {
  transform: translateY(-1px) scale(0.995);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.placeholder {
  font-size: 36px;
}

.duration {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
}

.reason {
  position: absolute;
  left: 6px;
  bottom: 6px;
  max-width: calc(100% - 64px);
  padding: 1px 7px;
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--md-sys-color-primary) 82%, transparent);
  color: var(--md-sys-color-on-primary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  min-width: 0;
}
.title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  line-height: 1.3;
}
.up {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 4px;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.up .material-symbols-outlined {
  font-size: 13px;
}
.up-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stats {
  display: flex;
  gap: 10px;
  margin-top: 2px;
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
