<script setup lang="ts">
/**
 * B 站「动态」子页（视频页 B 站分段 → 动态）。
 *
 * - 数据全在 store（dynItems / dynStatus / …），所以切走再切回不会重拉、不会丢滚动位置。
 * - 顶部是发布框：未登录时换成「去登录」提示（父级负责打开登录弹窗）。
 * - 滚动到底自动翻页：沿用推荐流那套 IntersectionObserver + 重新 observe 的写法
 *   （Observer 只在相交状态「变化」时回调，翻一页后哨兵可能仍在视口里）。
 */
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EmptyState from "@/components/EmptyState.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { biliCount, biliPubdate } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "login"): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

// ---------------------------------------------------------------- 发布
const draft = ref("");
const maxLen = 1000;
const canPublish = computed(
  () => !!draft.value.trim() && !bili.dynPublishing && bili.account.isLogin,
);

async function publish(): Promise<void> {
  if (!canPublish.value) return;
  const ok = await bili.publishDynamic(draft.value);
  if (ok) draft.value = "";
}

// ---------------------------------------------------------------- 滚动翻页
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

/** 重新 observe 一次，强制触发回调（IntersectionObserver 只在相交状态「变化」时回调）。 */
function reobserve(): void {
  const el = sentinel.value;
  if (!observer || !el) return;
  observer.unobserve(el);
  observer.observe(el);
}

async function maybeLoadMore(): Promise<void> {
  // 已到底必须直接返回：否则下面的 reobserve() 会再触发一次回调，形成空转死循环
  if (bili.dynEnd || bili.dynStatus === "loading" || bili.dynLoadingMore) return;
  await bili.loadMoreDynamics();
  // 一页可能不足以把哨兵推出视口，重新 observe 决定是否继续
  reobserve();
}

function attachObserver(): void {
  observer?.disconnect();
  if (!sentinel.value || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void maybeLoadMore();
    },
    { rootMargin: "600px" },
  );
  observer.observe(sentinel.value);
}

onMounted(() => {
  if (!bili.dynItems.length) void bili.loadDynamics(true);
  attachObserver();
});

onActivated(() => {
  // KeepAlive 复用时不会重新 onMounted：这里补一次拉取 + 重挂哨兵
  if (!bili.dynItems.length && bili.dynStatus !== "loading") void bili.loadDynamics(true);
  attachObserver();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

watch(sentinel, () => attachObserver());

// ---------------------------------------------------------------- 外链
/** 图片看大图：直接交给系统默认浏览器，不占应用内的查看器。 */
function openImage(url: string): void {
  if (url) window.open(url, "_blank");
}

/** 视频稿件动态：打开 B 站对应稿件页。 */
function openVideoLink(bvid: string): void {
  if (bvid) window.open(`https://www.bilibili.com/video/${bvid}`, "_blank");
}

/** 时间戳文案（相对时间，复用 utils 的统一实现）。 */
function postedAt(seconds: number): string {
  return biliPubdate(seconds);
}

// ---------------------------------------------------------------- 发布动态反诈
/**
 * 发布 5s 后 store 会把「动态是否公开可见」的复查结果写进 antifraudResult。
 *
 * 评论区那侧只为「发评反诈」弹窗；动态反诈的结果落在这里就地提示。加 !bili.current
 * 是为了互斥：视频浮层没关时评论组件正挂在那儿，两边同时监听结果会弹两次。
 */
const FRAUD_TITLE: Record<string, string> = {
  ok: "bili.antifraudOk",
  hidden: "bili.antifraudHidden",
  shadow: "bili.antifraudShadow",
  suspicious: "bili.antifraudSuspicious",
  failed: "bili.antifraudFailed",
};
const dynFraud = computed(() => (bili.current ? null : bili.antifraudResult));
const dynFraudTitle = computed(() =>
  dynFraud.value ? t(FRAUD_TITLE[dynFraud.value.kind] ?? "bili.antifraudFailed") : "",
);
const dynFraudOk = computed(() => dynFraud.value?.kind === "ok");

/** 申诉入口：与评论区反诈共用同一个官方评论申诉页（动态申诉同样走它）。 */
async function appeal(): Promise<void> {
  const url = "https://www.bilibili.com/h5/comment/appeal";
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // 剪贴板不可用不该拦住跳转
  }
  window.open(url, "_blank");
}
</script>

<template>
  <div class="dynamics">
    <!-- 发布结果 / 错误提示：由 store 定时清空，这里只负责显示 -->
    <Transition name="dyn-notice">
      <div v-if="bili.dynNotice" class="notice">
        <span class="material-symbols-outlined">info</span>
        {{ bili.dynNotice }}
      </div>
    </Transition>

    <!-- 发布框：未登录时换成登录引导 -->
    <div v-if="!bili.account.isLogin" class="login-bar">
      <span class="material-symbols-outlined">info</span>
      <span>{{ t("bili.dynNeedLogin") }}</span>
      <m3e-button variant="text" size="small" @click="emit('login')">
        {{ t("bili.scanLogin") }}
      </m3e-button>
    </div>

    <div v-else class="composer">
      <div class="row">
        <span class="avatar">
          <img
            v-if="bili.account.face"
            :src="bili.account.face"
            alt=""
            referrerpolicy="no-referrer"
          />
          <span v-else class="material-symbols-outlined">account_circle</span>
        </span>
        <m3e-form-field class="field" variant="filled">
          <textarea
            v-model="draft"
            :maxlength="maxLen"
            :placeholder="t('bili.dynPublishPlaceholder')"
            rows="2"
            @keydown.ctrl.enter.prevent="publish"
            @keydown.meta.enter.prevent="publish"
          />
        </m3e-form-field>
      </div>
      <div class="composer-actions">
        <span class="count tabular-nums">{{ draft.length }} / {{ maxLen }}</span>
        <m3e-button variant="filled" size="small" :disabled="!canPublish" @click="publish">
          <span slot="icon" class="material-symbols-outlined">send</span>
          {{ bili.dynPublishing ? t("bili.dynPublishing") : t("bili.dynPublish") }}
        </m3e-button>
      </div>
    </div>

    <!-- 发布动态反诈结果：发布 5s 后由 store 异步写入 -->
    <div v-if="dynFraud" class="fraud-card" :class="{ ok: dynFraudOk }">
      <span class="material-symbols-outlined">{{
        dynFraudOk ? "check_circle" : "visibility_off"
      }}</span>
      <div class="fraud-body">
        <span class="fraud-title">{{ dynFraudTitle }}</span>
        <span v-if="dynFraud.detail" class="fraud-detail">{{ dynFraud.detail }}</span>
      </div>
      <m3e-button v-if="!dynFraudOk" variant="text" size="small" @click="appeal">
        {{ t("bili.antifraudAppeal") }}
      </m3e-button>
      <m3e-button variant="text" size="small" @click="bili.closeAntifraud()">
        {{ t("bili.antifraudClose") }}
      </m3e-button>
    </div>

    <!-- 带货动态被过滤掉时必须告知，否则用户只会以为动态流变少了 -->
    <p v-if="bili.dynBlockedCount > 0" class="blocked">
      <span class="material-symbols-outlined">visibility_off</span>
      <span class="blocked-main">{{
        t("bili.dynBlocked").replace("{n}", String(bili.dynBlockedCount))
      }}</span>
      <span class="blocked-sub">{{ t("bili.dynBlockedHint") }}</span>
    </p>

    <ul v-if="bili.dynItems.length" class="list">
      <li v-for="d in bili.dynItems" :key="d.id || String(d.timestamp)" class="item">
        <span class="avatar">
          <img
            v-if="d.author.face"
            :src="d.author.face"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <span v-else class="material-symbols-outlined">person</span>
        </span>

        <div class="body">
          <div class="meta">
            <span class="name" :title="d.author.name">{{ d.author.name }}</span>
            <span v-if="d.timestamp" class="time">{{ postedAt(d.timestamp) }}</span>
            <span v-if="d.goods" class="badge goods">
              <span class="material-symbols-outlined">local_mall</span>{{ t("bili.dynGoods") }}
            </span>
          </div>

          <p v-if="d.text" class="text">{{ d.text }}</p>

          <!-- 图片网格：最多 9 张，点击用系统浏览器看原图 -->
          <div v-if="d.images.length" class="images">
            <button
              v-for="(img, i) in d.images.slice(0, 9)"
              :key="img + i"
              class="image"
              type="button"
              :title="t('bili.dynImages')"
              @click="openImage(img)"
            >
              <img :src="img" alt="" loading="lazy" referrerpolicy="no-referrer" />
            </button>
            <span v-if="d.images.length > 9" class="image-more tabular-nums"
              >+{{ d.images.length - 9 }}</span
            >
          </div>

          <!-- 视频稿件动态 -->
          <button v-if="d.bvid" class="video-card" type="button" @click="openVideoLink(d.bvid)">
            <span class="material-symbols-outlined">movie</span>
            <span class="video-title">{{ d.title || d.bvid }}</span>
            <span class="video-bvid tabular-nums">{{ d.bvid }}</span>
          </button>

          <!-- 带货卡片：即使没被屏蔽（开关关着）也要明确标出来 -->
          <div v-if="d.goods && (d.goodsTitle || d.goodsCover)" class="goods-card">
            <img
              v-if="d.goodsCover"
              :src="d.goodsCover"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <div class="goods-body">
              <span class="goods-title">{{ d.goodsTitle || t("bili.dynGoods") }}</span>
              <button v-if="d.goodsUrl" class="link" type="button" @click="openImage(d.goodsUrl)">
                {{ d.goodsUrl }}
              </button>
            </div>
          </div>

          <!-- 转发的原动态 -->
          <div v-if="d.orig" class="orig">
            <div class="orig-head">
              <span class="material-symbols-outlined">repeat</span>
              {{ t("bili.dynRepost") }} · {{ d.orig.name || t("bili.dynOriginal") }}
            </div>
            <p v-if="d.orig.text" class="orig-text">{{ d.orig.text }}</p>
            <div v-if="d.orig.images.length" class="images small">
              <button
                v-for="(img, i) in d.orig.images.slice(0, 9)"
                :key="img + i"
                class="image"
                type="button"
                :title="t('bili.dynImages')"
                @click="openImage(img)"
              >
                <img :src="img" alt="" loading="lazy" referrerpolicy="no-referrer" />
              </button>
            </div>
          </div>

          <div class="stats">
            <span class="stat" :title="t('bili.dynLikeCount')">
              <span class="material-symbols-outlined">thumb_up</span>
              <span class="tabular-nums">{{ biliCount(d.stats.like) }}</span>
            </span>
            <span class="stat" :title="t('bili.dynCommentCount')">
              <span class="material-symbols-outlined">forum</span>
              <span class="tabular-nums">{{ biliCount(d.stats.comment) }}</span>
            </span>
            <span class="stat" :title="t('bili.dynForwardCount')">
              <span class="material-symbols-outlined">repeat</span>
              <span class="tabular-nums">{{ biliCount(d.stats.forward) }}</span>
            </span>
          </div>
        </div>
      </li>
    </ul>

    <div v-if="bili.dynItems.length" ref="sentinel" class="sentinel">
      <m3e-loading-indicator v-if="bili.dynLoadingMore" class="lm-loading" />
      <span v-else-if="bili.dynEnd" class="end">{{ t("bili.noMore") }}</span>
    </div>

    <div v-else-if="bili.dynStatus === 'loading'" class="state">
      <m3e-loading-indicator class="lm-loading" />
      <span>{{ t("bili.dynLoading") }}</span>
    </div>

    <EmptyState
      v-else-if="bili.dynStatus === 'error'"
      variant="error"
      :title="t('bili.dynFeedFailed')"
      :description="bili.dynError"
      :action-label="t('bili.retry')"
      @action="bili.loadDynamics(true)"
    />

    <EmptyState
      v-else
      icon="article"
      :title="t('bili.dynEmpty')"
      :description="t('bili.dynEmptyHint')"
      :action-label="t('bili.retry')"
      @action="bili.loadDynamics(true)"
    />
  </div>
</template>

<style scoped>
.dynamics {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.notice .material-symbols-outlined {
  font-size: 17px;
}
.dyn-notice-enter-active,
.dyn-notice-leave-active {
  transition: opacity 200ms var(--md-sys-motion-spring-effects-fast);
}
.dyn-notice-enter-from,
.dyn-notice-leave-to {
  opacity: 0;
}

.login-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.login-bar .material-symbols-outlined {
  font-size: 18px;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar .material-symbols-outlined {
  font-size: 22px;
}

.field {
  flex: 1;
  min-width: 0;
  --m3e-form-field-container-height: auto;
}
.field textarea {
  width: 100%;
  min-height: 44px;
  max-height: 160px;
  padding: 6px 0;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.5;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.count {
  font-size: 11.5px;
  color: var(--md-sys-color-outline);
}

/* ---- 发布动态反诈结果 ---- */
.fraud-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.fraud-card.ok {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.fraud-card > .material-symbols-outlined {
  font-size: 18px;
}
.fraud-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.fraud-title {
  font-weight: 500;
}
.fraud-detail {
  opacity: 0.85;
  word-break: break-word;
}

.blocked {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 9px 14px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.blocked .material-symbols-outlined {
  font-size: 17px;
}
.blocked-main {
  font-weight: 500;
}
.blocked-sub {
  opacity: 0.8;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  gap: 10px;
  padding: 14px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}
.body {
  min-width: 0;
  flex: 1;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--md-sys-typescale-body-small-size);
}
.name {
  font-weight: 500;
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.time {
  font-size: 11.5px;
  color: var(--md-sys-color-outline);
}
.badge.goods {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: 10px;
  line-height: 15px;
  font-weight: 500;
}
.badge.goods .material-symbols-outlined {
  font-size: 11px;
}

.text {
  margin: 6px 0 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 6px;
  margin-top: 8px;
  max-width: 480px;
}
.images.small {
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  max-width: 360px;
}
.image {
  position: relative;
  aspect-ratio: 1;
  padding: 0;
  border: none;
  border-radius: var(--lm-shape-card-inner);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-highest);
  cursor: pointer;
}
.image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.image:hover img {
  filter: brightness(1.08);
}
.image-more {
  align-self: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.video-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 8px;
  padding: 9px 12px;
  border: none;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  text-align: left;
  cursor: pointer;
}
.video-card:hover {
  background: var(--md-sys-color-surface-container-high);
}
.video-card .material-symbols-outlined {
  font-size: 17px;
  color: var(--md-sys-color-primary);
}
.video-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.video-bvid {
  flex: none;
  font-size: 11px;
  color: var(--md-sys-color-outline);
}

.goods-card {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}
.goods-card img {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: var(--md-sys-shape-corner-small);
  object-fit: cover;
}
.goods-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.goods-title {
  font-size: var(--md-sys-typescale-body-small-size);
  font-weight: 500;
}
.link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--md-sys-color-primary);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  word-break: break-all;
  cursor: pointer;
}

.orig {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
}
.orig-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--md-sys-color-on-surface-variant);
}
.orig-head .material-symbols-outlined {
  font-size: 14px;
}
.orig-text {
  margin: 6px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--md-sys-color-on-surface-variant);
}

.stats {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--md-sys-color-on-surface-variant);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.stat .material-symbols-outlined {
  font-size: 14px;
}

.sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
}
.end {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-outline);
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 220px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
}
</style>
