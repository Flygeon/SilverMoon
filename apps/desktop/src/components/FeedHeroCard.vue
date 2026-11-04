<script setup lang="ts">
/**
 * 在线音乐信息流的共用外壳（网易云 / 酷狗共用）。
 *
 * 为什么要抽出来：两家此前是两个各写一套的组件（NowPlayingFeed / KugouFeed），
 * hero 卡、歌单网格、区块标题全是各自手绘的 <button> + 自定义底色，
 * 导致同一个「为你推荐」页在两个平台下版式与观感都不一致。
 *
 * 这里只统一**外壳与卡片视觉**，不统一**数据**：
 * - 两家各有什么内容（网易云有私人 FM，酷狗有签到日历）由调用方用插槽决定；
 * - 卡片一律走官方 m3e-card（filled + actionable），取色与 MediaCardShell 同源。
 */

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: string;
  }>(),
  { description: "", icon: "" },
);
defineEmits<{ play: [] }>();
</script>

<template>
  <!--
    Hero 卡：一条横向的信息条（图标 + 标题 + 说明 + 播放按钮）。
    用官方 m3e-card 而非自绘 button —— 托底、圆角、状态层、焦点环都由组件提供。
  -->
  <m3e-card
    class="feed-hero"
    variant="filled"
    actionable
    orientation="horizontal"
    :aria-label="title"
    @click="$emit('play')"
  >
    <div slot="header" class="hero-icon-wrap">
      <span class="material-symbols-outlined hero-icon" aria-hidden="true">{{ icon }}</span>
    </div>
    <div slot="content" class="hero-main">
      <h3 class="hero-title">{{ title }}</h3>
      <p class="hero-desc">{{ description }}</p>
    </div>
    <div slot="trailing" class="hero-play">
      <span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>
    </div>
  </m3e-card>
</template>

<style scoped>
.feed-hero {
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
}
.hero-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-inline-start: var(--lm-space-16);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.hero-icon {
  font-size: 24px;
}
.hero-main {
  padding: var(--lm-space-12) var(--lm-space-16);
  min-width: 0;
}
.hero-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  color: var(--md-sys-color-on-surface);
}
.hero-desc {
  margin: var(--lm-space-2) 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.hero-play {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-inline-end: var(--lm-space-16);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  flex: none;
}
.hero-play .material-symbols-outlined {
  font-size: 22px;
}
</style>
