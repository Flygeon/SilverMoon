<script setup lang="ts">
import { computed } from "vue";
import type { NovelCover, NovelShelfItem } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

/*
 * 书籍卡片：封面 + 书名 + 作者，官方 m3e-card 托底。
 * 显式副标题优先，否则回落到作者。
 */
const props = defineProps<{
  item: NovelCover | NovelShelfItem;
  subtitle?: string;
}>();
defineEmits<{ (e: "open"): void }>();
const cover = computed(() => ("imageUrl" in props.item ? props.item.imageUrl : props.item.cover));
const detail = computed(
  () => props.subtitle || ("author" in props.item ? props.item.author : "") || "",
);
</script>

<template>
  <MediaCardShell
    class="novel-card"
    :title="item.title"
    :cover="cover"
    :subtitle="detail"
    icon="menu_book"
    @open="$emit('open')"
  />
</template>
