<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import LibraryToolbar from "@/components/LibraryToolbar.vue";
import MediaGrid from "@/components/MediaGrid.vue";
import BookReader from "@/components/BookReader.vue";
import NovelOnlineView from "@/components/NovelOnlineView.vue";
import NovelBqgView from "@/components/NovelBqgView.vue";
import NovelFqapiView from "@/components/NovelFqapiView.vue";
import WritingStudio from "@/components/WritingStudio.vue";
import EmptyState from "@/components/EmptyState.vue";
import SegmentedTabs from "@/components/SegmentedTabs.vue";
import NovelChannelBar from "@/components/NovelChannelBar.vue";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { translate } from "@shared/i18n";
import type { MediaEntry } from "@shared/types";

const library = useLibraryStore();
const settings = useSettingsStore();
const router = useRouter();

const items = computed(() => library.entries("book"));
const hasScanDirs = computed(() => settings.scanDirs.length > 0);
/** 正在阅读的书；null 表示未打开阅读器 */
const reading = ref<MediaEntry | null>(null);
/** 一级导航：本地 / 在线 / 创作。三个在线源不再平铺，收进二级的下拉。 */
const topTab = ref<"local" | "online" | "write">("local");

/** 在线渠道（对应某个具体的源）。默认取第一个已启用的。 */
const onlineChannels = computed(() => {
  const list: { value: string; label: string; icon: string }[] = [];
  if (settings.onlineNovelEnabled) {
    list.push({ value: "online", label: "轻小说（文库8）", icon: "public" });
  }
  if (settings.bqgNovelEnabled) {
    list.push({ value: "bqg", label: "网络小说（笔趣阁）", icon: "auto_stories" });
  }
  if (settings.fqNovelEnabled) {
    list.push({ value: "fq", label: "番茄小说", icon: "local_library" });
  }
  return list;
});

const onlineChannel = ref("");

/** 一级分段：本地常驻；有任一在线源才显示「在线」；创作常驻。 */
const topTabs = computed(() => {
  const tabs: { value: string; label: string; icon: string }[] = [
    { value: "local", label: t("books.local"), icon: "menu_book" },
  ];
  if (onlineChannels.value.length) {
    tabs.push({ value: "online", label: "在线", icon: "public" });
  }
  tabs.push({ value: "write", label: t("write.tab"), icon: "edit_note" });
  return tabs;
});

// 渠道列表变化（用户开/关某个源）时，保证当前选中项仍然有效
watch(
  onlineChannels,
  (list) => {
    if (!list.length) return;
    if (!list.some((c) => c.value === onlineChannel.value)) {
      onlineChannel.value = list[0].value;
    }
  },
  { immediate: true },
);

/** 应用内可阅读的格式，其余仍交系统程序 */
const READABLE = ["epub", "pdf"];

function t(key: string) {
  return translate(settings.lang, key);
}

function load() {
  return library.refresh("book");
}

onMounted(load);
onActivated(() => {
  if (!items.value.length) void load();
});

function open(item: MediaEntry) {
  if (READABLE.includes(item.ext.toLowerCase())) {
    reading.value = item;
  } else {
    void capabilities.openFile(item.path);
  }
}

function clearSearch() {
  library.search = "";
  void load();
}
</script>

<template>
  <div class="view">
    <PageHeader :title="t('nav.books')" :description="t('navDesc.books')" />

    <!-- 一级：本地 / 在线（渠道走下拉） / 创作 -->
    <div class="lv1">
      <SegmentedTabs v-model="topTab" :tabs="topTabs" />
    </div>

    <!-- 在线：渠道下拉。三个在线源不再平铺成胶囊，避免横条越加越挤。 -->
    <NovelChannelBar
      v-if="topTab === 'online'"
      v-model="onlineChannel"
      :channels="onlineChannels"
    />

    <!-- 本地书籍 -->
    <template v-if="topTab === 'local'">
      <LibraryToolbar :count="library.totalFor('book')" @changed="load" />

      <MediaGrid
        v-if="library.loading || items.length"
        :items="items"
        :loading="library.loading"
        aspect="3/4"
        :min-width="150"
        subtitle="size"
        @open="open"
        @favorite="library.toggleFavorite"
      />

      <EmptyState
        v-else-if="library.search"
        icon="search_off"
        :title="`未找到与「${library.search}」匹配的书籍`"
        description="试试其它关键词，或清除搜索条件。"
        action-label="清除搜索"
        @action="clearSearch"
      />

      <EmptyState
        v-else
        icon="menu_book"
        :title="t('library.empty')"
        :description="
          hasScanDirs
            ? '已配置扫描目录，点击开始扫描以建立书籍索引。支持 EPUB / PDF / MOBI 等格式。'
            : '尚未配置扫描目录。请先在设置中添加要索引的文件夹。'
        "
        :action-label="hasScanDirs ? t('actions.scan') : ''"
        secondary-label="前往设置"
        @action="library.startScan()"
        @secondary="router.push('/settings')"
      />
    </template>

    <!-- 在线：按当前渠道渲染对应的源视图 -->
    <template v-else-if="topTab === 'online'">
      <NovelOnlineView v-if="onlineChannel === 'online'" />
      <NovelBqgView v-else-if="onlineChannel === 'bqg'" />
      <NovelFqapiView v-else-if="onlineChannel === 'fq'" />
    </template>

    <!-- 创作（本地 Markdown 写作工作台） -->
    <WritingStudio v-else-if="topTab === 'write'" />

    <BookReader v-if="reading" :item="reading" @close="reading = null" />
  </div>
</template>

<style scoped>
.view {
  min-height: 100%;
}

.lv1 {
  margin-bottom: 12px;
}
</style>
