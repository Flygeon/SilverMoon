<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { novelRankCached, novelRecommendCached } from "@/utils/novelCache";
import { translate } from "@shared/i18n";
import NovelCard from "@/components/NovelCard.vue";
import NovelSearchBar from "@/components/NovelSearchBar.vue";
import NovelDetailPanel from "@/components/NovelDetailPanel.vue";
import BookReader from "@/components/BookReader.vue";
import { openWenku8Login } from "@/novel/wenku8Login";
import { reloginRequested, clearRelogin } from "@/novel/wenku8Auth";
import type { NovelCover, NovelRecommendBlock, Wenku8LoginStatus } from "@shared/types";

/**
 * 从共享书架跳进来时，直接打开指定书目的详情。
 *
 * 书架页拿到 `source=wenku8` 的条目后把 BooksView 的 activeView 切到本组件，
 * 并把 aid/title 通过这两个 prop 传进来；本组件挂载时打开详情并通知父级清空，
 * 避免下次重新挂载时又自动打开同一本。
 */
const props = defineProps<{ openAid?: string; openTitle?: string }>();
const emit = defineEmits<{ (e: "opened"): void }>();

const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const view = ref<"home" | "detail" | "reader">("home");
const selected = ref<{ aid: string; title: string }>({ aid: "", title: "" });
const readerInit = ref<{ cid?: string; chapterTitle?: string }>({});

const searchQuery = ref("");
const searching = ref(false);
const searchResults = ref<NovelCover[]>([]);
const searchError = ref("");

const rankSort = ref("allvisit");
const rankResults = ref<NovelCover[]>([]);
const rankLoading = ref(false);
const homeError = ref("");

const recommend = ref<NovelRecommendBlock[]>([]);

// ---- Wenku8 登录态 ----
const loginStatus = ref<Wenku8LoginStatus>({ loggedIn: false });
const loggingIn = ref(false);
const loginBanner = ref("");

async function refreshLoginStatus() {
  try {
    loginStatus.value = await capabilities.wenku8LoginStatus();
  } catch {
    loginStatus.value = { loggedIn: false };
  }
}

async function doLogin() {
  loggingIn.value = true;
  loginBanner.value = "";
  clearRelogin();
  try {
    const status = await openWenku8Login();
    loginStatus.value = status;
  } catch (e) {
    loginBanner.value = e instanceof Error ? e.message : String(e);
  } finally {
    loggingIn.value = false;
  }
}

async function doLogout() {
  try {
    await capabilities.wenku8Logout();
    loginStatus.value = { loggedIn: false };
  } catch (e) {
    console.warn("[Novel] 退出登录失败:", e);
  }
}

async function loadRank() {
  rankLoading.value = true;
  try {
    rankResults.value = await novelRankCached(
      settings.wenku8Node,
      settings.novelCharset,
      rankSort.value,
      1,
    );
    homeError.value = "";
  } catch (e) {
    console.warn("[Novel] 排行榜加载失败:", e);
    rankResults.value = [];
    homeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    rankLoading.value = false;
  }
}

async function loadRecommend() {
  try {
    recommend.value = await novelRecommendCached(settings.wenku8Node, settings.novelCharset);
  } catch (e) {
    console.warn("[Novel] 推荐加载失败:", e);
    recommend.value = [];
  }
}

async function loadHome() {
  homeError.value = "";
  await Promise.all([loadRank(), loadRecommend()]);
}

/** 适配共享搜索栏：它回传关键词，本页的 doSearch 读的是 searchQuery ref。 */
function doSearchWith(keyword: string) {
  searchQuery.value = keyword;
  void doSearch();
}

async function doSearch() {
  void capabilities
    .appLog(`[novel-online] doSearch 被触发 q=${JSON.stringify(searchQuery.value)}`)
    .catch(() => {});
  const q = searchQuery.value.trim();
  if (!q) {
    void capabilities.appLog(`[novel-online] doSearch 空查询，忽略`).catch(() => {});
    return;
  }
  searching.value = true;
  searchError.value = "";
  try {
    searchResults.value = await capabilities.novelSearch(
      settings.wenku8Node,
      settings.novelCharset,
      q,
      1,
    );
    void capabilities
      .appLog(`[novel-online] doSearch OK results=${searchResults.value.length}`)
      .catch(() => {});
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : String(e);
    searchResults.value = [];
    void capabilities.appLog(`[novel-online] doSearch 异常: ${searchError.value}`).catch(() => {});
  } finally {
    searching.value = false;
  }
}

function openNovel(item: NovelCover) {
  selected.value = { aid: item.aid, title: item.title };
  view.value = "detail";
}

function openReader(cid: string, chapterTitle: string) {
  void capabilities.appLog(
    `[novel-online] openReader 被调用 aid=${selected.value.aid} cid=${cid} title=${chapterTitle} 当前 view=${view.value}`,
  );
  readerInit.value = { cid, chapterTitle };
  view.value = "reader";
  void capabilities.appLog(`[novel-online] view 已设为 reader=${view.value === "reader"}`);
}

function onReaderClose() {
  view.value = "detail";
}

function onDetailBack() {
  view.value = "home";
}

function pickRank(sort: string) {
  rankSort.value = sort;
  void loadRank();
}

onMounted(() => {
  void refreshLoginStatus();
  void loadHome();
  if (props.openAid) {
    openNovel({ aid: props.openAid, title: props.openTitle ?? "", imageUrl: "" });
    emit("opened");
  }
});
</script>

<template>
  <div class="novel-online">
    <!-- 阅读器（Teleport 到 body 避免 NovelOnlineView 的 transform 动画破坏 fixed 定位） -->
    <Teleport v-if="view === 'reader'" to="body">
      <BookReader
        :novel-source="{
          aid: selected.aid,
          title: selected.title,
          initialCid: readerInit.cid,
          initialChapterTitle: readerInit.chapterTitle,
        }"
        @close="onReaderClose"
      />
    </Teleport>

    <!-- 详情 -->
    <NovelDetailPanel
      v-else-if="view === 'detail'"
      :aid="selected.aid"
      :initial-title="selected.title"
      source="wenku8"
      @back="onDetailBack"
      @read="openReader"
    />

    <!-- 主页 -->
    <template v-else>
      <!-- Wenku8 登录态提示条：仅未登录时显示；已登录不显示任何登录条 -->
      <div v-if="!loginStatus.loggedIn" class="login-bar login-bar--off">
        <span class="material-symbols-outlined">account_circle</span>
        <span class="login-text">{{ t("novel.loginHint") }}</span>
        <m3e-button variant="filled" size="small" :disabled="loggingIn" @click="doLogin">
          <span v-if="loggingIn" slot="icon" class="material-symbols-outlined spin"
            >progress_activity</span
          >
          <span v-else slot="icon" class="material-symbols-outlined">login</span>
          {{ loggingIn ? t("novel.loggingIn") : t("novel.login") }}
        </m3e-button>
      </div>
      <p v-if="loginBanner" class="login-banner">{{ loginBanner }}</p>
      <div v-if="reloginRequested" class="login-bar login-bar--off">
        <span class="material-symbols-outlined">error</span>
        <span class="login-text">{{ t("novel.reloginHint") }}</span>
        <m3e-button variant="filled" size="small" :disabled="loggingIn" @click="doLogin">
          <span slot="icon" class="material-symbols-outlined">login</span>
          {{ t("novel.relogin") }}
        </m3e-button>
      </div>

      <!-- 搜索：与另外两个在线源共用同一个组件，保证视觉一致 -->
      <NovelSearchBar
        :placeholder="t('novel.searchPlaceholder')"
        :label="t('novel.search')"
        :busy="searching"
        @search="doSearchWith"
      />
      <p v-if="searchError" class="error">{{ searchError }}</p>
      <div v-if="homeError" class="home-error">
        <span>{{ homeError }}</span>
        <m3e-button variant="text" size="small" @click="loadHome">
          <span slot="icon" class="material-symbols-outlined">refresh</span>
          {{ t("novel.retry") }}
        </m3e-button>
      </div>
      <div v-if="searchResults.length" class="search-results">
        <h3 class="section-title">{{ t("novel.searchResults") }}</h3>
        <div class="lm-novel-grid">
          <NovelCard v-for="n in searchResults" :key="n.aid" :item="n" @open="openNovel(n)" />
        </div>
      </div>

      <!-- 排行榜 -->
      <section class="section">
        <div class="section-head">
          <h3 class="section-title">{{ t("novel.rank") }}</h3>
          <div class="rank-tabs">
            <m3e-filter-chip
              v-for="s in ['allvisit', 'postdate', 'goodnum'] as const"
              :key="s"
              class="chip"
              :selected="rankSort === s"
              @click.prevent="pickRank(s)"
            >
              {{ t("novel.rank_" + s) }}
            </m3e-filter-chip>
          </div>
        </div>
        <div v-if="rankLoading" class="state">
          <m3e-loading-indicator class="lm-loading" />
          {{ t("novel.loading") }}
        </div>
        <div v-else class="lm-novel-grid">
          <NovelCard v-for="n in rankResults" :key="n.aid" :item="n" @open="openNovel(n)" />
        </div>
      </section>

      <!-- 推荐 -->
      <section v-for="(block, i) in recommend" :key="i" class="section">
        <h3 class="section-title">{{ block.title }}</h3>
        <div class="lm-novel-grid">
          <NovelCard v-for="n in block.novels" :key="n.aid" :item="n" @open="openNovel(n)" />
        </div>
      </section>

      <!-- 空态 -->
      <div
        v-if="
          !rankLoading &&
          !homeError &&
          !searchResults.length &&
          !rankResults.length &&
          !recommend.length
        "
        class="state"
      >
        {{ t("novel.empty") }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.novel-online {
  display: flex;
  flex-direction: column;
  gap: var(--lm-layout-toolbar-content-gap);
  animation: lm-rise 340ms var(--md-sys-motion-easing-emphasized-decelerate) both;
}
.error {
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.home-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.login-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  font-size: var(--md-sys-typescale-body-medium-size);
}
.login-bar .material-symbols-outlined {
  font-size: 22px;
}
.login-bar--off {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.login-bar--on {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}
.login-text {
  flex: 1;
}
.login-banner {
  margin: 0;
  padding: 8px 14px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.spin {
  animation: lm-spin 1s linear infinite;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.section-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 600;
}
.rank-tabs {
  display: flex;
  gap: 6px;
}
/* 书籍卡片网格统一走全局 .lm-novel-grid（src/tokens/theme.css），此处不再重复定义 */
.state {
  padding: 24px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
/* chip 本体交给 m3e-filter-chip / m3e-assist-chip（选中态即 M3 规范：secondary-container 底 +
   on-secondary-container 文字 + 无描边，与改造前 .chip.active 一致）；
   下面把度量对齐改造前的 .chip（含选中时组件会占用 icon 槽展示勾选标记所需的 with-icon 内边距） */
.rank-tabs m3e-filter-chip {
  --m3e-chip-container-height: 30px;
  --m3e-chip-container-shape: var(--md-sys-shape-corner-full);
  --m3e-chip-padding-start: 12px;
  --m3e-chip-padding-end: 12px;
  --m3e-chip-with-icon-padding-start: 12px;
  --m3e-chip-with-icon-padding-end: 12px;
  --m3e-chip-label-text-font-size: var(--md-sys-typescale-label-small-size);
}
</style>
