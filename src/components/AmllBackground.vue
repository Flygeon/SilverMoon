<script setup lang="ts">
/**
 * AMLL 流体网格渐变背景（@applemusic-like-lyrics/core，AGPL-3.0-only）。
 * 使用 core 的 BackgroundRender + 默认 MeshGradientRenderer（纯 WebGL，无 CSS filter）：
 * - 渲染器内部按 renderScale(0.5) 降采样，fps 默认 30，GPU 成本远低于 CSS 全屏 blur 方案
 * - 封面变化时热替换 album（跨渐变过渡由渲染器自己处理）
 * - 窗口隐藏时暂停渲染循环
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { BackgroundRender, MeshGradientRenderer } from "@applemusic-like-lyrics/core";
import { usePlayerStore } from "@/stores/player";

const player = usePlayerStore();
const hostRef = ref<HTMLDivElement | null>(null);

let bg: BackgroundRender<MeshGradientRenderer> | null = null;

const visibilityHandler = () => {
  if (!bg) return;
  if (document.hidden) bg.pause();
  else bg.resume();
};

onMounted(() => {
  if (!hostRef.value) return;
  bg = BackgroundRender.new(MeshGradientRenderer);
  const el = bg.getElement();
  el.style.width = "100%";
  el.style.height = "100%";
  hostRef.value.appendChild(el);
  bg.setRenderScale(0.5);
  bg.setFPS(30);
  bg.setFlowSpeed(2);
  bg.setHasLyric(true);
  void bg.setAlbum(player.song?.cover || "/default.svg");
  document.addEventListener("visibilitychange", visibilityHandler);
});

watch(
  () => player.song?.cover,
  (cover) => {
    if (bg) void bg.setAlbum(cover || "/default.svg");
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", visibilityHandler);
  bg?.dispose();
  bg = null;
});
</script>

<template>
  <div ref="hostRef" class="amll-bg"></div>
</template>

<style scoped>
.amll-bg {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
