<script setup lang="ts">
/**
 * 图层面板（纯展示组件）。
 *
 * - `layers` 按 z 递增（0 = 最底层）传入，展示时倒序（顶层在上，对齐 PS 习惯）；
 * - 重命名走双击 → 行内 input，Enter / 失焦提交；
 * - 所有变更都经 emit 交给 DrawingBoard，由它统一推撤销历史。
 */
import { computed, nextTick, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { layerText } from "@/features/drawing/layerText";

export interface LayerItem {
  id: number;
  name: string;
  visible: boolean;
}

const props = defineProps<{
  layers: LayerItem[];
  activeId: number;
  /** 剩一个图层时不允许再删 */
  canDelete: boolean;
}>();

const emit = defineEmits<{
  (e: "select", id: number): void;
  (e: "toggle", id: number): void;
  (e: "add"): void;
  (e: "delete", id: number): void;
  (e: "up", id: number): void;
  (e: "down", id: number): void;
  (e: "rename", id: number, name: string): void;
}>();

const settings = useSettingsStore();
const t = (key: string) => layerText(settings.lang, key);

/** 展示顺序：顶层在上 */
const ordered = computed(() => props.layers.slice().reverse());

const editingId = ref<number | null>(null);
const editingName = ref("");
const editInput = ref<HTMLInputElement | null>(null);

function startRename(item: LayerItem) {
  editingId.value = item.id;
  editingName.value = item.name;
  nextTick(() => {
    editInput.value?.focus();
    editInput.value?.select();
  });
}

function commitRename(item: LayerItem) {
  if (editingId.value !== item.id) return;
  editingId.value = null;
  const name = editingName.value.trim();
  if (name && name !== item.name) emit("rename", item.id, name);
}

function cancelRename() {
  editingId.value = null;
}
</script>

<template>
  <div class="layer-panel">
    <div class="layer-head">
      <h3 class="layer-title">{{ t("draw.layers") }}</h3>
      <m3e-icon-button size="small" :title="t('draw.addLayer')" @click="emit('add')">
        <span class="material-symbols-outlined">add</span>
      </m3e-icon-button>
    </div>
    <m3e-list class="layer-list">
      <m3e-list-item
        v-for="(item, i) in ordered"
        :key="item.id"
        class="layer-item"
        :class="{ active: item.id === activeId, hidden: !item.visible }"
        @click="emit('select', item.id)"
        @dblclick="startRename(item)"
      >
        <template #leading
          ><span class="layer-eye">
            <m3e-icon-button
              size="small"
              :title="t('draw.toggleLayer')"
              @click.stop="emit('toggle', item.id)"
            >
              <span class="material-symbols-outlined">{{
                item.visible ? "visibility" : "visibility_off"
              }}</span>
            </m3e-icon-button>
          </span></template
        >
        <input
          v-if="editingId === item.id"
          ref="editInput"
          v-model="editingName"
          class="layer-rename"
          :placeholder="t('draw.layerNamePlaceholder')"
          maxlength="32"
          @click.stop
          @keydown.enter="commitRename(item)"
          @keydown.escape="cancelRename"
          @blur="commitRename(item)"
        />
        <span v-else class="layer-name" :title="t('draw.renameLayer')">{{ item.name }}</span>
        <template #trailing
          ><span class="layer-actions">
            <m3e-icon-button
              size="small"
              :title="t('draw.moveLayerUp')"
              :disabled="i === 0"
              @click.stop="emit('up', item.id)"
            >
              <span class="material-symbols-outlined">arrow_upward</span>
            </m3e-icon-button>
            <m3e-icon-button
              size="small"
              :title="t('draw.moveLayerDown')"
              :disabled="i === ordered.length - 1"
              @click.stop="emit('down', item.id)"
            >
              <span class="material-symbols-outlined">arrow_downward</span>
            </m3e-icon-button>
            <m3e-icon-button
              size="small"
              :title="t('draw.deleteLayer')"
              :disabled="!canDelete"
              @click.stop="emit('delete', item.id)"
            >
              <span class="material-symbols-outlined">delete</span>
            </m3e-icon-button>
          </span></template
        >
      </m3e-list-item>
    </m3e-list>
  </div>
</template>

<style scoped>
.layer-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.layer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.layer-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
}

.layer-list {
  max-height: 260px;
  overflow-y: auto;
}

.layer-item {
  --m3e-list-item-trailing-gap: 0;
  cursor: pointer;
  border-radius: 8px;
}

/* 活动图层：次级容器色高亮（与工具轨选中态同色系） */
.layer-item.active {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.layer-eye {
  display: inline-flex;
  margin-right: 2px;
}

.layer-eye .material-symbols-outlined {
  font-size: 19px;
}

.layer-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

/* 隐藏的图层：名字变淡，提示「这层不画也不导出」 */
.layer-item.hidden .layer-name {
  opacity: 0.45;
}

.layer-rename {
  min-width: 0;
  flex: 1;
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-highest);
  border: 1px solid var(--md-sys-color-primary);
  border-radius: 8px;
  outline: none;
}

.layer-actions {
  display: inline-flex;
  align-items: center;
  gap: 0;
}

.layer-actions .material-symbols-outlined {
  font-size: 18px;
}
</style>
