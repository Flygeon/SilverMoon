<script setup lang="ts">
/** 媒体内容卡片例外：原生 button 保留 Enter / Space；不模拟通用 MD3E 控件。 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    cover?: string;
    subtitle?: string;
    icon: string;
    aspect?: "portrait" | "square";
    referrerpolicy?: ReferrerPolicy;
  }>(),
  { cover: "", subtitle: "", aspect: "portrait", referrerpolicy: undefined },
);
defineEmits<{ open: [event: MouseEvent] }>();
const failedCover = ref<string | null>(null);
const showCover = computed(() => props.cover && failedCover.value !== props.cover);
</script>

<template>
  <button type="button" class="media-card" :data-aspect="aspect" @click="$emit('open', $event)">
    <div class="cover">
      <img
        v-if="showCover"
        :key="cover"
        :src="cover"
        :alt="title"
        loading="lazy"
        decoding="async"
        :referrerpolicy="referrerpolicy"
        @error="failedCover = cover"
      />
      <span v-else class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
      <slot name="cover-overlay" />
    </div>
    <div class="meta">
      <div class="title" :title="title">{{ title }}</div>
      <slot name="metadata">
        <div v-if="subtitle" class="sub" :title="subtitle">{{ subtitle }}</div>
      </slot>
    </div>
  </button>
</template>

<style scoped>
.media-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--lm-layout-control-gap);
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}
.media-card:focus-visible {
  outline: var(--lm-focus-width) solid var(--lm-focus-color);
  outline-offset: var(--lm-space-4);
  border-radius: var(--lm-shape-card);
}
.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: var(--lm-shape-card);
  overflow: hidden;
  background: var(--lm-media-placeholder-surface);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  color: var(--lm-media-placeholder-color);
  transition:
    transform var(--lm-motion-card) var(--md-sys-motion-spring-soft),
    box-shadow var(--lm-motion-card) var(--md-sys-motion-spring-effects-fast);
}
[data-aspect="square"] .cover {
  aspect-ratio: 1;
}
.media-card:hover .cover {
  transform: translateY(-4px) scale(1.015);
  box-shadow:
    var(--md-elevation-3),
    inset 0 0 0 1px var(--lm-hairline);
}
.media-card:active .cover {
  transform: translateY(-1px) scale(0.995);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover .material-symbols-outlined {
  font-size: 36px;
}
.meta {
  min-width: 0;
  width: 100%;
}
.title {
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  margin-top: var(--lm-space-2);
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--lm-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (prefers-reduced-motion: reduce) {
  .cover {
    transition: none;
  }
  .media-card:hover .cover,
  .media-card:active .cover {
    transform: none;
  }
}
</style>
