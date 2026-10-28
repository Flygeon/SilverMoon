<script setup lang="ts">
import { computed, ref } from "vue";
import { cssTokensFromSeed } from "@shared/m3-theme";
import { translate } from "@shared/i18n";

const props = defineProps<{
  seed: string;
  source: "manual" | "system";
  dark: boolean;
  lang: "zh" | "en";
  systemSeed?: string | null;
  disabled?: boolean;
}>();
const emit = defineEmits<{ select: [seed: string]; system: [] }>();
const colorInput = ref<HTMLInputElement | null>(null);
const presets = [
  { key: "blue", hex: "#1A5C9E" },
  { key: "teal", hex: "#00696E" },
  { key: "violet", hex: "#6750A4" },
  { key: "green", hex: "#4C662B" },
  { key: "amber", hex: "#8F4C00" },
  { key: "rose", hex: "#B3261E" },
  { key: "pink", hex: "#8B4A6C" },
] as const;
const t = (key: string) => translate(props.lang, key);
const options = computed(() => {
  const custom = !presets.some((preset) => preset.hex.toLowerCase() === props.seed.toLowerCase());
  const entries = [
    ...(props.systemSeed ? [{ key: "system", hex: props.systemSeed }] : []),
    ...presets,
    { key: "custom", hex: props.seed },
  ];
  return entries.map((entry) => {
    const colors = cssTokensFromSeed(entry.hex, props.dark);
    return {
      ...entry,
      label: t(
        entry.key === "system"
          ? "settings.system"
          : entry.key === "custom"
            ? "settings.colorCustom"
            : "settings.colorSeed_" + entry.key,
      ),
      selected:
        entry.key === "system"
          ? props.source === "system"
          : props.source === "manual" &&
            (entry.key === "custom"
              ? custom
              : entry.hex.toLowerCase() === props.seed.toLowerCase()),
      style: {
        "--sw-primary": colors["--md-sys-color-primary-container"],
        "--sw-secondary": colors["--md-sys-color-secondary-container"],
        "--sw-tertiary": colors["--md-sys-color-tertiary-container"],
        "--sw-check": colors["--md-sys-color-primary"],
        "--sw-on-check": colors["--md-sys-color-on-primary"],
      },
    };
  });
});

function select(key: string, hex: string) {
  if (props.disabled) return;
  if (key === "system") emit("system");
  else if (key === "custom") colorInput.value?.click();
  else emit("select", hex);
}

function onCustomInput(event: Event) {
  if (!props.disabled) emit("select", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="palette-picker" role="group" :aria-label="t('settings.colorScheme')">
    <div v-for="option in options" :key="option.key" class="palette-option">
      <m3e-button
        class="swatch"
        :class="{ active: option.selected }"
        :style="option.style"
        :data-palette="option.key"
        variant="tonal"
        shape="square"
        :aria-label="option.label"
        :aria-current="option.selected ? 'true' : undefined"
        :disabled="disabled"
        @click="select(option.key, option.hex)"
      >
        <span class="palette-disc" aria-hidden="true">
          <span class="primary"></span>
          <span class="secondary"></span>
          <span class="tertiary"></span>
          <span v-if="option.selected || option.key === 'custom'" class="palette-check">
            <span class="material-symbols-outlined">{{
              option.selected ? "check" : "colorize"
            }}</span>
          </span>
        </span>
      </m3e-button>
      <span class="palette-name">{{ option.label }}</span>
    </div>
    <input
      ref="colorInput"
      type="color"
      hidden
      :value="seed"
      :disabled="disabled"
      :aria-label="t('settings.colorCustom')"
      @input="onCustomInput"
    />
  </div>
</template>

<style scoped>
.palette-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
  gap: var(--lm-space-16) var(--lm-space-12);
  width: 100%;
  min-width: 0;
}
.palette-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--lm-space-12);
  min-width: 0;
}
.swatch {
  width: 100%;
  border-radius: var(--md-sys-shape-corner-large);
  outline: 2px solid transparent;
  outline-offset: -2px;
  --m3e-button-container-height: 88px;
  --m3e-button-shape-square: var(--md-sys-shape-corner-large);
  --m3e-tonal-button-container-color: var(--md-sys-color-surface-container);
}
.swatch.active {
  outline-color: var(--md-sys-color-primary);
  --m3e-tonal-button-container-color: var(--md-sys-color-secondary-container);
}
.palette-disc {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  overflow: hidden;
}
.primary {
  grid-column: 1 / -1;
  background: var(--sw-primary);
}
.secondary {
  background: var(--sw-secondary);
}
.tertiary {
  background: var(--sw-tertiary);
}
.palette-check {
  position: absolute;
  inset: 13px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--sw-check);
  color: var(--sw-on-check);
}
.palette-check .material-symbols-outlined {
  font-size: 19px;
}
.palette-name {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-medium-size);
  text-align: center;
}
</style>
