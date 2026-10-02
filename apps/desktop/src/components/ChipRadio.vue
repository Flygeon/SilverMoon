<script setup lang="ts">
/**
 * 单选 chip 组（M3 filter chip）。
 *
 * ## 为什么不能直接 `<m3e-filter-chip :selected="x === v" @click="x = v">`
 *
 * `m3e-filter-chip` 是**自管理选中态**的组件。看它 dist 里的点击处理：
 *
 * ```js
 * handleClick(e) {
 *   if (e.defaultPrevented) return;
 *   if (this.dispatchEvent(new Event("beforeinput", { cancelable: true }))) {
 *     this.selected = !this.selected;   // ← 组件自己翻转
 *     this.dispatchEvent(new Event("input", { bubbles: true }));
 *   }
 * }
 * ```
 *
 * 而 Vue 的 `@click` 监听**在插入 DOM 之前**就挂上了（patch 阶段），所以同一次点击里
 * 执行顺序是「Vue 先、组件后」：
 *
 * 1. Vue 的 handler 把 model 改成 B → 重渲染让 B 选中；
 * 2. 组件的 handleClick 紧接着把 B 翻回**未选中**。
 *
 * 结果：点一下只是「取消了当前选中」，得**再点一下**才真正切过去 —— 这正是
 * 「切换收藏夹要点两次」的根因，同理影响清晰度、评论排序等所有单选 chip。
 *
 * ## 这里的解法
 *
 * 只听组件的 `input` 事件（此时 `selected` 已是翻转后的值），按语义决定选中值，
 * 不在 `@click` 里抢着改 model。单击即切换，状态只有一个来源。
 */
import { computed } from "vue";
import { resolveChipToggle } from "@/utils/chipSelect";

const props = defineProps<{
  /** 当前选中值 */
  modelValue: string | number;
  /** 选项列表（值 + 展示文案，可选图标） */
  options: { value: string | number; label: string; icon?: string; disabled?: boolean }[];
  disabled?: boolean;
  /** 无障碍标签（chip 组必须有） */
  ariaLabel?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string | number] }>();

/** 命中集合：只让当前值那一项处于选中态（把组件自翻转的结果纠正回来） */
const selectedSet = computed(() => new Set([props.modelValue]));

function onInput(value: string | number, e: Event): void {
  const el = e.target as HTMLElement & { selected?: boolean };
  const { picked, pin } = resolveChipToggle(props.modelValue, value, el.selected ?? false);
  if (pin) {
    // 单选组不该被点成「一个都没选」：把组件刚翻掉的那一项拨回选中。
    // 放到微任务里，避开与组件自身渲染的时序竞争。
    queueMicrotask(() => {
      el.selected = true;
    });
    return;
  }
  if (picked !== props.modelValue) emit("update:modelValue", picked);
}
</script>

<template>
  <div class="chip-row" role="group" :aria-label="ariaLabel">
    <m3e-filter-chip
      v-for="opt in options"
      :key="opt.value"
      class="chip"
      :selected="selectedSet.has(opt.value)"
      :disabled="disabled || opt.disabled"
      @input="onInput(opt.value, $event)"
    >
      <span v-if="opt.icon" slot="icon" class="material-symbols-outlined">{{ opt.icon }}</span>
      {{ opt.label }}
    </m3e-filter-chip>
  </div>
</template>

<style scoped>
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  --m3e-chip-container-height: 32px;
}
</style>
