<script setup lang="ts">
/**
 * 扩展页面（主窗口内容区里的一整页）。
 *
 * 由 `contributes.nav[]` / `contributes.ui[]`（`surface: "nav"`）注入的导航项跳进来，
 * 路由形如 `/extension-page/<extId>/<route>`。
 *
 * 为什么走主窗口而不是再开一个窗口：用户点导航栏的期望是「像切页面一样」，
 * 而不是「弹出一个框」。真正需要独立窗口的扩展仍然用 `contributes.windows`。
 *
 * 复用 `ExtensionEmbed` —— 桥协议、source 校验、宿主保留方法分发都在那里，
 * 不重复实现第二套。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ExtensionEmbed from "@/components/ExtensionEmbed.vue";
import PageHeader from "@/components/PageHeader.vue";
import { capabilities, isDesktop } from "@/capabilities";
import type { ExtUiSurface } from "@shared/types";

const props = defineProps<{ extId: string; route: string }>();
// ⚠️ 不能直接叫 route：props 里已经有一个 route（URL 上的扩展路由段），
// 与 useRoute() 的 route 同名会在模板作用域撞车（vue/no-dupe-keys）。
const hostRoute = useRoute();

const all = ref<ExtUiSurface[]>([]);
const missing = ref(false);

/** 合成一个用于 Embed 的注入项。找不到声明时给一个兜底（用的是 URL 上的 route）。 */
const surface = computed<ExtUiSurface>(() => {
  const hit = all.value.find(
    (s) => s.extId === props.extId && s.surface === "nav" && s.route === props.route,
  );
  if (hit) return { ...hit, surface: "nav" };
  return {
    extId: props.extId,
    extName: props.extId,
    surface: "nav",
    slot: null,
    description: null,
    order: 100,
    id: props.route,
    title: props.extId,
    icon: null,
    route: props.route,
    position: "top",
    showOnRoutes: null,
    // 整页：交给父容器撑满（ExtensionEmbed 会用 height ?? 160，
    // 这里给一个足够大的值，实际以 CSS 的 100% 为准）
    height: 0,
    relIndex: "web/dist/index.html",
  };
});

const title = computed(() => all.value.find((s) => s.extId === props.extId)?.title || props.extId);

async function load() {
  all.value = isDesktop ? await capabilities.extUiSurfaces().catch(() => []) : [];
  // 声明里找不到这个 route：可能是扩展被禁用/卸载了，给出可读提示而不是空白
  missing.value =
    all.value.length > 0 &&
    !all.value.some(
      (s) => s.extId === props.extId && s.surface === "nav" && s.route === props.route,
    );
}

onMounted(load);
watch(() => hostRoute.fullPath, load);
</script>

<template>
  <div class="ext-page">
    <PageHeader :title="title" description="由扩展提供" />
    <div v-if="missing" class="missing">
      这个页面来自扩展「{{ extId }}」，但它现在没有声明该页面 ——
      可能是扩展被禁用或已卸载。可在「百宝箱 → 扩展」里检查。
    </div>
    <ExtensionEmbed v-else :surface="surface" class="full" />
  </div>
</template>

<style scoped>
.ext-page {
  display: flex;
  flex-direction: column;
  /* 内容区已被 main-content 加了内边距，这里撑满即可 */
  height: 100%;
  min-height: 0;
}
/* 整页时让 Embed 吃掉剩余高度，而不是用 manifest 里的 height */
.full {
  flex: 1;
  min-height: 0;
}
.full :deep(.ext-embed) {
  height: 100%;
  margin-bottom: 0;
}
.missing {
  padding: 24px;
  color: var(--md-sys-color-on-surface-variant, rgba(255, 255, 255, 0.6));
  line-height: 1.8;
}
</style>
