<script setup lang="ts">
/** 自绘 Sheet 的公共生命周期；焦点循环直接复用 MD3E 官方原语。 */
import { ref } from "vue";
import { useModalLayer } from "@/composables/useModalLayer";

defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();
const surface = ref<HTMLElement | null>(null);
const { onEscape } = useModalLayer(surface, () => emit("close"));
defineExpose({ focus: () => surface.value?.focus() });
</script>

<template>
  <m3e-focus-trap
    ref="surface"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    :aria-label="label"
    @keydown.esc="onEscape"
  >
    <slot />
  </m3e-focus-trap>
</template>
