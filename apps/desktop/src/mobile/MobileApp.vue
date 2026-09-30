<script setup lang="ts">
/**
 * 移动端外壳：路由出口 + 迷你播放器。
 * 桌面端的窗口标题栏、皮肤、桌面歌词窗口等一律不参与。
 */
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";
import MiniPlayer from "@/components/MiniPlayer.vue";
import { usePlayerStore } from "@/stores/player";

const route = useRoute();
const player = usePlayerStore();

/**
 * 播放页是全屏页面。桌面端 App.vue 的迷你播放器条件是
 * `player.song && !isPlayerPage`，移动端之前漏了这两个判断，
 * 于是全屏深色播放页上会压着一条浅色的空迷你条 —— 没有歌也照显示。
 */
const isPlayerPage = computed(() => route.path === "/music/player");
const showMiniPlayer = computed(() => Boolean(player.song) && !isPlayerPage.value);
</script>

<template>
  <div class="sm-mobile-root" :class="{ 'has-player': showMiniPlayer }">
    <div class="sm-mobile-page">
      <RouterView v-slot="{ Component }">
        <!-- 桌面端 App.vue:292 的过渡与 keep-alive，移动端原先整个漏掉了，
             所以切列表 <-> 播放页是硬切、没有任何动画。 -->
        <transition :name="isPlayerPage ? 'player' : 'page'" mode="out-in">
          <keep-alive :exclude="['PlayerView']" :max="4">
            <component :is="Component" />
          </keep-alive>
        </transition>
      </RouterView>
    </div>
    <MiniPlayer v-if="showMiniPlayer" />
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

  /* --lm-nav-width 是桌面端左侧导航栏的宽度（88px），MiniPlayer 用它做左偏移
     （MiniPlayer.vue:97 的 left）。移动端没有侧栏，留着这一条迷你播放器就会
     整体右移 88px，左边露出一条列表内容 —— 看起来就是「底部状态条错位」。
     自定义属性会沿 DOM 继承，MiniPlayer 虽然是 fixed 定位也照收不误。 */
  --lm-nav-width: 0px;

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

/* 迷你播放器是 fixed 定位，不占流内高度；有歌时给它让出位置，
   否则列表最后几条会被压在下面（桌面端对应 .has-player .main-content）。 */
.sm-mobile-root.has-player .sm-mobile-page {
  padding-bottom: var(--lm-miniplayer-height);
}

.sm-mobile-page {
  flex: 1 1 auto;
  min-height: 0;

  /* 外壳才是滚动容器。桌面端这个角色由 App.vue:538 的 .main-content
     （overflow-y:auto）担任，各页面自己只写 min-height:100% 撑满、不自己滚。
     移动端这里原先写成 overflow:hidden，于是所有列表都滚不动 ——
     内容再多也只显示第一屏。 */
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

/* 路由过渡，取自 App.vue。位移走带轻微回弹的空间弹簧，透明度走不回弹的
   效果弹簧，对应 M3 Expressive 的 MotionScheme.expressive()。 */
.page-enter-active,
.page-leave-active {
  transition:
    transform var(--md-sys-motion-duration-spring-spatial) var(--md-sys-motion-spring-spatial),
    opacity var(--md-sys-motion-duration-spring-effects-fast)
      var(--md-sys-motion-spring-effects-fast);
}
.page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.page-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 播放器路由：抽屉式滑入滑出 */
.player-enter-active,
.player-leave-active {
  transition:
    transform var(--md-sys-motion-duration-spring-spatial) var(--md-sys-motion-spring-spatial),
    opacity var(--md-sys-motion-duration-spring-effects) var(--md-sys-motion-spring-effects);
}
.player-enter-from,
.player-leave-to {
  transform: translateY(100%);
  opacity: 0.6;
}
</style>
