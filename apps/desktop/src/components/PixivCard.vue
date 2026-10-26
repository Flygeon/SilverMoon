<!-- 移植自 Pixez（GPL-3.0），本仓库 GPL-3.0-only，兼容。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { usePixivStore } from "@/stores/pixiv";
import { translate } from "@shared/i18n";
import type { PixivIllust } from "@shared/types";
import MediaCardShell from "./MediaCardShell.vue";

const props = defineProps<{ illust: PixivIllust }>();
defineEmits<{ (e: "open"): void }>();
const settings = useSettingsStore();
const pixiv = usePixivStore();
const src = ref("");
const bmLabel = computed(() => translate(settings.lang, "pixiv.totalBookmarks"));

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
  >
    <template #metadata>
      <div class="sub">
        <span class="bm" :title="bmLabel">
          <span class="material-symbols-outlined" aria-hidden="true">bookmark</span
          >{{ illust.totalBookmarks }}
        </span>
        <span class="author" :title="illust.user.name">{{ illust.user.name }}</span>
      </div>
    </template>
  </MediaCardShell>
</template>

<style scoped>
.sub {
  margin-top: var(--lm-space-2);
  display: flex;
  align-items: center;
  gap: var(--lm-layout-control-gap);
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--lm-text-secondary);
}
.bm {
  display: inline-flex;
  align-items: center;
  gap: var(--lm-space-2);
  flex-shrink: 0;
}
.bm .material-symbols-outlined {
  font-size: var(--md-sys-typescale-body-medium-size);
}
.author {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
