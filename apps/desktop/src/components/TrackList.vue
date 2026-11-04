<script setup lang="ts">
/**
 * 音乐列表模式：官方 m3e-list（segmented）+ m3e-list-item-button。
 *
 * 为什么不再自绘行：
 * 此前每行是一个 <div> + 手写 hover 背景色，属于「模仿 MD3」；
 * 现在托底、圆角、hover/focus/pressed 状态层、分段间距全部由 @m3e/web 提供，
 * 与设置页（SettingsView 用 m3e-list variant="segmented" 托住每行）保持同一套观感与令牌。
 *
 * 虚拟滚动保留：外界 406 首歌时仍只渲染可视区间，
 * m3e-list 只是包在 VirtualList 外层的一层容器，不参与行高计算。
 */
import { onBeforeUnmount, ref } from "vue";
import VirtualList from "@/components/VirtualList.vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { openContextMenu } from "@/composables/useContextMenu";
import { localTagTarget, openMusicTagDialog } from "@/composables/useMusicTagDialog";
import { translate } from "@shared/i18n";
import { formatDuration } from "@/utils/format";
import type { MediaEntry } from "@shared/types";

const props = defineProps<{ items: MediaEntry[] }>();

const emit = defineEmits<{
  (e: "open", item: MediaEntry, index: number): void;
  (e: "favorite", item: MediaEntry): void;
  (e: "notify", message: string): void;
}>();

const library = useLibraryStore();
const player = usePlayerStore();
const settings = useSettingsStore();

/**
 * 行高：必须与 m3e-list-item 的两行规格一致。
 * @m3e/web 对两行条目默认 min-height 72px（--m3e-list-item-two-line-height 的默认值），
 * 这里再加上 segmented 列表的行间距 8px，虚拟滚动才不会错位。
 */
const ROW_H = 80;

function t(key: string) {
  return translate(settings.lang, key);
}

function titleOf(item: MediaEntry) {
  return item.title || item.name;
}

function subtitleOf(item: MediaEntry) {
  return [item.artist, item.album].filter(Boolean).join(" · ") || "未知艺术家";
}

function thumbOf(item: MediaEntry) {
  return library.getThumb(item.id);
}

// ---- 缩略图：按 VirtualList 可视区间批量拉取（120ms 防抖，同 MediaGrid）----
const range = ref({ start: 0, end: Math.min(props.items.length, 80) });
let thumbTimer: number | null = null;

function onRangeChange(next: { start: number; end: number }) {
  range.value = next;
  if (!props.items.length) return;
  if (thumbTimer !== null) clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    thumbTimer = null;
    const ids = props.items.slice(next.start, next.end).map((item) => item.id);
    if (ids.length) void library.loadThumbnails(ids);
  }, 120);
}

onBeforeUnmount(() => {
  if (thumbTimer !== null) clearTimeout(thumbTimer);
});

// ---- 右击 / 行内操作 ----
function menuOf(item: MediaEntry) {
  return [
    { id: "play", label: t("context.play"), icon: "play_arrow" },
    { id: "play-next", label: t("context.playNext"), icon: "skip_next" },
    { id: "add-queue", label: t("context.addToQueue"), icon: "queue_music" },
    {
      id: "favorite",
      label: item.favorite ? t("context.unfavorite") : t("context.favorite"),
      icon: item.favorite ? "heart_broken" : "favorite",
    },
    { id: "reveal", label: t("context.revealInExplorer"), icon: "folder_open" },
    { id: "write-tags", label: t("musicTag.menu"), icon: "sell" },
  ];
}

function onMenuSelect(id: string, item: MediaEntry, index: number) {
  switch (id) {
    case "play":
      emit("open", item, index);
      break;
    case "play-next":
      player.playNext(item);
      emit("notify", t("actions.playNextQueued"));
      break;
    case "add-queue":
      void player.addToQueue(item);
      emit("notify", t("actions.addedToQueue"));
      break;
    case "favorite":
      emit("favorite", item);
      break;
    case "reveal":
      void capabilities.revealInExplorer(item.path);
      break;
    case "write-tags":
      openMusicTagDialog(localTagTarget(item));
      break;
    default:
      break;
  }
}

function onRowContext(e: MouseEvent, item: MediaEntry, index: number) {
  openContextMenu(e, menuOf(item), (id) => onMenuSelect(id, item, index));
}
</script>

<template>
  <!--
    segmented 列表：每行是一块独立的 MD3 托底，行间留 gap。
    这就是设置页「外观 / 语言 / 配色方案」那一组的同款容器写法。
  -->
  <m3e-list class="track-list" variant="segmented">
    <VirtualList
      :items="items"
      :item-height="ROW_H"
      :item-key="(item: MediaEntry) => item.id"
      @range-change="onRangeChange"
    >
      <template #default="{ item, index }">
        <m3e-list-item-button
          class="track-row"
          data-hero-source
          @click="emit('open', item, index)"
          @contextmenu="onRowContext($event, item, index)"
        >
          <!-- leading：封面 -->
          <div slot="leading" class="r-cover" data-hero-cover>
            <img
              v-if="thumbOf(item)"
              :src="thumbOf(item)"
              :alt="titleOf(item)"
              loading="lazy"
              decoding="async"
              draggable="false"
            />
            <span v-else class="material-symbols-outlined">music_note</span>
          </div>

          <!-- 默认槽：标题；supporting-text：艺人 · 专辑 -->
          <span class="r-title">{{ titleOf(item) }}</span>
          <span slot="supporting-text" class="r-sub">{{ subtitleOf(item) }}</span>

          <!-- trailing：时长 + 悬停操作 -->
          <div slot="trailing" class="r-trailing">
            <div class="r-actions" data-hero-skip>
              <m3e-icon-button
                size="small"
                :class="{ on: item.favorite }"
                :title="item.favorite ? t('context.unfavorite') : t('context.favorite')"
                :aria-label="item.favorite ? t('context.unfavorite') : t('context.favorite')"
                @click.stop="emit('favorite', item)"
              >
                <span class="material-symbols-outlined" :class="{ filled: item.favorite }"
                  >favorite</span
                >
              </m3e-icon-button>
              <m3e-icon-button
                size="small"
                :title="t('context.playNext')"
                :aria-label="t('context.playNext')"
                @click.stop="
                  player.playNext(item);
                  emit('notify', t('actions.playNextQueued'));
                "
              >
                <span class="material-symbols-outlined">skip_next</span>
              </m3e-icon-button>
              <m3e-icon-button
                size="small"
                :title="t('context.addToQueue')"
                :aria-label="t('context.addToQueue')"
                @click.stop="
                  void player.addToQueue(item);
                  emit('notify', t('actions.addedToQueue'));
                "
              >
                <span class="material-symbols-outlined">queue_music</span>
              </m3e-icon-button>
              <m3e-icon-button
                size="small"
                :title="t('actions.more')"
                :aria-label="t('actions.more')"
                @click.stop="onRowContext($event, item, index)"
              >
                <span class="material-symbols-outlined">more_vert</span>
              </m3e-icon-button>
            </div>
            <div class="r-duration tabular-nums">
              {{ item.durationMs ? formatDuration(item.durationMs) : "--:--" }}
            </div>
          </div>
        </m3e-list-item-button>
      </template>
    </VirtualList>
  </m3e-list>
</template>

<style scoped>
/*
 * 外层容器只负责「一段一段」的观感，托底色由 m3e-list 的 segmented variant 提供。
 * 形状收紧到卡片的圆角，与设置页保持一致（--lm-settings-group-radius 同类语义）。
 */
.track-list {
  --m3e-segmented-list-container-shape: var(--lm-shape-card);
  --m3e-segmented-list-item-container-shape: var(--lm-shape-card-inner);
  --m3e-segmented-list-item-hover-container-shape: var(--lm-shape-card-inner);
  --m3e-segmented-list-item-focus-container-shape: var(--lm-shape-card-inner);
}

/* 行：把虚拟列表的行高让给 m3e-list-item-button 自己撑满 */
.track-row {
  width: 100%;
  --m3e-list-item-padding-inline: var(--lm-space-8);
  --m3e-list-item-padding-block: var(--lm-space-4);
  --m3e-list-item-trailing-space: var(--lm-space-8);
}

.r-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--md-sys-shape-corner-small);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline);
}
.r-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.r-cover .material-symbols-outlined {
  font-size: 20px;
}

.r-title {
  display: block;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-sub {
  display: block;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.r-trailing {
  display: flex;
  align-items: center;
  gap: var(--lm-space-2);
}
/* 操作按钮常隐，悬停或键盘聚焦时出现 —— 与媒体卡片的心形按钮同一套交互习惯 */
.r-actions {
  display: flex;
  align-items: center;
  gap: var(--lm-space-2);
  opacity: 0;
  transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-spring-effects-fast);
}
.track-row:hover .r-actions,
.track-row:focus-visible .r-actions,
.track-row:focus-within .r-actions {
  opacity: 1;
}
.r-actions .on {
  color: var(--md-sys-color-error);
}
.r-duration {
  min-width: 44px;
  text-align: right;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
</style>
