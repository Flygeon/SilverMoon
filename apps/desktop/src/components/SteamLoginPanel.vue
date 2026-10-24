<script setup lang="ts">
/**
 * Steam 扫码登录面板 —— **应用唯一的登录入口**（CM 侧扫码）。
 *
 * ## 为什么只剩一种方式
 *
 * 早先有两套登录：网页扫码（WebAPI）与 CM 扫码，各要扫一次码。这是设计缺陷 ——
 * CM 侧现在已经能同时提供「游戏库」与「应用内下载」，所以统一成 CM 扫码：
 * 用户扫**一次**，库和下载都能用。网页登录的 op 仍留在宿主侧（旧数据 / 排障），
 * 但本组件不再调用任何一条（新增功能也不要再接回去）。
 *
 * ## 职责边界
 *
 * - **状态机在 store**：二维码 dataURL、轮询、错误全在 `stores/steam.ts` 的
 *   `cmLogin` 上；组件只决定「什么时候开始扫」「什么时候算成功」。
 * - **轮询幂等可停**：store 里同一时刻只有一个定时器；组件卸载 / keep-alive
 *   失活都必须显式停表，否则用户切到别的页面后后台还在打 cmPollQr。
 * - **不静默失败**：发起或轮询出错时展示 store 里的 qrError 原文。
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useSteamStore } from "@/stores/steam";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "logged-in"): void }>();

const settings = useSettingsStore();
const steam = useSteamStore();
const t = (key: string) => translate(settings.lang, key);

/**
 * 状态文字对应的 i18n 键。
 *
 * store 只存状态标记（它不知道界面语言），文案在这里取，中英文各一套。
 * 宿主目前只回 pending / authorized，`scanned` 是给「已扫码待确认」预留的。
 */
const statusKey = computed(() => {
  const status = steam.cmLogin.statusText;
  if (status === "success") return "games.qrAuthorized";
  if (status === "scanned") return "games.qrScanConfirm";
  return "games.qrWaiting";
});

/** 重新发起一轮扫码（二维码过期 / 出错后用户主动刷新） */
async function refreshQr(): Promise<void> {
  await steam.beginCmLogin();
}

onMounted(() => {
  // 已登录就不必再画码（例如详情页里登录成功后组件还没卸载的那一帧）
  if (steam.cmLogin.hasToken) return;
  void steam.beginCmLogin();
});

onActivated(() => {
  // keep-alive 回到本页：上一轮可能已经过期，且失活时被停表了 → 重新发起
  if (steam.cmLogin.hasToken || steam.cmLogin.statusText === "success") return;
  if (!steam.cmLogin.qrUrl) void steam.beginCmLogin();
});

onDeactivated(() => {
  // 页面被缓存（用户去了别的页）：**必须停表**，否则后台一直打 cmPollQr
  steam.stopCmPolling();
});

onBeforeUnmount(() => {
  steam.stopCmPolling();
  // 清掉这一轮的二维码与会话标识；hasToken / accountName 是主进程的事实，不动
  steam.resetCmLogin();
});

// 扫码成功 → 通知调用方（游戏库刷新 / 详情页续上被拦下的下载）
watch(
  () => steam.cmLogin.statusText,
  (now, before) => {
    if (now === "success" && before !== "success") emit("logged-in");
  },
);
</script>

<template>
  <div class="steam-login">
    <!-- 一次扫码，两处可用：这句话是这次架构统一的核心，别删 -->
    <p class="hint">{{ t("games.qrScanOnce") }}</p>

    <!-- 错误：统一一条，不让界面出现两套说法 -->
    <div v-if="steam.cmLogin.qrError" class="bar error" role="alert">
      <span class="material-symbols-outlined">error</span>
      <span>{{ steam.cmLogin.qrError }}</span>
    </div>

    <div class="qr-box">
      <img
        v-if="steam.cmLogin.qrUrl"
        :src="steam.cmLogin.qrUrl"
        class="qr-img"
        :alt="t('games.qrHint')"
      />
      <div v-else class="qr-placeholder">
        <m3e-loading-indicator v-if="steam.cmLogin.qrBusy" class="lm-loading" />
        <span v-else class="material-symbols-outlined qr-fail-icon">qr_code_2</span>
        <span class="qr-placeholder-text">
          {{ steam.cmLogin.qrBusy ? t("games.qrWaiting") : t("games.qrFailed") }}
        </span>
      </div>
    </div>

    <p class="scan-hint">{{ t("games.qrHint") }}</p>

    <p class="status-line" role="status">
      <m3e-loading-indicator
        v-if="!steam.cmLogin.qrError && !steam.cmLogin.qrBusy"
        class="inline-loading"
      />
      <span>{{ t(statusKey) }}</span>
    </p>

    <div class="pane-actions">
      <m3e-button
        variant="outlined"
        size="small"
        :disabled="steam.cmLogin.qrBusy"
        @click="refreshQr"
      >
        <span slot="icon" class="material-symbols-outlined">refresh</span>
        {{ t("games.qrRefresh") }}
      </m3e-button>
    </div>

    <p class="foot-hint">
      <span class="material-symbols-outlined inline-icon">verified</span>
      {{ t("games.loginLocalOnly") }}
    </p>
  </div>
</template>

<style scoped>
.steam-login {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
}

/* ---- 提示条 ---- */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.5;
}
.bar.error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.bar .material-symbols-outlined {
  font-size: 18px;
}
.hint {
  margin: 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.scan-hint {
  margin: 0;
  text-align: center;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  color: var(--md-sys-color-on-surface);
}
.foot-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}
.inline-icon {
  font-size: 16px;
}

/* ---- 二维码 ----
   ⚠️ 码本身是「黑码白底」的 PNG（qrcode 的 toDataURL 自带白底与 margin），
   所以这里**不设**任何底色令牌：二维码的成像不跟主题走，写死颜色反而会扫不出来。 */
.qr-box {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
}
.qr-img {
  width: 220px;
  height: 220px;
  border-radius: var(--md-sys-shape-corner-medium);
}
.qr-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 220px;
  height: 220px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
}
.qr-fail-icon {
  font-size: 40px;
}
.qr-placeholder-text {
  font-size: var(--md-sys-typescale-body-small-size);
}
.status-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  min-height: 20px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}
.inline-loading {
  --m3e-loading-indicator-size: 16px;
}
.pane-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
