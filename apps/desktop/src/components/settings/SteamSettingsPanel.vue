<script setup lang="ts">
/**
 * 设置 → Steam 目录。
 *
 * 从 `SettingsView.vue` 拆出来的第一个分区（治理计划 P1「从 Steam 分区最小切口起步」）。
 * 父组件只留卡片外壳（`v-if="activeSection === 'settings-steam'"`）与搜索索引锚点，
 * 内容与全部状态都在这里。
 *
 * ## 两种目录要分清
 *
 * - 自动识别的 Steam 根目录（`detected=true`）：只读，界面只显示，不允许手改 ——
 *   改它没有意义（下次启动又会按注册表/默认路径重新识别）；
 * - 自定义库目录（`customRoots`）：可增删，用来覆盖「Steam 装在非默认盘」的情况。
 *
 * 保存是**显式**的：改完点「保存」才写盘，避免每动一下就落一次 JSON。
 *
 * ## 为什么这里重复声明 .hint / .value / .dir-* 等规则
 *
 * 与 `SettingRow.vue` 同一原因（见它的头注释）：Vue 的 scoped CSS 只把父组件的
 * scope id 加到**子组件根元素**上，父组件的 `.dir-list` / `.hint` 规则对子组件内部的
 * 元素**不生效**。所以这些规则必须自带一份，否则拆完样式会静默丢。
 */
import { computed, onMounted, ref } from "vue";
import SettingRow from "@/components/SettingRow.vue";
import { capabilities } from "@/capabilities";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";
import type { SteamSettings } from "@shared/types";

/** 提示条文案由父组件统一弹出（toast 渲染在设置页根部，不在本组件内） */
const emit = defineEmits<{ notify: [message: string] }>();

const settings = useSettingsStore();

function t(key: string) {
  return translate(settings.lang, key);
}

const steamSettings = ref<SteamSettings | null>(null);
const steamSaving = ref(false);
/** 未保存的自定义目录草稿（与已保存值分开，取消时可直接丢弃） */
const steamRootsDraft = ref<string[]>([]);

const steamSettingsDirty = computed(() => {
  const saved = steamSettings.value?.customRoots ?? [];
  const draft = steamRootsDraft.value;
  return draft.length !== saved.length || draft.some((p, i) => p !== saved[i]);
});

async function loadSteamSettings(): Promise<void> {
  const res = await capabilities.steamSettings();
  steamSettings.value = res;
  steamRootsDraft.value = [...(res.customRoots ?? [])];
}

async function addSteamRoot(): Promise<void> {
  const picked = await capabilities.pickSteamRoot();
  // 取消（null）不是错误，直接返回
  if (!picked?.path) return;
  const path = picked.path;
  // 去重：同一个目录加两次只会让本地库重复扫描
  if (steamRootsDraft.value.includes(path)) {
    emit("notify", t("settings.steamRootExists"));
    return;
  }
  steamRootsDraft.value = [...steamRootsDraft.value, path];
}

function removeSteamRoot(index: number): void {
  steamRootsDraft.value = steamRootsDraft.value.filter((_, i) => i !== index);
}

async function saveSteamSettingsDraft(): Promise<void> {
  steamSaving.value = true;
  try {
    const res = await capabilities.setSteamSettings({ customRoots: steamRootsDraft.value });
    steamSettings.value = res;
    steamRootsDraft.value = [...(res.customRoots ?? [])];
    emit("notify", t("settings.steamSaved"));
  } catch (e) {
    emit("notify", String(e));
  } finally {
    steamSaving.value = false;
  }
}

onMounted(() => {
  // 卡片本身是 v-if 渲染的，切到本分区才挂载 —— 因此这里只读一次即可
  void loadSteamSettings();
});
</script>

<template>
  <div class="steam-settings">
    <h3>{{ t("settings.steamTitle") }}</h3>
    <p class="hint">{{ t("settings.steamHint") }}</p>

    <!-- 自动识别的 Steam 根目录：只读展示 -->
    <SettingRow :label="t('settings.steamRoot')" setting-key="settings.steamRoot">
      <span v-if="steamSettings?.detected && steamSettings?.steamRoot" class="value path-value">
        {{ steamSettings.steamRoot }}
      </span>
      <span v-else class="value muted">{{ t("settings.steamNotDetected") }}</span>
    </SettingRow>
    <p v-if="steamSettings?.detected" class="hint">
      {{ t("settings.steamDetectedHint") }}
    </p>

    <!-- 自定义库目录 -->
    <h3 class="sub">{{ t("settings.steamCustomRoots") }}</h3>
    <p class="hint">{{ t("settings.steamCustomRootsHint") }}</p>

    <div v-if="steamRootsDraft.length" class="dir-list">
      <div v-for="(dir, i) in steamRootsDraft" :key="dir" class="dir-item">
        <span class="material-symbols-outlined">folder</span>
        <span class="dir-path" :title="dir">{{ dir }}</span>
        <m3e-icon-button
          class="lm-icon-btn-sm danger"
          size="small"
          :title="t('settings.steamRemoveRoot')"
          @click="removeSteamRoot(i)"
        >
          <span class="material-symbols-outlined">close</span>
        </m3e-icon-button>
      </div>
    </div>
    <div v-else class="notice">{{ t("settings.steamCustomRootsEmpty") }}</div>

    <div class="actions">
      <m3e-button variant="tonal" size="small" @click="addSteamRoot">
        <span slot="icon" class="material-symbols-outlined">create_new_folder</span>
        {{ t("settings.steamAddRoot") }}
      </m3e-button>
      <m3e-button
        variant="filled"
        size="small"
        :disabled="!steamSettingsDirty || steamSaving"
        @click="saveSteamSettingsDraft"
      >
        {{ steamSaving ? t("settings.steamSaving") : t("settings.steamSave") }}
      </m3e-button>
    </div>
  </div>
</template>

<style scoped>
/* 与 SettingsView.vue 里的同名规则保持一致（scoped 不会穿透到这里，见组件头注释） */
h3 {
  margin-bottom: 6px;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
}
.hint {
  margin-bottom: 16px;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}
.value {
  min-width: 52px;
  text-align: right;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.dir-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.dir-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 12px;
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-medium);
}
.dir-item > .material-symbols-outlined {
  font-size: 19px;
  color: var(--md-sys-color-on-surface-variant);
}
.dir-path {
  flex: 1;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
/* 30×30 的尺寸与 17px 图标由全局 .lm-icon-btn-sm 提供 */
m3e-icon-button.danger:hover {
  --m3e-standard-icon-button-hover-state-layer-color: var(--md-sys-color-error-container);
  --m3e-standard-icon-button-hover-icon-color: var(--md-sys-color-error);
}
.notice {
  padding: 12px 14px;
  margin-bottom: 12px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-medium);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.actions .material-symbols-outlined {
  font-size: 18px;
}
</style>
