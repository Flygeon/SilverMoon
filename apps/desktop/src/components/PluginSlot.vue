<script setup lang="ts">
/**
 * 具名插槽容器：把插件声明的内容渲染到宿主指定的真实位置。
 *
 * 这是「扩展改主界面」的**通用机制** —— 与固定两槽（`nav` / `main`）的区别：
 * 宿主为设置页侧栏、设置卡片栈、播放页底部等**真实位置**各开一个具名插槽，
 * 扩展在 manifest 里声明挂到哪个（`contributes.ui[]` + `surface: "slot"`）。
 *
 * ## 两种呈现方式
 *
 * 同一个插槽既能放**扩展的一个独立页面**（`mode="entry"`：渲染一个可点条目，
 * 点了在主窗口内容区打开该扩展的 route），也能放**内嵌面板**（`mode="panel"`：
 * 直接嵌 iframe）。前者用于设置页侧栏这类「入口」位，后者用于卡片栈这类「内容」位。
 *
 * 不把两者合成一种，是因为它们在版式上根本不是一回事：入口是列表里的一行，
 * 内容是页面里的一块。硬凑成一个组件会让两边都别扭。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import PluginEmbed from "@/components/PluginEmbed.vue";
import { capabilities, isDesktop } from "@/capabilities";
import type { ExtUiSurface } from "@shared/types";

const props = defineProps<{
  /** 插槽 id，必须与宿主 Rust 侧 SLOT_IDS 一致 */
  slot: string;
  /** entry = 可点条目（用于侧栏/工具列表）；panel = 内嵌面板（用于卡片栈） */
  mode?: "entry" | "panel";
}>();

const router = useRouter();
const surfaces = ref<ExtUiSurface[]>([]);

/** 本插槽里声明的项，按 order 升序（内置项天然排在扩展项之前） */
const items = computed(() =>
  surfaces.value
    .filter((s) => s.surface === "slot" && s.slot === props.slot)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
);

async function load() {
  if (!isDesktop) return;
  const all = await capabilities.extUiSurfaces().catch(() => []);
  surfaces.value = all;
}

function openRoute(s: ExtUiSurface) {
  void router.push(`/extension-page/${encodeURIComponent(s.extId)}/${encodeURIComponent(s.route)}`);
}

onMounted(() => {
  void load();
  if (!isDesktop) return;
  // 装 / 卸 / 启用扩展后刷新，不必重启
  void capabilities.onExtUiChanged(() => void load());
});
</script>

<template>
  <template v-if="mode === 'panel'">
    <PluginEmbed v-for="s in items" :key="`${s.extId}:${s.id}`" :surface="s" class="slot-panel" />
  </template>

  <template v-else>
    <!-- entry：渲染成一行可点条目，与宿主自己的设置项/工具项同一版式 -->
    <button
      v-for="s in items"
      :key="`${s.extId}:${s.id}`"
      type="button"
      class="slot-entry"
      @click="openRoute(s)"
    >
      <span class="material-symbols-outlined slot-entry-icon">{{ s.icon || "extension" }}</span>
      <span class="slot-entry-text">
        <span class="slot-entry-title">{{ s.title }}</span>
        <span v-if="s.description" class="slot-entry-desc">{{ s.description }}</span>
      </span>
    </button>
  </template>
</template>

<style scoped>
.slot-panel {
  margin-bottom: 16px;
}
.slot-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: 8px;
}
.slot-entry:hover {
  background: var(--md-sys-color-surface-container-high, rgba(255, 255, 255, 0.06));
}
.slot-entry-icon {
  font-size: 20px;
  opacity: 0.8;
  flex-shrink: 0;
}
.slot-entry-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.slot-entry-title {
  font-size: 14px;
  line-height: 20px;
}
.slot-entry-desc {
  font-size: 12px;
  line-height: 16px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
