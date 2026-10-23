<script setup lang="ts">
/**
 * 番茄小说在线源。
 *
 * 数据经独立的 `silvermoon-fqapi` sidecar 取得（见 `utils/fqapiNovel.ts`），
 * 字段归一化成与文库8 / 笔趣阁一致的 `Novel*` 形状，因此复用同一套
 * `NovelCard` / `BookReader` —— 不另造阅读器。
 *
 * 三个视图（书架已统一到 BooksView 的「书架」页）：
 *   home    推荐流（按模块分组）+ 排行榜
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
import type { NovelCover, NovelDetail, NovelShelfItem, NovelVolume } from "@shared/types";

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

/** 当前书是否已在共享书架里（书架页负责展示，本页只保留详情页的加入/移出按钮） */
const shelf = ref<NovelShelfItem[]>([]);

const detail = ref<NovelDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const chapters = ref<{ cid: string; title: string }[]>([]);
const inShelf = computed(() =>
  shelf.value.some((b) => b.aid === selected.value.aid && b.source === "fqapi"),
);

const selftestError = ref("");
const selftestOk = ref<boolean | null>(null);

const homeTab = ref<"recommend" | "rank">("recommend");

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
    // 只需要 aid + source 来判断「当前书是否已在书架」；展示交给共享书架页。
    shelf.value = (await capabilities.novelShelfList()) ?? [];
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
      await capabilities.novelShelfAdd(d.aid, d.title, d.author, d.imgUrl, "fqapi");
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

function switchHomeTab(tab: "recommend" | "rank") {
  homeTab.value = tab;
  if (tab === "rank") void loadRank();
}

onMounted(async () => {
  if (props.openAid) {
    void openDetail({ aid: props.openAid, title: props.openTitle ?? "", imageUrl: "" });
    emit("opened");
  }
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
      <!-- 加载态：M3E 加载指示器 + 文案，与其它在线源的 .state 结构保持一致 -->
      <div v-else-if="detailLoading" class="state">
        <m3e-loading-indicator class="lm-loading" />
        加载中……
      </div>

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
        <div v-if="searchResults.length" class="lm-novel-grid">
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
        <!-- 搜索同样属于加载态，补上指示器（搜索栏只禁用按钮，不显示动画） -->
        <div v-if="searching" class="state">
          <m3e-loading-indicator class="lm-loading" />
          搜索中……
        </div>
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
          </m3e-button-group>
        </div>

        <!-- 推荐 -->
        <div v-if="homeTab === 'recommend'">
          <p v-if="feedError" class="error">{{ feedError }}</p>
          <div v-if="feedLoading" class="state">
            <m3e-loading-indicator class="lm-loading" />
            加载推荐……
          </div>
          <section v-for="sec in feedSections" :key="sec.title" class="feed-section">
            <h4 class="section-title">{{ sec.title }}</h4>
            <div class="lm-novel-grid">
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
          <div v-if="rankLoading" class="state">
            <m3e-loading-indicator class="lm-loading" />
            加载排行榜……
          </div>
          <template v-else-if="rankBooks.length">
            <h4 class="section-title">{{ rankTitle }}</h4>
            <div class="lm-novel-grid">
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

/* 书籍卡片网格统一走全局 .lm-novel-grid（src/tokens/theme.css），此处不再重复定义 */
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
