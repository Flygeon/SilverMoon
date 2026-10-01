<script setup lang="ts">
/**
 * 在线 B 站（视频页的第三个子选项卡）。
 *
 * 结构对齐参考项目 PiliPlus 的首页 + 账号体系，按桌面端范式落地：
 * - 内层三个分段：推荐流 / 搜索 / 我的（登录、账号信息）。
 * - 点击卡片进入视频详情浮层（BilibiliVideoView），解析 playurl 后用 ArtPlayer 播放。
 * - 全部状态在 `stores/bilibili`，因此切到「本地 / 动漫」再回来不会丢。
 */
import { computed, onActivated, onMounted, onBeforeUnmount, ref, watch } from "vue";
import SegmentedTabs from "@/components/SegmentedTabs.vue";
import BilibiliCard from "@/components/BilibiliCard.vue";
import BilibiliVideoView from "@/components/BilibiliVideoView.vue";
import BilibiliUserView from "@/components/BilibiliUserView.vue";
import BilibiliMinePanel from "@/components/BilibiliMinePanel.vue";
import BilibiliSearchHistory from "@/components/BilibiliSearchHistory.vue";
import EmptyState from "@/components/EmptyState.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import type { BiliVideo } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

type InnerTab = "feed" | "search" | "mine";
const innerTab = ref<InnerTab>("feed");
const innerTabs = computed(() => [
  { value: "feed" as InnerTab, label: t("bili.feed"), icon: "smart_display" },
  { value: "search" as InnerTab, label: t("bili.search"), icon: "search" },
  { value: "mine" as InnerTab, label: t("bili.mine"), icon: "account_circle" },
]);

// ---------------------------------------------------------------- 推荐流
const feedSentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

/** 重新 observe 一次，强制触发回调（IntersectionObserver 只在相交状态「变化」时回调）。 */
function reobserve(): void {
  const el = feedSentinel.value;
  if (!observer || !el) return;
  observer.unobserve(el);
  observer.observe(el);
}

async function maybeLoadMore(): Promise<void> {
  if (bili.feedStatus === "loading" || bili.feedLoadingMore) return;
  await bili.loadMoreFeed();
  // 一页可能不足以把哨兵推出视口，重新 observe 决定是否继续
  reobserve();
}

function attachObserver(): void {
  observer?.disconnect();
  if (!feedSentinel.value || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void maybeLoadMore();
    },
    { rootMargin: "600px" },
  );
  observer.observe(feedSentinel.value);
}

// ---------------------------------------------------------------- 搜索
const searchInput = ref("");
function submitSearch(): void {
  void bili.search(searchInput.value);
}

/** 点搜索历史里的词：回填输入框并直接搜。 */
function pickHistory(word: string): void {
  searchInput.value = word;
  void bili.search(word);
}

// ---------------------------------------------------------------- 登录弹窗
const loginOpen = ref(false);
const qrImage = ref("");
let pollTimer: number | null = null;
/** 轮询互斥：2s 定时器与切回前台补一次可能撞在一起 */
let polling = false;

watch(
  () => bili.qrContent,
  async (url) => {
    if (!url) {
      qrImage.value = "";
      return;
    }
    try {
      // 动态 import：qrcode 只在打开登录弹窗时才需要，不拖进视频页的常驻包
      const { default: QRCode } = await import("qrcode");
      qrImage.value = await QRCode.toDataURL(url, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
      });
    } catch {
      qrImage.value = "";
    }
  },
);

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function tick(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const done = await bili.pollQr();
    if (done) {
      stopPolling();
      if (bili.account.isLogin) loginOpen.value = false;
    }
  } finally {
    polling = false;
  }
}

async function openLogin(): Promise<void> {
  loginOpen.value = true;
  bili.resetQr();
  await bili.startQr();
  if (!bili.qrContent) return;
  stopPolling();
  pollTimer = window.setInterval(() => void tick(), 2000);
}

async function refreshQr(): Promise<void> {
  bili.resetQr();
  qrImage.value = "";
  await bili.startQr();
}

function closeLogin(): void {
  stopPolling();
  loginOpen.value = false;
  bili.resetQr();
}

// ---------------------------------------------------------------- 生命周期
onMounted(() => {
  attachObserver();
  if (!bili.feed.length) void bili.loadFeed(true);
  if (!bili.accountLoaded) void bili.loadAccount();
  void bili.loadSearchHistory();
});

onActivated(() => {
  if (!bili.feed.length && bili.feedStatus !== "loading") void bili.loadFeed(true);
  if (!bili.accountLoaded) void bili.loadAccount();
  void bili.loadSearchHistory();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  stopPolling();
});

watch(feedSentinel, () => attachObserver());

watch(
  () => bili.notice,
  (msg) => {
    if (!msg) return;
    window.setTimeout(() => bili.clearNotice(), 2600);
  },
);

// ---------------------------------------------------------------- 交互
function openVideo(video: BiliVideo): void {
  void bili.openVideo(video);
}

const feedBusy = computed(() => bili.feedStatus === "loading");
</script>

<template>
  <div class="bili-root">
    <SegmentedTabs v-model="innerTab" :tabs="innerTabs">
      <!-- ============================ 推荐 ============================ -->
      <template v-if="innerTab === 'feed'">
        <div class="toolbar">
          <m3e-button
            variant="tonal"
            size="small"
            :disabled="feedBusy"
            @click="bili.loadFeed(true)"
          >
            <span slot="icon" class="material-symbols-outlined">refresh</span>
            {{ t("bili.refresh") }}
          </m3e-button>
        </div>

        <div v-if="bili.feed.length" class="grid">
          <BilibiliCard v-for="v in bili.feed" :key="v.bvid + v.aid" :video="v" @open="openVideo" />
        </div>

        <div v-if="bili.feed.length" ref="feedSentinel" class="sentinel">
          <m3e-loading-indicator v-if="bili.feedLoadingMore" class="lm-loading" />
        </div>

        <div v-else-if="feedBusy" class="loading-block">
          <m3e-loading-indicator class="lm-loading" />
          <span>{{ t("bili.loading") }}</span>
        </div>

        <EmptyState
          v-else-if="bili.feedStatus === 'error'"
          variant="error"
          :title="t('bili.feedFailed')"
          :description="bili.feedError"
          :action-label="t('bili.retry')"
          @action="bili.loadFeed(true)"
        />

        <EmptyState
          v-else
          icon="smart_display"
          :title="t('bili.emptyFeed')"
          :description="t('bili.emptyFeedHint')"
          :action-label="t('bili.retry')"
          @action="bili.loadFeed(true)"
        />
      </template>

      <!-- ============================ 搜索 ============================ -->
      <template v-else-if="innerTab === 'search'">
        <div class="toolbar search-bar">
          <m3e-form-field class="search-field" variant="filled">
            <input
              v-model="searchInput"
              type="search"
              :placeholder="t('bili.searchPlaceholder')"
              spellcheck="false"
              @keydown.enter.prevent="submitSearch"
            />
          </m3e-form-field>
          <m3e-button variant="filled" size="small" @click="submitSearch">
            <span slot="icon" class="material-symbols-outlined">search</span>
            {{ t("bili.searchBtn") }}
          </m3e-button>
        </div>

        <!-- 搜索历史：只在有记录时出现 -->
        <BilibiliSearchHistory @pick="pickHistory" />

        <div v-if="bili.results.length" class="grid">
          <BilibiliCard
            v-for="v in bili.results"
            :key="v.bvid + v.aid"
            :video="v"
            @open="openVideo"
          />
        </div>

        <div v-if="bili.results.length" class="more-row">
          <m3e-button
            v-if="!bili.searchEnd"
            variant="tonal"
            size="small"
            :disabled="bili.searchLoadingMore"
            @click="bili.loadMoreSearch()"
          >
            <span slot="icon" class="material-symbols-outlined">expand_more</span>
            {{ bili.searchLoadingMore ? t("bili.loading") : t("bili.loadMore") }}
          </m3e-button>
        </div>

        <div v-else-if="bili.searchStatus === 'loading'" class="loading-block">
          <m3e-loading-indicator class="lm-loading" />
          <span>{{ t("bili.searching") }}</span>
        </div>

        <EmptyState
          v-else-if="bili.searchStatus === 'error' || bili.searchError"
          variant="search"
          :title="bili.searchError || t('bili.searchFailed')"
          :description="bili.keyword ? `「${bili.keyword}」` : ''"
        />

        <EmptyState
          v-else
          icon="search"
          :title="t('bili.searchEmpty')"
          :description="t('bili.searchEmptyHint')"
        />
      </template>

      <!-- ============================= 我的 ============================= -->
      <template v-else>
        <BilibiliMinePanel @open="openVideo" @login="openLogin" />
      </template>
    </SegmentedTabs>

    <!-- 登录弹窗 -->
    <Transition name="bili-modal">
      <div v-if="loginOpen" class="modal-scrim" @click.self="closeLogin">
        <div class="modal">
          <h3>{{ t("bili.loginTitle") }}</h3>
          <p class="hint">{{ t("bili.loginTip") }}</p>
          <div class="qr-wrap">
            <img v-if="qrImage" :src="qrImage" alt="QR" class="qr-img" />
            <div v-else class="qr-loading">
              <m3e-loading-indicator class="lm-loading" />
              {{ bili.startingQr ? t("bili.loading") : bili.loginError || t("bili.qrFailed") }}
            </div>
          </div>
          <p class="qr-status">{{ bili.qrStatusText }}</p>
          <p v-if="bili.loginError" class="qr-error">{{ bili.loginError }}</p>
          <div class="modal-actions">
            <m3e-button variant="text" size="small" @click="refreshQr">
              <span slot="icon" class="material-symbols-outlined">refresh</span>
              {{ t("bili.refreshQr") }}
            </m3e-button>
            <m3e-button variant="filled" size="small" @click="closeLogin">
              {{ t("bili.done") }}
            </m3e-button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 视频详情浮层（自行通过 store 关闭，父级只负责挂载） -->
    <BilibiliVideoView v-if="bili.current" :key="bili.current.bvid" @login="openLogin" />

    <!-- UP 主主页浮层：从详情页点 UP 头像进入 -->
    <BilibiliUserView v-if="bili.userMid" :key="bili.userMid" />

    <!-- 全局提示 -->
    <Transition name="bili-toast">
      <div v-if="bili.notice" class="bili-toast">
        <span class="material-symbols-outlined">info</span>
        {{ bili.notice }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.bili-root {
  min-height: 100%;
  position: relative;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-bottom: 14px;
}

.search-bar {
  justify-content: flex-start;
}
.search-field {
  flex: 1;
  min-width: 0;
  --m3e-form-field-container-height: 40px;
}
.search-field input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  outline: none;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 20px 16px;
}

.sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
}

.more-row {
  display: flex;
  justify-content: center;
  padding: 18px 0;
}

.loading-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 240px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
}

/* 账号卡已迁到 BilibiliMinePanel，「我的」页不再需要这组样式；仅保留登录弹窗用到的 .hint */
.hint {
  margin: 0;
  max-width: 420px;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- 登录弹窗 ---- */
.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 260;
  display: grid;
  place-items: center;
  background: var(--md-sys-color-scrim);
}
.modal {
  width: min(420px, 88vw);
  padding: 22px 24px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-elevation-3);
  text-align: center;
}
.modal h3 {
  margin: 0 0 6px;
  font-size: var(--md-sys-typescale-title-medium-size);
}
.qr-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 14px 0 8px;
}
.qr-img {
  width: 220px;
  height: 220px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: #fff;
  padding: 8px;
}
.qr-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 220px;
  height: 220px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}
.qr-status {
  margin: 6px 0 14px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
/* 授权后账号信息拉取失败时必须显式告知，否则弹窗会停在「登录成功」上不动 */
.qr-error {
  margin: -8px 0 14px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.bili-modal-enter-active,
.bili-modal-leave-active {
  transition: opacity 180ms var(--md-sys-motion-spring-effects-fast);
}
.bili-modal-enter-from,
.bili-modal-leave-to {
  opacity: 0;
}

/* ---- 提示 ---- */
.bili-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 300;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  box-shadow: var(--md-elevation-3);
  font-size: var(--md-sys-typescale-body-small-size);
}
.bili-toast .material-symbols-outlined {
  font-size: 17px;
}
.bili-toast-enter-active,
.bili-toast-leave-active {
  transition: opacity 200ms var(--md-sys-motion-spring-effects-fast);
}
.bili-toast-enter-from,
.bili-toast-leave-to {
  opacity: 0;
}
</style>
