<script setup lang="ts">
import type { AnimeItem } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

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
