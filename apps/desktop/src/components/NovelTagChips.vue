<script setup lang="ts">
/**
 * 在线小说源的标签条（MD3 筛选 chip）。
 *
 * 为什么单独抽：番茄小说页要显示详情里的分类，而图三那种「圆角胶囊 +
 * 描边」的样式是本项目其它地方（番剧信息面板）已经确立的视觉语言。
 * 用 m3e-filter-chip 而不是手写 span，才能拿到 MD3 的选中态与无障碍语义。
 *
 * 这里的 chip **不可点选**（纯展示）：`m3e-filter-chip` 的 selected 是给
 * 筛选用的，展示型标签用 assist chip 更准确。
 */
defineProps<{
  tags: string[];
}>();

const emit = defineEmits<{ (e: "pick", tag: string): void }>();
</script>

<template>
  <div v-if="tags.length" class="tag-row">
    <m3e-assist-chip
      v-for="tag in tags"
      :key="tag"
      class="tag"
      :label="tag"
      @click="emit('pick', tag)"
    ></m3e-assist-chip>
  </div>
</template>

<style scoped>
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 统一尺寸：默认 chip 在列表里偏大，压成与图三接近的紧凑胶囊 */
.tag {
  --m3e-chip-container-height: 32px;
  --m3e-chip-container-shape: var(--md-sys-shape-corner-full);
  --m3e-chip-padding-start: 14px;
  --m3e-chip-padding-end: 14px;
  --m3e-chip-label-text-font-size: var(--md-sys-typescale-label-large-size);
}
</style>
