<script setup lang="ts">
/** 桌面搜索输入：只适配 m3e 的几何与事件，不持有来源、查询或防抖策略。 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder: string;
    clearLabel: string;
    variant?: "default" | "settings";
  }>(),
  { variant: "default" },
);
const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [];
}>();
const input = ref<HTMLInputElement | null>(null);
const value = computed({
  get: () => props.modelValue,
  set: (text: string) => emit("update:modelValue", text),
});

function submit(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  emit("submit");
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <m3e-search-bar
    class="search-field"
    :data-variant="variant"
    :clearable="!!modelValue"
    :clear-label="clearLabel"
  >
    <span slot="leading" class="material-symbols-outlined" aria-hidden="true">search</span>
    <input
      ref="input"
      slot="input"
      v-model="value"
      type="text"
      inputmode="search"
      enterkeyhint="search"
      :aria-label="placeholder"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter="submit"
    />
  </m3e-search-bar>
</template>

<style scoped>
.search-field {
  display: block;
  width: 100%;
  min-width: 0;
  border-radius: var(--md-sys-shape-corner-full);
  --m3e-search-bar-container-height: var(--lm-search-height);
  --m3e-search-bar-container-color: var(--md-sys-color-surface-container);
  --m3e-search-bar-leading-icon-color: var(--md-sys-color-on-surface-variant);
  --m3e-search-bar-input-text-font-size: var(--md-sys-typescale-body-medium-size);
  --m3e-search-bar-input-text-line-height: var(--md-sys-typescale-body-medium-line-height);
  --m3e-search-bar-supporting-text-font-size: var(--md-sys-typescale-body-medium-size);
  --m3e-search-bar-supporting-text-line-height: var(--md-sys-typescale-body-medium-line-height);
}
.search-field:focus-within {
  outline: var(--lm-focus-width) solid var(--lm-focus-color);
  outline-offset: var(--lm-focus-offset);
  --m3e-search-bar-container-color: var(--md-sys-color-surface-container-high);
}
.search-field[data-variant="settings"] {
  --m3e-search-bar-container-height: var(--lm-settings-search-height);
  --m3e-search-bar-container-color: var(--md-sys-color-surface-container-low);
  --m3e-search-bar-input-text-font-size: var(--md-sys-typescale-body-small-size);
  --m3e-search-bar-supporting-text-font-size: var(--md-sys-typescale-body-small-size);
}
.material-symbols-outlined {
  font-size: 20px;
  color: var(--md-sys-color-on-surface-variant);
}
input {
  font-family: inherit;
}
</style>
