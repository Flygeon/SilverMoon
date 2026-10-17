<script setup lang="ts">
/**
 * 在线小说「渠道 + 视图」两级导航。
 *
 * ## 为什么是下拉而不是分段标签
 *
 * 原来四个在线源（轻小说 / 网络小说 / 番茄 / 后续还会加）平铺成胶囊，
 * 加上「本地」「创作」一共 5~6 个，横条越来越挤、也很难一眼看出
 * 「哪几个是同一类」。参照音乐页的层级思路（PlatformBar = 数据来源，
 * SegmentedTabs = 内容域），这里把**渠道收进下拉**：
 *
 *   [本地] [⁠在线源 ▾ 番茄小说] [创作]     ← 一级：本地 / 在线 / 创作
 *   推荐 | 排行榜 | 我的书架                ← 二级：当前渠道的视图
 *
 * ## 为什么用 m3e-form-field + m3e-select
 *
 * `m3e-select` 按 MD3E 规范必须放在 `m3e-form-field` 容器里才能拿到
 * 浮动标签与轮廓；单独使用会缺边界与标签语义。选中值通过 `change`
 * 事件回传（`(e.target as M3eSelect).value`）。
 */
import { computed } from "vue";

/** 在线渠道。`value` 与 BooksView 的 bookTab 取值一致。 */
export interface NovelChannel {
  value: string;
  label: string;
  icon?: string;
}

const props = defineProps<{
  channels: NovelChannel[];
  modelValue: string;
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const current = computed(() => props.channels.find((c) => c.value === props.modelValue));

function onChange(e: Event) {
  const target = e.target as { value?: string } | null;
  const next = target?.value;
  if (next) emit("update:modelValue", next);
}
</script>

<template>
  <div class="channel-bar">
    <span class="channel-label">在线渠道</span>
    <m3e-form-field class="channel-field" variant="outlined">
      <m3e-select
        :value="modelValue"
        hide-selection-indicator
        aria-label="选择在线小说渠道"
        @change="onChange"
      >
        <m3e-option v-for="ch in channels" :key="ch.value" :value="ch.value">
          {{ ch.label }}
        </m3e-option>
      </m3e-select>
    </m3e-form-field>
    <span v-if="current?.icon" class="channel-hint">
      <span class="material-symbols-outlined">{{ current.icon }}</span>
      {{ current.label }}
    </span>
  </div>
</template>

<style scoped>
.channel-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.channel-label {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-large-size);
  white-space: nowrap;
}

.channel-field {
  min-width: 200px;
  /* form-field 默认带上下留白，这里压紧以贴合横条 */
  --m3e-field-container-height: 48px;
}

.channel-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}

.channel-hint .material-symbols-outlined {
  font-size: 16px;
}
</style>
