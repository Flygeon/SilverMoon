<script setup lang="ts">
/**
 * 设置页的单行容器。
 *
 * ## 为什么要有它
 *
 * 改版前这一行的结构
 * （`<label class="row switch-row"><span class="row-label">…</span>…</label>`）
 * 在模板里被**复制了 40 遍**，另有 80 处 row-label、60 处 hint —— 间距、禁用态、
 * 以及「搜索能不能定位到这一项」全靠人工保持一致。
 *
 * 现在收敛成一处，并且**统一挂上 data-setting**：设置搜索靠它把结果跳转/高亮
 * 到具体某一项，而不是只能跳到分类。
 *
 * ## 为什么这里重复声明 .row / .row-label
 *
 * Vue 的 scoped CSS 只会把**父组件的 scope id 加到子组件根元素**上，
 * 子组件内部的 `<span class="row-label">` 只带自己的 scope id ——
 * 父组件里的 `.row-label` 规则对它**不生效**。
 * 所以这个组件必须自带这两条规则（SettingsView 里保留同名规则供未迁移的行使用）。
 */
withDefaults(
  defineProps<{
    /** 已翻译的显示文案 */
    label: string;
    /**
     * 该项的 i18n 键（如 `settings.preciseLyrics`）。
     * **只用于 `data-setting`** —— 设置搜索的跳转与高亮锚点，不参与显示。
     */
    settingKey?: string;
    /** 整行可点（点行即切换控件）。开关行为 true；滑块/纯展示行为 false。 */
    clickable?: boolean;
  }>(),
  { settingKey: undefined, clickable: false },
);
</script>

<template>
  <component
    :is="clickable ? 'label' : 'div'"
    class="row"
    :class="{ 'switch-row': clickable }"
    :data-setting="settingKey"
  >
    <span class="row-label">{{ label }}</span>
    <slot />
  </component>
</template>

<style scoped>
/* 与 SettingsView.vue 里的同名规则保持一致（见组件头注释：scoped 不会穿透到这里） */
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
}
.row-label {
  flex: 1;
  font-size: var(--md-sys-typescale-body-medium-size);
}
</style>
