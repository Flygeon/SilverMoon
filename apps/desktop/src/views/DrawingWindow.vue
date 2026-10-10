<script setup lang="ts">
/**
 * 独立绘画窗口的宿主视图（路由 /drawing）。
 *
 * 职责边界：
 * - 从 **URL query** 解析参数（新窗口与主窗口不共享 Pinia store，见 drawingWindow.ts）；
 * - 把画作元信息补齐（尺寸从 query 拿，名字从 store 查）；
 * - 承载 DrawingBoard，并把它的 close/saved 事件接到窗口收尾上。
 *
 * 布局是「专业绘画应用」的骨架：顶部菜单栏 + 左侧工具栏 + 中间画布 + 右侧属性面板。
 * 具体绘制逻辑仍全在 DrawingBoard.vue 里，这里只管壳。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import DrawingBoard from "@/components/DrawingBoard.vue";
import { useDrawingStore } from "@/stores/drawing";
import { useSettingsStore } from "@/stores/settings";
import { closeDrawingWindow } from "@/utils/drawingWindow";
import { translate } from "@shared/i18n";
import type { Drawing } from "@/features/drawing/types";

const route = useRoute();
const store = useDrawingStore();
const settings = useSettingsStore();

function t(key: string) {
  return translate(settings.lang, key);
}

/** 画布尺寸：来自 query，缺省 1024²（与主窗口的预设默认一致）。 */
const canvasWidth = computed(() => {
  const v = Number(route.query.w);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 1024;
});
const canvasHeight = computed(() => {
  const v = Number(route.query.h);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 1024;
});

/** 要打开的画作 id（新建时为 null）。 */
const drawingId = computed(() => {
  const v = route.query.id;
  return typeof v === "string" && v ? v : null;
});

const drawing = ref<Drawing | null>(null);
const loading = ref(true);

onMounted(async () => {
  if (drawingId.value) {
    // 列表可能还没加载（新窗口是独立进程，store 是空的）：确保一次再查
    await store.ensure();
    drawing.value = store.items.find((d) => d.id === drawingId.value) ?? null;
  }
  loading.value = false;
});

/** 关闭：窗口关掉后主窗口会由 watchDrawingWindowClosed 唤回。 */
function onClose() {
  void closeDrawingWindow();
}

async function onSaved() {
  // 保存后主窗口的列表需要刷新，但那是另一个进程的 store ——
  // 这里只更新本窗口的 store，主窗口在恢复显示时会自己 ensure()。
  await store.refresh();
}
</script>

<template>
  <div class="drawing-window">
    <div v-if="loading" class="loading">{{ t("draw.loading") }}</div>
    <DrawingBoard
      v-else
      :drawing="drawing"
      :canvas-width="canvasWidth"
      :canvas-height="canvasHeight"
      @close="onClose"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
/* 独立窗口：占满整个窗口，不再有主界面外壳的边距 */
.drawing-window {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--md-sys-color-on-surface-variant);
}
</style>
