<script setup lang="ts" generic="T extends string">
/** 下拉字段只适配值与标签；弹层、键盘和选中态由 m3e-select 负责。 */
defineProps<{
  modelValue: T;
  label: string;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
function change(event: Event) {
  emit("update:modelValue", (event.target as HTMLElement & { value: T }).value);
}
</script>

<template>
  <m3e-form-field class="select-field" variant="outlined">
    <label slot="label">{{ label }}</label>
    <m3e-select :value="modelValue" :disabled="disabled" :aria-label="label" @change="change">
      <!-- m3e-select 会 cloneNode 选项生成弹层；value 不反射，须保存在 attribute。 -->
      <m3e-option
        v-for="option in options"
        :key="option.value"
        :value.attr="option.value"
        :disabled="option.disabled"
        >{{ option.label }}</m3e-option
      >
    </m3e-select>
  </m3e-form-field>
</template>

<style scoped>
.select-field {
  display: block;
  min-width: 0;
  width: 100%;
  --m3e-form-field-width: 100%;
}
</style>
