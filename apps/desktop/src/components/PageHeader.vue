<script lang="ts">
/** 标题下拉的选项。放在普通 <script> 里导出，<script setup> 不允许 ES 模块导出。 */
export interface PageMenuItem {
  value: string;
  label: string;
  icon?: string;
}
</script>

<script setup lang="ts">
/**
 * 页面标题。
 *
 * 当传了 `menuItems` 时，标题本身变成下拉选单的触发器（右侧带 `expand_more`）：
 * 书籍 / 图片 / 视频页的重点是「当前在看哪一类内容」，把原来平铺的分段控件收进标题，
 * 既省一行横向空间，也让一级导航更像「页面标题 → 内容域」而不是一排按钮。
 *
 * 菜单本体用 @m3e/web 的 `m3e-menu` + `m3e-menu-trigger`：
 * - 触发器嵌在按钮里，由组件负责锚定、贴边翻转、方向键导航与 Esc 关闭；
 * - 点击菜单项后 `m3e-menu-item` 会自动 hideAll，不需要手写关闭逻辑。
 */
import { computed, useId } from "vue";

const props = defineProps<{
  title: string;
  description?: string;
  /** 传了才把标题渲染成下拉选单 */
  menuItems?: PageMenuItem[];
  /** 当前选中项（v-model:menu-value） */
  menuValue?: string;
}>();

const emit = defineEmits<{ "update:menuValue": [value: string] }>();

/**
 * 菜单 id 必须每个实例唯一：`m3e-menu-trigger` 通过 `for` 找到同名 `m3e-menu`，
 * 同一个页面里多个 PageHeader 同时存在时不能撞车。
 */
const menuId = `page-menu-${useId()}`;
const hasMenu = computed(() => (props.menuItems?.length ?? 0) > 0);

function select(value: string) {
  if (value !== props.menuValue) emit("update:menuValue", value);
}
</script>

<template>
  <header class="page-head">
    <div class="page-head-text">
      <h2 class="page-head-title">
        <button v-if="hasMenu" type="button" class="title-menu-btn">
          <m3e-menu-trigger :for="menuId" class="title-trigger">
            <span class="title-label">{{ title }}</span>
            <span class="material-symbols-outlined title-chevron" aria-hidden="true"
              >expand_more</span
            >
          </m3e-menu-trigger>
        </button>
        <template v-else>{{ title }}</template>
      </h2>
      <p v-if="description" class="page-head-desc">{{ description }}</p>
    </div>
    <div class="page-head-trailing">
      <slot />
    </div>

    <!-- 菜单放在 header 内即可：m3e-menu 自己渲染成浮层，不会被父级 overflow 裁掉 -->
    <m3e-menu v-if="hasMenu" :id="menuId" class="page-menu">
      <m3e-menu-item v-for="item in menuItems" :key="item.value" @click="select(item.value)">
        <span v-if="item.icon" slot="icon" class="material-symbols-outlined menu-icon">{{
          item.icon
        }}</span>
        {{ item.label }}
        <span
          v-if="item.value === menuValue"
          slot="trailing-icon"
          class="material-symbols-outlined menu-check"
          aria-label="当前"
          >check</span
        >
      </m3e-menu-item>
    </m3e-menu>
  </header>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.page-head-text {
  min-width: 0;
}
.page-head-title {
  font-size: var(--md-sys-typescale-title-large-size);
  font-weight: var(--md-sys-typescale-title-large-weight);
  line-height: 1.2;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page-head-desc {
  margin: 2px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page-head-trailing {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  white-space: nowrap;
}

/* 标题触发器：看起来仍是标题，而不是按钮 —— 去掉按钮底色与内边距，只保留 hover 的淡色药丸 */
.title-menu-btn {
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  cursor: pointer;
  border-radius: var(--md-sys-shape-corner-small);
}
.title-menu-btn:hover {
  background: var(--md-sys-color-surface-container-high);
}
.title-menu-btn:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.title-trigger {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px 2px 4px;
  border-radius: var(--md-sys-shape-corner-small);
}
.title-chevron {
  font-size: 22px;
  line-height: 1;
  color: var(--md-sys-color-on-surface-variant);
}
.menu-icon {
  font-size: 20px;
}
.menu-check {
  font-size: 20px;
  color: var(--md-sys-color-primary);
}
.page-menu {
  --m3e-menu-container-min-width: 190px;
}
</style>
