<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import MediaViewer from "@/components/MediaViewer.vue";
import type { MediaEntry } from "@shared/types";
defineProps<{ item: MediaEntry }>();
defineEmits<{ close: []; favorite: [item: MediaEntry] }>();
const BookReader = defineAsyncComponent(() => import("@/components/BookReader.vue"));
</script>
<template>
  <BookReader
    v-if="item.type === 'book' && ['pdf', 'epub'].includes(item.ext.toLowerCase())"
    :item="item"
    @close="$emit('close')"
  />
  <MediaViewer
    v-else
    :items="[item]"
    :index="0"
    @close="$emit('close')"
    @favorite="$emit('favorite', $event)"
  />
</template>
