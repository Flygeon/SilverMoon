<script setup lang="ts">
/**
 * 聚合搜索播放源底部面板（照 Kazumi SourceSheet 复刻）：
 * 以番剧中文名（无则原语名）并行查询全部已启用规则源，每个源一张卡：
 * 头（源名 + 状态：检索中/无结果/N 条/检索失败）+ 命中条目行（点击 → 选该源）。
 * 卡片头部更多操作：别名检索 / 手动检索 / 在浏览器中打开。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ModalSurface from "./ModalSurface.vue";
import SearchField from "./SearchField.vue";
import { useSettingsStore } from "@/stores/settings";
import { useAnimeStore } from "@/stores/anime";
import { translate } from "@shared/i18n";
import { capabilities } from "@/capabilities";
import { normalizeRule, renderTemplate } from "@/utils/animeRules";
import type { AnimeSearchItem, BangumiSubject } from "@shared/types";

const props = defineProps<{
  /** 聚合搜索的关键字（中文名优先） */
  keyword: string;
  /** 当前条目（别名列表用来做「别名检索」） */
  subject: BangumiSubject | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "pick", pluginName: string, item: AnimeSearchItem): void;
}>();

const settings = useSettingsStore();
const anime = useAnimeStore();
const t = (key: string) => translate(settings.lang, key);

/** 有结果的源默认展开；显式开合优先于结果状态。 */
const expanded = ref<Record<string, boolean>>({});
/** 展开「更多操作」行的源 */
const moreOpen = ref<Set<string>>(new Set());
/** 「手动检索」输入框的关键字 */
const manualKeyword = ref<Record<string, string>>({});
/**
 * 顶部关键字输入框（改它 → 重查全部源）。
 *
 * 存在的理由：关键字可能压根没定下来（例如从观看历史续播时 Bangumi 详情
 * 还没拉到），此时聚合搜索会被拦下、卡片区一片空白。没有这个输入框用户
 * 就只能在每张卡里逐个手动检索，等于卡死。
 */
const topKeyword = ref(props.keyword);

function doRequeryAll() {
  const kw = topKeyword.value.trim();
  if (!kw) return;
  void anime.requeryAllSources(kw);
}

function statusInfo(result: (typeof anime.sourceSearch)[number]): {
  text: string;
  error?: boolean;
} {
  switch (result.status) {
    case "pending":
      return { text: t("anime.sourcePending") };
    case "success":
      return { text: `${result.items.length} ${t("anime.sourceResultCount")}` };
    case "error":
      return { text: result.message || t("anime.sourceError"), error: true };
    default:
      return {
        text: result.message
          ? `${t("anime.sourceNoResult")} · ${result.message}`
          : t("anime.sourceNoResult"),
      };
  }
}

/** 某源是否已展开（默认展开所有有结果的卡） */
function isExpanded(name: string) {
  if (Object.prototype.hasOwnProperty.call(expanded.value, name)) return expanded.value[name];
  const r = anime.sourceSearch.find((s) => s.pluginName === name);
  return r?.status === "success" && r.items.length > 0;
}

function toggle(name: string) {
  expanded.value = { ...expanded.value, [name]: !isExpanded(name) };
}

function toggleMore(name: string) {
  const next = new Set(moreOpen.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  moreOpen.value = next;
}

function pick(pluginName: string, item: AnimeSearchItem) {
  emit("pick", pluginName, item);
}

/** 别名检索：在别名 list 里挑一个，重新查该源（结果替换该卡） */
function doAliasSearch(pluginName: string, alias: string) {
  moreOpen.value = new Set();
  void anime.requerySingleSource(pluginName, alias);
}

/** 手动检索：自定义关键字重查该源 */
function doManualSearch(pluginName: string) {
  const kw = (manualKeyword.value[pluginName] ?? "").trim();
  if (!kw) return;
  moreOpen.value = new Set();
  void anime.requerySingleSource(pluginName, kw);
}

/** 在系统浏览器打开该源按关键字搜索的页面（照 Kazumi 在浏览器中打开） */
function openInBrowser(pluginName: string) {
  const entry = anime.rules.find((r) => r.name === pluginName);
  let url = "";
  if (entry?.json) {
    try {
      const rule = normalizeRule(JSON.parse(entry.json));
      if (rule.searchURL) url = renderTemplate(rule.searchURL, { keyword: props.keyword });
      else url = rule.baseURL;
    } catch {
      url = "";
    }
  }
  moreOpen.value = new Set();
  if (url) void capabilities.openUrl(url);
}

/** 当前卡片没有结果时可提示的别名（照 Kazumi 别名检索候选） */
const aliasList = computed(() => props.subject?.alias?.slice(0, 12) ?? []);

// ---- 底部面板开合（自绘，不依赖 @m3e/web 的 bottom-sheet）----
//
// 为什么自绘：@m3e/web 的 m3e-bottom-sheet 依赖原生 Popover API，show() 只设
// open=true，真正的显示发生在 updated() 里无条件的 showPopover()；元素在「打开
// 瞬间」被 Vue/Lit 时序错开（KeepAlive 移出/移回、SegmentedTabs 过渡）时会抛
// InvalidStateError 或被静默吞掉，表现为「点开始观看毫无反应」。自绘面板用
// Teleport 挂到 body，不触碰 popover / 顶层；焦点、背景 inert 和锁滚由 ModalSurface 负责。

const opened = ref(false);
let openFrame = 0;

/** 挂载即打开：父用 v-if 控制挂载，挂载后下一帧置 opened 触发入场过渡 */
onMounted(() => {
  openFrame = requestAnimationFrame(() => {
    opened.value = true;
  });
});

onBeforeUnmount(() => {
  cancelAnimationFrame(openFrame);
});

/** 请求关闭：先播收起动画，动画结束（after-leave）再由模板 emit('close') 通知父卸载 */
function requestClose() {
  opened.value = false;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-scrim">
      <div v-if="opened" class="sheet-scrim" @click="requestClose"></div>
    </Transition>
    <Transition name="sheet-panel" @after-leave="emit('close')">
      <ModalSurface
        v-if="opened"
        class="source-sheet"
        :label="t('anime.sourceSheetTitle')"
        @close="requestClose"
      >
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-head">
          <span class="sheet-title">{{ t("anime.sourceSheetTitle") }}</span>
          <m3e-icon-button :aria-label="t('anime.exit')" @click="requestClose">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </m3e-icon-button>
        </div>

        <div class="sheet-body">
          <div class="kw-row">
            <SearchField
              v-model="topKeyword"
              :placeholder="t('anime.manualSearch')"
              :clear-label="t('actions.clearSearch')"
              @submit="doRequeryAll"
            />
            <m3e-button
              variant="tonal"
              size="small"
              :disabled="anime.sourceSearching"
              @click="doRequeryAll"
            >
              <span v-if="anime.sourceSearching" slot="icon" class="material-symbols-outlined spin"
                >progress_activity</span
              >
              <span v-else slot="icon" class="material-symbols-outlined">search</span>
            </m3e-button>
          </div>

          <p v-if="anime.sourceSearchError" class="state error">
            {{ anime.sourceSearchError }}
          </p>

          <p v-else-if="anime.sourceSearching && !anime.sourceSearch.length" class="state">
            {{ t("anime.choosingSource") }}
          </p>

          <div v-else-if="!anime.sourceSearch.length" class="state">
            {{ t("anime.noSource") }}
          </div>

          <div v-else class="cards">
            <m3e-card
              v-for="result in anime.sourceSearch"
              :key="result.pluginName"
              class="card"
              variant="filled"
            >
              <!-- 卡片头：源名 + 状态 -->
              <button
                type="button"
                class="card-head"
                :aria-expanded="isExpanded(result.pluginName)"
                @click="toggle(result.pluginName)"
              >
                <span class="src-name">{{ result.pluginName }}</span>
                <span
                  class="src-status"
                  :class="{ error: statusInfo(result).error }"
                  :title="statusInfo(result).text"
                  >{{ statusInfo(result).text }}</span
                >
                <span v-if="result.status === 'pending'" class="material-symbols-outlined spin"
                  >progress_activity</span
                >
                <span v-else class="material-symbols-outlined chevron">expand_more</span>
              </button>

              <!-- 命中条目 -->
              <button
                v-for="(item, i) in result.items.slice(0, 12)"
                v-show="isExpanded(result.pluginName)"
                :key="i"
                type="button"
                class="result-row"
                @click="pick(result.pluginName, item)"
              >
                <span class="row-name">{{ item.name }}</span>
                <span class="material-symbols-outlined">play_arrow</span>
              </button>

              <!-- 更多操作 -->
              <div v-show="isExpanded(result.pluginName)" class="more-area">
                <m3e-icon-button
                  class="more-toggle lm-icon-btn-sm"
                  size="small"
                  :aria-label="t('actions.more')"
                  :title="t('actions.more')"
                  :aria-expanded="moreOpen.has(result.pluginName)"
                  @click="toggleMore(result.pluginName)"
                >
                  <span class="material-symbols-outlined">more_vert</span>
                </m3e-icon-button>

                <div v-if="moreOpen.has(result.pluginName)" class="more-panel">
                  <div class="more-actions">
                    <m3e-button
                      v-if="aliasList.length"
                      variant="outlined"
                      size="small"
                      @click="doAliasSearch(result.pluginName, aliasList[0])"
                    >
                      {{ t("anime.aliasSearch") }}
                    </m3e-button>
                    <m3e-button
                      variant="outlined"
                      size="small"
                      @click="doManualSearch(result.pluginName)"
                    >
                      {{ t("anime.manualSearch") }}
                    </m3e-button>
                    <m3e-button
                      variant="outlined"
                      size="small"
                      @click="openInBrowser(result.pluginName)"
                    >
                      {{ t("anime.openInBrowser") }}
                    </m3e-button>
                  </div>
                  <div v-if="aliasList.length" class="alias-row">
                    <m3e-assist-chip
                      v-for="a in aliasList"
                      :key="a"
                      @click="doAliasSearch(result.pluginName, a)"
                      >{{ a }}</m3e-assist-chip
                    >
                  </div>
                  <div class="manual-row">
                    <SearchField
                      :model-value="manualKeyword[result.pluginName] || ''"
                      :placeholder="t('anime.manualSearch')"
                      :clear-label="t('actions.clearSearch')"
                      @update:model-value="manualKeyword[result.pluginName] = $event"
                      @submit="doManualSearch(result.pluginName)"
                    />
                    <m3e-button
                      variant="tonal"
                      size="small"
                      @click="doManualSearch(result.pluginName)"
                    >
                      <span slot="icon" class="material-symbols-outlined">search</span>
                    </m3e-button>
                  </div>
                </div>
              </div>
            </m3e-card>
          </div>
        </div>
      </ModalSurface>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 自绘底部面板：遮罩 + 面板 + 手柄 + 进出场过渡，全部由本组件负责
   （不再依赖 m3e-bottom-sheet 的 popover / inert / 拖拽手势） */
.sheet-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--lm-layer-overlay);
  background: var(--lm-overlay-scrim);
}
.sheet-scrim-enter-active,
.sheet-scrim-leave-active {
  transition: opacity 220ms ease;
}
.sheet-scrim-enter-from,
.sheet-scrim-leave-to {
  opacity: 0;
}
.source-sheet {
  position: fixed;
  left: 50%;
  bottom: 0;
  z-index: var(--lm-layer-overlay-panel);
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: min(84vh, 760px);
  padding: 6px 18px 18px;
  border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
  background: var(--md-sys-color-surface-container-high);
  box-shadow: 0 -6px 28px rgba(0, 0, 0, 0.28);
  transform: translateX(-50%);
  overflow: hidden;
}
.sheet-panel-enter-active,
.sheet-panel-leave-active {
  transition:
    transform 300ms var(--md-sys-motion-spring-spatial),
    opacity 200ms ease;
}
.sheet-panel-enter-from,
.sheet-panel-leave-to {
  transform: translateX(-50%) translateY(100%);
  opacity: 0.5;
}
.sheet-handle {
  flex: none;
  width: 32px;
  height: 4px;
  margin: 8px auto 10px;
  border-radius: 999px;
  background: var(--md-sys-color-on-surface-variant);
  opacity: 0.4;
}
.sheet-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.sheet-title {
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.state {
  padding: 32px 0;
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: pre-line;
}
.state.error {
  padding: 16px 0;
  color: var(--md-sys-color-error);
}
.kw-row {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.kw-row > :first-child {
  flex: 1;
  min-width: 0;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  /* 源结果卡是「贴合式」卡片（头的按钮 / 结果行自带内边距），故用 m3e-card 的默认槽
     （默认槽不带内边距），并保留宿主圆角 + 溢出裁剪，让贴合内容也贴齐圆角 */
  border-radius: var(--md-sys-shape-corner-extra-large);
  overflow: hidden;
  --m3e-card-shape: var(--md-sys-shape-corner-extra-large);
  --m3e-filled-card-container-color: var(--md-sys-color-surface-container);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 14px;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.card-head:hover {
  background: var(--md-sys-color-surface-container-high);
}
.src-name {
  flex: 1;
  min-width: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.src-status {
  flex: none;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
  max-width: 48%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.src-status.error {
  color: var(--md-sys-color-error);
}
.card-head .material-symbols-outlined {
  flex: none;
  font-size: 18px;
  color: var(--md-sys-color-on-surface-variant);
}
.card-head .chevron {
  transition: transform 220ms var(--md-sys-motion-spring-spatial-fast);
}
.spin {
  animation: lm-spin 1s linear infinite;
}
.result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-top: 1px solid var(--lm-hairline);
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.result-row:hover {
  background: var(--md-sys-color-surface-container-high);
}
.row-name {
  flex: 1;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-row .material-symbols-outlined {
  flex: none;
  font-size: 18px;
  color: var(--md-sys-color-primary);
}
.more-area {
  position: relative;
  border-top: 1px solid var(--lm-hairline);
  padding: 6px 8px;
}
.more-toggle {
  margin-left: auto;
}
.more-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 8px 10px;
}
.more-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.alias-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.manual-row {
  display: flex;
  align-items: center;
  gap: var(--lm-layout-control-gap);
}
.manual-row > :first-child {
  flex: 1;
  min-width: 0;
}
</style>
