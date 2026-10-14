<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useSkinsStore } from "@/stores/skins";
import { usePlayerStore } from "@/stores/player";
import { useAudioEffectsStore } from "@/stores/audioEffects";
import { useLibraryStore } from "@/stores/library";
import { useMusicTagsStore } from "@/stores/musicTags";
import { useDesktopStore } from "@/stores/desktop";
import { capabilities, isDesktop } from "@/capabilities";
import MiniPlayer from "@/components/MiniPlayer.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import TextPrompt from "@/components/TextPrompt.vue";
import MusicTagDialog from "@/components/MusicTagDialog.vue";
import AppToast from "@/components/AppToast.vue";
import WindowTitleBar from "@/components/WindowTitleBar.vue";
import { useDesktopChrome } from "@/composables/useDesktopChrome";
import { activeSkinDoc, skinBgActive, skinSafeMode } from "@/utils/skinRuntime";
import { markBoot } from "@/utils/bootTiming";
import { armAppReadyFallback, signalAppReady } from "@/utils/appReady";
import ExtensionEmbed from "@/components/ExtensionEmbed.vue";
import type { ExtUiSurface } from "@shared/types";
import { translate } from "@shared/i18n";
import { listen, type Event, type UnlistenFn } from "@/ipc/events";
import { onDragDropEvent, type DragDropEvent } from "@/ipc/dragdrop";
import { getCurrentWindow } from "@/ipc/window";
import {
  DL_BOUNDS_EVENT,
  DL_CONTROL_EVENT,
  DL_READY_EVENT,
  closeDesktopLyricsWindow,
  emitDesktopLyricsState,
  openDesktopLyricsWindow,
  type DesktopLyricsState,
} from "@/utils/desktopLyrics";
import type { DesktopLyricsBounds } from "@/stores/settings";
import { startSpectrumPush, stopSpectrumPush } from "@/utils/desktopLyricsSpectrum";

const settings = useSettingsStore();
const player = usePlayerStore();
const skins = useSkinsStore();
// 桌面环境集成（壁纸 / 常亮锁 / 系统通知 / 系统强调色）
const desktopEnv = useDesktopStore();
// 托盘命令 + 关闭最小化到托盘 + 应用内热键
useDesktopChrome();
// ---- 桌面歌词控制器 ----
let dlUnlisteners: UnlistenFn[] = [];

function pushDesktopLyricsState() {
  if (!settings.desktopLyricsEnabled) return;
  const stateData: DesktopLyricsState = {
    lines: player.lyrics.map((l) => ({
      time: l.time,
      text: l.text,
      translation: l.translation,
      romaji: l.romaji,
      bg: l.bg?.text,
      units:
        settings.desktopLyricsWordByWord && l.units?.length
          ? l.units.map((u) => ({ start: u.start, end: u.end }))
          : undefined,
    })),
    currentTime: player.currentTime,
    playing: player.playing,
    title: player.song?.title ?? "",
    artist: player.song?.artist ?? "",
  };
  void emitDesktopLyricsState(stateData);
}

/**
 * 频谱推送的启停。
 *
 * 只在「桌面歌词开着」且「无歌词显示模式选了频谱」时才推 —— 两个条件任一
 * 不满足都要停，否则会在没人看的时候持续 20Hz 地发 IPC。
 * player.audioEl 在音频元素挂载后才可用，所以这里也用 watch 而不是只在
 * 开关变化时判断一次。
 */
function syncSpectrumPush() {
  const want = settings.desktopLyricsEnabled && settings.desktopLyricsIdleMode === "spectrum";
  if (!want) {
    stopSpectrumPush();
    return;
  }
  const ok = startSpectrumPush(player.audioEl);
  // 音频元素还没就绪时先不起，等它出现后下面的 watch 会再来一次
  if (!ok) stopSpectrumPush();
}

watch(
  () => settings.desktopLyricsEnabled,
  async (on) => {
    if (on) {
      await openDesktopLyricsWindow(settings.desktopLyricsBounds);
      // 等子窗口就绪事件回推一次状态（也做一次兜底延迟发送）
      window.setTimeout(() => pushDesktopLyricsState(), 400);
      syncSpectrumPush();
    } else {
      stopSpectrumPush();
      await closeDesktopLyricsWindow();
    }
  },
);

watch(
  () => [settings.desktopLyricsIdleMode, player.audioEl] as const,
  () => syncSpectrumPush(),
);

onMounted(async () => {
  if (isDesktop) {
    try {
      dlUnlisteners.push(
        await listen<null>(DL_READY_EVENT, () => pushDesktopLyricsState()),
        await listen<{ action: "toggle" | "next" | "prev" | "close" }>(DL_CONTROL_EVENT, (e) => {
          switch (e.payload.action) {
            case "toggle":
              player.togglePlay();
              break;
            case "next":
              void player.next();
              break;
            case "prev":
              void player.previous();
              break;
            case "close":
              settings.desktopLyricsEnabled = false;
              break;
          }
        }),
        await listen<DesktopLyricsBounds>(DL_BOUNDS_EVENT, (e) => {
          settings.desktopLyricsBounds = e.payload;
        }),
      );
    } catch {
      /* 宿主不可用或权限不足时静默 */
    }
  }
});

onBeforeUnmount(() => {
  dlUnlisteners.forEach((un) => un());
  dlUnlisteners = [];
  stopSpectrumPush();
});
const library = useLibraryStore();
const audioEffects = useAudioEffectsStore();
const router = useRouter();
const route = useRoute();

const navItems = computed(() => [
  { key: "images", path: "/images", icon: "image", type: "image" },
  { key: "videos", path: "/videos", icon: "movie", type: "video" },
  { key: "music", path: "/music", icon: "music_note", type: "audio" },
  { key: "books", path: "/books", icon: "menu_book", type: "book" },
  { key: "treasure", path: "/treasure", icon: "inventory_2", type: null },
]);

// ---- 扩展注入到主界面的 UI（contributes.nav / contributes.ui）----
//
// 扩展通过 manifest 声明注入点，主窗口在这里把它们渲染出来 ——
// 这是「扩展改主界面」的正规入口，不必另弹一个窗口。
// 加载失败就当作没有注入：扩展出问题不该让主界面开不出来。
const extSurfaces = ref<ExtUiSurface[]>([]);

/** 导航栏里的扩展项（合并进主界面导航，位置与内置项一致） */
const extNavItems = computed(() =>
  extSurfaces.value
    .filter((s) => s.surface === "nav")
    .map((s) => ({
      key: `ext:${s.extId}:${s.id}`,
      path: `/extension-page/${encodeURIComponent(s.extId)}/${encodeURIComponent(s.route)}`,
      icon: s.icon || "extension",
      label: s.title,
      ext: true,
    })),
);

/** 内容区里的扩展嵌入块：按当前路由筛选 */
const extMainSurfaces = computed(() => {
  const here = route.path;
  return extSurfaces.value.filter((s) => {
    if (s.surface !== "main") return false;
    const only = s.showOnRoutes;
    if (!only || only.length === 0) return true;
    return only.some((p) => here === p || here.startsWith(p.endsWith("/") ? p : p + "/"));
  });
});
const bottomItems = [
  // 收藏 / 历史 / 回收站 / 扩展 已统一收纳进「百宝箱」，不再单独占底部导航
  { key: "settings", path: "/settings", icon: "settings", label: "" },
];

/** 拉取扩展注入点。安装/卸载/启用扩展后由宿主广播 `ext:ui-changed` 触发刷新。 */
async function refreshExtSurfaces() {
  if (!isDesktop) return;
  extSurfaces.value = await capabilities.extUiSurfaces().catch(() => []);
}

function t(key: string) {
  return translate(settings.lang, key);
}

const isPlayerPage = computed(() => route.path === "/music/player");
const isDesktopLyricsPage = computed(() => route.path === "/desktop-lyrics");
const isExtensionHostPage = computed(() => route.path === "/extension-host");
/**
 * 设置页是**自管滚动**的页面：它的左右两栏各自带 overflow 容器，
 * 外层 .main-content 再套一个滚动条就会变成「滚动容器套滚动容器」——
 * 鼠标落在左栏滚列表、落在右侧滚整页，且底部内容会被迷你播放条压住。
 * 所以这里按页面短路 .main-content 的滚动（与 extension-host-page 同一套做法）。
 */
const isSettingsPage = computed(() => route.path === "/settings");
/**
 * 当前窗口是否是**独立绘画窗口**。
 *
 * ⚠️ 必须用窗口 **label** 判定，不能只看路由 `route.path === "/drawing"`。
 * 原因：`useRoute()` 在首次渲染时拿到的还是初始路由（`/` → 重定向 `/images`），
 * 真正的 hash 路由是**异步**解析的。于是「以路由为条件短路外壳」会在第一帧
 * 判成 false，把主界面外壳渲染进绘画窗口 —— 表现就是「绘画窗口里显示的是主界面」，
 * 而路由到位后也不会撤掉（外壳已经挂载）。
 *
 * label 是 Tauri 在窗口创建时就注入的（见 ipc/bridge.ts 的 currentLabel），
 * 同步可读、无竞态 —— 扩展窗口当初也是这么判定的。
 */
const isDrawingWindow = (() => {
  if (!isDesktop) return false;
  try {
    return getCurrentWindow().label === "drawing";
  } catch {
    return false;
  }
})();

/** 是否走「绘画窗口专用渲染」：label 命中，或路由已走到 /drawing。 */
const isDrawingPage = computed(() => isDrawingWindow || route.path === "/drawing");

// 扩展窗口（label: extension，由 Rust open_extension_window 创建）加载的是
// 主 SPA，默认会 redirect 到 /images —— 按 label 重定向到扩展宿主路由。
const isExtensionWindow = (() => {
  if (!isDesktop) return false;
  try {
    return getCurrentWindow().label === "extension";
  } catch {
    return false;
  }
})();

function isActive(path: string) {
  // 扩展页面路由带参数（/extension-page/<extId>/<route>），导航项里存的是
  // 展开后的完整路径，所以这里用前缀匹配，切到别的扩展页时不会残留高亮。
  if (path.startsWith("/extension-page/")) return route.path.startsWith(path);
  return route.path === path;
}

function countOf(type: string | null): number {
  return type ? (library.counts[type] ?? 0) : 0;
}

onMounted(async () => {
  if (isDrawingWindow) {
    // 兜底：万一 hash 没生效（或被重定向走），强制回到绘画路由
    if (route.path !== "/drawing") void router.replace({ path: "/drawing", query: route.query });
    return; // 绘画窗口不跑主界面初始化（皮肤 / 媒体库 / 拖放监听全都不需要）
  }
  if (isExtensionWindow) {
    void router.replace("/extension-host");
    return; // 扩展宿主窗口不需要主界面初始化（皮肤/媒体库）
  }
  // 启动打点：这段串行 await 是「白屏/splash 停留」的主要来源，逐段记耗时
  markBoot("主界面初始化开始");
  // 桌面集成能力探测（异步、不阻塞启动）：结果决定壁纸/常亮锁/通知入口显隐，
  // 强调色到达后由 settings 的种子来源 watch 自动重算主题。
  void desktopEnv.init();
  await settings.load();
  markBoot("设置已加载");

  // 先用**基础主题**出界面，皮肤稍后再换。
  //
  // 原来这里是 `await skins.load()` 再 applyTheme，串行多等约 420ms
  // （实测：设置 785ms → 皮肤 1204ms）。而 skins.load() 里是三次 IPC + 皮肤文件
  // 读取解析，全都挡在首屏前面。
  //
  // 取舍：皮肤会带来配色切换（默认动态色 → 皮肤色）。这是**有意的**——
  // 用户明确要求「先出界面再换肤」。若要消除这次切换，就得把皮肤挡回首屏前，
  // 那 420ms 也就回来了。
  settings.applyTheme(settings.theme);
  markBoot("主题已应用");

  void audioEffects.init();
  void library.refreshCounts();
  // 在线歌曲的标签覆盖：启动时一次性灌回内存，切歌时无需再等 IPC
  void useMusicTagsStore().hydrate();

  // 首屏已经画出来了（主题已应用 + 下一帧）就让宿主显示窗口。
  // 媒体库路由若还要等首屏数据，那段更早由 library.refresh 发信号；
  // 这里只兜住「非媒体库路由」和「数据迟迟不来」两种情况。
  void nextTick(() => {
    requestAnimationFrame(() => {
      signalAppReady("主题已应用");
      armAppReadyFallback(1500);
    });
  });

  // 皮肤延后加载：就绪后再换肤并重解析主题（含 -safe-mode 与内置皮肤播种）
  void (async () => {
    await skins.load();
    markBoot("皮肤已加载");
    settings.applyTheme(settings.theme);
    markBoot("主题已应用(含皮肤)");
  })();
});

// ---- 皮肤拖拽导入（全窗口任意位置，支持 v1 .json 与 v2 .zip）----
const skinDropOver = ref(false);
let unDragDrop: UnlistenFn | null = null;
function isSkinFile(x: string): boolean {
  const l = x.toLowerCase();
  return l.endsWith(".json") || l.endsWith(".zip");
}
onMounted(async () => {
  if (!isDesktop) return;
  try {
    unDragDrop = await onDragDropEvent((e: Event<DragDropEvent>) => {
      const p = e.payload;
      if (p.type === "enter") {
        skinDropOver.value = p.paths.some(isSkinFile);
      } else if (p.type === "leave") {
        skinDropOver.value = false;
      } else if (p.type === "drop") {
        skinDropOver.value = false;
        const file = p.paths.find(isSkinFile);
        if (file) void skins.importFromFile(file);
        else skins.notice = t("settings.skinDropUnsupported");
      }
    });
  } catch {
    /* 拖拽事件不可用时静默（非桌面环境） */
  }
});
onBeforeUnmount(() => {
  unDragDrop?.();
  unDragDrop = null;
});

// ---- 扩展主界面注入点 ----
// 首次加载 + 订阅宿主的变更广播（装/卸/启用扩展后刷新，不必重启应用）。
let unExtUi: (() => void) | null = null;
onMounted(async () => {
  await refreshExtSurfaces();
  if (!isDesktop) return;
  unExtUi = await capabilities.onExtUiChanged(() => void refreshExtSurfaces());
});
onBeforeUnmount(() => {
  unExtUi?.();
  unExtUi = null;
});

// ---- 滚动位置记忆 ----
// keep-alive 缓存组件时，离开路由后 main-content 内容高度塌缩，浏览器会把
// scrollTop 钳制回顶部，返回时位置已丢失。这里在切换前记录、返回后恢复。
const scrollMemory = new Map<string, number>();
const mainEl = ref<HTMLElement | null>(null);
let scrollRestoreTimer: number | null = null;
router.beforeEach((_to, from) => {
  if (mainEl.value) {
    scrollMemory.set(from.path, mainEl.value.scrollTop);
  }
});
router.afterEach((to) => {
  const saved = scrollMemory.get(to.path);
  if (saved === undefined) return;
  // 等路由过渡（180ms）+ 内容重插入完成后再恢复
  if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = window.setTimeout(() => {
    if (mainEl.value) mainEl.value.scrollTop = saved;
  }, 260);
});
</script>

<template>
  <!--
    独立绘画窗口：整块主界面外壳（导航栏 / 标题栏 / 播放条 / 皮肤背景）都不渲染，
    只留路由出口。绘画窗口有自己的完整布局（见 views/DrawingWindow.vue）。

    为什么在 App.vue 这一层短路，而不是靠 CSS 隐藏：
    外壳里挂着全局监听（拖放、快捷键、播放器、皮肤），隐藏只是看不见，
    它们照样在跑；而绘画是吃性能的场景，不该被主界面的监听分走。
  -->
  <router-view v-if="isDrawingPage" />

  <div
    v-else
    class="app-shell"
    data-lm-region="shell"
    :class="{
      'has-player': player.song && !isPlayerPage,
      'desktop-lyrics-page': isDesktopLyricsPage,
      'extension-host-page': isExtensionHostPage,
      'settings-page': isSettingsPage,
    }"
  >
    <!-- 皮肤背景图层（v2：变量由 skinLoader 写入；播放器页/桌面歌词页不渲染） -->
    <div
      v-if="skinBgActive && !isPlayerPage && !isDesktopLyricsPage && !isExtensionHostPage"
      class="lm-skin-bg"
      aria-hidden="true"
    ></div>

    <!-- Windows 自定义标题栏（仅桌面端，播放页/桌面歌词页/扩展宿主页隐藏） -->
    <WindowTitleBar
      v-if="isDesktop && !isPlayerPage && !isDesktopLyricsPage && !isExtensionHostPage"
    />

    <!-- 主体：左侧导航 + 内容区 -->
    <div class="app-body">
      <!-- 左侧导航 Rail -->
      <nav
        v-if="!isPlayerPage && !isDesktopLyricsPage && !isExtensionHostPage"
        class="nav-rail lm-glass"
        data-lm-region="nav"
      >
        <div v-if="!isDesktop" class="brand">
          <span class="material-symbols-outlined brand-mark">blur_on</span>
          <span class="brand-name">{{ t("app.name") }}</span>
        </div>

        <div class="nav-group">
          <button
            v-for="item in navItems"
            :key="item.key"
            class="nav-item"
            :class="{ active: isActive(item.path) }"
            @click="router.push(item.path)"
          >
            <span class="indicator">
              <span class="material-symbols-outlined" :class="{ filled: isActive(item.path) }">{{
                item.icon
              }}</span>
              <span v-if="countOf(item.type)" class="badge tabular-nums">{{
                countOf(item.type) > 999 ? "999+" : countOf(item.type)
              }}</span>
            </span>
            <span class="label">{{ t("nav." + item.key) }}</span>
          </button>

          <!-- 扩展注入的导航项（contributes.nav / contributes.ui surface="nav"）：
               与内置项同一套样式，点击跳到 /extension-page/<extId>/<route>。 -->
          <button
            v-for="item in extNavItems"
            :key="item.key"
            class="nav-item"
            :class="{ active: isActive(item.path) }"
            :title="item.label"
            @click="router.push(item.path)"
          >
            <span class="indicator">
              <span class="material-symbols-outlined" :class="{ filled: isActive(item.path) }">{{
                item.icon
              }}</span>
            </span>
            <span class="label">{{ item.label }}</span>
          </button>
        </div>

        <div class="nav-group bottom">
          <button
            v-for="item in bottomItems"
            :key="item.key"
            class="nav-item"
            :class="{ active: isActive(item.path) }"
            @click="router.push(item.path)"
          >
            <span class="indicator">
              <span class="material-symbols-outlined" :class="{ filled: isActive(item.path) }">{{
                item.icon
              }}</span>
            </span>
            <span class="label">{{ item.label || t("nav." + item.key) }}</span>
          </button>
        </div>
      </nav>

      <!-- 内容区 -->
      <div class="content" data-lm-region="content">
        <main ref="mainEl" class="main-content">
          <!-- 扩展注入到内容区顶部的块（contributes.ui surface="main" position="top"） -->
          <ExtensionEmbed
            v-for="s in extMainSurfaces.filter((x) => x.position !== 'bottom')"
            :key="`${s.extId}:${s.id}`"
            :surface="s"
          />

          <router-view v-slot="{ Component }">
            <transition :name="isPlayerPage ? 'player' : 'page'" mode="out-in">
              <!--
                keep-alive 的取舍（内存相关，改之前先读这段）：

                - max：默认永不淘汰，访问过的每个页面都会常驻（含其 DOM 与虚拟滚动层），
                  会话越长内存/GC 压力越大。8 个足够覆盖常用来回切换。
                - exclude：**只对路由级组件生效**。注意媒体页里的在线源
                  （PixivOnlineView / AnimeOnlineView / BilibiliOnlineView / NovelOnlineView）
                  是 ImagesView / VideosView / BooksView 的**子组件**，不是路由组件，
                  在这里写它们没有任何效果 —— 它们的常驻与否取决于所属视图是否被缓存。
                - 这里排除的是「缓存了也没有收益」的轻量页：它们要么每次都由 store/SQLite
                  快速重建，要么本身只有几十个节点。排除后 keep-alive 的槽位留给
                  四个媒体页与设置页这类真正重的页面，避免被工具页挤掉。
                  （exclude 按组件名匹配；<script setup> 下 Vue 从文件名推导，
                   与现有的 PlayerView 同一机制，无需 defineOptions。）

                注意：把 max 从 8 继续下调是**有 UX 代价**的（用户刚滚过的媒体网格会被销毁重建）。
                要不要降、降到几，应当用设置页「内存诊断」实测后再定，不要凭感觉调。
              -->
              <keep-alive
                :exclude="[
                  'PlayerView',
                  'PresetMarket',
                  'OsuView',
                  'ExtensionsView',
                  'NovelStatsView',
                  'DesktopLyrics',
                  'ExtensionHost',
                ]"
                :max="8"
              >
                <component :is="Component" />
              </keep-alive>
            </transition>
          </router-view>

          <!-- 扩展注入到内容区底部的块（position="bottom"） -->
          <ExtensionEmbed
            v-for="s in extMainSurfaces.filter((x) => x.position === 'bottom')"
            :key="`${s.extId}:${s.id}`"
            :surface="s"
          />
        </main>
      </div>
    </div>

    <MiniPlayer
      v-if="player.song && !isPlayerPage && !isDesktopLyricsPage && !isExtensionHostPage"
    />

    <!-- 全局 M3 右键菜单、文本输入框与写标签对话框（Teleport 到 body） -->
    <ContextMenu />
    <TextPrompt />
    <MusicTagDialog />
    <AppToast />

    <!-- 全局回退提示（播放器 store 触发，播放页/列表页均可见） -->
    <transition name="lyric-toast">
      <div v-if="player.lyricNotice" class="lyric-toast">
        <span class="material-symbols-outlined">info</span>
        {{ player.lyricNotice }}
      </div>
    </transition>

    <!-- 皮肤系统全局通知（导入/更新/回退等） -->
    <transition name="lyric-toast">
      <div v-if="skins.notice" class="lyric-toast skin-toast">
        <span class="material-symbols-outlined">palette</span>
        {{ skins.notice }}
      </div>
    </transition>

    <!-- 皮肤拖拽导入遮罩 -->
    <transition name="skin-fade">
      <div v-if="skinDropOver" class="skin-drop-overlay">
        <div class="skin-drop-card">
          <span class="material-symbols-outlined">palette</span>
          <span>{{ t("settings.skinDrop") }}</span>
        </div>
      </div>
    </transition>

    <!-- 皮肤远程引用导入确认（方案书 §2 D5） -->
    <transition name="skin-fade">
      <div
        v-if="skins.pendingRemote"
        class="skin-modal-scrim"
        @click.self="skins.cancelRemoteImport()"
      >
        <div class="skin-modal">
          <h3>{{ t("settings.skinRemoteTitle") }}</h3>
          <p class="skin-modal-hint">{{ t("settings.skinRemoteHint") }}</p>
          <ul class="skin-refs">
            <li v-for="r in skins.pendingRemote.refs" :key="r" :title="r">{{ r }}</li>
          </ul>
          <div class="skin-modal-actions">
            <m3e-button variant="text" size="small" @click="skins.cancelRemoteImport()">
              {{ t("settings.skinCancel") }}
            </m3e-button>
            <m3e-button variant="filled" size="small" @click="skins.confirmRemoteImport()">
              {{ t("settings.skinStillImport") }}
            </m3e-button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--md-sys-color-background);
}

/* ---- 皮肤背景图层（v2）：z-index 0 铺底，内容层在其上 ---- */
.lm-skin-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-image: var(--lm-skin-bg-image, none);
  background-size: var(--lm-skin-bg-size, cover);
  background-position: var(--lm-skin-bg-position, center);
  background-repeat: no-repeat;
  pointer-events: none;
}
.lm-skin-bg::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--lm-skin-bg-overlay, transparent);
}
/* 背景激活时内容层抬到背景之上 */
.app-shell:has(> .lm-skin-bg) .app-body {
  position: relative;
  z-index: 1;
}
.app-shell.desktop-lyrics-page {
  background: transparent;
}
.app-shell.desktop-lyrics-page .main-content {
  padding: 0;
}

.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* ---- 导航 Rail ---- */
.nav-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: var(--lm-nav-width);
  flex: none;
  padding: 14px 8px 12px;
  border-right: 1px solid var(--lm-hairline);
  z-index: 10;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-bottom: 14px;
  color: var(--md-sys-color-primary);
}
.brand-mark {
  font-size: 26px;
  font-variation-settings:
    "FILL" 1,
    "wght" 500;
}
.brand-name {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
}

.nav-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
}
.nav-group.bottom {
  margin-top: auto;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 0 7px;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--md-sys-shape-corner-medium);
}
.nav-item:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: -2px;
}

/* M3 药丸形状选中指示器 */
.indicator {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 32px;
  border-radius: 16px;
  transition:
    background var(--md-sys-motion-duration-short) var(--md-sys-motion-spring-effects-fast),
    transform 200ms var(--md-sys-motion-spring);
}
.nav-item:hover .indicator {
  background: var(--md-sys-color-surface-container-high);
}
.nav-item.active .indicator {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.nav-item:active .indicator {
  transform: scale(0.9);
}
.indicator .material-symbols-outlined {
  font-size: 22px;
}

.badge {
  position: absolute;
  top: -3px;
  right: 4px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
}

.label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.2px;
}
.nav-item.active .label {
  color: var(--md-sys-color-on-surface);
  font-weight: 500;
}

/* ---- 内容区 ---- */
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.main-content {
  flex: 1;
  overflow-y: auto;
  /* 滚动条按占位计算：自定义滚动条宽 10px，内容长短不同的页面/分类切换时
     滚动条忽有忽无会让整块内容左右跳 10px（表现为"卡片宽度不一样、左栏不固定"） */
  scrollbar-gutter: stable;
  padding: var(--lm-content-pad);
  /* 迷你播放条不遮挡末行内容 */
  padding-bottom: var(--lm-content-pad);
}
.has-player .main-content {
  padding-bottom: calc(var(--lm-miniplayer-height) + var(--lm-content-pad));
}

/* 设置页（.settings-view）：
   它自己管滚动 —— 左右两栏各带一个 overflow 容器（见 SettingsView.vue 的
   .settings-nav / .settings-body），所以外壳**不能再套一层滚动条**，
   否则就是「滚动容器套滚动容器」：鼠标落在左栏滚列表、落在右侧滚整页。

   高度走 flex（而不是让子元素 height:100%），这样扩展注入到内容区的块
   （ExtensionEmbed surface="main"）仍能先占自己的自然高度，设置页拿剩下的。

   ⚠️ **踩过的坑**：把这里改成 display:flex 之后，子元素 .settings-view 的
   margin:0 auto 换了含义 —— flex 的自动外边距会吞掉交叉轴剩余空间，使该项
   不再被 align-items:stretch 拉伸，宽度退化成 fit-content。表现是设置卡片
   宽度随内容长短乱跳（外观 ~520px、歌词 ~750px），右侧空出一大片。
   解法是给 .settings-view 显式 width:100%（见 SettingsView.vue），
   而不是把父级改回 block —— 那样扩展块就没法参与高度分配了。

   注意：这里**不要**另写 padding-bottom 给迷你播放条留位 —— 上面的
   .has-player .main-content 已经给了 calc(--lm-miniplayer-height + --lm-content-pad)，
   再写一条更具体的规则去覆盖它只会把 --lm-content-pad 吃掉。
   旧代码的问题恰恰是「自己猜高度」（max-height: calc(100vh - 120px)），别再重复这个错。 */
.settings-page .main-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  scrollbar-gutter: auto;
}

/* 扩展宿主页（专用窗口 label="extension"）：
   它是**另开的那个窗口**里的页面，主界面的内边距在这里没有意义 ——
   留着会在扩展 UI 周围套一圈白边（截图里那圈很明显）。
   滚动条同理：扩展自带 UI 自己管滚动，外边再套一层会出现双滚动条。 */
.extension-host-page .main-content {
  padding: 0;
  overflow: hidden;
  scrollbar-gutter: auto;
}

/* 路由切换（屏幕过渡）：位移走带轻微回弹的空间弹簧，透明度走不回弹的
   效果弹簧——对应 M3 Expressive 的 MotionScheme.expressive()。
   时长取各自弹簧的自然稳定时间，让回弹完整播放而不被截断。 */
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

/* 全局回退提示 toast */
.lyric-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(560px, 80vw);
  padding: 11px 18px;
  border-radius: 999px;
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  box-shadow: var(--md-elevation-3);
  font-size: var(--md-sys-typescale-body-small-size);
}
.lyric-toast .material-symbols-outlined {
  font-size: 17px;
  opacity: 0.85;
}
.lyric-toast-enter-active,
.lyric-toast-leave-active {
  transition: all 240ms var(--md-sys-motion-spring-spatial);
}
.lyric-toast-enter-from,
.lyric-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}

/* ---- 皮肤系统全局层 ---- */

/* 皮肤通知：与回退提示错开（顶部居中，避开标题栏） */
.skin-toast {
  top: calc(var(--lm-titlebar-height) + 8px);
  bottom: auto;
}

.skin-fade-enter-active,
.skin-fade-leave-active {
  transition: opacity 160ms var(--md-sys-motion-spring-effects-fast);
}
.skin-fade-enter-from,
.skin-fade-leave-to {
  opacity: 0;
}

.skin-drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--md-sys-color-scrim) 60%, transparent);
  pointer-events: none;
}
.skin-drop-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 30px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  border: 2px dashed var(--md-sys-color-primary);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-primary);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.skin-drop-card .material-symbols-outlined {
  font-size: 26px;
}

.skin-modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 310;
  display: grid;
  place-items: center;
  background: var(--md-sys-color-scrim);
}
.skin-modal {
  width: min(480px, 86vw);
  padding: 22px 24px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-elevation-3);
}
.skin-modal h3 {
  margin-bottom: 8px;
  font-size: var(--md-sys-typescale-title-medium-size);
}
.skin-modal-hint {
  margin-bottom: 10px;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}
.skin-refs {
  max-height: 140px;
  margin-bottom: 14px;
  padding: 8px 12px;
  overflow-y: auto;
  list-style: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container);
  font-size: var(--md-sys-typescale-body-small-size);
  font-family: monospace;
  word-break: break-all;
}
.skin-refs li {
  padding: 2px 0;
  color: var(--md-sys-color-on-surface-variant);
}
.skin-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
