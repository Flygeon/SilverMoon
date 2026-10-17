<script setup lang="ts">
/**
 * 番茄小说在线源。
 *
 * 数据经独立的 `silvermoon-fqapi` sidecar 取得（见 `utils/fqapiNovel.ts`），
 * 字段归一化成与文库8 / 笔趣阁一致的 `Novel*` 形状，因此可以复用同一套
 * `NovelCard` / `BookReader` —— 不另造阅读器。
 *
 * 与另外两个源的差别：**它需要联网注册匿名设备**（sidecar 内部维护 5 台
 * 设备的池）。首次打开会有几秒延迟，失败时给出明确的原因而不是空列表。
 */
import { onMounted, ref } from "vue";
import { capabilities } from "@/capabilities";
import NovelCard from "@/components/NovelCard.vue";
import BookReader from "@/components/BookReader.vue";
import { fqapiCatalogue, fqapiDetail, fqapiSearch, fqapiSelftest } from "@/utils/fqapiNovel";
import type { NovelCover, NovelDetail, NovelVolume } from "@shared/types";

const view = ref<"home" | "detail" | "reader">("home");
const selected = ref<{ aid: string; title: string }>({ aid: "", title: "" });
const readerInit = ref<{ cid?: string; chapterTitle?: string }>({});

const searchQuery = ref("");
const searching = ref(false);
const searchResults = ref<NovelCover[]>([]);
const searchError = ref("");
const hasMore = ref(false);
const nextOffset = ref("");
/** 是否已经搜过一次（决定首页显示引导还是结果） */
const searched = ref(false);

const detail = ref<NovelDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const chapters = ref<{ cid: string; title: string }[]>([]);

/** 自检结果（排障用；首次失败时展示，帮助判断是网络还是上游变了） */
const selftestResult = ref<unknown>(null);
const selftestError = ref("");

function log(msg: string) {
  void capabilities.appLog(`[novel-fqapi] ${msg}`).catch(() => {});
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function doSearch(append = false) {
  const q = searchQuery.value.trim();
  if (!q) return;
  searching.value = true;
  searchError.value = "";
  try {
    const {
      covers,
      hasMore: more,
      nextOffset: off,
    } = await fqapiSearch(q, append ? nextOffset.value : "");
    searchResults.value = append ? [...searchResults.value, ...covers] : covers;
    hasMore.value = more;
    nextOffset.value = off;
    searched.value = true;
    log(`搜索「${q}」得到 ${searchResults.value.length} 条（hasMore=${more}）`);
  } catch (e) {
    searchError.value = errText(e);
    if (!append) searchResults.value = [];
    log(`搜索失败：${searchError.value}`);
  } finally {
    searching.value = false;
  }
}

/** 首屏自检：确认 sidecar 能拉到内容，失败时把原因摆出来而不是干等。 */
async function runSelftest() {
  selftestError.value = "";
  try {
    selftestResult.value = await fqapiSelftest();
    log(`自检通过：${JSON.stringify(selftestResult.value).slice(0, 300)}`);
  } catch (e) {
    selftestError.value = errText(e);
    log(`自检失败：${selftestError.value}`);
  }
}

async function openDetail(cover: NovelCover) {
  selected.value = { aid: cover.aid, title: cover.title };
  view.value = "detail";
  detail.value = null;
  chapters.value = [];
  detailLoading.value = true;
  detailError.value = "";
  try {
    const [d, vols] = await Promise.all([fqapiDetail(cover.aid), fqapiCatalogue(cover.aid)]);
    detail.value = d;
    const flat: { cid: string; title: string }[] = [];
    for (const v of vols as NovelVolume[]) flat.push(...v.chapters);
    chapters.value = flat;
    log(`打开详情 aid=${cover.aid} 章节数=${flat.length}`);
  } catch (e) {
    detailError.value = errText(e);
    log(`打开详情失败：${detailError.value}`);
  } finally {
    detailLoading.value = false;
  }
}

function openReader(cid: string, chapterTitle: string) {
  readerInit.value = { cid, chapterTitle };
  view.value = "reader";
}

function onReaderClose() {
  view.value = "detail";
}

function onDetailBack() {
  view.value = "home";
}

onMounted(() => {
  void runSelftest();
});
</script>

<template>
  <div class="novel-fqapi">
    <!-- 阅读器 -->
    <Teleport v-if="view === 'reader'" to="body">
      <BookReader
        :novel-source="{
          aid: selected.aid,
          title: selected.title,
          source: 'fqapi',
          initialCid: readerInit.cid,
          initialChapterTitle: readerInit.chapterTitle,
        }"
        @close="onReaderClose"
      />
    </Teleport>

    <!-- 详情 -->
    <div v-else-if="view === 'detail'" class="detail">
      <m3e-button class="back" variant="text" size="small" @click="onDetailBack">
        <span slot="icon" class="material-symbols-outlined">arrow_back</span>
        返回
      </m3e-button>

      <p v-if="detailError" class="error">{{ detailError }}</p>
      <div v-else-if="detailLoading" class="state">加载中……</div>

      <template v-else-if="detail">
        <div class="detail-head">
          <img v-if="detail.imgUrl" class="cover" :src="detail.imgUrl" :alt="detail.title" />
          <div class="meta">
            <h3 class="title">{{ detail.title }}</h3>
            <p v-if="detail.author" class="line">作者：{{ detail.author }}</p>
            <p v-if="detail.status" class="line">状态：{{ detail.status }}</p>
            <p v-if="detail.finUpdate" class="line">更新：{{ detail.finUpdate }}</p>
            <p v-if="detail.tags.length" class="line">分类：{{ detail.tags.join(" / ") }}</p>
          </div>
        </div>

        <p v-if="detail.introduce" class="introduce">{{ detail.introduce }}</p>

        <section class="section">
          <h4 class="section-title">目录（{{ chapters.length }}）</h4>
          <div v-if="chapters.length" class="chapter-list">
            <button
              v-for="ch in chapters"
              :key="ch.cid"
              class="chapter"
              @click="openReader(ch.cid, ch.title)"
            >
              {{ ch.title }}
            </button>
          </div>
          <p v-else class="state">暂无目录</p>
        </section>
      </template>
    </div>

    <!-- 主页 -->
    <div v-else class="home">
      <div class="search-bar">
        <input
          v-model="searchQuery"
          class="search-input"
          type="text"
          placeholder="搜索书名 / 作者"
          @keyup.enter="doSearch(false)"
        />
        <m3e-button variant="filled" size="small" :disabled="searching" @click="doSearch(false)">
          {{ searching ? "搜索中…" : "搜索" }}
        </m3e-button>
      </div>

      <!-- 自检失败：把真实原因摆出来，别让用户面对空列表 -->
      <div v-if="selftestError" class="notice error-notice">
        <strong>内容源不可用</strong>
        <p>{{ selftestError }}</p>
        <m3e-button variant="text" size="small" @click="runSelftest">重试</m3e-button>
      </div>

      <p v-if="searchError" class="error">{{ searchError }}</p>

      <div v-if="searchResults.length" class="grid">
        <NovelCard
          v-for="novel in searchResults"
          :key="novel.aid"
          :item="novel"
          @open="openDetail(novel)"
        />
      </div>
      <div v-if="hasMore && !searching" class="more">
        <m3e-button variant="tonal" size="small" @click="doSearch(true)">加载更多</m3e-button>
      </div>

      <div v-if="searching && !searchResults.length" class="state">搜索中……</div>
      <div v-else-if="searched && !searchResults.length && !searchError" class="state">
        没有找到结果
      </div>
      <div v-else-if="!searched" class="empty-hint">
        <span class="material-symbols-outlined">menu_book</span>
        <p>搜索番茄小说的书名或作者</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.novel-fqapi {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 0;
}

.search-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  font: inherit;
  outline: none;
}

.search-input:focus {
  border-color: var(--md-sys-color-primary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 16px;
}

.notice {
  padding: 12px 16px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}

.error-notice {
  border-left: 3px solid var(--md-sys-color-error);
}

.error-notice p {
  margin: 4px 0 8px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 13px;
  word-break: break-all;
}

.error {
  color: var(--md-sys-color-error);
  font-size: 13px;
}

.state,
.empty-hint {
  padding: 32px 0;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.empty-hint .material-symbols-outlined {
  font-size: 40px;
  opacity: 0.5;
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-head {
  display: flex;
  gap: 16px;
}

.cover {
  width: 120px;
  height: 160px;
  border-radius: var(--md-sys-shape-corner-medium);
  object-fit: cover;
  flex: none;
  background: var(--md-sys-color-surface-container-high);
}

.meta .title {
  margin: 0 0 8px;
  font-size: 20px;
}

.meta .line {
  margin: 2px 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 13px;
}

.introduce {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 14px;
  line-height: 1.7;
}

.section-title {
  margin: 0 0 8px;
  font-size: 15px;
}

.chapter-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px;
  max-height: 50vh;
  overflow-y: auto;
}

.chapter {
  padding: 8px 10px;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: none;
  color: var(--md-sys-color-on-surface);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter:hover {
  background: var(--md-sys-color-surface-container-high);
}

.more {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}
</style>
