import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/images" },
    { path: "/images", component: () => import("@/views/ImagesView.vue") },
    { path: "/videos", component: () => import("@/views/VideosView.vue") },
    { path: "/music", component: () => import("@/views/MusicView.vue") },
    { path: "/music/player", component: () => import("@/views/PlayerView.vue") },
    { path: "/books", component: () => import("@/views/BooksView.vue") },
    { path: "/games", component: () => import("@/views/GamesView.vue") },
    // 游戏详情页：独立路由（此前是 GamesView 里的 m3e-dialog 浮窗）。
    // props:true 把 :appId 直接当 prop 传进去，详情页不必自己读 route。
    {
      path: "/games/:appId",
      component: () => import("@/views/GameDetailView.vue"),
      props: true,
    },
    { path: "/folders", component: () => import("@/views/FoldersView.vue") },
    { path: "/webdav", component: () => import("@/views/WebDavView.vue") },
    { path: "/treasure", component: () => import("@/views/TreasureView.vue") },
    { path: "/treasure/market", component: () => import("@/views/PresetMarket.vue") },
    { path: "/treasure/osu", component: () => import("@/views/OsuView.vue") },
    { path: "/favorites", component: () => import("@/views/FavoritesView.vue") },
    { path: "/history", component: () => import("@/views/HistoryView.vue") },
    { path: "/stats", component: () => import("@/views/StatsView.vue") },
    { path: "/novel-stats", component: () => import("@/views/NovelStatsView.vue") },
    { path: "/trash", component: () => import("@/views/TrashView.vue") },
    { path: "/settings", component: () => import("@/views/SettingsView.vue") },
    { path: "/desktop-lyrics", component: () => import("@/views/DesktopLyrics.vue") },
    { path: "/extensions", component: () => import("@/views/ExtensionsView.vue") },
    { path: "/extension-host", component: () => import("@/views/ExtensionHost.vue") },
    // 扩展页面：承载 contributes.nav / contributions.ui(surface="nav") 注入的导航项。
    // 走主窗口内容区（而不是另开窗口），这样点导航项就像切页面一样自然。
    {
      path: "/extension-page/:extId/:route",
      component: () => import("@/views/ExtensionPage.vue"),
      props: true,
    },
    // 独立绘画窗口（最大化窗口，见 utils/drawingWindow.ts）
    { path: "/drawing", component: () => import("@/views/DrawingWindow.vue") },
  ],
});

// 开发专用：正式构建消除该路由与组件，不向用户增加未经评审的产品入口。
if (import.meta.env.DEV) {
  router.addRoute({
    path: "/__design",
    component: () => import("@/views/DesignSystemView.vue"),
  });
}

export default router;
