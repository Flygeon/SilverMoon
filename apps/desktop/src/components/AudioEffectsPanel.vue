<script setup lang="ts">
/**
 * 音效面板：EQ + 低音增强 + 混响 + 立体声宽度 + 预设管理。
 * 用于全屏播放器右侧栏与设置页，保持一致 MD3 视觉。
 */
import { nextTick, ref } from "vue";
import { useAudioEffectsStore } from "@/stores/audioEffects";
import { useSettingsStore } from "@/stores/settings";
import { capabilities, isDesktop } from "@/capabilities";
import { translate } from "@shared/i18n";
import { save } from "@/ipc/dialog";
import { writeTextFile } from "@/ipc/fs";
import ModalSurface from "@/components/ModalSurface.vue";

const effects = useAudioEffectsStore();
const settings = useSettingsStore();
const newPresetName = ref("");
const importCode = ref("");
const shareStatus = ref<"copied" | "failed" | "imported" | "invalid" | null>(null);

// ---- 分享弹窗 ----
const sharePopupPresetId = ref<string | null>(null);
const shareSurface = ref<{ focus(): void } | null>(null);
const uploadPopupPresetId = ref<string | null>(null);
const uploadName = ref("");
const uploadDesc = ref("");
const uploadShareCode = ref("");
const uploadStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
const uploadError = ref("");

function t(key: string) {
  return translate(settings.lang, key);
}

function isActive(id: string) {
  return effects.config.presetId === id;
}

function applyPreset(id: string) {
  effects.applyPreset(id);
}

function savePreset() {
  const name = newPresetName.value.trim();
  if (!name) return;
  effects.saveUserPreset(name);
  newPresetName.value = "";
}

function deletePreset(id: string) {
  effects.deleteUserPreset(id);
}

/** 分享按钮：先弹出选择窗 */
function showSharePopup(id: string) {
  sharePopupPresetId.value = id;
  uploadPopupPresetId.value = null;
  uploadStatus.value = "idle";
  uploadError.value = "";
}

function closeSharePopup() {
  sharePopupPresetId.value = null;
  uploadPopupPresetId.value = null;
  uploadStatus.value = "idle";
  uploadError.value = "";
}

/** 复制分享码（原行为） */
async function copyShareCode(id: string) {
  const codes = effects.exportUserPreset(id);
  if (!codes || codes.length === 0) {
    shareStatus.value = "failed";
    return;
  }
  const mode = settings.shareCodePreference;
  let code: string;
  if (mode === "chinese") {
    code = codes[0];
  } else if (mode === "original") {
    code = codes[1] ?? codes[0];
  } else {
    code = `${t("player.effectsShareChineseLabel")}：${codes[0]}\n${t("player.effectsShareOriginalLabel")}：${codes[1]}`;
  }
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(code);
    } else {
      const input = document.createElement("textarea");
      input.value = code;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("Clipboard unavailable");
    }
    shareStatus.value = "copied";
    closeSharePopup();
  } catch {
    shareStatus.value = "failed";
  }
}

/** 切换到上传至预设市场弹窗 */
function openUploadPopup(id: string) {
  const preset = effects.userPresets.find((p) => p.id === id);
  if (!preset) return;
  const codes = effects.exportUserPreset(id);
  if (!codes || codes.length === 0) return;
  // 用 LLFX3 紧凑格式作为市场分享码
  uploadName.value = preset.name;
  uploadDesc.value = "";
  uploadShareCode.value = codes[1] ?? codes[0]; // LLFX3:xxx
  uploadPopupPresetId.value = id;
  uploadStatus.value = "idle";
  uploadError.value = "";
  sharePopupPresetId.value = null;
  // 步骤切换会移除当前焦点按钮；将焦点留在同一弹层，Escape 和 Tab 才继续可用。
  void nextTick(() => shareSurface.value?.focus());
}

async function saveUploadJson() {
  if (!uploadName.value.trim() || !uploadShareCode.value.trim()) {
    uploadError.value = "名称和分享码不能为空";
    return;
  }
  uploadStatus.value = "saving";
  uploadError.value = "";

  const jsonObj = {
    name: uploadName.value.trim(),
    version: 1,
    description: uploadDesc.value.trim(),
    shareCode: uploadShareCode.value.trim(),
  };

  const jsonStr = JSON.stringify(jsonObj, null, 2);
  const safeName = uploadName.value.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "preset";
  const fileName = `preset-${safeName}.json`;

  if (isDesktop) {
    // 桌面端：走系统保存对话框
    try {
      const filePath = await save({
        defaultPath: fileName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) {
        uploadStatus.value = "idle";
        return;
      }
      await writeTextFile(filePath, jsonStr);
      uploadStatus.value = "saved";
      // 打开浏览器到预设仓库
      await capabilities.openUrl("https://github.com/Flygeon/LumiLuna-Presets");
    } catch (e) {
      uploadError.value = String(e);
      uploadStatus.value = "error";
    }
  } else {
    // 浏览器预览：退化为下载方式
    try {
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      uploadStatus.value = "saved";
      // 打开浏览器到预设仓库
      window.open("https://github.com/Flygeon/LumiLuna-Presets", "_blank");
    } catch (e) {
      uploadError.value = String(e);
      uploadStatus.value = "error";
    }
  }
}

function importPreset() {
  shareStatus.value = effects.importUserPreset(importCode.value) ? "imported" : "invalid";
  if (shareStatus.value === "imported") importCode.value = "";
}

/** m3e-switch 选中态：change 由开关自身派发，e.target 即 m3e-switch */
function switchChecked(e: Event): boolean {
  return !!(e.target as HTMLElement & { checked?: boolean }).checked;
}

/** m3e-slider 当前值：值挂在 m3e-slider-thumb 上，input 由 thumb 冒泡到外层 slider */
function sliderValue(e: Event): number | null {
  const host = e.currentTarget as { thumb?: { value?: number | null } | null } | null;
  const v = host?.thumb?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 把滑块值（取整）交给指定 setter */
function applySlider(e: Event, setter: (v: number) => void) {
  const v = sliderValue(e);
  if (v != null) setter(Math.round(v));
}

/** EQ 第 i 段的增益 */
function applyEqBand(i: number, e: Event) {
  const v = sliderValue(e);
  if (v != null) effects.setEqBand(i, Math.round(v));
}

const frequencyLabel = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(0)}k` : String(hz));
</script>

<template>
  <div class="audio-effects-panel">
    <label class="enable-row">
      <span class="material-symbols-outlined">graphic_eq</span>
      <span class="enable-label">{{ t("player.effectsEnable") }}</span>
      <m3e-switch
        :checked="effects.config.enabled"
        @change="effects.setEnabled(switchChecked($event))"
      />
    </label>

    <fieldset class="effects-body" :disabled="!effects.config.enabled">
      <!-- 预设 -->
      <section class="ef-section">
        <h4 class="ef-title">{{ t("player.effectsPresets") }}</h4>
        <div class="preset-list">
          <m3e-filter-chip
            v-for="p in effects.builtinPresets"
            :key="p.id"
            class="chip"
            :selected="isActive(p.id)"
            @click.prevent="applyPreset(p.id)"
          >
            {{ p.name }}
          </m3e-filter-chip>
          <span
            v-for="p in effects.userPresets"
            :key="p.id"
            class="user-preset"
            :class="{ active: isActive(p.id) }"
          >
            <m3e-assist-chip class="chip user" @click="applyPreset(p.id)">
              {{ p.name }}
            </m3e-assist-chip>
            <m3e-icon-button
              class="preset-action lm-icon-btn-sm"
              size="small"
              :aria-label="t('player.effectsShare')"
              :title="t('player.effectsShare')"
              @click="showSharePopup(p.id)"
            >
              <span class="material-symbols-outlined">ios_share</span>
            </m3e-icon-button>
            <m3e-icon-button
              class="preset-action preset-delete lm-icon-btn-sm"
              size="small"
              :aria-label="t('player.effectsDelete')"
              :title="t('player.effectsDelete')"
              @click="deletePreset(p.id)"
            >
              <span class="material-symbols-outlined">close</span>
            </m3e-icon-button>
          </span>
        </div>
        <div class="save-preset">
          <m3e-form-field variant="outlined" class="preset-field">
            <label slot="label">{{ t("player.effectsSaveName") }}</label>
            <input
              v-model="newPresetName"
              :aria-label="t('player.effectsSaveName')"
              @keydown.enter="if (!$event.isComposing) savePreset();"
            />
          </m3e-form-field>
          <m3e-button variant="tonal" size="small" @click="savePreset">
            <span slot="icon" class="material-symbols-outlined">save</span>
            {{ t("player.effectsSave") }}
          </m3e-button>
        </div>
        <div class="import-preset">
          <m3e-form-field variant="outlined" class="preset-field">
            <label slot="label">{{ t("player.effectsImportCode") }}</label>
            <input
              v-model="importCode"
              :aria-label="t('player.effectsImportCode')"
              @keydown.enter="if (!$event.isComposing) importPreset();"
            />
          </m3e-form-field>
          <m3e-button variant="tonal" size="small" @click="importPreset">
            <span slot="icon" class="material-symbols-outlined">input</span>
            {{ t("player.effectsImport") }}
          </m3e-button>
        </div>
        <p v-if="shareStatus" class="share-status" :class="shareStatus">
          {{ t(`player.effectsShare${shareStatus[0].toUpperCase()}${shareStatus.slice(1)}`) }}
        </p>
      </section>

      <!-- 均衡器 -->
      <section class="ef-section">
        <h4 class="ef-title">{{ t("player.effectsEq") }}</h4>
        <div class="eq-grid">
          <label v-for="(band, i) in effects.config.eqBands" :key="band.frequency" class="eq-band">
            <span class="eq-freq">{{ frequencyLabel(band.frequency) }}</span>
            <m3e-slider orientation="vertical" :min="-12" :max="12" @input="applyEqBand(i, $event)">
              <m3e-slider-thumb :value="band.gain" />
            </m3e-slider>
            <span class="eq-value tabular-nums">{{
              band.gain > 0 ? `+${band.gain}` : band.gain
            }}</span>
          </label>
        </div>
      </section>

      <!-- 环境音效 -->
      <section class="ef-section">
        <h4 class="ef-title">{{ t("player.effectsEnvironment") }}</h4>
        <label class="slider-row">
          <span class="slider-label">
            <span class="material-symbols-outlined">sensors</span>
            {{ t("player.effectsBass") }}
          </span>
          <m3e-slider :min="-12" :max="12" @input="applySlider($event, effects.setBassBoost)">
            <m3e-slider-thumb :value="effects.config.bassBoost" />
          </m3e-slider>
          <span class="slider-value tabular-nums">{{ effects.config.bassBoost }}</span>
        </label>
        <label class="slider-row">
          <span class="slider-label">
            <span class="material-symbols-outlined">surround_sound</span>
            {{ t("player.effectsReverb") }}
          </span>
          <m3e-slider :min="0" :max="100" @input="applySlider($event, effects.setReverb)">
            <m3e-slider-thumb :value="effects.config.reverb" />
          </m3e-slider>
          <span class="slider-value tabular-nums">{{ effects.config.reverb }}</span>
        </label>
        <label class="slider-row">
          <span class="slider-label">
            <span class="material-symbols-outlined">swap_horiz</span>
            {{ t("player.effectsStereo") }}
          </span>
          <m3e-slider :min="0" :max="100" @input="applySlider($event, effects.setStereoWidth)">
            <m3e-slider-thumb :value="effects.config.stereoWidth" />
          </m3e-slider>
          <span class="slider-value tabular-nums">{{ effects.config.stereoWidth }}</span>
        </label>
      </section>

      <m3e-button class="reset" variant="text" size="small" @click="effects.resetToFlat()">
        <span slot="icon" class="material-symbols-outlined">restart_alt</span>
        {{ t("player.effectsReset") }}
      </m3e-button>
    </fieldset>

    <!-- 同一弹层承载分享与上传步骤，切换步骤保留触发器与焦点边界。 -->
    <Teleport to="body">
      <div
        v-if="sharePopupPresetId || uploadPopupPresetId"
        class="popup-overlay"
        @click.self="closeSharePopup"
      >
        <ModalSurface
          ref="shareSurface"
          class="popup-card"
          :class="{ 'upload-card': uploadPopupPresetId }"
          :label="t(uploadPopupPresetId ? 'player.effectsShareUpload' : 'player.effectsShare')"
          @close="closeSharePopup"
        >
          <h4 class="popup-title">
            {{ t(uploadPopupPresetId ? "player.effectsShareUpload" : "player.effectsShare") }}
          </h4>
          <div v-if="sharePopupPresetId" class="popup-actions">
            <m3e-button variant="tonal" @click="copyShareCode(sharePopupPresetId)">
              <span slot="icon" class="material-symbols-outlined">content_copy</span>
              {{ t("player.effectsShareCopy") }}
            </m3e-button>
            <m3e-button variant="tonal" @click="openUploadPopup(sharePopupPresetId)">
              <span slot="icon" class="material-symbols-outlined">cloud_upload</span>
              {{ t("player.effectsShareUpload") }}
            </m3e-button>
          </div>
          <template v-else>
            <p class="upload-hint">{{ t("player.effectsUploadHint") }}</p>
            <m3e-form-field class="upload-field" variant="outlined">
              <label slot="label">{{ t("player.effectsUploadName") }}</label>
              <input
                v-model="uploadName"
                :aria-label="t('player.effectsUploadName')"
                :placeholder="t('player.effectsUploadNamePlaceholder')"
              />
            </m3e-form-field>
            <m3e-form-field class="upload-field" variant="outlined">
              <label slot="label">{{ t("player.effectsUploadDesc") }}</label>
              <textarea
                v-model="uploadDesc"
                :aria-label="t('player.effectsUploadDesc')"
                :placeholder="t('player.effectsUploadDescPlaceholder')"
                rows="3"
              />
            </m3e-form-field>
            <m3e-form-field class="upload-field" variant="outlined">
              <label slot="label">{{ t("player.effectsUploadShareCode") }}</label>
              <input
                v-model="uploadShareCode"
                :aria-label="t('player.effectsUploadShareCode')"
                readonly
              />
            </m3e-form-field>
            <div v-if="uploadError" class="upload-error">{{ uploadError }}</div>
            <div v-if="uploadStatus === 'saved'" class="upload-success">
              <span class="material-symbols-outlined">check_circle</span>
              {{ t("player.effectsUploadSaved") }}
            </div>
            <div class="upload-actions">
              <m3e-button
                variant="filled"
                size="small"
                :disabled="uploadStatus === 'saving' || uploadStatus === 'saved'"
                @click="saveUploadJson"
              >
                <span
                  v-if="uploadStatus === 'saving'"
                  slot="icon"
                  class="material-symbols-outlined spinning"
                  >sync</span
                >
                <span v-else slot="icon" class="material-symbols-outlined">save</span>
                {{
                  uploadStatus === "saved"
                    ? t("player.effectsUploadSaved")
                    : t("player.effectsUploadSave")
                }}
              </m3e-button>
              <m3e-button variant="text" size="small" @click="closeSharePopup">
                {{ t("actions.cancel") }}
              </m3e-button>
            </div>
          </template>
          <m3e-icon-button
            class="popup-close lm-icon-btn-sm"
            size="small"
            :aria-label="t('actions.close')"
            :title="t('actions.close')"
            @click="closeSharePopup"
          >
            <span class="material-symbols-outlined">close</span>
          </m3e-icon-button>
        </ModalSurface>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.audio-effects-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  overflow-y: auto;
  padding: 2px 4px 12px 0;
  color: var(--md-sys-color-on-surface);
}

.enable-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  cursor: pointer;
  user-select: none;
}
.enable-row .material-symbols-outlined {
  color: var(--md-sys-color-primary);
  font-size: 22px;
}
.enable-label {
  flex: 1;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
}
/* 开关改用 @m3e/web 的 m3e-switch */
.enable-row m3e-switch {
  flex: none;
  cursor: pointer;
}

.effects-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  border: none;
  margin: 0;
  padding: 0;
}
.effects-body:disabled {
  opacity: 0.5;
}

.ef-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ef-title {
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.user-preset {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.preset-action {
  flex: none;
}
.preset-delete {
  --m3e-standard-icon-button-icon-color: var(--md-sys-color-error);
}

.save-preset {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--lm-layout-control-gap);
}
.import-preset {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--lm-layout-control-gap);
}
.preset-field {
  flex: 1;
  min-width: 0;
}
.import-preset m3e-button {
  --m3e-button-small-container-height: 36px;
  --m3e-button-small-leading-space: 14px;
  --m3e-button-small-trailing-space: 14px;
  --m3e-button-small-icon-size: 17px;
}
.share-status {
  margin: -2px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.share-status.invalid,
.share-status.failed {
  color: var(--md-sys-color-error);
}
.save-preset m3e-button {
  --m3e-button-small-container-height: 36px;
  --m3e-button-small-leading-space: 14px;
  --m3e-button-small-trailing-space: 14px;
  --m3e-button-small-icon-size: 17px;
}

.eq-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
  gap: 8px;
}
.eq-band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 4px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
}
.eq-freq {
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}
/* 竖向滑块：--m3e-slider-min-width 在竖向时即 min-block-size（高度），默认 200px 会撑爆 EQ 区 */
.eq-band m3e-slider {
  --m3e-slider-min-width: 90px;
  height: 90px;
}
.eq-value {
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 2px;
}
.slider-label {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 150px;
  flex: none;
  font-size: var(--md-sys-typescale-body-small-size);
}
.slider-label .material-symbols-outlined {
  font-size: 18px;
  color: var(--md-sys-color-primary);
}
.slider-row m3e-slider {
  flex: 1;
  min-width: 0;
  --m3e-slider-min-width: 0px;
}
.slider-value {
  width: 36px;
  text-align: right;
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.reset {
  align-self: flex-start;
}

/* ---- 分享弹窗 ---- */
.popup-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--lm-layer-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lm-overlay-scrim);
  backdrop-filter: blur(2px);
  animation: popup-fade 180ms var(--md-sys-motion-spring-effects-fast);
}
@keyframes popup-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.popup-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 380px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  padding: var(--lm-space-24);
  border-radius: var(--lm-shape-dialog);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-elevation-3);
  animation: popup-scale 220ms var(--md-sys-motion-spring-spatial);
}
@keyframes popup-scale {
  from {
    transform: scale(0.92);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
.popup-title {
  margin: 0;
  padding-inline-end: var(--lm-space-32);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.popup-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.popup-close {
  position: absolute;
  top: var(--lm-space-12);
  right: var(--lm-space-12);
}

/* ---- 上传弹窗 ---- */
.upload-card {
  width: 440px;
}
.upload-hint {
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  line-height: 1.5;
}
.upload-field {
  width: 100%;
}
.upload-field textarea {
  resize: vertical;
}
.upload-error {
  padding: 8px 12px;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: var(--md-sys-typescale-body-small-size);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.upload-success {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: var(--md-sys-typescale-body-small-size);
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}
.upload-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
/* chip 本体交给 m3e-filter-chip / m3e-assist-chip（选中态即 M3 规范：secondary-container 底 +
   on-secondary-container 文字 + 无描边，与改造前 .chip.active 一致）；
   下面把度量对齐改造前的 .chip（含选中时组件会占用 icon 槽展示勾选标记所需的 with-icon 内边距） */
.preset-list m3e-filter-chip {
  --m3e-chip-container-height: 30px;
  --m3e-chip-padding-start: 14px;
  --m3e-chip-padding-end: 14px;
  --m3e-chip-with-icon-padding-start: 14px;
  --m3e-chip-with-icon-padding-end: 14px;
  --m3e-chip-unselected-state-layer-hover-color: var(--md-sys-color-surface-container-high);
}
</style>
