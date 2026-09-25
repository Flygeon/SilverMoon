<script setup lang="ts">
/**
 * osu! 谱面下载（百宝箱 → 更多工具）。
 *
 * 后端链路（backend/src/osu.rs）：三源搜索 → 多镜像下载 .osz → 解压解析
 * .osu → 音频转 mp3 → 写 ID3（含封面）→ 入曲库；进度经 `osu:progress` 回推。
 *
 * 封面说明：osu! 的封面图（assets.ppy.sh）在本应用里取不到（参考实现同样取不到），
 * 因此一律显示占位图，不做任何封面请求。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore, type OsuMirror } from "@/stores/settings";
import { useLibraryStore } from "@/stores/library";
import { translate } from "@shared/i18n";
import { capabilities } from "@/capabilities";
import type { OsuBeatmapset, OsuProgress } from "@shared/types";

const router = useRouter();
const settings = useSettingsStore();
const library = useLibraryStore();
const t = (key: string) => translate(settings.lang, key);

const keyword = ref("");
const searching = ref(false);
const items = ref<OsuBeatmapset[]>([]);
const sourceErrors = ref<string[]>([]);
const message = ref("");
const errorMsg = ref("");
/** 正在下载的谱面集 ID（同时只允许一个，后端也串行化导入） */
const busyId = ref("");
const progress = ref<OsuProgress | null>(null);

const mirrors: { value: OsuMirror; label: string }[] = [
  { value: "auto", label: "osu.mirrorAuto" },
  { value: "official", label: "osu.mirrorOfficial" },
  { value: "sayobot", label: "osu.mirrorSayobot" },
  { value: "catboy", label: "osu.mirrorCatboy" },
  { value: "nerinyan", label: "osu.mirrorNerinyan" },
];

let unlisten: (() => void) | null = null;

async function doSearch() {
  const q = keyword.value.trim();
  if (!q || searching.value) return;
  searching.value = true;
  errorMsg.value = "";
  sourceErrors.value = [];
  items.value = [];
  try {
    const res = await capabilities.osuSearch(q, 24);
    items.value = res.items;
    sourceErrors.value = res.errors ?? [];
    if (!items.value.length) message.value = t("osu.noResult");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    searching.value = false;
  }
}

async function download(item: OsuBeatmapset) {
  if (busyId.value) return;
  busyId.value = item.id;
  errorMsg.value = "";
  message.value = "";
  progress.value = { beatmapsetId: item.id, stage: "downloading", message: "", percent: 0 };
  try {
    const res = await capabilities.osuDownload(
      item.id,
      settings.osuMirror,
      settings.osuOutDir || undefined,
    );
    message.value = `${t("osu.imported")}：${res.title}`;
    // 曲库列表立刻刷新，导入的曲目马上可见（无需手动重扫）
    void library.refresh("audio");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = "";
    progress.value = null;
  }
}

async function importLocalArchive() {
  if (busyId.value) return;
  const path = await capabilities.pickOsuArchive();
  if (!path) return;
  busyId.value = "__local__";
  errorMsg.value = "";
  message.value = "";
  progress.value = { beatmapsetId: "", stage: "extracting", message: "", percent: 0 };
  try {
    const res = await capabilities.osuImportArchive(path, settings.osuOutDir || undefined);
    message.value = `${t("osu.imported")}：${res.title}`;
    void library.refresh("audio");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = "";
    progress.value = null;
  }
}

async function pickDir() {
  const dir = await capabilities.pickDirectory();
  if (dir) {
    settings.osuOutDir = dir;
  }
}

function openPage(item: OsuBeatmapset) {
  void capabilities.openUrl(item.pageUrl).catch(() => {});
}

onMounted(async () => {
  unlisten = await capabilities.onOsuProgress((p) => {
    progress.value = p;
  });
});

onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
});
</script>

<template>
  <div class="osu-view">
    <div class="osu-head">
      <m3e-icon-button size="small" @click="router.back()">
        <span class="material-symbols-outlined">arrow_back</span>
      </m3e-icon-button>
      <h2 class="page-title">{{ t("osu.title") }}</h2>
    </div>
    <p class="page-hint">{{ t("osu.desc") }}</p>

    <div class="osu-tools">
      <div class="osu-search">
        <span class="material-symbols-outlined">search</span>
        <input
          v-model="keyword"
          type="text"
          :placeholder="t('osu.searchPlaceholder')"
          @keydown.enter="doSearch"
        />
        <m3e-button variant="filled" size="small" :disabled="searching" @click="doSearch">
          {{ searching ? t("osu.searching") : t("osu.search") }}
        </m3e-button>
      </div>
      <div class="osu-options">
        <label class="opt">
          <span class="opt-label">{{ t("osu.mirror") }}</span>
          <select v-model="settings.osuMirror" class="osu-select">
            <option v-for="m in mirrors" :key="m.value" :value="m.value">
              {{ t(m.label) }}
            </option>
          </select>
        </label>
        <label class="opt grow">
          <span class="opt-label">{{ t("osu.outDir") }}</span>
          <span class="dir-value" :title="settings.osuOutDir || t('osu.outDirAuto')">
            {{ settings.osuOutDir || t("osu.outDirAuto") }}
          </span>
          <m3e-button variant="text" size="small" @click="pickDir">
            {{ t("osu.pickDir") }}
          </m3e-button>
        </label>
        <m3e-button
          variant="outlined"
          size="small"
          :disabled="!!busyId"
          @click="importLocalArchive"
        >
          <span slot="icon" class="material-symbols-outlined">folder_open</span>
          {{ t("osu.importLocal") }}
        </m3e-button>
      </div>
    </div>

    <div v-if="errorMsg" class="osu-bar error">
      <span class="material-symbols-outlined">error</span>
      <span>{{ errorMsg }}</span>
    </div>
    <div v-else-if="message" class="osu-bar ok">
      <span class="material-symbols-outlined">check_circle</span>
      <span>{{ message }}</span>
    </div>
    <div v-else-if="sourceErrors.length" class="osu-bar warn">
      <span class="material-symbols-outlined">info</span>
      <span>{{ sourceErrors.join(" | ") }}</span>
    </div>

    <div v-if="progress" class="osu-progress">
      <div class="bar">
        <div class="fill" :style="{ width: `${Math.max(2, progress.percent)}%` }" />
      </div>
      <span class="pg-text">
        {{ progress.message || progress.stage }} · {{ Math.round(progress.percent) }}%
      </span>
    </div>

    <p v-if="!items.length && !searching" class="osu-empty">{{ t("osu.empty") }}</p>
    <ul v-else class="osu-list">
      <li v-for="item in items" :key="item.id" class="osu-item">
        <!-- 封面一律占位（osu! 封面图在本应用取不到，不做请求） -->
        <div class="cover">
          <span class="material-symbols-outlined">music_note</span>
        </div>
        <div class="meta">
          <span class="title" :title="item.title">{{ item.title }}</span>
          <span class="sub">
            <span v-if="item.uploader">{{ item.uploader }} · </span>
            <span class="src">{{ item.source }}</span>
          </span>
        </div>
        <div class="acts">
          <m3e-icon-button size="small" :title="t('osu.openPage')" @click="openPage(item)">
            <span class="material-symbols-outlined">open_in_new</span>
          </m3e-icon-button>
          <m3e-button variant="filled" size="small" :disabled="!!busyId" @click="download(item)">
            <span slot="icon" class="material-symbols-outlined">download</span>
            {{ busyId === item.id ? t("osu.searching") : t("osu.download") }}
          </m3e-button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.osu-view {
  max-width: 760px;
  margin: 0 auto;
}
.osu-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.osu-head .page-title {
  flex: 1;
  margin: 0;
  font-size: var(--md-sys-typescale-title-large-size);
  font-weight: var(--md-sys-typescale-title-large-weight);
}
.page-hint {
  margin: 4px 0 16px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.osu-tools {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.osu-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 14px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-highest);
}
.osu-search .material-symbols-outlined {
  font-size: 20px;
  color: var(--md-sys-color-on-surface-variant);
}
.osu-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-family: inherit;
}

.osu-options {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--md-sys-typescale-label-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.opt.grow {
  flex: 1;
  min-width: 0;
}
.opt-label {
  flex: none;
}
.dir-value {
  max-width: 240px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--md-sys-color-on-surface);
}
.osu-select {
  padding: 6px 12px;
  border: none;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  outline: none;
}
.osu-select:hover {
  background: var(--md-sys-color-surface-container-highest);
}

.osu-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: var(--lm-shape-card);
  font-size: var(--md-sys-typescale-body-small-size);
  word-break: break-all;
}
.osu-bar.ok {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.osu-bar.error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.osu-bar.warn {
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}

.osu-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.osu-progress .bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-highest);
  overflow: hidden;
}
.osu-progress .fill {
  height: 100%;
  border-radius: 999px;
  background: var(--md-sys-color-primary);
  transition: width 200ms ease;
}
.pg-text {
  flex: none;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.osu-empty {
  margin: 28px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.osu-list {
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.osu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container);
}
.osu-item .cover {
  flex: none;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.osu-item .cover .material-symbols-outlined {
  font-size: 26px;
}
.osu-item .meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.osu-item .title {
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.osu-item .sub {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.osu-item .src {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.osu-item .acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
