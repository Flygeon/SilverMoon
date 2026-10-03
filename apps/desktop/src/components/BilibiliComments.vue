<script setup lang="ts">
/**
 * 视频评论区（详情浮层左栏底部）。
 *
 * - 数据：`/x/v2/reply/main` 游标分页（实测无需 WBI、无需登录），排序用上游 `mode`：
 *   3 热门 / 2 最新，切换即重拉。
 * - 楼中楼：首屏直接用上游给的预览（一般 3 条），点「共 N 条回复」再拉
 *   `/x/v2/reply/reply` 的完整列表，可继续「加载更多」。
 * - 展开态就存在 store 的 `subReplies[rpid]` 上（有值即展开），不再另立一套开关。
 */
import { computed, ref, watch } from "vue";
import BilibiliReplyComposer from "@/components/BilibiliReplyComposer.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { BILI_REPLY_HOT, BILI_REPLY_TIME, biliCount, type BiliReply } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "login"): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

/** 评论输入框；点某条评论的「回复」时把目标传下去。 */
const composer = ref<InstanceType<typeof BilibiliReplyComposer> | null>(null);

/** 回复某条一级评论：root 与 parent 都是它自己。 */
function replyTo(r: BiliReply): void {
  composer.value?.replyToComment(r.rpid, r.rpid, r.author.name);
}
/** 回复楼中楼里的某条：root 是所在楼的一级评论，parent 是这条子回复。 */
function replyToSub(root: BiliReply, s: BiliReply): void {
  composer.value?.replyToComment(s.rpid, root.rpid, s.author.name);
}

const sorts = computed(() => [
  { value: BILI_REPLY_HOT, label: t("bili.sortHot") },
  { value: BILI_REPLY_TIME, label: t("bili.sortTime") },
]);

/** 已展开用拉到的完整列表，未展开用上游预览 */
function subList(r: BiliReply): BiliReply[] {
  return bili.subReplies[r.rpid] ?? r.replies;
}
function subExpanded(r: BiliReply): boolean {
  return !!bili.subReplies[r.rpid];
}
function subMore(r: BiliReply): boolean {
  return subExpanded(r) && bili.subEnds[r.rpid] === false;
}

// ---------------------------------------------------------------- 发评反诈
/** 手动「复查」某条一级评论：只查这一条，结果同样落到 antifraudResult。 */
function recheck(r: BiliReply): void {
  void bili.checkReply(r.rpid, "", r.message, true);
}

/** 申诉页地址：B 站官方的评论申诉入口（复制 + 用系统浏览器打开）。 */
const APPEAL_URL = "https://www.bilibili.com/h5/comment/appeal";

/** 反诈弹窗的打开 / 关闭方法（m3e-dialog 没有 v-model，只能拿实例调）。 */
interface M3eDialog extends HTMLElement {
  show(): Promise<void>;
  hide(returnValue?: string): Promise<void>;
}
const fraudDialog = ref<M3eDialog | null>(null);

/** kind → 文案键。failed 只影响标题，detail 里带上游原话。 */
const FRAUD_TITLE: Record<string, string> = {
  ok: "bili.antifraudOk",
  hidden: "bili.antifraudHidden",
  shadow: "bili.antifraudShadow",
  suspicious: "bili.antifraudSuspicious",
  failed: "bili.antifraudFailed",
};

const fraudTitle = computed(() =>
  bili.antifraudResult ? t(FRAUD_TITLE[bili.antifraudResult.kind] ?? "bili.antifraudFailed") : "",
);

/** ok / failed 没什么可申诉的；只有「被折叠 / shadow / 状态可疑」才给申诉入口。 */
const fraudAppealable = computed(() => {
  const kind = bili.antifraudResult?.kind;
  return kind === "hidden" || kind === "shadow" || kind === "suspicious";
});

// 自动复查（发评后 8s 由 store 触发）也要弹窗，所以打开动作挂在结果变化上，
// 而不是绑在某个按钮的 click 上；关闭统一走 store.closeAntifraud()。
watch(
  () => bili.antifraudResult,
  async (r) => {
    if (r) await fraudDialog.value?.show();
    else await fraudDialog.value?.hide();
  },
);

function closeFraud(): void {
  bili.closeAntifraud();
}

/** 关掉后兜底收敛：Esc / 点遮罩同样要清掉结果，否则下次结果不变再也不弹。 */
function onFraudClosed(): void {
  if (bili.antifraudResult) bili.closeAntifraud();
}

/** 复制申诉链接并打开系统浏览器（与分享链接同一套做法）。 */
async function appeal(): Promise<void> {
  try {
    await navigator.clipboard.writeText(APPEAL_URL);
  } catch {
    // 剪贴板不可用（无权限 / 非安全上下文）不该拦住跳转，继续打开即可
  }
  window.open(APPEAL_URL, "_blank");
}
</script>

<template>
  <section class="comments">
    <!-- 评论输入框：未登录时这里显示「去登录」提示 -->
    <BilibiliReplyComposer ref="composer" @login="emit('login')" />

    <!-- 复查进行中：结果要等两次翻页，先给个明确反馈（自动复查尤其需要） -->
    <p v-if="bili.antifraudChecking" class="fraud-checking">
      <m3e-loading-indicator class="lm-loading" />
      {{ t("bili.antifraudChecking") }}
    </p>

    <div class="bar">
      <h3 class="title">
        <span class="material-symbols-outlined">forum</span>
        <span v-if="bili.replyTotal" class="tabular-nums">{{ biliCount(bili.replyTotal) }}</span>
        {{ t("bili.commentUnit") }}
      </h3>
      <div class="sorts">
        <!-- @click.prevent 必需，否则 chip 会自己翻转 selected 而要点两次 -->
        <m3e-filter-chip
          v-for="s in sorts"
          :key="s.value"
          class="sort-chip"
          :selected="bili.replySort === s.value"
          @click.prevent="bili.setReplySort(s.value)"
        >
          {{ s.label }}
        </m3e-filter-chip>
      </div>
    </div>

    <div v-if="bili.replyStatus === 'loading' && !bili.replies.length" class="state">
      <m3e-loading-indicator class="lm-loading" />
      <span>{{ t("bili.loading") }}</span>
    </div>

    <!-- 只在「一条都没加载出来」时才用错误态顶掉列表：
         分页失败若也走这里，已有评论会整块消失，用户以为内容丢了 -->
    <div v-else-if="bili.replyStatus === 'error' && !bili.replies.length" class="state error">
      <span class="material-symbols-outlined">error</span>
      <span>{{ bili.replyError || t("bili.replyFailed") }}</span>
      <button class="link" type="button" @click="bili.loadReplies(true)">
        {{ t("bili.retry") }}
      </button>
    </div>

    <p v-else-if="!bili.replies.length" class="state">{{ t("bili.noComments") }}</p>

    <ul v-else class="list">
      <li v-for="r in bili.replies" :key="r.rpid" class="item">
        <span class="avatar">
          <img
            v-if="r.author.avatar"
            :src="r.author.avatar"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <span v-else class="material-symbols-outlined">person</span>
        </span>

        <div class="body">
          <div class="meta">
            <span class="name" :class="{ vip: r.author.vip }" :title="r.author.name">{{
              r.author.name
            }}</span>
            <span v-if="r.author.level" class="badge lv">Lv{{ r.author.level }}</span>
            <span v-if="r.isUp" class="badge up">UP</span>
            <span v-if="r.isTop" class="badge top">{{ t("bili.pinned") }}</span>
            <span v-if="r.timeDesc" class="time">{{ r.timeDesc }}</span>
            <span v-if="r.location" class="loc">· {{ r.location }}</span>
          </div>

          <p class="text">{{ r.message }}</p>

          <div class="acts">
            <button
              class="act btn"
              :class="{ on: r.liked }"
              type="button"
              :title="t('bili.likeCount')"
              :disabled="!!bili.acting['reply-like-' + r.rpid]"
              @click="bili.toggleReplyLike(r)"
            >
              <span class="material-symbols-outlined">thumb_up</span>
              <span class="tabular-nums">{{ biliCount(r.like) }}</span>
            </button>
            <button
              class="act btn"
              type="button"
              :title="t('bili.replyAction')"
              @click="replyTo(r)"
            >
              <span class="material-symbols-outlined">reply</span>
              {{ t("bili.replyAction") }}
            </button>
            <!-- 手动复查：对单条评论再跑一次可见性判断（自动复查只发生在新评论发出后） -->
            <button
              class="act btn"
              type="button"
              :title="t('bili.antifraudManual')"
              :disabled="bili.antifraudChecking"
              @click="recheck(r)"
            >
              <span class="material-symbols-outlined">fact_check</span>
              {{ t("bili.antifraudManual") }}
            </button>
            <button
              v-if="!subExpanded(r) && r.replyCount"
              class="act btn"
              type="button"
              @click="bili.loadSubReplies(r.rpid)"
            >
              {{ t("bili.repliesPrefix") }}{{ r.replyCount }}{{ t("bili.repliesSuffix") }}
            </button>
            <button
              v-else-if="subExpanded(r)"
              class="act btn"
              type="button"
              @click="bili.loadSubReplies(r.rpid)"
            >
              {{ t("bili.collapse") }}
            </button>
          </div>

          <!-- 楼中楼 -->
          <div v-if="subList(r).length" class="subs">
            <div v-for="s in subList(r)" :key="s.rpid" class="sub">
              <span class="sub-head">
                <span class="sub-name" :class="{ up: s.isUp }">{{ s.author.name }}</span>
                <span v-if="s.isUp" class="badge up sm">UP</span>
                <button
                  class="sub-like tabular-nums"
                  :class="{ on: s.liked }"
                  type="button"
                  :title="t('bili.likeCount')"
                  :disabled="!!bili.acting['reply-like-' + s.rpid]"
                  @click="bili.toggleReplyLike(s)"
                >
                  <span class="material-symbols-outlined">thumb_up</span>{{ biliCount(s.like) }}
                </button>
              </span>
              <span class="sub-text">{{ s.message }}</span>
              <button
                class="sub-reply"
                type="button"
                :title="t('bili.replyAction')"
                @click="replyToSub(r, s)"
              >
                {{ t("bili.replyAction") }}
              </button>
            </div>
            <button
              v-if="subMore(r)"
              class="link"
              type="button"
              :disabled="bili.subBusy[r.rpid]"
              @click="bili.loadSubReplies(r.rpid, true)"
            >
              {{ bili.subBusy[r.rpid] ? t("bili.loading") : t("bili.loadMore") }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 带货评论被过滤时告知条数，否则评论区看起来只是「莫名其妙少了评论」 -->
    <p v-if="bili.replyBlockedCount > 0" class="reply-blocked">
      <span class="material-symbols-outlined">visibility_off</span>
      <span>{{ t("bili.replyBlocked").replace("{n}", String(bili.replyBlockedCount)) }}</span>
      <span class="reply-blocked-hint">{{ t("bili.replyBlockedHint") }}</span>
    </p>

    <div v-if="bili.replies.length" class="more">
      <!-- 分页失败：列表保留，错误就近提示并可重试（不要顶掉已有内容） -->
      <p v-if="bili.replyStatus === 'error'" class="more-error">
        <span class="material-symbols-outlined">error</span>
        {{ bili.replyError || t("bili.replyFailed") }}
      </p>
      <button
        v-if="!bili.replyEnd"
        class="link big"
        type="button"
        :disabled="bili.replyLoadingMore"
        @click="bili.loadMoreReplies()"
      >
        {{ bili.replyLoadingMore ? t("bili.loading") : t("bili.loadMoreComments") }}
      </button>
      <span v-else class="end">{{ t("bili.noMoreComments") }}</span>
    </div>

    <!-- 发评反诈结果弹窗：自动复查（发评后 8s）与手动复查共用这一个 -->
    <m3e-dialog ref="fraudDialog" class="fraud-dialog" @cancel="closeFraud" @closed="onFraudClosed">
      <span slot="header">{{ t("bili.antifraud") }}</span>
      <template v-if="bili.antifraudResult">
        <p class="fraud-title">{{ fraudTitle }}</p>
        <p v-if="bili.antifraudResult.detail" class="fraud-detail">
          {{ bili.antifraudResult.detail }}
        </p>
        <!-- 回显被复查的评论原文：用户要能对上「查的是哪条」，光有结论不够 -->
        <p v-if="bili.antifraudResult.message" class="fraud-quote">
          {{ bili.antifraudResult.message }}
        </p>
      </template>
      <div slot="actions" end>
        <m3e-button v-if="fraudAppealable" variant="text" size="small" @click="appeal">
          <span slot="icon" class="material-symbols-outlined">gavel</span>
          {{ t("bili.antifraudAppeal") }}
        </m3e-button>
        <m3e-button variant="filled" size="small" @click="closeFraud">
          {{ t("bili.antifraudClose") }}
        </m3e-button>
      </div>
    </m3e-dialog>
  </section>
</template>

<style scoped>
.comments {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 6px;
  padding-top: 16px;
  border-top: 1px solid var(--lm-hairline);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
}
.title .material-symbols-outlined {
  font-size: 18px;
  color: var(--md-sys-color-primary);
}
.sorts {
  display: flex;
  gap: 4px;
}
.sort-chip {
  --m3e-chip-container-height: 28px;
}

.state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  /* 行内 loading indicator 默认高度会把这一行撑歪，压回文字大小 */
  --m3e-loading-indicator-size: 16px;
}
.state.error {
  color: var(--md-sys-color-error);
}

/* ---- 发评反诈 ---- */
.fraud-checking {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.fraud-dialog {
  --m3e-dialog-min-width: 380px;
}
.fraud-title {
  margin: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  line-height: 1.6;
}
.fraud-detail {
  margin: 8px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}
.fraud-quote {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- 带货评论过滤提示 ---- */
.reply-blocked {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
  font-size: var(--md-sys-typescale-body-small-size);
}
.reply-blocked .material-symbols-outlined {
  font-size: 16px;
}
.reply-blocked-hint {
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
  font-size: 20px;
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
  color: var(--md-sys-color-on-surface-variant);
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name.vip {
  color: var(--md-sys-color-primary);
}
.time,
.loc {
  font-size: 11.5px;
  color: var(--md-sys-color-outline);
}

.badge {
  padding: 0 5px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  font-size: 10px;
  line-height: 15px;
  font-weight: 500;
}
.badge.lv {
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.badge.up {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}
.badge.top {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}
.badge.sm {
  font-size: 9px;
  line-height: 13px;
}

.text {
  margin: 5px 0 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.acts {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--md-sys-color-on-surface-variant);
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.act.on {
  color: var(--md-sys-color-primary);
}
/* 点赞按钮：可点 + 满足 M3 最小触达（原来 14px 高，几乎点不中） */
.act.btn {
  min-height: 28px;
  padding: 0 4px;
  border-radius: var(--md-sys-shape-corner-full);
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.act.btn:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-high);
}
.act.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.act .material-symbols-outlined {
  font-size: 14px;
}
.btn {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}
.btn:hover {
  color: var(--md-sys-color-primary);
}
/* 「回复」按钮：比点赞数更靠后，视觉上更轻 */
.act.btn .material-symbols-outlined {
  font-size: 14px;
}
.sub-reply {
  align-self: flex-start;
  margin-top: 1px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.sub-reply:hover {
  color: var(--md-sys-color-primary);
}

.subs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 9px 11px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
}
.sub {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.5;
}
.sub-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sub-name {
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
}
.sub-name.up {
  color: var(--md-sys-color-primary);
}
.sub-like {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 24px;
  margin-left: auto;
  padding: 0 4px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-outline);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sub-like:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-primary);
}
.sub-like.on {
  color: var(--md-sys-color-primary);
}
.sub-like:disabled {
  opacity: 0.6;
  cursor: default;
}
.sub-like .material-symbols-outlined {
  font-size: 12px;
}
.sub-text {
  color: var(--md-sys-color-on-surface);
  word-break: break-word;
}

.link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--md-sys-color-primary);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
}
.link:disabled {
  color: var(--md-sys-color-on-surface-variant);
  cursor: default;
}

.more {
  display: flex;
  justify-content: center;
  padding: 4px 0 8px;
}
.link.big {
  align-self: center;
  padding: 8px 20px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-weight: 500;
}
.link.big:hover:not(:disabled) {
  background: var(--md-sys-color-secondary-container);
  filter: brightness(1.06);
}
.more-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.more-error .material-symbols-outlined {
  font-size: 16px;
}
.end {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-outline);
}
</style>
