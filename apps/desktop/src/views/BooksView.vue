<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from "vue";
import PageHeader, { type PageMenuItem } from "@/components/PageHeader.vue";
import LibraryToolbar from "@/components/LibraryToolbar.vue";
import MediaGrid from "@/components/MediaGrid.vue";
import BookReader from "@/components/BookReader.vue";
import NovelOnlineView from "@/components/NovelOnlineView.vue";
import NovelBqgView from "@/components/NovelBqgView.vue";
import NovelFqapiView from "@/components/NovelFqapiView.vue";
import NovelShelfView from "@/components/NovelShelfView.vue";
import WritingStudio from "@/components/WritingStudio.vue";
import EmptyState from "@/components/EmptyState.vue";
import SegmentedTabs from "@/components/SegmentedTabs.vue";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { showAppToast } from "@/components/AppToast.vue";
import { capabilities } from "@/capabilities";
import { translate } from "@shared/i18n";
import type { MediaEntry, NovelShelfItem } from "@shared/types";

const library = useLibraryStore();
const settings = useSettingsStore();

const items = computed(() => library.entries("book"));
/** 正在阅读的书；null 表示未打开阅读器 */
const reading = ref<MediaEntry | null>(null);

/**
 * 书籍页的内容域。
 *
 * 原来的「本地 / 在线 / 创作」分段 + 二级渠道下拉，现在全部收进标题下拉：
 * 书架 / 本地 / 轻小说 / 网络小说 / 番茄小说 / 创作。
 */
type BookView = "shelf" | "local" | "wenku8" | "bqg" | "fq" | "write";
const activeView = ref<BookView>("shelf");

/** 从共享书架跳转到某个源时，把要打开的书带过去（源组件挂载时读取） */
const pendingOpen = ref<{ aid: string; title: string } | null>(null);

const viewOptions = computed<PageMenuItem[]>(() => {
  const list: PageMenuItem[] = [
    { value: "shelf", label: t("books.shelf"), icon: "bookmarks" },
    { value: "local", label: t("books.local"), icon: "folder_open" },
  ];
  if (settings.onlineNovelEnabled) {
    list.push({ value: "wenku8", label: t("books.wenku8"), icon: "public" });
  }
  if (settings.bqgNovelEnabled) {
    list.push({ value: "bqg", label: t("books.bqg"), icon: "auto_stories" });
  }
  if (settings.fqNovelEnabled) {
    list.push({ value: "fq", label: t("books.fq"), icon: "local_library" });
  }
  list.push({ value: "write", label: t("write.tab"), icon: "edit_note" });
  return list;
});

function t(key: string) {
  return translate(settings.lang, key);
}

/**
 * 仅在「用户关掉某个在线源」时把当前页回落，不要用 viewOptions 做通用 watch：
 * 从书架打开一本已关闭源的书时，该源不在 options 里，通用 watch 会立刻把用户踢回书架。
 */
watch(
  () => [settings.onlineNovelEnabled, settings.bqgNovelEnabled, settings.fqNovelEnabled],
  () => {
    if (!viewOptions.value.some((o) => o.value === activeView.value)) activeView.value = "shelf";
  },
);

function selectView(value: string) {
  pendingOpen.value = null;
  activeView.value = value as BookView;
}

/** 点击书架条目：切到对应源的详情页 */
function openFromShelf(item: NovelShelfItem) {
  const source = item.source || "wenku8";
  const view: BookView = source === "fqapi" ? "fq" : source === "bqg" ? "bqg" : "wenku8";
  pendingOpen.value = { aid: item.aid, title: item.title };
  activeView.value = view;
}

/** 应用内可阅读的格式，其余仍交系统程序 */
const READABLE = ["epub", "pdf"];

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

// ---- 导入（书籍不再走扫描）----
const importing = ref(false);

async function importBooks() {
  if (importing.value) return;
  importing.value = true;
  try {
    const paths = await capabilities.pickBookFiles();
    if (!paths.length) return;
    const count = await capabilities.importBooks(paths);
    if (count > 0) {
      await load();
      await library.refreshCounts();
      showAppToast(t("books.importDone").replace("{n}", String(count)));
    } else {
      showAppToast(t("books.importNone"), { tone: "error" });
    }
  } catch (e) {
    showAppToast(e instanceof Error ? e.message : String(e), { tone: "error" });
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="view">
    <PageHeader
      :title="t('nav.books')"
      :description="t('navDesc.books')"
      :menu-items="viewOptions"
      :menu-value="activeView"
      @update:menu-value="selectView"
    />

    <!-- hide-tabs：按钮组已经收进标题下拉，这里只保留方向感知的内容切换过渡 -->
    <SegmentedTabs
      :model-value="activeView"
      :tabs="viewOptions.map((o) => ({ value: o.value, label: o.label, icon: o.icon }))"
      hide-tabs
    >
      <!-- 共享书架：番茄 / 轻小说 / 网络小说 的书汇总在这里 -->
      <NovelShelfView v-if="activeView === 'shelf'" @open="openFromShelf" />

      <!-- 本地：只显示手动导入的书，不参与媒体扫描 -->
      <template v-else-if="activeView === 'local'">
        <LibraryToolbar
          :count="library.totalFor('book')"
          :import-label="t('books.import')"
          :importing="importing"
          @changed="load"
          @import="importBooks"
        />

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
          :title="t('books.importEmptyTitle')"
          :description="t('books.importEmptyHint')"
          :action-label="t('books.import')"
          @action="importBooks"
        />
      </template>

      <!-- 三个在线源：各自不再渲染书架，书架统一在上面 -->
      <NovelOnlineView
        v-else-if="activeView === 'wenku8'"
        :open-aid="pendingOpen?.aid"
        :open-title="pendingOpen?.title"
        @opened="pendingOpen = null"
      />
      <NovelBqgView
        v-else-if="activeView === 'bqg'"
        :open-aid="pendingOpen?.aid"
        :open-title="pendingOpen?.title"
        @opened="pendingOpen = null"
      />
      <NovelFqapiView
        v-else-if="activeView === 'fq'"
        :open-aid="pendingOpen?.aid"
        :open-title="pendingOpen?.title"
        @opened="pendingOpen = null"
      />

      <!-- 创作（本地 Markdown 写作工作台） -->
      <WritingStudio v-else-if="activeView === 'write'" />
    </SegmentedTabs>

    <BookReader v-if="reading" :item="reading" @close="reading = null" />
  </div>
</template>

<style scoped>
.view {
  min-height: 100%;
}
</style>
