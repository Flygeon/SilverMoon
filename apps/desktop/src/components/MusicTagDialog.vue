<script setup lang="ts">
/**
 * 「写音乐标签」对话框。
 *
 * 这里只做状态绑定与渲染：真正的能力调用序列都在 `useMusicTagDialog` 的导出函数里
 * （applyTagDialog / resetTagDialog / searchTagCandidates …），组件负责把它们接到按钮上
 * 并把结果翻译成 toast。
 *
 * 自绘遮罩 + 面板（同 SourceSheet）：@m3e/web 的弹出层依赖原生 Popover API，在
 * 打开瞬间遇到 keep-alive / 过渡时会抛 InvalidStateError；标签表单重、要能滚，
 * 自己控制层级与滚动更稳。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { translate } from "@shared/i18n";
import { useSettingsStore } from "@/stores/settings";
import { useAppToast } from "@/components/AppToast.vue";
import { fieldsDirty } from "@/utils/musicTagDraft";
import { musicTagSourceLabelKey } from "@/utils/musicTagSources";
import {
  MUSIC_TAG_MODE_OPTIONS,
  applyTagDialog,
  chooseCoverFile,
  closeMusicTagDialog,
  fetchLyricsForResult,
  keepCover,
  pickSearchResult,
  removeCover,
  resetTagDialog,
  searchTagCandidates,
  useMusicTagDialog,
} from "@/composables/useMusicTagDialog";
import type { MusicTagFields, MusicTagSearchResult } from "@shared/types";

const settings = useSettingsStore();
const dialog = useMusicTagDialog();
const { show } = useAppToast();

function t(key: string): string {
  return translate(settings.lang, key);
}

/** 表单里逐字段渲染（label 走冻结的 i18n 键名） */
const FIELDS: { key: keyof MusicTagFields; label: string }[] = [
  { key: "title", label: "musicTag.title" },
  { key: "artist", label: "musicTag.artist" },
  { key: "album", label: "musicTag.album" },
  { key: "albumArtist", label: "musicTag.albumArtist" },
  { key: "year", label: "musicTag.year" },
  { key: "trackNo", label: "musicTag.trackNo" },
  { key: "discNo", label: "musicTag.discNo" },
  { key: "genre", label: "musicTag.genre" },
  { key: "comment", label: "musicTag.comment" },
];
/** 歌词单独用 textarea 渲染在字段区末尾 */
const TEXTAREAS = ["lyrics"] as const;

const targetKind = computed(() => dialog.target?.kind ?? "local");
const dirty = computed(() => fieldsDirty(dialog.fields, dialog.original));
/** 本地无备份时「还原默认」只是丢弃本次编辑，仍有意义，故不置灰 */
const canReset = computed(
  () => targetKind.value === "online" || dialog.hasLocalBackup || dirty.value,
);
/** 表单有改动、或封面被改成 set/remove，都算可应用 */
const canApply = computed(() => dirty.value || dialog.coverMode !== "keep");
/** 封面状态文案：保留 / 已选新图 / 将删除 */
const coverStatusText = computed(() => {
  if (dialog.coverMode === "remove") return t("musicTag.removeCover");
  if (dialog.coverPreview) return t("musicTag.pickCover");
  // 本地读不到封面 dataURL，只有在线歌曲能预览平台封面
  return dialog.target?.kind === "online" ? t("musicTag.cover") : t("musicTag.coverKeep");
});

/** 预览图：新选的图优先，其次在线歌曲的平台封面（本地封面路径拿不到 dataURL） */
const coverPreview = computed(() => {
  if (dialog.coverPreview) return dialog.coverPreview;
  if (dialog.coverMode === "remove") return "";
  if (dialog.target?.kind === "online") return dialog.target.song.pic;
  return "";
});

/** 面板开合过渡 + 锁背景滚动 + Esc 关闭 */
const opened = ref(false);
let prevOverflow = "";

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

watch(
  () => dialog.visible,
  (v) => {
    if (v) {
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", onKeydown);
      requestAnimationFrame(() => (opened.value = true));
    } else {
      opened.value = false;
      window.removeEventListener("keydown", onKeydown);
      document.body.style.overflow = prevOverflow;
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = prevOverflow;
});

function close() {
  closeMusicTagDialog();
}

async function onApply() {
  const kind = targetKind.value;
  const r = await applyTagDialog();
  if (!r.ok) {
    show(r.error || t("musicTag.applyFailed"), { tone: "error" });
    return; // 失败不关窗
  }
  show(kind === "local" ? t("musicTag.applied") : t("musicTag.onlineCached"));
  close();
}

async function onReset() {
  const r = await resetTagDialog();
  if (!r.ok) {
    show(r.error || t("musicTag.resetFailed"), { tone: "error" });
    return;
  }
  if (r.mode === "online") show(t("musicTag.resetOnline"));
  else if (r.mode === "backup") show(t("musicTag.resetLocalBackup"));
  else show(t("musicTag.resetLocalOriginal"));
  // original 模式要留在窗内让用户看到表单已回滚，另两种已经复位完成
  if (r.mode !== "original") close();
}

async function onSearch() {
  const err = await searchTagCandidates();
  if (err) {
    show(err, { tone: "error" });
    return;
  }
  if (!dialog.results.length) show(t("musicTag.noResults"));
}

async function onFetchLyrics(result: MusicTagSearchResult) {
  pickSearchResult(result);
  const err = await fetchLyricsForResult(result);
  if (err) show(err, { tone: "error" });
}

async function onPickCover() {
  const err = await chooseCoverFile();
  if (err) show(err, { tone: "error" });
}
</script>

<template>
  <Teleport to="body">
    <Transition name="mtd-scrim">
      <div v-if="opened" class="mtd-scrim" @click="close"></div>
    </Transition>
    <Transition name="mtd-panel">
      <div
        v-if="opened"
        class="music-tag-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('musicTag.dialogTitle')"
      >
        <header class="mtd-head">
          <span class="material-symbols-outlined head-icon">sell</span>
          <div class="head-main">
            <h2 class="head-title">{{ t("musicTag.dialogTitle") }}</h2>
            <div class="head-sub">
              <span class="kind-chip">{{
                t(targetKind === "local" ? "musicTag.targetLocal" : "musicTag.targetOnline")
              }}</span>
              <span class="head-name">{{ dialog.target?.label ?? "" }}</span>
            </div>
          </div>
          <button class="mtd-close" :title="t('musicTag.close')" @click="close">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

        <div class="mtd-body">
          <!-- 1. 本地聚合搜索候选（智能匹配 = 五源并发 + 相似度打分） -->
          <section class="mtd-section">
            <h3 class="section-title">{{ t("musicTag.fetchFromApi") }}</h3>
            <div class="search-row">
              <select v-model="dialog.mode" class="mtd-select" :title="t('musicTag.source')">
                <option v-for="opt in MUSIC_TAG_MODE_OPTIONS" :key="opt.value" :value="opt.value">
                  {{ t(opt.labelKey) }}
                </option>
              </select>
              <input
                v-model="dialog.keyword"
                class="mtd-input"
                :placeholder="t('musicTag.keyword')"
                spellcheck="false"
                @keydown.enter="onSearch"
              />
              <button class="mtd-btn tonal" :disabled="dialog.searching" @click="onSearch">
                <span class="material-symbols-outlined" :class="{ spin: dialog.searching }">
                  {{ dialog.searching ? "progress_activity" : "search" }}
                </span>
                {{ dialog.searching ? t("musicTag.searching") : t("musicTag.search") }}
              </button>
            </div>
            <p v-if="dialog.error" class="mtd-error">
              <span class="material-symbols-outlined">error</span>{{ dialog.error }}
            </p>
            <!-- 单个源失败不挡搜索：只提示哪几个源没响应 -->
            <p v-if="dialog.partialError" class="mtd-partial">
              <span class="material-symbols-outlined">info</span>{{ dialog.partialError }}
            </p>
            <ul v-if="dialog.results.length" class="result-list">
              <li
                v-for="(r, i) in dialog.results"
                :key="`${r.source}:${r.songId}:${i}`"
                class="result-row"
              >
                <button class="result-main" @click="pickSearchResult(r)">
                  <span class="result-title">
                    <span class="result-source">{{ t(musicTagSourceLabelKey(r.source)) }}</span>
                    {{ r.title || "—" }}
                  </span>
                  <span class="result-sub">
                    {{ [r.artist, r.album, r.year].filter(Boolean).join(" · ") }}
                  </span>
                </button>
                <button
                  class="result-act"
                  :title="t('musicTag.lyrics')"
                  :disabled="dialog.fetchingLyrics"
                  @click="onFetchLyrics(r)"
                >
                  <span class="material-symbols-outlined">lyrics</span>
                </button>
              </li>
            </ul>
            <p v-else-if="dialog.searching" class="mtd-muted">{{ t("musicTag.searching") }}</p>
          </section>

          <!-- 2. 封面 -->
          <section class="mtd-section">
            <h3 class="section-title">{{ t("musicTag.cover") }}</h3>
            <div class="cover-row">
              <div class="cover-box">
                <img v-if="coverPreview" :src="coverPreview" alt="" />
                <span v-else class="material-symbols-outlined">album</span>
              </div>
              <div class="cover-actions">
                <span class="mtd-muted">{{ coverStatusText }}</span>
                <div class="btn-row">
                  <button class="mtd-btn outlined" @click="onPickCover">
                    <span class="material-symbols-outlined">add_photo_alternate</span>
                    {{ t("musicTag.pickCover") }}
                  </button>
                  <button
                    class="mtd-btn text"
                    :disabled="dialog.coverMode === 'remove'"
                    @click="removeCover"
                  >
                    <span class="material-symbols-outlined">hide_image</span>
                    {{ t("musicTag.removeCover") }}
                  </button>
                  <button
                    v-if="dialog.coverMode !== 'keep'"
                    class="mtd-btn text"
                    @click="keepCover"
                  >
                    <span class="material-symbols-outlined">undo</span>
                    {{ t("musicTag.coverKeep") }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- 3. 字段表单（全部可手动编辑） -->
          <section class="mtd-section">
            <h3 class="section-title">{{ t("musicTag.fields") }}</h3>
            <div class="field-grid">
              <label v-for="f in FIELDS" :key="f.key" class="mtd-field">
                <span class="mtd-label">{{ t(f.label) }}</span>
                <input
                  v-model="dialog.fields[f.key]"
                  class="mtd-input"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
            </div>
            <label v-for="key in TEXTAREAS" :key="key" class="mtd-field lyrics-field">
              <span class="mtd-label">
                {{ t("musicTag.lyrics") }}
                <span v-if="dialog.lyricsFromApi" class="lrc-tag">LRC</span>
              </span>
              <textarea
                v-model="dialog.fields[key]"
                class="mtd-input mtd-textarea"
                rows="6"
                spellcheck="false"
                :placeholder="t('musicTag.lyricsPlaceholder')"
              ></textarea>
            </label>
          </section>
        </div>

        <footer class="mtd-foot">
          <button
            class="mtd-btn text danger"
            :disabled="dialog.applying || !canReset"
            @click="onReset"
          >
            <span class="material-symbols-outlined">restart_alt</span>
            {{ t("musicTag.reset") }}
          </button>
          <div class="foot-right">
            <button class="mtd-btn text" :disabled="dialog.applying" @click="close">
              {{ t("musicTag.cancel") }}
            </button>
            <button
              class="mtd-btn filled"
              :disabled="dialog.applying || !canApply"
              @click="onApply"
            >
              <span class="material-symbols-outlined" :class="{ spin: dialog.applying }">
                {{ dialog.applying ? "progress_activity" : "save" }}
              </span>
              {{ dialog.applying ? t("musicTag.applying") : t("musicTag.apply") }}
            </button>
          </div>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mtd-scrim {
  position: fixed;
  inset: 0;
  z-index: 2500;
  background: rgba(0, 0, 0, 0.42);
}
.mtd-scrim-enter-active,
.mtd-scrim-leave-active {
  transition: opacity 200ms ease;
}
.mtd-scrim-enter-from,
.mtd-scrim-leave-to {
  opacity: 0;
}

.music-tag-dialog {
  position: fixed;
  left: 50%;
  top: 50%;
  z-index: 2501;
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100vw - 32px));
  max-height: min(88vh, 900px);
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  box-shadow: var(--md-elevation-3);
  transform: translate(-50%, -50%);
  overflow: hidden;
}
.mtd-panel-enter-active,
.mtd-panel-leave-active {
  transition:
    opacity 200ms ease,
    transform 240ms var(--md-sys-motion-spring-spatial);
}
.mtd-panel-enter-from,
.mtd-panel-leave-to {
  opacity: 0;
  transform: translate(-50%, -48%) scale(0.98);
}

/* ---- 头部 ---- */
.mtd-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 18px 12px;
}
.head-icon {
  flex: none;
  font-size: 22px;
  color: var(--md-sys-color-primary);
}
.head-main {
  flex: 1;
  min-width: 0;
}
.head-title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.head-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  min-width: 0;
}
.kind-chip {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-size: var(--md-sys-typescale-label-small-size);
}
.head-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.mtd-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}
.mtd-close:hover {
  background: var(--md-sys-color-surface-container);
}

/* ---- 可滚动主体 ---- */
.mtd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 18px 8px;
}
.mtd-section {
  padding: 12px 0;
  border-top: 1px solid var(--lm-hairline);
}
.mtd-section:first-child {
  border-top: none;
}
.section-title {
  margin: 0 0 10px;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
}
.mtd-muted {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.mtd-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.mtd-error .material-symbols-outlined {
  font-size: 18px;
}

/* 部分数据源失败的弱提示 */
.mtd-partial {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.mtd-partial .material-symbols-outlined {
  font-size: 16px;
}

/* 搜索行 */
.search-row {
  display: flex;
  gap: 8px;
}
.mtd-select,
.mtd-input {
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  outline: none;
}
.mtd-select {
  flex: none;
  width: 116px;
}
.mtd-input:focus,
.mtd-select:focus {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary);
}
.search-row .mtd-input {
  flex: 1;
}

.result-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  max-height: 210px;
  overflow-y: auto;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
}
.result-row {
  display: flex;
  align-items: center;
  border-top: 1px solid var(--lm-hairline);
}
.result-row:first-child {
  border-top: none;
}
.result-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.result-main:hover {
  background: var(--md-sys-color-surface-container-high);
}
.result-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 来源标签：五源混合结果里一眼看出这条来自哪个平台 */
.result-source {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
}
.result-sub {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-act {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-right: 8px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-primary);
  cursor: pointer;
}
.result-act:hover {
  background: var(--md-sys-color-surface-container-high);
}

/* 封面 */
.cover-row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.cover-box {
  flex: none;
  display: grid;
  place-items: center;
  width: 96px;
  height: 96px;
  border-radius: var(--md-sys-shape-corner-medium);
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-outline);
}
.cover-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-box .material-symbols-outlined {
  font-size: 30px;
}
.cover-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 表单 */
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.mtd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mtd-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.lrc-tag {
  padding: 1px 6px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.lyrics-field {
  margin-top: 10px;
}
.mtd-textarea {
  height: auto;
  padding: 10px 12px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}

/* 底部操作 */
.mtd-foot {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--lm-hairline);
}
.foot-right {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.mtd-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-primary);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.mtd-btn .material-symbols-outlined {
  font-size: 18px;
}
.mtd-btn.filled {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}
.mtd-btn.tonal {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.mtd-btn.outlined {
  border-color: var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-on-surface);
}
.mtd-btn.text:hover {
  background: var(--md-sys-color-surface-container);
}
.mtd-btn.danger {
  color: var(--md-sys-color-error);
}
.mtd-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.spin {
  animation: mtd-spin 1s linear infinite;
}
@keyframes mtd-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 窄窗：字段改单列，头部/底部不换行溢出 */
@media (max-width: 620px) {
  .field-grid {
    grid-template-columns: 1fr;
  }
  .search-row {
    flex-wrap: wrap;
  }
  .mtd-select {
    width: 100%;
  }
}
</style>
