<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { BiliCredentialLogin, type BiliLoginResult } from "@/utils/bilibiliLogin";
import type { BiliAccount } from "@/utils/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";

const props = defineProps<{ method: "password" | "sms" }>();
const emit = defineEmits<{ success: [account: BiliAccount] }>();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);
const session = new BiliCredentialLogin();
const username = ref("");
const password = ref("");
const cid = ref("86");
const tel = ref("");
const code = ref("");
const riskPhone = ref("");
const busy = ref(false);
const error = ref("");
const status = ref("");
const seconds = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
let alive = true;
const canSubmit = computed(
  () =>
    !busy.value &&
    (riskPhone.value || props.method === "sms"
      ? /^\d{4,8}$/.test(code.value)
      : !!username.value.trim() && !!password.value),
);

function stopTimer(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  seconds.value = 0;
}
watch([cid, tel], () => {
  session.resetSms();
  code.value = "";
  error.value = "";
  status.value = "";
  stopTimer();
});
async function perform(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  status.value = t("bili.authWorking");
  try {
    await work();
  } catch (e) {
    if (alive) {
      error.value = String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "");
      status.value = "";
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function sendCode(): Promise<void> {
  if (seconds.value > 0) return;
  await perform(async () => {
    if (riskPhone.value) await session.sendRiskSms();
    else await session.sendSms(cid.value.trim().replace(/^\+/, ""), tel.value.trim());
    if (!alive) return;
    status.value = t("bili.smsSent");
    const deadline = Date.now() + 60000;
    stopTimer();
    seconds.value = 60;
    timer = setInterval(() => {
      seconds.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (seconds.value === 0) stopTimer();
    }, 250);
  });
}
async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  await perform(async () => {
    let result: BiliLoginResult;
    if (riskPhone.value) result = await session.verifyRisk(code.value.trim());
    else if (props.method === "sms") {
      result = await session.smsLogin(
        cid.value.trim().replace(/^\+/, ""),
        tel.value.trim(),
        code.value.trim(),
      );
    } else {
      const secret = password.value;
      password.value = "";
      result = await session.password(username.value.trim(), secret);
    }
    if (!alive) return;
    if ("riskPhone" in result) {
      riskPhone.value = result.riskPhone;
      code.value = "";
      stopTimer();
      status.value = t("bili.riskRequired");
    } else {
      code.value = "";
      emit("success", result.account);
    }
  });
}
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing || event.target instanceof HTMLButtonElement) return;
  if (!(event.target instanceof HTMLInputElement)) return;
  event.preventDefault();
  void submit();
}
onBeforeUnmount(() => {
  alive = false;
  session.dispose();
  password.value = "";
  code.value = "";
  stopTimer();
});
</script>

<template>
  <form class="credential-form" @submit.prevent="submit" @keydown.enter="onEnter">
    <template v-if="riskPhone">
      <p class="hint">{{ t("bili.riskRequired") }}</p>
      <strong>{{ riskPhone }}</strong>
    </template>
    <template v-else-if="method === 'password'">
      <m3e-form-field variant="outlined">
        <label slot="label">{{ t("bili.loginUsername") }}</label>
        <input
          v-model="username"
          name="username"
          autocomplete="username"
          maxlength="128"
          :aria-label="t('bili.loginUsername')"
          :disabled="busy"
        />
      </m3e-form-field>
      <m3e-form-field variant="outlined">
        <label slot="label">{{ t("bili.loginPassword") }}</label>
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          maxlength="128"
          :aria-label="t('bili.loginPassword')"
          :disabled="busy"
        />
      </m3e-form-field>
    </template>
    <template v-else>
      <div class="phone-fields">
        <m3e-form-field variant="outlined" class="country-field">
          <label slot="label">{{ t("bili.countryCode") }}</label>
          <input
            v-model="cid"
            name="countryCode"
            inputmode="tel"
            maxlength="5"
            :aria-label="t('bili.countryCode')"
            :disabled="busy"
          />
        </m3e-form-field>
        <m3e-form-field variant="outlined" class="phone-field">
          <label slot="label">{{ t("bili.phoneNumber") }}</label>
          <input
            v-model="tel"
            type="tel"
            name="tel"
            autocomplete="tel-national"
            maxlength="20"
            :aria-label="t('bili.phoneNumber')"
            :disabled="busy"
          />
        </m3e-form-field>
      </div>
    </template>
    <template v-if="riskPhone || method === 'sms'">
      <div class="code-fields">
        <m3e-form-field variant="outlined">
          <label slot="label">{{ t("bili.smsCode") }}</label>
          <input
            v-model="code"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="8"
            :aria-label="t('bili.smsCode')"
            :disabled="busy"
          />
        </m3e-form-field>
        <m3e-button variant="tonal" type="button" :disabled="busy || seconds > 0" @click="sendCode">
          {{ seconds > 0 ? `${seconds}s` : t("bili.sendSms") }}
        </m3e-button>
      </div>
    </template>
    <p class="hint">{{ t("bili.captchaTip") }}</p>
    <p v-if="status" class="hint" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
    <m3e-button variant="filled" type="submit" :disabled="!canSubmit" @click.prevent="submit">
      {{ riskPhone ? t("bili.verifyAndLogin") : t("bili.signIn") }}
    </m3e-button>
  </form>
</template>

<style scoped>
.credential-form {
  display: grid;
  gap: var(--lm-space-16);
  padding-top: var(--lm-space-20);
  text-align: start;
}
.credential-form m3e-form-field {
  width: 100%;
  min-width: 0;
}
.phone-fields {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: var(--lm-space-12);
}
.code-fields {
  display: flex;
  align-items: center;
  gap: var(--lm-space-12);
}
.code-fields m3e-form-field {
  flex: 1;
}
.code-fields m3e-button {
  flex-shrink: 0;
}
.hint {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}
.auth-error {
  margin: 0;
  color: var(--md-sys-color-error);
  font-size: var(--md-sys-typescale-body-small-size);
}
@media (max-width: 420px) {
  .code-fields {
    flex-wrap: wrap;
  }
}
</style>
