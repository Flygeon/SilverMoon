<script setup lang="ts">
/**
 * 绘画 —— 图片页签下的「绘画」分段。
 *
 * 两种状态：画作列表（卡片墙 + 新增入口）/ 编辑器。
 * 编辑器经 defineAsyncComponent 按需加载：leafer-editor 压缩后约 305 KB，
 * 只在真正进入编辑器时才拉取，不进图片页的主包。
 *
 * 画作存放在 <应用数据目录>/drawings/*.png，磁盘是唯一事实来源，
 * 每次增删改后重列一次目录（见 stores/drawing.ts）。
 */
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import EmptyState from "@/components/EmptyState.vue";
import { useDrawingStore } from "@/stores/drawing";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { promptText } from "@/composables/useTextPrompt";
import { formatSize } from "@/utils/format";
import { CANVAS_PRESETS } from "@/features/drawing/types";
import type { Drawing } from "@/features/drawing/types";
import { translate } from "@shared/i18n";

const DrawingBoard = defineAsyncComponent(() => import("@/components/DrawingBoard.vue"));

const store = useDrawingStore();
const settings = useSettingsStore();

/** 编辑器会话：null 表示停在列表；drawing 为 null 表示新建 */
const session = ref<{ drawing: Drawing | null; width: number; height: number } | null>(null);
/** 新增画作时的尺寸选择对话框 */
/** m3e-dialog 的打开 / 关闭方法（它没有 v-model，只能拿实例调） */
interface M3eDialog extends HTMLElement {
  show(): Promise<void>;
  hide(returnValue?: string): Promise<void>;
}

const presetRef = ref<M3eDialog | null>(null);
const confirmRef = ref<M3eDialog | null>(null);
const pendingDelete = ref<Drawing | null>(null);
const snackOpen = ref(false);
const snackText = ref("");

function t(key: string) {
  return translate(settings.lang, key);
}

function toast(text: string) {
  snackText.value = text;
  snackOpen.value = false;
  void Promise.resolve().then(() => {
    snackOpen.value = true;
  });
}

/** m3e-snackbar 自动关闭后要把 open 同步回来，否则下次 toast 时 open 仍是 true，不会重开 */
function onSnackToggle(e: Event) {
  snackOpen.value = Boolean((e.target as HTMLElement & { open?: boolean }).open);
}

function urlOf(d: Drawing): string {
  // thumbUrl 是通用的「磁盘路径 → 可用 URL」转换（非桌面环境原样返回）
  return capabilities.thumbUrl(d.path);
}

const countText = computed(() => store.items.length + " " + t("draw.count"));

onMounted(() => {
  void store.ensure();
});

function openPresets() {
  void presetRef.value?.show();
}

function closePresets() {
  void presetRef.value?.hide();
}

function startNew(preset: (typeof CANVAS_PRESETS)[number]) {
  closePresets();
  session.value = { drawing: null, width: preset.width, height: preset.height };
}

async function openDrawing(d: Drawing) {
  const size = await store.drawingSize(d.id);
  session.value = {
    drawing: d,
    width: size.width || 1024,
    height: size.height || 1024,
  };
}

function closeEditor() {
  session.value = null;
  void store.refresh();
}

async function onSaved() {
  toast(t("draw.saved"));
}

async function onRename(d: Drawing) {
  const next = await promptText(t("draw.rename"), d.name);
  if (!next || next === d.name) return;
  try {
    await store.rename(d.id, next);
  } catch {
    toast(t("draw.renameFailed"));
  }
}

function onDelete(d: Drawing) {
  const el = confirmRef.value;
  if (!el || typeof el.show !== "function") {
    void store.remove(d.id).then(() => toast(t("draw.deleted")));
    return;
  }
  pendingDelete.value = d;
  void el.show();
}

async function confirmDelete() {
  const d = pendingDelete.value;
  pendingDelete.value = null;
  void confirmRef.value?.hide();
  if (!d) return;
  await store.remove(d.id);
  toast(t("draw.deleted"));
}

function cancelDelete() {
  pendingDelete.value = null;
  void confirmRef.value?.hide();
}
</script>

<template>
  <!-- 编辑器 -->
  <DrawingBoard
    v-if="session"
    :drawing="session.drawing"
    :canvas-width="session.width"
    :canvas-height="session.height"
    @close="closeEditor"
    @saved="onSaved"
  />

  <!-- 画作列表 -->
  <div v-else class="studio">
    <div class="bar">
      <span class="count">{{ countText }}</span>
      <span class="grow"></span>
      <m3e-button variant="filled" size="small" @click="openPresets">
        <span slot="icon" class="material-symbols-outlined">add</span>
        {{ t("draw.newDrawing") }}
      </m3e-button>
    </div>

    <div v-if="store.loading && !store.items.length" class="grid">
      <div v-for="i in 8" :key="i" class="card skeleton">
        <div class="thumb"></div>
        <div class="meta">
          <div class="sk-line"></div>
          <div class="sk-line short"></div>
        </div>
      </div>
    </div>

    <EmptyState
      v-else-if="!store.items.length"
      icon="draw"
      :title="t('draw.empty')"
      :description="t('draw.emptyHint')"
      :action-label="t('draw.newDrawing')"
      @action="openPresets"
    />

    <div v-else class="grid">
      <article
        v-for="d in store.items"
        :key="d.id"
        class="card"
        tabindex="0"
        @click="openDrawing(d)"
        @keydown.enter.prevent="openDrawing(d)"
      >
        <div class="thumb">
          <img :src="urlOf(d)" :alt="d.name" loading="lazy" decoding="async" />
          <div class="overlay">
            <button class="act" :title="t('draw.rename')" @click.stop="onRename(d)">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="act" :title="t('draw.delete')" @click.stop="onDelete(d)">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </div>
        <div class="meta">
          <div class="title" :title="d.name">{{ d.name }}</div>
          <div class="sub">{{ formatSize(d.size) }}</div>
        </div>
      </article>
    </div>

    <!-- Teleport 到 body：对话框是 fixed 层，留在页面里会被祖先的 overflow/transform 裁掉 -->
    <Teleport to="body">
      <!-- 新增：先选画布尺寸 -->
      <m3e-dialog ref="presetRef" class="preset-dialog">
        <span slot="header">{{ t("draw.chooseCanvas") }}</span>
        <div class="presets">
          <m3e-button v-for="p in CANVAS_PRESETS" :key="p.id" variant="tonal" @click="startNew(p)">
            <span slot="icon" class="material-symbols-outlined">crop_square</span>
            {{ p.label }}
          </m3e-button>
        </div>
        <div slot="actions" end>
          <m3e-button variant="text" size="small" @click="closePresets">
            {{ t("actions.cancel") }}
          </m3e-button>
        </div>
      </m3e-dialog>

      <!-- 删除确认 -->
      <m3e-dialog ref="confirmRef" class="preset-dialog">
        <span slot="header">{{ t("draw.delete") }}</span>
        <p class="confirm-text">{{ t("draw.deleteConfirm") }}</p>
        <div slot="actions" end>
          <m3e-button variant="text" size="small" @click="cancelDelete">
            {{ t("actions.cancel") }}
          </m3e-button>
          <m3e-button variant="tonal" size="small" @click="confirmDelete">
            {{ t("actions.delete") }}
          </m3e-button>
        </div>
      </m3e-dialog>
    </Teleport>

    <m3e-snackbar :open="snackOpen" :duration="2400" @toggle="onSnackToggle">
      {{ snackText }}
    </m3e-snackbar>
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.count {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}

.grow {
  flex: 1;
}

.preset-dialog {
  --m3e-dialog-min-width: 360px;
}

.presets {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.confirm-text {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
}

/* 卡片墙：与图片卡片同一套视觉令牌与悬停动效 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 20px 16px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  cursor: pointer;
  border-radius: var(--lm-shape-card);
  outline: none;
}

.card:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 4px;
}

.thumb {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  transition:
    transform 220ms var(--md-sys-motion-spring-soft),
    box-shadow 220ms var(--md-sys-motion-spring-effects-fast);
}

.card:hover .thumb {
  transform: translateY(-4px) scale(1.015);
  box-shadow:
    var(--md-elevation-3),
    inset 0 0 0 1px var(--lm-hairline);
}

.card:active .thumb {
  transform: translateY(-1px) scale(0.995);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  /* 画作多为白底，给一层浅底避免与卡片背景糊在一起 */
  background: #fff;
}

.overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.card:hover .overlay,
.card:focus-visible .overlay {
  opacity: 1;
}

.act {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-highest);
  box-shadow: var(--md-elevation-1);
}

.act:hover {
  background: var(--md-sys-color-secondary-container);
}

.act .material-symbols-outlined {
  font-size: 17px;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-size: 13px;
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

/* 骨架屏 */
.skeleton .thumb,
.sk-line {
  background: var(--md-sys-color-surface-container-high);
  animation: pulse 1.4s ease-in-out infinite;
}

.sk-line {
  height: 12px;
  border-radius: 6px;
}

.sk-line.short {
  width: 40%;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
