/**
 * 播放器独立入口（Flutter 宿主 / WebView2）。
 *
 * 与 src/main.ts 的区别：这里只挂载「音乐」这条播放链路的最小应用——
 * MusicView（歌单/列表）、PlayerView（全屏播放器）以及两者之间常驻的
 * MiniPlayer，不引导航 Rail、不引 App.vue、不引无关业务页。
 *
 * 由 vite.player.config.ts 单入口打包成 player-dist，再由 Flutter 侧的
 * loopback HTTP 中间层伺服；中间层在 /shim.js 注入 window.__SILVERMOON__，
 * 因此这里不需要（也不能）自己造宿主桥。
 *
 * 路由用 hash 模式：产物经 loopback 伺服时路径不固定，hash 路由无需服务端
 * 重写就能深链（player.html#/music、player.html#/player）。
 */
import { computed, createApp, defineComponent, h, onMounted, onUnmounted } from "vue";
import { createPinia } from "pinia";
import { RouterView, createRouter, createWebHashHistory, useRoute } from "vue-router";
import MiniPlayer from "@/components/MiniPlayer.vue";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
// 字体声明必须先于主题令牌引入（与 src/main.ts 同一顺序约定）
import "@/tokens/fonts.css";
import "@/tokens/theme.css";
// @m3e/web 原生组件按需注册（MiniPlayer / MusicView 用到 m3e-icon-button 等）
import "@/m3e";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/music" },
    { path: "/music", name: "music", component: () => import("@/views/MusicView.vue") },
    { path: "/player", name: "player", component: () => import("@/views/PlayerView.vue") },
    // MusicView / MiniPlayer 内部沿用桌面端的 router.push("/music/player")，
    // 这里保留同一路径，避免复用源码被迫改动（同组件、仅多一条别名路由）。
    {
      path: "/music/player",
      name: "player-legacy",
      component: () => import("@/views/PlayerView.vue"),
    },
  ],
});

/**
 * 迷你外壳：复刻 App.vue 里 MiniPlayer 的位置关系——
 * 与路由视图同级、位于其后、由 .player-shell 的底部内边距避让，
 * 只在「有歌在播 且 不在全屏播放页」时渲染（与 App.vue 的 v-if 条件一致）。
 */
const PlayerShell = defineComponent({
  name: "PlayerShell",
  setup() {
    const player = usePlayerStore();
    const settings = useSettingsStore();
    const route = useRoute();

    const isPlayerPage = computed(
      () => route.name === "player" || route.name === "player-legacy",
    );
    const showMiniPlayer = computed(() => Boolean(player.song) && !isPlayerPage.value);

    // App.vue 里这部分属于主界面初始化；播放器链路同样依赖已落盘的设置
    // （主题、音量、在线音乐开关、播放器相关偏好），故照搬最小子集。
    onMounted(async () => {
      await settings.load();
      settings.applyTheme(settings.theme);
    });

    /**
     * 宿主设置变更。
     *
     * 播放层在自己的进程里跑，settings store 只在挂载时读过一次盘；Flutter 设置页
     * 写的是同一个 settings.json，不重读就会出现「设置页改了，播放器还用旧值」。
     * 宿主在写盘后广播 app:settings-changed（中间层 POST /bridge/emit → SSE →
     * silvermoon:event），这里收到就重读并重新应用主题。
     */
    const onHostEvent = (event: Event): void => {
      const frame = (event as CustomEvent<{ event?: string }>).detail;
      if (frame?.event !== "app:settings-changed") return;
      void settings.load().then(() => settings.applyTheme(settings.theme));
    };
    onMounted(() => window.addEventListener("silvermoon:event", onHostEvent));
    onUnmounted(() => window.removeEventListener("silvermoon:event", onHostEvent));

    return () =>
      h("div", { class: ["player-shell", { "has-player": showMiniPlayer.value }] }, [
        h(RouterView),
        showMiniPlayer.value ? h(MiniPlayer) : null,
      ]);
  },
});

const app = createApp(PlayerShell);
app.use(createPinia());
app.use(router);
app.mount("#app");
