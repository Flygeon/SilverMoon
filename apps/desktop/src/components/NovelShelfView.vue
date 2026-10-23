<script setup lang="ts">
/**
 * 书籍页的共享书架。
 *
 * 这里同时承载两类内容：
 *   1. **本地导入**的书籍（`book_import` 写进 files(imported=1)，EPUB / PDF …）；
 *   2. 番茄 / 轻小说（文库8）/ 网络小说（笔趣阁）加入书架的书。
 *
 * 书籍页不再有独立的「本地」选项卡；导入按钮在书架页标题右侧，导入后的书直接出现在
 * 本页的「本地」分组里。
 *
 * 在线书架数据来自 `novel_shelf` 表，按 `source` 分组；点击后由 BooksView 切到对应
 * 源并打开详情。本地书点击后直接进 BookReader（或交系统程序）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { capabilities } from "@/capabilities";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";
import { formatSize } from "@/utils/format";
import NovelCard from "@/components/NovelCard.vue";
import EmptyState from "@/components/EmptyState.vue";
import type { MediaEntry, NovelCover, NovelShelfItem } from "@shared/types";

const emit = defineEmits<{
  (e: "open", item: NovelShelfItem): void;
  (e: "open-local", item: MediaEntry): void;
  (e: "import"): void;
}>();

const library = useLibraryStore();
const settings = useSettingsStore();

const items = ref<NovelShelfItem[]>([]);
const loading = ref(true);
const error = ref("");

/**
 * 本地导入的书。
 *
 * 全量渲染会同时挂几百张卡片、请求几百张缩略图；首屏只渲染前
 * LOCAL_PAGE_SIZE 本，用户点「加载更多」再增量渲染。
 */
const LOCAL_PAGE_SIZE = 48;
const localLimit = ref(LOCAL_PAGE_SIZE);
const localBooks = computed(() => library.entries("book"));
const visibleLocal = computed(() => localBooks.value.slice(0, localLimit.value));
const hasMoreLocal = computed(() => localBooks.value.length > visibleLocal.value.length);

/** 只给当前可见的本地书拉缩略图；加载更多后再增量请求 */
watch(
  visibleLocal,
  (books) => {
    const ids = books.map((b) => b.id);
    if (ids.length) void library.loadThumbnails(ids);
  },
  { immediate: true },
);

function localCard(book: MediaEntry): NovelCover {
  return {
    aid: book.id,
    title: book.title || book.name,
    imageUrl: library.getThumb(book.id) ?? "",
    author: formatSize(book.size),
  };
}

function loadMoreLocal() {
  localLimit.value += LOCAL_PAGE_SIZE;
}

/** 分组顺序固定：番茄在最前（用户最常用），其次文库8、笔趣阁。 */
const SOURCE_ORDER = ["fqapi", "wenku8", "bqg"] as const;
const SOURCE_LABEL: Record<string, string> = {
  fqapi: "books.fq",
  wenku8: "books.wenku8",
  bqg: "books.bqg",
};

function t(key: string) {
  return translate(settings.lang, key);
}

/** 老库没有 source（schema v6 前）：按文库8 兜底，后端迁移也会按 aid 长度回填。 */
function sourceOf(item: NovelShelfItem): string {
  return item.source || "wenku8";
}

const groups = computed(() => {
  const map = new Map<string, NovelShelfItem[]>();
  for (const item of items.value) {
    const key = sourceOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  const order: string[] = [...SOURCE_ORDER];
  for (const key of map.keys()) if (!order.includes(key)) order.push(key);
  return order
    .filter((key) => (map.get(key)?.length ?? 0) > 0)
    .map((key) => ({
      key,
      label: SOURCE_LABEL[key] ? t(SOURCE_LABEL[key]) : key,
      books: map.get(key) ?? [],
    }));
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // 浏览器预览 / 老宿主可能返回 null：统一兜成空数组，避免模板 length 崩掉
    items.value = (await capabilities.novelShelfList()) ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="novel-shelf">
    <p v-if="error" class="state shelf-error">
      <span>{{ error }}</span>
      <m3e-button variant="text" size="small" @click="load">重试</m3e-button>
    </p>

    <!-- 本地导入的书（书籍页不再有独立「本地」页） -->
    <section v-if="localBooks.length" class="section">
      <div class="section-head">
        <h3 class="section-title">{{ t("books.local") }}</h3>
        <span class="count tabular-nums">{{ localBooks.length }}</span>
      </div>
      <div class="lm-novel-grid">
        <NovelCard
          v-for="book in visibleLocal"
          :key="'local:' + book.id"
          :item="localCard(book)"
          @open="emit('open-local', book)"
        />
      </div>
      <div v-if="hasMoreLocal" class="more">
        <m3e-button variant="tonal" size="small" @click="loadMoreLocal">
          {{ t("books.loadMore") }}（{{ localBooks.length - visibleLocal.length }}）
        </m3e-button>
      </div>
    </section>

    <div v-if="loading" class="state">
      <m3e-loading-indicator class="lm-loading" />
      {{ t("novel.loading") }}
    </div>

    <!-- 在线书架：按来源分组 -->
    <template v-else-if="items.length">
      <section v-for="group in groups" :key="group.key" class="section">
        <div class="section-head">
          <h3 class="section-title">{{ group.label }}</h3>
          <span class="count tabular-nums">{{ group.books.length }}</span>
        </div>
        <div class="lm-novel-grid">
          <NovelCard
            v-for="book in group.books"
            :key="group.key + ':' + book.aid"
            :item="book"
            :subtitle="book.author"
            @open="emit('open', book)"
          />
        </div>
      </section>
    </template>

    <EmptyState
      v-if="!loading && !error && !items.length && !localBooks.length"
      icon="bookmarks"
      :title="t('books.shelfEmptyTitle')"
      :description="t('books.shelfEmptyHint')"
      :action-label="t('books.import')"
      @action="emit('import')"
    />
  </div>
</template>

<style scoped>
.novel-shelf {
  display: flex;
  flex-direction: column;
  gap: 24px;
  animation: lm-rise 340ms var(--md-sys-motion-spring-spatial) both;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.section-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.count {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
/* 书籍卡片网格统一走全局 .lm-novel-grid（src/tokens/theme.css），此处不再重复定义 */
.more {
  display: flex;
  justify-content: center;
}
.state {
  padding: 24px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.shelf-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--md-sys-color-error);
}
</style>
