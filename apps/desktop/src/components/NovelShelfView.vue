<script setup lang="ts">
/**
 * 三个在线小说源共用的书架。
 *
 * 书架数据本来就在同一张 `novel_shelf` 表里（`novel_shelf_list`），
 * 但过去是每个源各自渲染一遍：番茄页的「我的书架」、文库8 页顶部的书架区。
 * 结果同一本书会在三个入口重复出现，而且从番茄页点文库8 的书会打开错误的详情。
 *
 * 现在书架集中到这里，按 `source` 分组；点击后由 BooksView 切到对应源并打开详情。
 * 三个源自己的页面不再显示书架。
 */
import { computed, onMounted, ref } from "vue";
import { capabilities } from "@/capabilities";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";
import NovelCard from "@/components/NovelCard.vue";
import EmptyState from "@/components/EmptyState.vue";
import type { NovelShelfItem } from "@shared/types";

const emit = defineEmits<{ (e: "open", item: NovelShelfItem): void }>();

const settings = useSettingsStore();
const items = ref<NovelShelfItem[]>([]);
const loading = ref(true);
const error = ref("");

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
    <div v-if="loading" class="state">
      <m3e-loading-indicator class="lm-loading" />
      {{ t("novel.loading") }}
    </div>
    <p v-else-if="error" class="state error">{{ error }}</p>

    <template v-else-if="items.length">
      <section v-for="group in groups" :key="group.key" class="section">
        <div class="section-head">
          <h3 class="section-title">{{ group.label }}</h3>
          <span class="count tabular-nums">{{ group.books.length }}</span>
        </div>
        <div class="grid">
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
      v-else
      icon="bookmarks"
      :title="t('books.shelfEmptyTitle')"
      :description="t('books.shelfEmptyHint')"
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
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 16px;
}
.state {
  padding: 24px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.error {
  color: var(--md-sys-color-error);
}
</style>
