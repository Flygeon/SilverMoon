<script setup lang="ts">
/**
 * 评论输入框（详情页评论区顶部）。
 *
 * 未登录时不显示输入框，只给一条「去登录」的提示（父级负责打开登录弹窗）。
 * 发送成功后清空并退出回复态；内容为空 / 发送中则禁用按钮。
 * 正文含商品推广链接且设置里打开了「发布前二次确认」时，先弹窗确认再发（带货评论
 * 容易被上游折叠，多发一步确认能避免用户事后才发现评论不见了）。
 */
import { computed, ref, watch } from "vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "login"): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const text = ref("");
/** 正在回复的目标（空表示发一级评论） */
const replyTo = ref<{ rpid: string; root: string; name: string } | null>(null);

const canSend = computed(() => !!text.value.trim() && !bili.replySending);
const maxLen = 1000;

/** 供父级（评论列表）调用：点某条评论的「回复」按钮 */
function replyToComment(rpid: string, root: string, name: string): void {
  replyTo.value = { rpid, root, name };
}

function cancelReply(): void {
  replyTo.value = null;
}

/**
 * 商品推广链接特征（与参考项目 PiliPlus 的带货识别口径一致）。
 *
 * 只认「高能带货短链 + 淘宝/天猫商品页」这两种：B 站带货评论不外传这两类链接，
 * 放宽（比如任何 http 链接都拦）会把正常分享视频链接的评论也拦下来，得不偿失。
 */
const GOODS_RE = /(https?:\/\/)?(gaoneng\.bilibili\.com\/tetris|item\.(taobao|tmall)\.com)/i;

function hasGoodsLink(s: string): boolean {
  return GOODS_RE.test(s);
}

/** 二次确认弹窗的方法（m3e-dialog 没有 v-model，只能拿实例调）。 */
interface M3eDialog extends HTMLElement {
  show(): Promise<void>;
  hide(returnValue?: string): Promise<void>;
}
const confirmDialog = ref<M3eDialog | null>(null);
/** 待确认的发送任务；null 表示没有挂起的发送 */
let pending: (() => Promise<void>) | null = null;
/**
 * 本次交互是否点了「仍然发送」。
 *
 * m3e-dialog 在**程序化** hide() 时也会派发 cancel 事件（见 TextPrompt.vue 的同一坑），
 * 所以必须用这个标记把「用户取消」和「确认后关闭」区分开：否则点确认时 cancel 先把
 * pending 清掉，onConfirmClosed 拿不到任务，表现为「点了确认却什么都没发」。
 */
let confirmed = false;

/**
 * 真正发送（抽出来是因为它可能被二次确认延后执行）。
 *
 * 延后期间用户可能已经切了视频 / 改了内容：这里重新取一次当前文本与回复目标，
 * 与点击确认那一刻的界面保持一致，避免把旧内容发出去。
 */
async function doSend(): Promise<void> {
  if (!canSend.value) return;
  const target = replyTo.value;
  const ok = await bili.postReply(
    text.value,
    target ? target.root || target.rpid : "",
    target ? target.rpid : "",
  );
  if (ok) {
    text.value = "";
    replyTo.value = null;
  }
}

async function send(): Promise<void> {
  if (!canSend.value) return;
  // 命中带货链接且开关打开时先弹窗确认：这类评论容易被上游折叠 / 判定为推广
  if (settings.biliAntiGoodsPublish && hasGoodsLink(text.value)) {
    pending = doSend;
    confirmed = false;
    await confirmDialog.value?.show();
    return;
  }
  await doSend();
}

/** 确认发送：置位后关弹窗，真正发送交给 onConfirmClosed（避开 hide 的 async 竞态）。 */
function confirmSend(): void {
  confirmed = true;
  void confirmDialog.value?.hide();
}

/** 取消（按钮 / Esc / 点遮罩）：丢掉挂起的发送，但保留草稿让用户改掉链接重发。 */
function cancelSend(): void {
  // 程序化 hide() 也会派发 cancel：已确认时不能把它当成取消
  if (confirmed) return;
  pending = null;
  void confirmDialog.value?.hide();
}

/** 弹窗真正关闭后执行一次发送；取消路径 pending 已被清空，自然什么都不做。 */
async function onConfirmClosed(): Promise<void> {
  const job = confirmed ? pending : null;
  confirmed = false;
  pending = null;
  if (job) await job();
}

/** 切换视频时清掉草稿与回复目标，避免把上一条视频的回复发到下一条上。 */
watch(
  () => bili.current?.bvid,
  () => {
    text.value = "";
    replyTo.value = null;
  },
);

defineExpose({ replyToComment, cancelReply });
</script>

<template>
  <div class="composer">
    <template v-if="bili.account.isLogin">
      <div v-if="replyTo" class="reply-hint">
        <span class="material-symbols-outlined">reply</span>
        {{ t("bili.replyingTo") }}<strong>{{ replyTo.name }}</strong>
        <button class="cancel" type="button" @click="cancelReply">
          {{ t("bili.cancelReply") }}
        </button>
      </div>

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
            v-model="text"
            :maxlength="maxLen"
            :placeholder="replyTo ? t('bili.replyPlaceholder') : t('bili.commentPlaceholder')"
            rows="2"
            @keydown.ctrl.enter.prevent="send"
            @keydown.meta.enter.prevent="send"
          />
        </m3e-form-field>

        <m3e-button variant="filled" size="small" :disabled="!canSend" @click="send">
          <span slot="icon" class="material-symbols-outlined">send</span>
          {{ bili.replySending ? t("bili.sending") : t("bili.send") }}
        </m3e-button>
      </div>
      <div class="meta">
        <span class="count tabular-nums">{{ text.length }} / {{ maxLen }}</span>
        <span class="tip">{{ t("bili.sendTip") }}</span>
      </div>
    </template>

    <div v-else class="login-hint">
      <span class="material-symbols-outlined">info</span>
      <span>{{ t("bili.commentNeedLogin") }}</span>
      <m3e-button variant="text" size="small" @click="emit('login')">
        {{ t("bili.scanLogin") }}
      </m3e-button>
    </div>

    <!-- 带货链接二次确认：这类评论发出后容易被折叠，先让用户确认一次 -->
    <Teleport to="body">
      <m3e-dialog
        ref="confirmDialog"
        class="goods-confirm"
        @cancel="cancelSend"
        @closed="onConfirmClosed"
      >
        <span slot="header">{{ t("bili.antiGoodsConfirmTitle") }}</span>
        <p class="goods-tip">{{ t("bili.antiGoodsConfirmHint") }}</p>
        <p class="goods-quote">{{ text }}</p>
        <div slot="actions" end>
          <m3e-button variant="text" size="small" @click="cancelSend">
            {{ t("bili.cancelReply") }}
          </m3e-button>
          <m3e-button variant="filled" size="small" @click="confirmSend">
            {{ t("bili.antiGoodsConfirmOk") }}
          </m3e-button>
        </div>
      </m3e-dialog>
    </Teleport>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.reply-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.reply-hint .material-symbols-outlined {
  font-size: 16px;
}
.reply-hint strong {
  color: var(--md-sys-color-primary);
  font-weight: 500;
}
.cancel {
  margin-left: auto;
  padding: 2px 10px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-primary);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
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

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-left: 44px;
  font-size: 11.5px;
  color: var(--md-sys-color-outline);
}
.tip {
  opacity: 0.85;
}

.login-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.login-hint .material-symbols-outlined {
  font-size: 18px;
}

/* ---- 带货链接二次确认弹窗 ---- */
.goods-confirm {
  --m3e-dialog-min-width: 400px;
}
.goods-tip {
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}
.goods-quote {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
