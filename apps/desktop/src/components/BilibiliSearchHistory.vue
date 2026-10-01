<script setup lang="ts">
/**
 * 搜索历史面板：横向 chip 列表 + 顶部「清空」。
 *
 * 只在有历史时渲染（父级用 `v-if`），点 chip 直接重搜该词，点 × 删除单条。
 */
import { computed } from "vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "pick", word: string): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const hasHistory = computed(() => bili.searchHistory.length > 0);
</script>

<template>
  <section v-if="hasHistory" class="search-history">
    <div class="head">
      <span class="label">
        <span class="material-symbols-outlined">history</span>
        {{ t("bili.searchHistory") }}
      </span>
      <button class="clear" type="button" @click="bili.clearSearchHistory()">
        {{ t("bili.clearHistory") }}
      </button>
    </div>

    <div class="chips">
      <span v-for="word in bili.searchHistory" :key="word" class="chip">
        <button class="chip-main" type="button" :title="word" @click="emit('pick', word)">
          {{ word }}
        </button>
        <button
          class="chip-x"
          type="button"
          :title="t('bili.removeHistory')"
          @click.stop="bili.removeSearchHistory(word)"
        >
          <span class="material-symbols-outlined">close</span>
        </button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.search-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--md-sys-typescale-label-large-size);
  color: var(--md-sys-color-on-surface-variant);
}
.label .material-symbols-outlined {
  font-size: 17px;
}
.clear {
  padding: 2px 10px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-primary);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
}
.clear:hover {
  background: var(--md-sys-color-surface-container-high);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.chip:hover {
  background: var(--md-sys-color-surface-container-highest);
}
.chip-main {
  min-width: 0;
  max-width: 180px;
  padding: 6px 4px 6px 14px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.chip-x {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-right: 6px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}
.chip-x:hover {
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-error);
}
.chip-x .material-symbols-outlined {
  font-size: 14px;
}
</style>
