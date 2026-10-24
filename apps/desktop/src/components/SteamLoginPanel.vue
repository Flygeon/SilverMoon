<script setup lang="ts">
/**
 * Steam 登录面板（三种方式：扫码 / 账号密码 + Steam Guard / 已保存会话）。
 *
 * 链路：本组件 → useSteamStore → capabilities.steam({ op })
 *       → callBridge("steam", payload) → electron/ipc.ts 的 steam 通道 → electron/steam/。
 *
 * 设计要点：
 * - **状态机在 store 里**：这里只负责「什么时候该调哪个 op」。登录流程的
 *   pending / guard / authenticated / failed 全部读 store 的 authState。
 * - **轮询归本组件管**：二维码用 setInterval 反复调 loginPoll，间隔来自宿主的
 *   interval（**秒**）。组件卸载 / 切换方式 / 登录成功都必须停表，否则会泄漏定时器
 *   并持续打接口。
 * - **不静默失败**：每个请求都有 loading 与错误文案；错误来自 store.error。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useSteamStore } from "@/stores/steam";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "logged-in"): void }>();

const settings = useSettingsStore();
const steam = useSteamStore();
const t = (key: string) => translate(settings.lang, key);

/** 当前选中的登录方式；已保存会话只在其存在时作为初始选项 */
type Method = "qr" | "credentials" | "session";
const method = ref<Method>(steam.status.hasSession && !steam.status.loggedIn ? "session" : "qr");

// ---- 方式一：二维码 ----
/** 生成好的二维码 dataURL（qrcode 库产出），空串表示还没生成 */
const qrImage = ref("");
const qrLoading = ref(false);
const qrError = ref("");
/** 轮询定时器；同一时刻只允许一个 */
let pollTimer: number | null = null;
/** 轮询互斥：定时器与「立即补一次」可能撞在一起 */
let polling = false;

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
    const done = await steam.pollQr();
    if (done) {
      stopPolling();
      if (steam.loggedIn) emit("logged-in");
    }
  } finally {
    polling = false;
  }
}

/** 把 challengeUrl 画成二维码。qrcode 动态 import：只有真正扫码时才需要它。 */
async function renderQr(url: string): Promise<void> {
  qrLoading.value = true;
  qrError.value = "";
  try {
    const { default: QRCode } = await import("qrcode");
    qrImage.value = await QRCode.toDataURL(url, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
    });
  } catch (e) {
    qrImage.value = "";
    qrError.value = e instanceof Error ? e.message : String(e);
  } finally {
    qrLoading.value = false;
  }
}

/** 开始（或重新开始）扫码：拿 challengeUrl → 画码 → 按 interval 起轮询 */
async function startQrFlow(): Promise<void> {
  stopPolling();
  qrImage.value = "";
  qrError.value = "";
  const challenge = await steam.startQr();
  if (!challenge) {
    qrError.value = steam.error || t("games.qrFailed");
    return;
  }
  await renderQr(challenge.challengeUrl);
  if (qrError.value) return;
  // 契约里 interval 的单位是**秒**，setInterval 要毫秒
  const ms = Math.max(1000, (challenge.interval || 5) * 1000);
  pollTimer = window.setInterval(() => void tick(), ms);
  // 立刻补一次：若用户已经确认过（或预览里已到第 3 次），不必干等一个周期
  void tick();
}

// ---- 方式二：账号密码 ----
const accountName = ref(steam.status.accountName ?? "");
const password = ref("");
/** 验证码输入（guard 阶段） */
const guardCode = ref("");

/** 当前流程是否处在 Guard 阶段 */
const inGuard = computed(() => steam.authState.state === "guard");
const guardType = computed<"email" | "device">(() => steam.authState.guardType ?? "device");

function submitCredentials(): void {
  const account = accountName.value.trim();
  if (!account || !password.value || steam.authBusy) return;
  void (async () => {
    const next = await steam.login(account, password.value);
    password.value = "";
    if (next.state === "authenticated") {
      emit("logged-in");
      return;
    }
    // device 确认：host 让用户去手机应用里点确认，这里转为轮询 loginPoll
    if (next.state === "pending") startGuardPolling();
    if (next.state === "guard") guardCode.value = "";
  })();
}

/** device 确认阶段的轮询（与扫码共用同一套 tick） */
function startGuardPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => void tick(), 3000);
  void tick();
}

function submitGuardCode(): void {
  const code = guardCode.value.trim();
  if (!code || steam.authBusy) return;
  void (async () => {
    const next = await steam.submitGuard(code, guardType.value);
    guardCode.value = "";
    if (next.state === "authenticated") {
      emit("logged-in");
      return;
    }
    if (next.state === "pending") startGuardPolling();
  })();
}

// ---- 方式三：已保存会话 ----
const resumeBusy = ref(false);

async function resume(): Promise<void> {
  if (resumeBusy.value) return;
  resumeBusy.value = true;
  try {
    await steam.resumeSession();
    if (steam.loggedIn) emit("logged-in");
  } finally {
    resumeBusy.value = false;
  }
}

// ---- 方式切换 ----
function choose(next: Method): void {
  if (next === method.value) return;
  method.value = next;
  // 切走扫码就停表，否则后台一直轮询
  if (next !== "qr") {
    stopPolling();
    void steam.cancelLogin();
  } else {
    void startQrFlow();
  }
}

// 进入扫码页就自动起流程（二维码要用户主动看到才算开始，不必再点一次）
watch(
  method,
  (now) => {
    if (now === "qr") void startQrFlow();
  },
  { immediate: true },
);

// 登录成功后统一收尾：停表、清码，避免组件还挂着轮询
watch(
  () => steam.loggedIn,
  (ok) => {
    if (ok) {
      stopPolling();
      qrImage.value = "";
    }
  },
);

onBeforeUnmount(() => {
  stopPolling();
  // 面板卸载时若还在扫码流程，通知宿主清掉 pending，避免后台任务挂着
  if (steam.qr) void steam.cancelLogin();
});

/** 顶部错误条：优先显示 store 的主动错误，其次本地二维码错误 */
const displayError = computed(() => steam.error || qrError.value);

/** Guard 阶段文案跟着 guardType 走 */
const guardTitle = computed(() =>
  guardType.value === "email" ? t("games.guardEmail") : t("games.guardDevice"),
);
const guardHint = computed(() =>
  guardType.value === "email" ? t("games.guardEmailHint") : t("games.guardDeviceHint"),
);
</script>

<template>
  <div class="steam-login">
    <!-- 三种方式的入口：M3E 连通按钮组，切换时不留第二套视觉 -->
    <m3e-button-group class="method-group" aria-label="login method">
      <m3e-button
        v-for="m in ['qr', 'credentials', 'session'] as Method[]"
        :key="m"
        shape="round"
        size="medium"
        type="button"
        :variant="method === m ? 'filled' : 'tonal'"
        :disabled="m === 'session' && !steam.status.hasSession"
        @click="choose(m)"
      >
        <span slot="icon" class="material-symbols-outlined method-icon">{{
          m === "qr" ? "qr_code_2" : m === "credentials" ? "key" : "history"
        }}</span>
        {{
          m === "qr"
            ? t("games.methodQr")
            : m === "credentials"
              ? t("games.methodCredentials")
              : t("games.methodSession")
        }}
      </m3e-button>
    </m3e-button-group>

    <!-- 错误：统一一条，不让三种方式各说各的 -->
    <div v-if="displayError" class="bar error" role="alert">
      <span class="material-symbols-outlined">error</span>
      <span>{{ displayError }}</span>
    </div>

    <!-- ================= 方式一：二维码 ================= -->
    <section v-if="method === 'qr'" class="pane qr-pane">
      <p class="hint">{{ t("games.qrHint") }}</p>
      <div class="qr-box">
        <img v-if="qrImage" :src="qrImage" class="qr-img" :alt="t('games.methodQr')" />
        <div v-else class="qr-placeholder">
          <m3e-loading-indicator v-if="qrLoading || steam.authBusy" class="lm-loading" />
          <span v-else class="material-symbols-outlined qr-fail-icon">qr_code_2</span>
          <span class="qr-placeholder-text">
            {{ qrLoading || steam.authBusy ? t("games.qrWaiting") : t("games.qrFailed") }}
          </span>
        </div>
      </div>
      <p class="status-line">
        <m3e-loading-indicator v-if="steam.authState.state === 'pending'" class="inline-loading" />
        <span>{{ steam.authState.message || t("games.qrWaiting") }}</span>
      </p>
      <div class="pane-actions">
        <m3e-button
          variant="outlined"
          size="small"
          :disabled="steam.authBusy || !!qrLoading"
          @click="startQrFlow"
        >
          <span slot="icon" class="material-symbols-outlined">refresh</span>
          {{ t("games.qrRefresh") }}
        </m3e-button>
      </div>
      <p class="foot-hint">{{ t("games.qrPreviewNote") }}</p>
    </section>

    <!-- ================= 方式二：账号密码 / Guard ================= -->
    <section v-else-if="method === 'credentials'" class="pane">
      <!-- Guard 阶段：只显示验证码输入，不显示账号密码 -->
      <template v-if="inGuard">
        <div class="guard-head">
          <span class="material-symbols-outlined guard-icon">{{
            guardType === "email" ? "mail" : "smartphone"
          }}</span>
          <div>
            <div class="guard-title">{{ guardTitle }}</div>
            <p class="guard-hint">{{ guardHint }}</p>
          </div>
        </div>
        <m3e-form-field class="field" variant="filled">
          <input
            v-model="guardCode"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            :placeholder="t('games.guardPlaceholder')"
            spellcheck="false"
            @keydown.enter.prevent="submitGuardCode"
          />
        </m3e-form-field>
        <div class="pane-actions">
          <m3e-button
            variant="filled"
            size="small"
            :disabled="!guardCode.trim() || steam.authBusy"
            @click="submitGuardCode"
          >
            <span slot="icon" class="material-symbols-outlined">check</span>
            {{ steam.authBusy ? t("games.submitting") : t("games.submit") }}
          </m3e-button>
          <m3e-button variant="text" size="small" @click="choose('qr')">
            {{ t("games.backToLogin") }}
          </m3e-button>
        </div>
      </template>

      <!-- 账号密码输入 -->
      <template v-else>
        <m3e-form-field class="field" variant="filled">
          <input
            v-model="accountName"
            type="text"
            autocomplete="username"
            :placeholder="t('games.accountPlaceholder')"
            spellcheck="false"
          />
          <span slot="leading-icon" class="material-symbols-outlined field-icon">person</span>
        </m3e-form-field>
        <m3e-form-field class="field" variant="filled">
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            :placeholder="t('games.passwordPlaceholder')"
            @keydown.enter.prevent="submitCredentials"
          />
          <span slot="leading-icon" class="material-symbols-outlined field-icon">password</span>
        </m3e-form-field>
        <div class="pane-actions">
          <m3e-button
            variant="filled"
            size="small"
            :disabled="!accountName.trim() || !password || steam.authBusy"
            @click="submitCredentials"
          >
            <span slot="icon" class="material-symbols-outlined">login</span>
            {{ steam.authBusy ? t("games.loggingIn") : t("games.login") }}
          </m3e-button>
        </div>
        <p class="foot-hint">
          <span class="material-symbols-outlined inline-icon">verified</span>
          {{ t("games.loginLocalOnly") }}
        </p>
      </template>

      <!-- device 确认中：提示去手机点确认，同时后台轮询 -->
      <div v-if="steam.authState.state === 'pending'" class="confirm-box">
        <m3e-loading-indicator class="lm-loading" />
        <span>{{ t("games.guardDeviceConfirm") }}</span>
        <p class="status-line">{{ steam.authState.message }}</p>
      </div>
    </section>

    <!-- ================= 方式三：已保存会话 ================= -->
    <section v-else class="pane">
      <div class="session-box">
        <span class="material-symbols-outlined session-icon">account_circle</span>
        <div class="session-text">
          <div class="session-title">
            {{
              steam.displayName
                ? t("games.continueAs").replace("{name}", steam.displayName)
                : t("games.methodSession")
            }}
          </div>
          <p class="session-hint">
            {{ steam.needsReconnect ? t("games.reconnectHint") : t("games.continueHint") }}
          </p>
        </div>
      </div>
      <div class="pane-actions">
        <m3e-button
          variant="filled"
          size="small"
          :disabled="resumeBusy || steam.statusLoading"
          @click="resume"
        >
          <span slot="icon" class="material-symbols-outlined">sync</span>
          {{
            resumeBusy
              ? t("games.loggingIn")
              : steam.needsReconnect
                ? t("games.reconnect")
                : t("games.continueAs").replace("{name}", steam.displayName || "")
          }}
        </m3e-button>
        <m3e-button variant="text" size="small" @click="choose('credentials')">
          {{ t("games.switchAccount") }}
        </m3e-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.steam-login {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}

/* 连通按钮组：与 SegmentedTabs 同一套令牌（36dp 高、3dp 间隙、8dp 内侧圆角） */
.method-group {
  --m3e-connected-button-group-spacing: 3px;
  --m3e-connected-button-group-medium-inner-shape: 8px;
  --m3e-connected-button-group-medium-inner-pressed-shape: 8px;
  --m3e-button-medium-container-height: 36px;
  --m3e-button-medium-label-text-font-size: var(--md-sys-typescale-label-large-size);
  --m3e-button-icon-size: 18px;
  --m3e-button-icon-label-space: 8px;
  display: inline-flex;
  align-self: center;
}
.method-icon {
  font-size: 18px;
  line-height: 1;
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
/* ---- 面板 ---- */
.pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint {
  margin: 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.foot-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 4px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}
.inline-icon {
  font-size: 16px;
}

/* ---- 二维码 ---- */
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
  background: #fff;
  padding: 8px;
  box-sizing: border-box;
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

/* ---- 表单 ---- */
.field {
  width: 100%;
  --m3e-form-field-container-height: 48px;
}
.field input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  outline: none;
}
.field-icon {
  font-size: 20px;
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- Guard ---- */
.guard-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.guard-icon {
  font-size: 24px;
  flex-shrink: 0;
}
.guard-title {
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
}
.guard-hint {
  margin: 4px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.5;
}
.confirm-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface);
  text-align: center;
}

/* ---- 已保存会话 ---- */
.session-box {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-high);
}
.session-icon {
  font-size: 40px;
  color: var(--md-sys-color-primary);
}
.session-text {
  min-width: 0;
}
.session-title {
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-hint {
  margin: 4px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
</style>
