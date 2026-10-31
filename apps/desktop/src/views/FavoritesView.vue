<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from "vue";
import MediaGrid from "@/components/MediaGrid.vue";
import PageHeader from "@/components/PageHeader.vue";
import SearchField from "@/components/SearchField.vue";
import EntryPreview from "@/components/EntryPreview.vue";
import { showAppToast } from "@/components/AppToast.vue";
import { promptText } from "@/composables/useTextPrompt";
import { JsonStore } from "@/ipc/store";
import type { MediaEntry, MediaType } from "@shared/types";
import EmptyState from "@/components/EmptyState.vue";
import { useEntryList } from "@/composables/useEntryList";
import { useSettingsStore } from "@/stores/settings";
import { capabilities, isDesktop } from "@/capabilities";
import { translate } from "@shared/i18n";

const settings = useSettingsStore();
const {
  items,
  loading,
  load,
  open: playAudio,
  toggleFavorite,
} = useEntryList(() => capabilities.listFavorites());
interface Collection {
  id: string;
  name: string;
  ids: string[];
}
const store = new JsonStore("collections.json");
const collections = ref<Collection[]>([]);
const ready = ref(false);
const active = ref("all");
const filter = ref<MediaType | "all">("all");
const query = ref("");
const list = ref(false);
const ascending = ref(false);
const batch = ref(false);
const selected = ref<string[]>([]);
const preview = ref<MediaEntry | null>(null);
const types = [
  { value: "all", label: "全部" },
  { value: "audio", label: "音乐" },
  { value: "video", label: "视频" },
  { value: "book", label: "书籍" },
  { value: "image", label: "图片" },
] as const;
const current = computed(() => collections.value.find((c) => c.id === active.value));
const title = computed(() => current.value?.name ?? "全部收藏");
const members = computed(() =>
  current.value ? items.value.filter((i) => current.value!.ids.includes(i.id)) : items.value,
);
const results = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  const result = members.value.filter(
    (i) =>
      (filter.value === "all" || i.type === filter.value) &&
      `${i.title ?? ""} ${i.name} ${i.artist ?? ""} ${i.album ?? ""}`
        .toLocaleLowerCase()
        .includes(term),
  );
  return ascending.value
    ? [...result].sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name))
    : result;
});
let activated = false;
onActivated(() => {
  if (activated) void load();
  activated = true;
});
onMounted(async () => {
  try {
    const saved = isDesktop
      ? await store.get<Collection[]>("collections")
      : JSON.parse(localStorage.getItem("silvermoon.collections") ?? "[]");
    collections.value = Array.isArray(saved)
      ? saved.filter(
          (c): c is Collection =>
            typeof c?.id === "string" &&
            typeof c.name === "string" &&
            Array.isArray(c.ids) &&
            c.ids.every((id: unknown) => typeof id === "string"),
        )
      : [];
    ready.value = true;
  } catch {
    showAppToast("收藏夹读取失败，请重新打开此页面重试", { tone: "error" });
  }
});
async function save(next: Collection[]) {
  try {
    if (isDesktop) {
      await store.set("collections", next);
      await store.save();
    } else localStorage.setItem("silvermoon.collections", JSON.stringify(next));
    collections.value = next;
    return true;
  } catch {
    showAppToast("收藏夹保存失败，请重试", { tone: "error" });
    return false;
  }
}
async function createCollection() {
  const name = (await promptText("新建收藏夹"))?.trim();
  if (!name || !ready.value) return;
  const c = { id: crypto.randomUUID(), name, ids: [] };
  if (await save([...collections.value, c])) active.value = c.id;
}
async function renameCollection() {
  const c = current.value;
  if (!c) return;
  const name = (await promptText("重命名收藏夹", c.name))?.trim();
  if (name) await save(collections.value.map((i) => (i.id === c.id ? { ...i, name } : i)));
}
async function addToCollection(id: string) {
  if (!selected.value.length) return;
  if (
    await save(
      collections.value.map((c) =>
        c.id === id ? { ...c, ids: [...new Set([...c.ids, ...selected.value])] } : c,
      ),
    )
  ) {
    selected.value = [];
    batch.value = false;
    showAppToast("已加入收藏夹");
  }
}
async function removeFromCollection() {
  const c = current.value;
  if (!c) return;
  if (
    await save(
      collections.value.map((i) =>
        i.id === c.id ? { ...i, ids: i.ids.filter((id) => !selected.value.includes(id)) } : i,
      ),
    )
  )
    selected.value = [];
}
function open(item: MediaEntry, index: number) {
  if (batch.value) {
    selected.value = selected.value.includes(item.id)
      ? selected.value.filter((id) => id !== item.id)
      : [...selected.value, item.id];
    return;
  }
  if (item.type === "audio") void playAudio(item, index);
  else preview.value = item;
}
function random() {
  const index = Math.floor(Math.random() * results.value.length);
  const item = results.value[index];
  if (item) open(item, index);
}

function t(key: string) {
  return translate(settings.lang, key);
}
</script>

<template>
  <div class="view">
    <PageHeader :title="t('nav.favorites')" description="把喜欢的内容，留在触手可及的地方。">
      <SearchField
        v-model="query"
        class="favorites-search"
        placeholder="搜索收藏的标题、作者…"
        clear-label="清除搜索"
      />
      <m3e-button variant="filled" :disabled="!ready" @click="createCollection"
        >新建收藏夹</m3e-button
      >
    </PageHeader>
    <div class="favorites-layout">
      <aside class="collections" aria-label="收藏夹">
        <m3e-button :variant="active === 'all' ? 'tonal' : 'text'" @click="active = 'all'"
          >全部收藏 · {{ items.length }}</m3e-button
        >
        <h3>我的收藏夹</h3>
        <m3e-button
          v-for="c in collections"
          :key="c.id"
          :variant="active === c.id ? 'tonal' : 'text'"
          @click="active = c.id"
          ><span slot="icon" class="material-symbols-outlined">folder</span
          ><span class="collection-name">{{ c.name }}</span> ·
          {{ items.filter((i) => c.ids.includes(i.id)).length }}</m3e-button
        >
        <p v-if="!collections.length" class="collection-help">
          新建收藏夹后，使用「批量整理」将不同媒体收在一起。
        </p>
      </aside>
      <div class="favorites-content">
        <m3e-card class="collection-banner"
          ><div class="banner-inner">
            <span class="material-symbols-outlined banner-icon">favorite</span>
            <div>
              <h2>{{ title }}</h2>
              <p>{{ members.length }} 项内容 · {{ collections.length }} 个收藏夹</p>
            </div>
            <m3e-icon-button v-if="current" aria-label="重命名收藏夹" @click="renameCollection"
              ><span class="material-symbols-outlined">edit</span></m3e-icon-button
            ><m3e-button variant="tonal" :disabled="!results.length || batch" @click="random"
              >随机看看</m3e-button
            >
          </div></m3e-card
        >
        <div class="filters">
          <m3e-button
            v-for="type in types"
            :key="type.value"
            :variant="filter === type.value ? 'filled' : 'tonal'"
            size="small"
            @click="filter = type.value"
            >{{ type.label }}</m3e-button
          ><span class="spacer"></span
          ><m3e-icon-button
            :variant="list ? 'standard' : 'tonal'"
            aria-label="瀑布流视图"
            :aria-pressed="!list"
            @click="list = false"
            ><span class="material-symbols-outlined">grid_view</span></m3e-icon-button
          ><m3e-icon-button
            :variant="list ? 'tonal' : 'standard'"
            aria-label="列表视图"
            :aria-pressed="list"
            @click="list = true"
            ><span class="material-symbols-outlined">view_list</span></m3e-icon-button
          >
        </div>
        <div class="result-tools">
          <span>{{ results.length }} 项{{ batch ? ` · 已选 ${selected.length} 项` : "" }}</span
          ><span class="spacer"></span
          ><m3e-button variant="text" size="small" @click="ascending = !ascending">{{
            ascending ? "标题排序" : "默认顺序"
          }}</m3e-button
          ><m3e-button
            variant="text"
            size="small"
            @click="
              batch = !batch;
              selected = [];
            "
            >{{ batch ? "完成整理" : "批量整理" }}</m3e-button
          >
        </div>
        <div v-if="batch" class="batch-tools">
          <span>点击卡片选择，再加入收藏夹</span
          ><m3e-button variant="tonal" size="small" @click="selected = results.map((i) => i.id)"
            >全选</m3e-button
          ><m3e-button
            v-for="c in collections"
            :key="c.id"
            variant="tonal"
            size="small"
            :disabled="!selected.length"
            @click="addToCollection(c.id)"
            >加入 {{ c.name }}</m3e-button
          ><m3e-button
            v-if="current"
            variant="text"
            :disabled="!selected.length"
            @click="removeFromCollection"
            >移出当前收藏夹</m3e-button
          >
        </div>

        <MediaGrid
          v-if="loading || results.length"
          :items="results"
          :loading="loading"
          masonry
          mixed
          :list="list"
          :selected-ids="selected"
          :selecting="batch"
          :min-width="200"
          @open="open"
          @favorite="toggleFavorite"
        />

        <EmptyState
          v-else
          icon="favorite"
          :title="
            query || filter !== 'all' ? '没有匹配的收藏' : current ? '收藏夹还是空的' : '还没有收藏'
          "
          :description="
            current
              ? '在全部收藏中点击批量整理，选择内容加入这个收藏夹。'
              : '在媒体卡片上点击心形图标，即可将其加入收藏。'
          "
        />
      </div>
    </div>
    <EntryPreview
      v-if="preview"
      :item="preview"
      @close="preview = null"
      @favorite="toggleFavorite"
    />
  </div>
</template>

<style scoped>
.favorites-search {
  width: min(30vw, 320px);
}
.favorites-layout {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: var(--lm-space-24);
}
.collections {
  display: flex;
  flex-direction: column;
  gap: var(--lm-space-8);
  border-right: 1px solid var(--lm-hairline);
  padding-right: var(--lm-space-16);
}
.collections m3e-button {
  width: 100%;
  min-width: 0;
}
.collections h3 {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
  margin: var(--lm-space-24) 0 var(--lm-space-8);
}
.collection-name {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.collection-help {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
  line-height: 1.8;
}
.favorites-content {
  min-width: 0;
}
.collection-banner {
  display: block;
  --m3e-filled-card-container-color: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.banner-inner {
  display: flex;
  align-items: center;
  gap: var(--lm-space-16);
  padding: var(--lm-space-20) var(--lm-space-24);
}
.banner-inner h2 {
  font-size: 22px;
  font-weight: 500;
  margin: 0;
}
.banner-inner p {
  margin: var(--lm-space-8) 0 0;
  font-size: 12px;
}
.banner-icon {
  font-size: 36px;
}
.banner-inner > m3e-button {
  margin-left: auto;
  flex-shrink: 0;
}
.filters,
.result-tools,
.batch-tools {
  display: flex;
  align-items: center;
  gap: var(--lm-space-8);
  margin: var(--lm-space-20) 0;
  flex-wrap: wrap;
}
.result-tools,
.batch-tools {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}
.spacer {
  flex: 1;
}
@media (max-width: 1000px) {
  .favorites-layout {
    grid-template-columns: 1fr;
  }
  .collections {
    flex-direction: row;
    flex-wrap: wrap;
    border: 0;
    padding: 0;
  }
  .collections m3e-button {
    width: auto;
  }
  .collections h3,
  .collection-help {
    display: none;
  }
}
.view {
  min-height: 100%;
}
</style>
