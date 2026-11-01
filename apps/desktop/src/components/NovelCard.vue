<script setup lang="ts">
import { computed } from "vue";
import type { NovelCover, NovelShelfItem } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

/*
 * 书籍卡片。只保留封面 —— 作者等副标题不再渲染成可见文字，
 * 标题由 MediaCardShell 放到 aria-label 上供读屏使用。
 */
const props = defineProps<{
  item: NovelCover | NovelShelfItem;
}>();
defineEmits<{ (e: "open"): void }>();
const cover = computed(() => ("imageUrl" in props.item ? props.item.imageUrl : props.item.cover));
</script>

<template>
  <MediaCardShell
    class="novel-card"
    :title="item.title"
    :cover="cover"
    icon="menu_book"
    @open="$emit('open')"
  />
</template>
