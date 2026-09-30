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

  /* WebView 是铺满的（Flutter 侧 SafeArea top:false），所以状态栏、灵动岛
     和横屏刘海都会盖在内容上 —— 不内缩的话标题会压在时间和电量下面。
     桌面端没有安全区这个概念，Vue 各处也都没用 env()，所以统一在这里兜住。
     只在 WebView 真的铺到边缘时 env() 才有值，Flutter 侧若哪天改成内缩，
     这里会自然变成 0，不会双重内缩。 */
  padding-top: env(safe-area-inset-top);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  box-sizing: border-box;
}

.sm-mobile-page {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
</style>
