<script setup lang="ts">
/**
 * 「写音乐标签」对话框。
 *
 * 这里只做状态绑定与渲染：真正的能力调用序列都在 `useMusicTagDialog` 的导出函数里
 * （applyTagDialog / resetTagDialog / searchTagCandidates …），组件负责把它们接到按钮上
 * 并把结果翻译成 toast。
 *
 * 保留可滚动的产品面板；焦点、背景锁与 Escape 复用 ModalSurface，
 * 输入与操作组合官方 m3e 控件，业务流程仍由原 composable 持有。
 */
import { computed } from "vue";
import ModalSurface from "@/components/ModalSurface.vue";
import SearchField from "@/components/SearchField.vue";
import SelectField from "@/components/SelectField.vue";
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
  fetchWordLyrics,
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
const modeOptions = computed(() =>
  MUSIC_TAG_MODE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
);

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
  if (dialog.searching) return;
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

/** 候选行的「逐字」按钮：优先按该候选取 QRC/KRC/yrc，没有则退它的逐行接口 */
async function onFetchWordLyrics(result: MusicTagSearchResult) {
  pickSearchResult(result);
  const err = await fetchWordLyrics(result);
  if (err) show(err, { tone: "error" });
}

/** 顶部「逐字歌词」：不挑候选，按歌名+时长走 AMLL → QQ → 酷狗 回退链 */
async function onFetchWordLyricsAuto() {
  const err = await fetchWordLyrics();
  if (err) show(err, { tone: "error" });
}

/**
 * 用户手动改歌词后清掉「来自 API / 逐字」标记。
 *
 * 标记描述的是**已取回内容**的来源；手动编辑后内容已不再等于取回结果，
 * 留着「逐字」徽标会让人误以为写进文件的是官方词级时间轴。
 * 这里挂 @input（只在用户输入时触发），取词赋值走 state 不经过 DOM 事件，不会误清。
 */
function onLyricsEdited() {
  dialog.lyricsFromApi = false;
  dialog.lyricsWordLevel = false;
}

async function onPickCover() {
  const err = await chooseCoverFile();
  if (err) show(err, { tone: "error" });
}
</script>

<template>
  <Teleport to="body">
    <Transition name="mtd-scrim">
      <div v-if="dialog.visible" class="mtd-scrim" @click="close"></div>
    </Transition>
    <Transition name="mtd-panel">
      <ModalSurface
        v-if="dialog.visible"
        class="music-tag-dialog"
        :label="t('musicTag.dialogTitle')"
        @close="close"
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
          <m3e-icon-button
            class="mtd-close lm-icon-btn-sm"
            size="small"
            :aria-label="t('musicTag.close')"
            :title="t('musicTag.close')"
            @click="close"
          >
            <span class="material-symbols-outlined">close</span>
          </m3e-icon-button>
        </header>

        <div class="mtd-body">
          <!-- 1. 本地聚合搜索候选（智能匹配 = 五源并发 + 相似度打分） -->
          <section class="mtd-section">
            <h3 class="section-title">{{ t("musicTag.fetchFromApi") }}</h3>
            <div class="search-row">
              <SelectField
                v-model="dialog.mode"
                class="mtd-select"
                :label="t('musicTag.source')"
                :options="modeOptions"
              />
              <SearchField
                v-model="dialog.keyword"
                class="mtd-search"
                :placeholder="t('musicTag.keyword')"
                :clear-label="t('actions.clearSearch')"
                :aria-busy="dialog.searching"
                @submit="onSearch"
              />
              <m3e-button
                variant="tonal"
                size="small"
                :disabled="dialog.searching"
                @click="onSearch"
              >
                <span
                  slot="icon"
                  class="material-symbols-outlined"
                  :class="{ spin: dialog.searching }"
                >
                  {{ dialog.searching ? "progress_activity" : "search" }}
                </span>
                {{ dialog.searching ? t("musicTag.searching") : t("musicTag.search") }}
              </m3e-button>
              <m3e-button
                variant="outlined"
                size="small"
                :disabled="dialog.fetchingWordLyrics"
                :title="t('musicTag.wordLyricsHint')"
                @click="onFetchWordLyricsAuto"
              >
                <span
                  slot="icon"
                  class="material-symbols-outlined"
                  :class="{ spin: dialog.fetchingWordLyrics }"
                >
                  {{ dialog.fetchingWordLyrics ? "progress_activity" : "award_star" }}
                </span>
                {{ t("musicTag.wordLyrics") }}
              </m3e-button>
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
                <button type="button" class="result-main" @click="pickSearchResult(r)">
                  <span class="result-title">
                    <span class="result-source">{{ t(musicTagSourceLabelKey(r.source)) }}</span>
                    {{ r.title || "—" }}
                  </span>
                  <span class="result-sub">
                    {{ [r.artist, r.album, r.year].filter(Boolean).join(" · ") }}
                  </span>
                </button>
                <m3e-icon-button
                  class="result-act lm-icon-btn-sm"
                  size="small"
                  :aria-label="t('musicTag.lyrics')"
                  :title="t('musicTag.lyrics')"
                  :disabled="dialog.fetchingLyrics"
                  @click="onFetchLyrics(r)"
                >
                  <span class="material-symbols-outlined">lyrics</span>
                </m3e-icon-button>
                <m3e-icon-button
                  class="result-act lm-icon-btn-sm"
                  size="small"
                  :aria-label="t('musicTag.wordLyrics')"
                  :title="t('musicTag.wordLyrics')"
                  :disabled="dialog.fetchingWordLyrics"
                  @click="onFetchWordLyrics(r)"
                >
                  <span class="material-symbols-outlined">award_star</span>
                </m3e-icon-button>
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
                  <m3e-button variant="outlined" size="small" @click="onPickCover">
                    <span slot="icon" class="material-symbols-outlined">add_photo_alternate</span>
                    {{ t("musicTag.pickCover") }}
                  </m3e-button>
                  <m3e-button
                    variant="text"
                    size="small"
                    :disabled="dialog.coverMode === 'remove'"
                    @click="removeCover"
                  >
                    <span slot="icon" class="material-symbols-outlined">hide_image</span>
                    {{ t("musicTag.removeCover") }}
                  </m3e-button>
                  <m3e-button
                    v-if="dialog.coverMode !== 'keep'"
                    variant="text"
                    size="small"
                    @click="keepCover"
                  >
                    <span slot="icon" class="material-symbols-outlined">undo</span>
                    {{ t("musicTag.coverKeep") }}
                  </m3e-button>
                </div>
              </div>
            </div>
          </section>

          <!-- 3. 字段表单（全部可手动编辑） -->
          <section class="mtd-section">
            <h3 class="section-title">{{ t("musicTag.fields") }}</h3>
            <div class="field-grid">
              <m3e-form-field v-for="f in FIELDS" :key="f.key" class="mtd-field" variant="outlined">
                <label slot="label">{{ t(f.label) }}</label>
                <input
                  v-model="dialog.fields[f.key]"
                  :aria-label="t(f.label)"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                />
              </m3e-form-field>
            </div>
            <m3e-form-field
              v-for="key in TEXTAREAS"
              :key="key"
              class="mtd-field lyrics-field"
              variant="outlined"
            >
              <label slot="label" class="mtd-label">
                {{ t("musicTag.lyrics") }}
                <!-- 逐字与逐行分开标记：用户一眼能看出写进文件的是不是词级时间轴 -->
                <span v-if="dialog.lyricsWordLevel" class="lrc-tag word">
                  {{ t("musicTag.wordLevelTag") }}
                </span>
                <span v-else-if="dialog.lyricsFromApi" class="lrc-tag">LRC</span>
              </label>
              <textarea
                v-model="dialog.fields[key]"
                class="mtd-textarea"
                :aria-label="t('musicTag.lyrics')"
                rows="6"
                spellcheck="false"
                :placeholder="t('musicTag.lyricsPlaceholder')"
                @input="onLyricsEdited"
              ></textarea>
            </m3e-form-field>
          </section>
        </div>

        <footer class="mtd-foot">
          <m3e-button
            class="danger"
            variant="text"
            size="small"
            :disabled="dialog.applying || !canReset"
            @click="onReset"
          >
            <span slot="icon" class="material-symbols-outlined">restart_alt</span>
            {{ t("musicTag.reset") }}
          </m3e-button>
          <div class="foot-right">
            <m3e-button variant="text" size="small" :disabled="dialog.applying" @click="close">
              {{ t("musicTag.cancel") }}
            </m3e-button>
            <m3e-button
              variant="filled"
              size="small"
              :disabled="dialog.applying || !canApply"
              @click="onApply"
            >
              <span
                slot="icon"
                class="material-symbols-outlined"
                :class="{ spin: dialog.applying }"
              >
                {{ dialog.applying ? "progress_activity" : "save" }}
              </span>
              {{ dialog.applying ? t("musicTag.applying") : t("musicTag.apply") }}
            </m3e-button>
          </div>
        </footer>
      </ModalSurface>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mtd-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--lm-layer-overlay);
  background: var(--lm-overlay-scrim);
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
  z-index: var(--lm-layer-overlay-panel);
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
  align-items: center;
  flex-wrap: wrap;
  gap: var(--lm-layout-control-gap);
}
.mtd-select {
  flex: none;
  width: 176px;
}
.mtd-search {
  flex: 1 1 180px;
  min-width: 0;
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
  margin-right: var(--lm-space-8);
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
  min-width: 0;
  width: 100%;
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
/* 逐字用 tertiary 区分逐行：写进文件的是词级时间轴，值得一眼看见 */
.lrc-tag.word {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}
.lyrics-field {
  margin-top: 10px;
}
.mtd-textarea {
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
.danger {
  --m3e-text-button-label-text-color: var(--md-sys-color-error);
  --m3e-text-button-icon-color: var(--md-sys-color-error);
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
