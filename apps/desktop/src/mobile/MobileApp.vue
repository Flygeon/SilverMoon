<script setup lang="ts">
/**
 * 移动端外壳：只负责挂路由出口 + 迷你播放器。
 * 桌面端的窗口标题栏、皮肤、桌面歌词窗口等一律不参与。
 */
import { RouterView } from "vue-router";
import MiniPlayer from "@/components/MiniPlayer.vue";
</script>

<template>
  <div class="sm-mobile-root">
    <div class="sm-mobile-page">
      <RouterView />
    </div>
    <MiniPlayer />
  </div>
</template>

<style scoped>
.sm-mobile-root {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--md-sys-color-surface, #101014);
}

.sm-mobile-page {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
</style>
