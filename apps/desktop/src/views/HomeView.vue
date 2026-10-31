<script setup lang="ts">
import { computed, onActivated, ref } from "vue";
import { useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import MediaGrid from "@/components/MediaGrid.vue";
import EntryPreview from "@/components/EntryPreview.vue";
import EmptyState from "@/components/EmptyState.vue";
import SearchField from "@/components/SearchField.vue";
import { useEntryList } from "@/composables/useEntryList";
import { useLibraryStore } from "@/stores/library";
import { capabilities } from "@/capabilities";
import { showAppToast } from "@/components/AppToast.vue";
import type { BookProgress, MediaEntry } from "@shared/types";

const router = useRouter();
const library = useLibraryStore();
const history = ref<MediaEntry[]>([]);
const favorites = ref<MediaEntry[]>([]);
const progress = ref<Record<string, BookProgress>>({});
const preview = ref<MediaEntry | null>(null);
const query = ref("");
const {
  items,
  loading,
  load,
  open: playAudio,
  toggleFavorite,
} = useEntryList(async () => {
  const [recent, books] = await Promise.all([
    capabilities.listFiles({ sortBy: "mtime", desc: true, limit: 24 }),
    capabilities.listFiles({ type: "book", sortBy: "mtime", desc: true, limit: 24 }),
  ]);
  const saved = await Promise.all(
    books
      .slice(0, 24)
      .map(
        async (item) =>
          [item.id, await capabilities.getBookProgress(item.id).catch(() => null)] as const,
      ),
  );
  progress.value = Object.fromEntries(
    saved.filter((pair): pair is readonly [string, BookProgress] => pair[1] !== null),
  );
  recentBooks.value = books;
  return recent.slice(0, 24);
});
const recentBooks = ref<MediaEntry[]>([]);
const recent = computed(() =>
  items.value
    .filter((item) =>
      `${item.title ?? ""} ${item.name} ${item.artist ?? ""}`
        .toLocaleLowerCase()
        .includes(query.value.trim().toLocaleLowerCase()),
    )
    .slice(0, 12),
);
const continuing = computed(() => {
  const book = recentBooks.value
    .filter((i) => progress.value[i.id] && progress.value[i.id].percent < 100)
    .sort((a, b) => progress.value[b.id].updatedAt - progress.value[a.id].updatedAt)[0];
  return [...(book ? [book] : []), ...history.value.filter((i) => i.id !== book?.id)].slice(0, 3);
});
const shortcuts = computed(() => [
  {
    title: "我的收藏",
    description: `${favorites.value.length} 项喜欢的内容`,
    icon: "favorite",
    path: "/favorites",
  },
  { title: "本地媒体", description: "按文件夹浏览媒体库", icon: "folder", path: "/folders" },
  { title: "我的书架", description: "阅读与创作都在这里", icon: "menu_book", path: "/books" },
]);
async function refresh() {
  try {
    const [h, f] = await Promise.all([capabilities.listHistory(), capabilities.listFavorites()]);
    history.value = h;
    favorites.value = f;
    void library.loadThumbnails(h.slice(0, 3).map((i) => i.id));
  } catch {
    showAppToast("部分首页内容加载失败，请点击刷新重试", { tone: "error" });
  }
}
let activated = false;
onActivated(async () => {
  if (activated) await load();
  activated = true;
  await refresh();
});
function open(item: MediaEntry, index = 0) {
  if (item.type === "audio") {
    if (!items.value.some((i) => i.id === item.id)) items.value = [...items.value, item];
    void playAudio(item, index);
  } else preview.value = item;
}
</script>

<template>
  <div class="home-page">
    <PageHeader title="首页" description="从上次停下的地方，继续。">
      <SearchField
        v-model="query"
        class="home-search"
        placeholder="搜索最近加入的媒体…"
        clear-label="清除搜索"
      />
      <m3e-button variant="tonal" @click="load().then(refresh)">刷新</m3e-button>
      <m3e-button variant="filled" @click="router.push('/settings?section=settings-scan')"
        ><span slot="icon" class="material-symbols-outlined">add</span>添加媒体</m3e-button
      >
    </PageHeader>
    <section class="home-section">
      <div class="section-heading">
        <h2>继续使用</h2>
        <m3e-button variant="text" size="small" @click="router.push('/history')"
          >查看历史<span slot="icon" class="material-symbols-outlined"
            >chevron_right</span
          ></m3e-button
        >
      </div>
      <MediaGrid
        v-if="continuing.length"
        :items="continuing"
        masonry
        cover-only
        :min-width="170"
        @open="open"
        @favorite="toggleFavorite"
      />
      <m3e-card v-else class="welcome"
        ><div>
          <span class="material-symbols-outlined">history</span>
          <h3>从喜欢的内容开始</h3>
          <p>播放音乐、阅读书籍后，可以在这里继续。</p>
          <m3e-button variant="tonal" @click="router.push('/folders')">浏览本地媒体</m3e-button>
        </div></m3e-card
      >
    </section>
    <section class="home-section">
      <div class="section-heading">
        <h2>常用入口</h2>
        <span>你的内容，触手可及</span>
      </div>
      <div class="shortcut-grid">
        <m3e-card
          v-for="link in shortcuts"
          :key="link.path"
          actionable
          @click="router.push(link.path)"
          ><div class="shortcut-inner">
            <span class="material-symbols-outlined shortcut-icon">{{ link.icon }}</span>
            <div>
              <h3>{{ link.title }}</h3>
              <p>{{ link.description }}</p>
            </div>
            <span class="material-symbols-outlined">chevron_right</span>
          </div></m3e-card
        >
      </div>
    </section>
    <section class="home-section">
      <div class="section-heading">
        <h2>最近加入的媒体</h2>
      </div>
      <MediaGrid
        v-if="loading || recent.length"
        :items="recent"
        :loading="loading"
        mixed
        cover-only
        masonry
        :min-width="170"
        @open="open"
        @favorite="toggleFavorite"
      /><EmptyState
        v-else
        icon="folder"
        :title="query ? '没有匹配的媒体' : '媒体库还是空的'"
        description="添加扫描目录后，你的媒体会出现在这里。"
      />
    </section>
    <EntryPreview
      v-if="preview"
      :item="preview"
      @close="preview = null"
      @favorite="toggleFavorite"
    />
  </div>
</template>

<style scoped>
.home-search {
  width: min(28vw, 300px);
}
.home-section {
  margin-bottom: var(--lm-space-32);
}
.section-heading {
  display: flex;
  align-items: center;
  gap: var(--lm-space-12);
  justify-content: space-between;
  margin-bottom: var(--lm-space-16);
}
.section-heading h2 {
  font-size: 20px;
  font-weight: 500;
  margin: 0;
}
.section-heading > span,
.shortcut-inner p,
.welcome p {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
}
.shortcut-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--lm-space-16);
}
.shortcut-inner {
  display: flex;
  align-items: center;
  gap: var(--lm-space-16);
  padding: var(--lm-space-16);
}
.shortcut-inner h3 {
  font-size: 15px;
  margin: 0 0 var(--lm-space-4);
}
.shortcut-inner p {
  margin: 0;
}
.shortcut-inner > .material-symbols-outlined:last-child {
  margin-left: auto;
}
.shortcut-icon {
  padding: var(--lm-space-12);
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.welcome > div {
  padding: var(--lm-space-24);
}
.welcome h3 {
  font-size: 20px;
  margin: var(--lm-space-12) 0;
}
.welcome m3e-button {
  margin-top: var(--lm-space-16);
}
@media (max-width: 1200px) {
  .shortcut-inner {
    gap: var(--lm-space-8);
  }
}
@media (max-width: 760px) {
  .shortcut-grid {
    grid-template-columns: 1fr;
  }
  .home-search {
    width: 100%;
  }
}
</style>
