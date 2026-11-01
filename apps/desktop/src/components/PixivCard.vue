<!-- 移植自 Pixez（GPL-3.0），本仓库 GPL-3.0-only，兼容。 -->
<script setup lang="ts">
/*
 * Pixiv 卡片。只保留封面 —— 书签数与作者不再渲染成可见文字，
 * 标题由 MediaCardShell 放到 aria-label 上供读屏使用。
 * 封面经 pixiv store 代理解析，失败时保留占位，卡片仍能打开详情。
 */
import { ref, watch } from "vue";
import { usePixivStore } from "@/stores/pixiv";
import type { PixivIllust } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

const props = defineProps<{ illust: PixivIllust }>();
defineEmits<{ (e: "open"): void }>();
const pixiv = usePixivStore();
const src = ref("");

watch(
  () => pixiv.coverUrl(props.illust),
  async (url, _previous, onCleanup) => {
    let current = true;
    onCleanup(() => (current = false));
    src.value = "";
    try {
      const resolved = await pixiv.imageUrl(url);
      if (current) src.value = resolved;
    } catch {
      // 代理或授权失败保留占位；卡片仍能打开详情。
    }
  },
  { immediate: true },
);
</script>

<template>
  <MediaCardShell
    class="pixiv-card"
    :title="illust.title"
    :cover="src"
    icon="image"
    aspect="square"
    @open="$emit('open')"
  />
</template>
