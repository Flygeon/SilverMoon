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
import { computed, ref } from "vue";
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
</script>

<template>
  <section class="comments">
    <!-- 评论输入框：未登录时这里显示「去登录」提示 -->
    <BilibiliReplyComposer ref="composer" @login="emit('login')" />

    <div class="bar">
      <h3 class="title">
        <span class="material-symbols-outlined">forum</span>
        <span v-if="bili.replyTotal" class="tabular-nums">{{ biliCount(bili.replyTotal) }}</span>
        {{ t("bili.commentUnit") }}
      </h3>
      <div class="sorts">
        <button
          v-for="s in sorts"
          :key="s.value"
          class="sort"
          :class="{ active: bili.replySort === s.value }"
          type="button"
          @click="bili.setReplySort(s.value)"
        >
          {{ s.label }}
        </button>
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
            <span class="act" :class="{ on: r.upLiked }" :title="t('bili.likeCount')">
              <span class="material-symbols-outlined">thumb_up</span>
              <span class="tabular-nums">{{ biliCount(r.like) }}</span>
            </span>
            <button
              class="act btn"
              type="button"
              :title="t('bili.replyAction')"
              @click="replyTo(r)"
            >
              <span class="material-symbols-outlined">reply</span>
              {{ t("bili.replyAction") }}
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
                <span v-if="s.like" class="sub-like tabular-nums">
                  <span class="material-symbols-outlined">thumb_up</span>{{ biliCount(s.like) }}
                </span>
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
.sort {
  padding: 4px 10px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.sort:hover {
  background: var(--md-sys-color-surface-container-high);
}
.sort.active {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-weight: 500;
}

.state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.state.error {
  color: var(--md-sys-color-error);
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
  margin-left: auto;
  font-size: 11px;
  color: var(--md-sys-color-outline);
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
