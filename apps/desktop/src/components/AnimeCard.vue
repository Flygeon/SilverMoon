<script setup lang="ts">
import type { AnimeItem } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

/*
 * 番剧卡片。只保留封面 —— 集数 / 进度等副标题不再渲染成可见文字，
 * 标题由 MediaCardShell 放到 aria-label 上供读屏使用。
 * 与图片 / 视频 / 音乐 / 书籍 / B站 卡片同一套 m3e-card 托底与取色。
 */
defineProps<{ item: AnimeItem }>();
defineEmits<{ (e: "open", ev: MouseEvent): void }>();
</script>

<template>
  <MediaCardShell
    class="anime-card"
    :data-anime-id="item.src"
    :title="item.title"
    :cover="item.cover"
    icon="movie"
    referrerpolicy="no-referrer"
    @open="$emit('open', $event)"
  />
</template>
