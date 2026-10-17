<script setup lang="ts">
/**
 * 在线小说源的标签条（MD3 chip）。
 *
 * ## ⚠️ 标签文字必须作为**子内容**，不能用 `label` 属性
 *
 * `m3e-chip` 的 `label` 是 **只读 getter**（读的是默认插槽的文本），
 * 没有 setter。写 `:label="tag"` 不会渲染任何文字 —— 实测结果是一排
 * 空心圆圈。正确写法是把文字放进默认插槽：
 *
 * ```html
 * <m3e-assist-chip>武侠</m3e-assist-chip>
 * ```
 *
 * ## 为什么用 assist 而不是 filter chip
 *
 * filter chip 的 `selected` 是筛选语义；这里只是展示分类，点了也没筛选
 * 行为，用 assist 更准确。
 *
 * ## 为什么要 m3e-chip-set 包一层
 *
 * 组件的文档要求 chip 集合放进 `m3e-chip-set`（带 `role="group"`），
 * 否则无障碍读屏无法把它们读成一组。
 */
defineProps<{ tags: string[] }>();

const emit = defineEmits<{ (e: "pick", tag: string): void }>();
</script>

<template>
  <m3e-chip-set v-if="tags.length" class="tag-row" role="group" aria-label="分类">
    <m3e-assist-chip
      v-for="tag in tags"
      :key="tag"
      class="tag"
      variant="outlined"
      @click="emit('pick', tag)"
    >
      {{ tag }}
    </m3e-assist-chip>
  </m3e-chip-set>
</template>

<style scoped>
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 统一尺寸：默认 chip 在列表里偏大，压成与信息面板接近的紧凑胶囊 */
.tag {
  --m3e-chip-container-height: 32px;
  --m3e-chip-container-shape: var(--md-sys-shape-corner-full);
  --m3e-chip-padding-start: 14px;
  --m3e-chip-padding-end: 14px;
  --m3e-chip-label-text-font-size: var(--md-sys-typescale-label-large-size);
}
</style>
