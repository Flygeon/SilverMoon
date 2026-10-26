<script setup lang="ts">
/** 列表页工具栏：搜索、排序、扫描入口与进度 */
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import SearchField from "@/components/SearchField.vue";
import { useLibraryStore, type SortKey } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";

const props = defineProps<{ count: number }>();

const emit = defineEmits<{ (e: "changed"): void }>();

const library = useLibraryStore();
const settings = useSettingsStore();

function t(key: string) {
  return translate(settings.lang, key);
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "library.sortName" },
  { key: "mtime", label: "library.sortModified" },
  { key: "size", label: "library.sortSize" },
  { key: "taken_at", label: "library.sortTaken" },
];

// 输入防抖，避免每敲一个字就查一次库
const term = ref(library.search);
let timer: number | null = null;
function cancelPendingSearch() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}
watch(term, (v) => {
  cancelPendingSearch();
  if (v === library.search) return;
  timer = window.setTimeout(() => {
    timer = null;
    library.search = v;
    emit("changed");
  }, 260);
});
// 空状态清除与其他库页面的查询同样反映到输入框，避免残留旧词。
watch(
  () => library.search,
  (value) => {
    cancelPendingSearch();
    term.value = value;
  },
);
onActivated(() => {
  term.value = library.search;
});
onDeactivated(cancelPendingSearch);
onBeforeUnmount(cancelPendingSearch);

function pickSort(key: SortKey) {
  if (library.sortBy === key) {
    library.sortDesc = !library.sortDesc;
  } else {
    library.sortBy = key;
    library.sortDesc = false;
  }
  emit("changed");
}
</script>

<template>
  <div class="toolbar">
    <SearchField
      v-model="term"
      class="search"
      :placeholder="t('actions.search')"
      :clear-label="t('actions.clearSearch')"
    />

    <div class="sorts">
      <m3e-filter-chip
        v-for="s in SORTS"
        :key="s.key"
        class="chip"
        :selected="library.sortBy === s.key"
        @click.prevent="pickSort(s.key)"
      >
        {{ t(s.label) }}
        <span
          v-if="library.sortBy === s.key"
          slot="trailing-icon"
          class="material-symbols-outlined arrow"
          >{{ library.sortDesc ? "arrow_downward" : "arrow_upward" }}</span
        >
      </m3e-filter-chip>
    </div>

    <span class="count tabular-nums">{{ props.count }} {{ t("library.items") }}</span>

    <div class="spacer"></div>

    <!-- 扫描中显示进度与取消，否则显示扫描按钮 -->
    <div v-if="library.scanning" class="scan-progress">
      <!-- 枚举阶段总数未知 -> indeterminate；否则按百分比显示 -->
      <m3e-linear-progress-indicator
        class="scan-bar"
        :indeterminate="!library.progress?.total"
        :max="100"
        :value="library.progress?.percent ?? 0"
      ></m3e-linear-progress-indicator>
      <span class="scan-text">{{ library.scanLabel }}</span>
      <m3e-button variant="text" size="small" @click="library.cancelScan()">
        {{ t("actions.cancel") }}
      </m3e-button>
    </div>
    <m3e-button v-else variant="tonal" size="small" @click="library.startScan()">
      <span slot="icon" class="material-symbols-outlined">refresh</span>
      {{ t("actions.rescan") }}
    </m3e-button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--lm-layout-toolbar-gap);
  flex-wrap: wrap;
  margin-bottom: var(--lm-layout-toolbar-content-gap);
}

.search {
  flex: 0 1 var(--lm-search-width);
  width: var(--lm-search-width);
  max-width: 100%;
  min-width: 0;
}

.sorts {
  display: flex;
  gap: var(--lm-layout-control-gap);
  flex-wrap: wrap;
}
.count {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.spacer {
  flex: 1;
}

.scan-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 进度条本体交给 m3e-linear-progress-indicator（默认 4px 厚、primary 前景）；
   这里只把轨道色换回原来的 surface-container-highest，并固定 140px 宽度 */
.scan-bar {
  width: 140px;
  flex: none;
  --m3e-linear-progress-indicator-thickness: 4px;
  --m3e-progress-indicator-track-color: var(--md-sys-color-surface-container-highest);
}
.scan-text {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  min-width: 120px;
}
/* chip 本体交给 m3e-filter-chip / m3e-assist-chip（选中态即 M3 规范：secondary-container 底 +
   on-secondary-container 文字 + 无描边，与改造前 .chip.active 一致）；
   下面把度量对齐改造前的 .chip（含选中时组件会占用 icon 槽展示勾选标记所需的 with-icon 内边距） */
.sorts m3e-filter-chip {
  --m3e-chip-container-height: var(--lm-filter-chip-height);
  --m3e-chip-padding-start: 12px;
  --m3e-chip-padding-end: 12px;
  --m3e-chip-with-icon-padding-start: 12px;
  --m3e-chip-with-icon-padding-end: 12px;
  --m3e-chip-spacing: 4px;
  --m3e-chip-icon-size: 15px;
  --m3e-chip-unselected-state-layer-hover-color: var(--md-sys-color-surface-container-high);
}
</style>
