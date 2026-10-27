<script setup lang="ts">
/**
 * 搜索历史面板：横向 chip 列表 + 顶部「清空」。
 *
 * 只在有历史时渲染（父级用 `v-if`），点 chip 直接重搜该词，点 × 删除单条。
 */
import { computed, ref } from "vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "pick", word: string): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const hasHistory = computed(() => bili.searchHistory.length > 0);
/** 清空不可恢复（历史是本地持久化数据），二次确认 */
const confirmClear = ref(false);
</script>

<template>
  <section v-if="hasHistory" class="search-history">
    <div class="head">
      <span class="label">
        <span class="material-symbols-outlined">history</span>
        {{ t("bili.searchHistory") }}
      </span>
      <m3e-button v-if="!confirmClear" variant="text" size="small" @click="confirmClear = true">
        {{ t("bili.clearHistory") }}
      </m3e-button>
      <span v-else class="clear-confirm">
        {{ t("bili.clearHistoryConfirm") }}
        <m3e-button
          variant="text"
          size="small"
          @click="
            bili.clearSearchHistory();
            confirmClear = false;
          "
        >
          {{ t("bili.confirm") }}
        </m3e-button>
        <m3e-button variant="text" size="small" @click="confirmClear = false">
          {{ t("bili.cancelReply") }}
        </m3e-button>
      </span>
    </div>

    <div class="chips">
      <span
        v-for="word in bili.searchHistory"
        :key="word"
        class="history-item"
        role="group"
        :aria-label="word"
      >
        <m3e-assist-chip class="chip-main" :title="word" @click="emit('pick', word)">
          <span class="word">{{ word }}</span>
        </m3e-assist-chip>
        <m3e-icon-button
          class="chip-x"
          variant="standard"
          size="small"
          :title="t('bili.removeHistory')"
          :aria-label="`${t('bili.removeHistory')}: ${word}`"
          @click.stop="bili.removeSearchHistory(word)"
        >
          <span class="material-symbols-outlined">close</span>
        </m3e-icon-button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.search-history {
  display: flex;
  flex-direction: column;
  gap: var(--lm-space-8);
  /* 上接搜索栏、下接结果区 / 空状态：两侧都要留白，否则会和 EmptyState 的上边框
     贴在一起（EmptyState 自带 padding，但它是同级块，margin 不会自动产生） */
  margin: var(--lm-space-8) 0 var(--lm-space-20);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--lm-space-12);
}
.label {
  display: inline-flex;
  align-items: center;
  gap: var(--lm-space-8);
  font-size: var(--md-sys-typescale-label-large-size);
  color: var(--md-sys-color-on-surface-variant);
}
.label .material-symbols-outlined {
  font-size: 17px;
}
.clear-confirm {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--lm-space-4);
  font-size: var(--md-sys-typescale-label-large-size);
  color: var(--md-sys-color-on-surface-variant);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--lm-space-8);
}
.history-item {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: var(--lm-space-2);
}
.chip-main {
  min-width: 0;
}
.word {
  display: block;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-x {
  flex: none;
}
</style>
