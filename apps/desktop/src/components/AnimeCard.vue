<script setup lang="ts">
import type { AnimeItem } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

/*
 * 番剧卡片：封面 + 标题 + 副标题（最近观看集数等），官方 m3e-card 托底。
 * 与图片 / 视频的纯封面卡片不同 —— 番剧需要文字才分得清是哪一部、看到第几集。
 */
defineProps<{ item: AnimeItem; subtitle?: string }>();
defineEmits<{ (e: "open", ev: MouseEvent): void }>();
</script>

<template>
  <MediaCardShell
    class="anime-card"
    :data-anime-id="item.src"
    :title="item.title"
    :cover="item.cover"
    :subtitle="subtitle"
    icon="movie"
    referrerpolicy="no-referrer"
    @open="$emit('open', $event)"
  />
</template>
