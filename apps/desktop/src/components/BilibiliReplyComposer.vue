<script setup lang="ts">
/**
 * 评论输入框（详情页评论区顶部）。
 *
 * 未登录时不显示输入框，只给一条「去登录」的提示（父级负责打开登录弹窗）。
 * 发送成功后清空并退出回复态；内容为空 / 发送中则禁用按钮。
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

async function send(): Promise<void> {
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
</style>
