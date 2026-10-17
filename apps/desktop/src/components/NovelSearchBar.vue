<script setup lang="ts">
/**
 * 在线小说源的统一搜索栏。
 *
 * ## 为什么抽出来
 *
 * 轻小说 / 网络小说 / 番茄三个源各写过一份「输入框 + 搜索按钮」，结果
 * 三份长得都不一样（按钮 variant、圆角、底色全不同）。抽成一个组件后，
 * 一致性是**结构保证**，不是靠人记得同步。
 *
 * ## 为什么用 m3e-search-bar
 *
 * 这是 @m3e/web 的官方 MD3E 组件（`SearchBarElement`），带 clearable、
 * 焦点态、以及 MD3 的容器高度/圆角/配色令牌。原先三处都是手写
 * `<input>` 拼样式，长得像但不受组件契约保护。
 *
 * 按钮放 `trailing` 槽：MD3 的 search bar 本身只有输入，动作由调用方
 * 通过槽位提供，这样「搜索」这个动作的强调级别仍由本组件统一（tonal，
 * 次级动作 —— 搜索不是页面主行动，不该用 filled 抢戏）。
 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** 输入框占位文案 */
    placeholder?: string;
    /** 是否正在搜索：禁用按钮并换文案 */
    busy?: boolean;
    /** 忙碌时按钮上的文案 */
    busyLabel?: string;
    /** 按钮常态文案 */
    label?: string;
  }>(),
  {
    placeholder: "搜索",
    busy: false,
    busyLabel: "搜索中",
    label: "搜索",
  },
);

const emit = defineEmits<{
  /** 提交搜索词 */
  (e: "search", keyword: string): void;
}>();

const keyword = ref("");
const bar = ref<HTMLElement | null>(null);

const buttonLabel = computed(() => (props.busy ? props.busyLabel : props.label));

/** 从 m3e-search-bar 的 input 槽里取真实 <input>：组件把输入框交给调用方提供。 */
function innerInput(): HTMLInputElement | null {
  const host = bar.value;
  if (!host) return null;
  return host.querySelector("input");
}

function submit() {
  const text = keyword.value.trim();
  if (!text || props.busy) return;
  emit("search", text);
}

function onInput(e: Event) {
  const target = e.target as HTMLInputElement | null;
  keyword.value = target?.value ?? "";
}

/** 清空（m3e-search-bar 的 clear 事件）。 */
function onClear() {
  keyword.value = "";
}

/** 供外部（如「再搜一次」）读取当前词。 */
function current(): string {
  return keyword.value.trim();
}

defineExpose({ current, focus: () => innerInput()?.focus() });
</script>

<template>
  <div class="novel-search">
    <m3e-search-bar ref="bar" class="bar" clearable @clear="onClear">
      <m3e-icon slot="leading" name="search"></m3e-icon>
      <input
        slot="input"
        :value="keyword"
        :placeholder="placeholder"
        type="text"
        @input="onInput"
        @keyup.enter="submit"
      />
    </m3e-search-bar>
    <m3e-button variant="tonal" size="small" :disabled="busy" @click="submit">
      <span slot="icon" class="material-symbols-outlined">search</span>
      {{ buttonLabel }}
    </m3e-button>
  </div>
</template>

<style scoped>
.novel-search {
  display: flex;
  gap: 8px;
  align-items: center;
}

.bar {
  flex: 1;
  min-width: 0;
  /* 高度与按钮对齐（small 按钮 32px，这里给 40px 保持输入舒适） */
  --m3e-search-bar-container-height: 40px;
  /* MD3 search bar 默认就是 full 圆角（胶囊），保持组件默认即可 */
}
</style>
