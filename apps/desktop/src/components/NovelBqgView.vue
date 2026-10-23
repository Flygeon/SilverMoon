<script setup lang="ts">
import { onMounted, ref } from "vue";
import { capabilities } from "@/capabilities";
import { bqgCatalogueCached } from "@/utils/novelCache";
import NovelCard from "@/components/NovelCard.vue";
import NovelSearchBar from "@/components/NovelSearchBar.vue";
import BookReader from "@/components/BookReader.vue";
import type { NovelCover, NovelDetail, NovelVolume } from "@shared/types";

const BASE = "https://www.bqg413.cc";

/** 从共享书架跳进来时直接打开指定书目（见 BooksView 的 openFromShelf）。 */
const props = defineProps<{ openAid?: string; openTitle?: string }>();
const emit = defineEmits<{ (e: "opened"): void }>();

const view = ref<"home" | "detail" | "reader">("home");
const selected = ref<{ aid: string; title: string }>({ aid: "", title: "" });
const readerInit = ref<{ cid?: string; chapterTitle?: string }>({});

const searchQuery = ref("");
const searching = ref(false);
const searchResults = ref<NovelCover[]>([]);
const searchError = ref("");

const homeCovers = ref<NovelCover[]>([]);
const homeLoading = ref(false);
const homeError = ref("");

const detail = ref<NovelDetail | null>(null);
/** 是否已在共享书架里（书架统一在「书架」页，本页只保留加入/移出按钮） */
const inShelf = ref(false);
const shelfBusy = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const volumes = ref<NovelVolume[]>([]);
const chapters = ref<{ cid: string; title: string }[]>([]);

function log(msg: string) {
  void capabilities.appLog(`[novel-bqg] ${msg}`).catch(() => {});
}

function coverUrl(u: string | undefined): string {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("/")) return BASE + u;
  return u;
}

async function loadHome() {
  homeLoading.value = true;
  homeError.value = "";
  try {
    homeCovers.value = await capabilities.bqgHome();
    log(`loadHome OK covers=${homeCovers.value.length}`);
  } catch (e) {
    homeError.value = e instanceof Error ? e.message : String(e);
    homeCovers.value = [];
    log(`loadHome ERR: ${homeError.value}`);
  } finally {
    homeLoading.value = false;
  }
}

/** 适配共享搜索栏：它回传关键词，本页的 doSearch 读的是 searchQuery ref。 */
function doSearchWith(keyword: string) {
  searchQuery.value = keyword;
  void doSearch();
}

async function doSearch() {
  const q = searchQuery.value.trim();
  if (!q) return;
  searching.value = true;
  searchError.value = "";
  log(`doSearch q=${JSON.stringify(q)}`);
  try {
    searchResults.value = await capabilities.bqgSearch(q);
    log(`doSearch OK results=${searchResults.value.length}`);
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : String(e);
    searchResults.value = [];
    log(`doSearch ERR: ${searchError.value}`);
  } finally {
    searching.value = false;
  }
}

function openNovel(item: NovelCover) {
  selected.value = { aid: item.aid, title: item.title };
  void openDetail();
}

async function refreshShelf() {
  try {
    const list = await capabilities.novelShelfList();
    inShelf.value = list.some((s) => s.aid === selected.value.aid && s.source === "bqg");
  } catch {
    inShelf.value = false;
  }
}

async function toggleShelf() {
  const d = detail.value;
  if (!d || shelfBusy.value) return;
  shelfBusy.value = true;
  try {
    if (inShelf.value) {
      await capabilities.novelShelfRemove(d.aid);
      inShelf.value = false;
    } else {
      await capabilities.novelShelfAdd(d.aid, d.title, d.author, coverUrl(d.imgUrl), "bqg");
      inShelf.value = true;
    }
  } catch (e) {
    log(`书架操作失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    shelfBusy.value = false;
  }
}

async function openDetail() {
  view.value = "detail";
  detailLoading.value = true;
  detailError.value = "";
  detail.value = null;
  volumes.value = [];
  chapters.value = [];
  inShelf.value = false;
  log(`openDetail aid=${selected.value.aid}`);
  try {
    const [d, vols] = await Promise.all([
      capabilities.bqgDetail(selected.value.aid),
      bqgCatalogueCached(selected.value.aid),
    ]);
    detail.value = d;
    volumes.value = vols;
    const list: { cid: string; title: string }[] = [];
    for (const v of vols) list.push(...v.chapters);
    chapters.value = list;
    log(`openDetail OK chapters=${list.length}`);
    void refreshShelf();
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e);
    log(`openDetail ERR: ${detailError.value}`);
  } finally {
    detailLoading.value = false;
  }
}

function openReader(cid: string, chapterTitle: string) {
  log(`openReader aid=${selected.value.aid} cid=${cid} title=${chapterTitle}`);
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
  void loadHome();
  if (props.openAid) {
    openNovel({ aid: props.openAid, title: props.openTitle ?? "", imageUrl: "" });
    emit("opened");
  }
});
</script>

<template>
  <div class="novel-bqg">
    <!-- 阅读器 -->
    <Teleport v-if="view === 'reader'" to="body">
      <BookReader
        :novel-source="{
          aid: selected.aid,
          title: selected.title,
          source: 'bqg',
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
      <!-- 加载态：M3E 加载指示器 + 文案，与其它在线源的 .state 结构保持一致 -->
      <div v-else-if="detailLoading" class="state">
        <m3e-loading-indicator class="lm-loading" />
        加载中……
      </div>

      <template v-else-if="detail">
        <div class="detail-head">
          <img class="cover" :src="coverUrl(detail.imgUrl)" :alt="detail.title" />
          <div class="meta">
            <h3 class="title">{{ detail.title }}</h3>
            <p v-if="detail.author" class="line">作者：{{ detail.author }}</p>
            <p v-if="detail.status" class="line">状态：{{ detail.status }}</p>
            <p v-if="detail.finUpdate" class="line">更新：{{ detail.finUpdate }}</p>
            <p v-if="detail.tags.length" class="line">分类：{{ detail.tags.join(" / ") }}</p>
            <div class="actions">
              <m3e-button variant="tonal" size="small" :disabled="shelfBusy" @click="toggleShelf">
                <span slot="icon" class="material-symbols-outlined">{{
                  inShelf ? "bookmark_remove" : "bookmark_add"
                }}</span>
                {{ inShelf ? "移出书架" : "加入书架" }}
              </m3e-button>
            </div>
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
    <template v-else>
      <!-- 搜索：与另外两个在线源共用同一个组件，保证视觉一致 -->
      <NovelSearchBar placeholder="搜索笔趣阁小说" :busy="searching" @search="doSearchWith" />
      <p v-if="searchError" class="error">{{ searchError }}</p>

      <div v-if="searchResults.length" class="search-results">
        <h3 class="section-title">搜索结果</h3>
        <div class="lm-novel-grid">
          <NovelCard v-for="n in searchResults" :key="n.aid" :item="n" @open="openNovel(n)" />
        </div>
      </div>

      <section class="section">
        <h3 class="section-title">热门小说</h3>
        <div v-if="homeLoading" class="state">
          <m3e-loading-indicator class="lm-loading" />
          加载中……
        </div>
        <p v-else-if="homeError" class="error">{{ homeError }}</p>
        <div v-else class="lm-novel-grid">
          <NovelCard v-for="n in homeCovers" :key="n.aid" :item="n" @open="openNovel(n)" />
        </div>
      </section>

      <div
        v-if="!homeLoading && !homeError && !searchResults.length && !homeCovers.length"
        class="state"
      >
        暂无数据
      </div>
    </template>
  </div>
</template>

<style scoped>
.novel-bqg {
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: lm-rise 340ms var(--md-sys-motion-spring-spatial) both;
}
.error {
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
/* 书籍卡片网格统一走全局 .lm-novel-grid（src/tokens/theme.css），此处不再重复定义 */
.state {
  padding: 24px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.back {
  align-self: flex-start;
}
.detail-head {
  display: flex;
  gap: 16px;
}
.cover {
  width: 120px;
  height: 160px;
  object-fit: cover;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-highest);
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.title {
  margin: 0 0 4px;
  font-size: var(--md-sys-typescale-title-large-size);
  font-weight: 500;
}
.line {
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.introduce {
  margin: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.7;
  color: var(--md-sys-color-on-surface);
  white-space: pre-wrap;
}
.chapter-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.chapter {
  text-align: left;
  padding: 10px 14px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  cursor: pointer;
}
.chapter:hover {
  background: var(--md-sys-color-surface-container-high);
}
</style>
