<script setup lang="ts">
/**
 * 番茄小说在线源。
 *
 * 数据经独立的 `silvermoon-fqapi` sidecar 取得（见 `utils/fqapiNovel.ts`），
 * 字段归一化成与文库8 / 笔趣阁一致的 `Novel*` 形状，因此复用同一套
 * `NovelCard` / `BookReader` —— 不另造阅读器。
 *
 * 四个视图：
 *   home    推荐流（按模块分组）+ 排行榜 + 我的书架
 *   detail  书籍详情（标签用 MD3 chip）
 *   reader  阅读器（正文由 sidecar 解析成段落）
 *
 * 与另外两个源的差别：**它需要联网注册匿名设备**（sidecar 内部维护 5 台
 * 设备的池）。首次打开有数秒延迟；首屏跑一次 selftest，失败时把真实原因
 * 摆出来，而不是让用户面对一个空列表。
 */
import { computed, onMounted, ref } from "vue";
import { capabilities } from "@/capabilities";
import NovelCard from "@/components/NovelCard.vue";
import BookReader from "@/components/BookReader.vue";
import NovelSearchBar from "@/components/NovelSearchBar.vue";
import NovelTagChips from "@/components/NovelTagChips.vue";
import {
  fqapiCatalogue,
  fqapiDetail,
  fqapiFeed,
  fqapiRank,
  fqapiSearch,
  fqapiSelftest,
  type FqapiFeedSection,
} from "@/utils/fqapiNovel";
import type { NovelCover, NovelDetail, NovelProgress, NovelVolume } from "@shared/types";

const view = ref<"home" | "detail" | "reader">("home");
const selected = ref<{ aid: string; title: string }>({ aid: "", title: "" });
const readerInit = ref<{ cid?: string; chapterTitle?: string }>({});

const searchQuery = ref("");
const searching = ref(false);
const searchResults = ref<NovelCover[]>([]);
const searchError = ref("");
const hasMore = ref(false);
const nextOffset = ref("");
/** 是否搜过一次（决定首页显示引导还是结果） */
const searched = ref(false);

/** 推荐流：按模块分组 */
const feedSections = ref<FqapiFeedSection[]>([]);
const feedLoading = ref(false);
const feedError = ref("");

/** 排行榜 */
const rankBooks = ref<NovelCover[]>([]);
const rankTitle = ref("排行榜");
const rankLoading = ref(false);
const rankError = ref("");

/** 我的书架（与另外两个源共用同一张 Rust 表） */
const shelf = ref<NovelCover[]>([]);
const progressMap = ref<Record<string, NovelProgress>>({});

const detail = ref<NovelDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const chapters = ref<{ cid: string; title: string }[]>([]);
const inShelf = computed(() => shelf.value.some((b) => b.aid === selected.value.aid));

const selftestError = ref("");
const selftestOk = ref<boolean | null>(null);

const homeTab = ref<"recommend" | "rank" | "shelf">("recommend");

function log(msg: string) {
  void capabilities.appLog(`[novel-fqapi] ${msg}`).catch(() => {});
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- 自检 ----
async function runSelftest() {
  selftestError.value = "";
  try {
    const r = (await fqapiSelftest()) as { ok?: boolean; steps?: unknown };
    selftestOk.value = r?.ok !== false;
    if (!selftestOk.value) {
      const steps = (r?.steps ?? []) as { step?: string; error?: string }[];
      const bad = steps.find((s) => s.error);
      selftestError.value = bad?.error ?? "内容源自检未通过";
    }
    log(`自检 ${selftestOk.value ? "通过" : "失败"}：${JSON.stringify(r).slice(0, 300)}`);
  } catch (e) {
    selftestOk.value = false;
    selftestError.value = errText(e);
    log(`自检异常：${selftestError.value}`);
  }
}

// ---- 推荐流 ----
async function loadFeed() {
  feedLoading.value = true;
  feedError.value = "";
  try {
    const { sections } = await fqapiFeed("0");
    feedSections.value = sections;
    log(`推荐流 ${sections.length} 个模块`);
  } catch (e) {
    feedError.value = errText(e);
    log(`推荐流失败：${feedError.value}`);
  } finally {
    feedLoading.value = false;
  }
}

// ---- 排行榜 ----
async function loadRank() {
  if (rankBooks.value.length || rankLoading.value) return;
  rankLoading.value = true;
  rankError.value = "";
  try {
    const r = await fqapiRank();
    rankTitle.value = r.title;
    rankBooks.value = r.books;
    log(`排行榜「${r.title}」${r.books.length} 本`);
  } catch (e) {
    rankError.value = errText(e);
    log(`排行榜失败：${rankError.value}`);
  } finally {
    rankLoading.value = false;
  }
}

// ---- 书架 ----
async function loadShelf() {
  try {
    const items = await capabilities.novelShelfList();
    // NovelShelfItem 用 `cover`，卡片组件要 `imageUrl`：这里做一次映射，
    // 避免为了对齐字段去改三处共用的类型。
    shelf.value = items.map((it) => ({
      aid: it.aid,
      title: it.title,
      imageUrl: it.cover,
      author: it.author || null,
    }));
    const map: Record<string, NovelProgress> = {};
    for (const b of shelf.value) {
      const p = await capabilities.novelProgressGet(b.aid).catch(() => null);
      if (p) map[b.aid] = p;
    }
    progressMap.value = map;
  } catch (e) {
    log(`书架读取失败：${errText(e)}`);
  }
}

async function toggleShelf() {
  const d = detail.value;
  if (!d) return;
  try {
    if (inShelf.value) {
      await capabilities.novelShelfRemove(d.aid);
    } else {
      await capabilities.novelShelfAdd(d.aid, d.title, d.author, d.imgUrl);
    }
    await loadShelf();
  } catch (e) {
    log(`书架操作失败：${errText(e)}`);
  }
}

// ---- 搜索 ----
async function doSearch(keyword: string, append = false) {
  if (!keyword) return;
  searching.value = true;
  searchError.value = "";
  try {
    const {
      covers,
      hasMore: more,
      nextOffset: off,
    } = await fqapiSearch(keyword, append ? nextOffset.value : "");
    searchResults.value = append ? [...searchResults.value, ...covers] : covers;
    hasMore.value = more;
    nextOffset.value = off;
    searched.value = true;
    searchQuery.value = keyword;
    log(`搜索「${keyword}」得到 ${searchResults.value.length} 条（hasMore=${more}）`);
  } catch (e) {
    searchError.value = errText(e);
    if (!append) searchResults.value = [];
    log(`搜索失败：${searchError.value}`);
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  searched.value = false;
  searchQuery.value = "";
  searchResults.value = [];
  hasMore.value = false;
}

// ---- 详情 / 阅读 ----
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
    log(`打开详情 ${cover.aid} 章节数=${flat.length}`);
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

async function onReaderClose() {
  view.value = "detail";
  await loadShelf();
}

function onDetailBack() {
  view.value = "home";
}

function switchHomeTab(tab: "recommend" | "rank" | "shelf") {
  homeTab.value = tab;
  if (tab === "rank") void loadRank();
  if (tab === "shelf") void loadShelf();
}

onMounted(async () => {
  await runSelftest();
  if (!selftestOk.value) return;
  void loadFeed();
  void loadShelf();
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
            <div class="actions">
              <m3e-button variant="filled" size="small" @click="toggleShelf">
                <span slot="icon" class="material-symbols-outlined">
                  {{ inShelf ? "bookmark_remove" : "bookmark_add" }}
                </span>
                {{ inShelf ? "移出书架" : "加入书架" }}
              </m3e-button>
              <m3e-button
                v-if="chapters.length"
                variant="tonal"
                size="small"
                @click="openReader(chapters[0].cid, chapters[0].title)"
              >
                <span slot="icon" class="material-symbols-outlined">menu_book</span>
                从第一章读
              </m3e-button>
            </div>
          </div>
        </div>

        <NovelTagChips v-if="detail.tags.length" :tags="detail.tags" />

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
      <NovelSearchBar
        placeholder="搜索番茄小说 / 作者"
        :busy="searching"
        @search="(kw) => doSearch(kw, false)"
      />

      <!-- 自检失败：把真实原因摆出来 -->
      <div v-if="selftestError" class="notice error-notice">
        <strong>内容源不可用</strong>
        <p>{{ selftestError }}</p>
        <m3e-button variant="text" size="small" @click="runSelftest">重试</m3e-button>
      </div>

      <template v-if="searched">
        <div class="search-header">
          <h3 class="section-title">搜索结果</h3>
          <m3e-button variant="text" size="small" @click="clearSearch">清除</m3e-button>
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
          <m3e-button variant="tonal" size="small" @click="doSearch(searchQuery, true)">
            加载更多
          </m3e-button>
        </div>
        <div v-if="searching" class="state">搜索中……</div>
        <div v-else-if="!searchResults.length && !searchError" class="state">没有找到结果</div>
      </template>

      <template v-else-if="selftestOk !== false">
        <div class="home-tabs">
          <m3e-button-group>
            <m3e-button
              :variant="homeTab === 'recommend' ? 'filled' : 'outlined'"
              size="small"
              @click="switchHomeTab('recommend')"
            >
              推荐
            </m3e-button>
            <m3e-button
              :variant="homeTab === 'rank' ? 'filled' : 'outlined'"
              size="small"
              @click="switchHomeTab('rank')"
            >
              排行榜
            </m3e-button>
            <m3e-button
              :variant="homeTab === 'shelf' ? 'filled' : 'outlined'"
              size="small"
              @click="switchHomeTab('shelf')"
            >
              我的书架（{{ shelf.length }}）
            </m3e-button>
          </m3e-button-group>
        </div>

        <!-- 推荐 -->
        <div v-if="homeTab === 'recommend'">
          <p v-if="feedError" class="error">{{ feedError }}</p>
          <div v-if="feedLoading" class="state">加载推荐……</div>
          <section v-for="sec in feedSections" :key="sec.title" class="feed-section">
            <h4 class="section-title">{{ sec.title }}</h4>
            <div class="grid">
              <NovelCard
                v-for="novel in sec.books"
                :key="novel.aid"
                :item="novel"
                @open="openDetail(novel)"
              />
            </div>
          </section>
          <div v-if="!feedLoading && !feedSections.length && !feedError" class="state">
            暂无推荐
          </div>
        </div>

        <!-- 排行榜 -->
        <div v-else-if="homeTab === 'rank'">
          <p v-if="rankError" class="error">{{ rankError }}</p>
          <div v-if="rankLoading" class="state">加载排行榜……</div>
          <template v-else-if="rankBooks.length">
            <h4 class="section-title">{{ rankTitle }}</h4>
            <div class="grid">
              <NovelCard
                v-for="novel in rankBooks"
                :key="novel.aid"
                :item="novel"
                @open="openDetail(novel)"
              />
            </div>
          </template>
          <div v-else-if="!rankError" class="state">暂无榜单</div>
        </div>

        <!-- 书架 -->
        <div v-else>
          <div v-if="shelf.length" class="grid">
            <NovelCard
              v-for="novel in shelf"
              :key="novel.aid"
              :item="novel"
              :subtitle="progressMap[novel.aid]?.chapterTitle"
              @open="openDetail(novel)"
            />
          </div>
          <div v-else class="empty-hint">
            <span class="material-symbols-outlined">bookmark_border</span>
            <p>书架是空的。在书籍详情页点「加入书架」</p>
          </div>
        </div>
      </template>
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

.home-tabs {
  margin-top: 4px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 16px;
}

.feed-section {
  margin-top: 12px;
}

.search-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

/* 返回按钮必须贴左：父级是 flex column（align-items 默认 stretch），
   不写这条按钮会被拉满整行 —— 正是用户看到的「返回占一整条」。 */
.back {
  align-self: flex-start;
}

.detail-head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

/* 详情页的纵向节奏：封面区 → 标签 → 简介 → 目录。
   原来全靠 .detail 的 gap 撑，标签行会紧贴封面底边（图里那种「贴着」）。
   这里给每一段明确的上边距，让层次读得出来。 */
.detail > .tag-row,
.detail > .introduce,
.detail > .section {
  margin-top: 4px;
}

.cover {
  width: 120px;
  height: 160px;
  border-radius: var(--md-sys-shape-corner-medium);
  object-fit: cover;
  flex: none;
  background: var(--md-sys-color-surface-container-high);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta .title {
  margin: 0 0 6px;
  font-size: 20px;
}

.meta .line {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
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
