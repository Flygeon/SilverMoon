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
import { holdHeroFlight, recordHeroSource, startHeroFlight } from "@/utils/heroTransition";
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
import { emitDesktopLyricsSettingsChanged } from "@/utils/desktopLyrics";

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
      /**
       * 子窗口已经开着时，改设置必须**通知它**。
       *
       * 两个窗口各有独立的 Pinia store：主窗口改了 desktopLyricsAnchor，
       * 歌词窗口内存里那份不会跟着变（它只在挂载时 load 一次）。
       * 所以这里把「设置变了」广播过去，让它重新 load 并重新锚定。
       */
      void emitDesktopLyricsSettingsChanged();
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

/**
 * 桌面歌词相关设置一变就通知子窗口。
 *
 * 两个窗口各有独立的 Pinia store，主窗口这边改了值，子窗口内存里那份不会变
 * —— 子窗口只在自己挂载时 load 过一次。不通知的话，用户在设置页改了
 * 「吸附任务栏」「逐字填充」等，歌词窗口**当场毫无反应**，
 * 必须等下次重开窗口才生效（这正是「吸不上去」的根因之一）。
 *
 * 监听的是**整个桌面歌词设置组**而不是逐项：漏列一项就是一次
 * 「改了没反应」，而多通知一次的代价只是一次 IPC + 一次读盘。
 */
watch(
  () => [
    settings.desktopLyricsAnchor,
    settings.desktopLyricsAnchorAlign,
    settings.desktopLyricsAnchorOffsetX,
    settings.desktopLyricsAnchorOffsetY,
    settings.desktopLyricsWordByWord,
    settings.desktopLyricsIdleMode,
    settings.desktopLyricsShowNext,
    settings.desktopLyricsShowTranslation,
    settings.desktopLyricsFontSize,
    settings.desktopLyricsOpacity,
    settings.desktopLyricsAnimation,
    settings.desktopLyricsToolbar,
    settings.desktopLyricsDoubleClick,
    settings.desktopLyricsLocked,
    settings.desktopLyricsAlwaysOnTop,
    settings.desktopLyricsClickThrough,
  ],
  () => {
    if (!settings.desktopLyricsEnabled) return;
    void emitDesktopLyricsSettingsChanged();
  },
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

/**
 * 是否处在「游戏」区域（网格页与详情页）。
 *
 * 这块区域的路由切换**不能用 `mode="out-in"`**：
 * out-in 要等旧页面离场后才挂载新页面，而卡片→详情是一次共享元素飞行，
 * 新页必须立刻进 DOM 才有东西可补间。用 out-in 的结果就是
 * 「点击后卡一下，然后直接出现，没有飞行动画」。
 *
 * 注意是**按路由静态判断**，不要按「过渡是否进行中」动态切换：
 * 后者会让 Transition 组件重建，反而引入新的卡顿。
 */
const isGamesArea = computed(() => route.path.startsWith("/games"));

const navItems = computed(() => [
  { key: "images", path: "/images", icon: "image", type: "image" },
  { key: "videos", path: "/videos", icon: "movie", type: "video" },
  { key: "music", path: "/music", icon: "music_note", type: "audio" },
  { key: "books", path: "/books", icon: "menu_book", type: "book" },
  // 游戏：Steam 登录 + 游戏库（见 views/GamesView.vue）。type 为 null，
  // 因为它不进媒体库统计，导航徽标不该显示媒体条数。
  { key: "games", path: "/games", icon: "sports_esports", type: null },
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

/**
 * 外壳（导航栏 / 标题栏 / 迷你条）是否可见。
 *
 * ⚠️ **不能直接用 `!isPlayerPage`**：`isPlayerPage` 在路由变化那一 tick 就翻转，
 * 于是导航栏（88px）与标题栏被 `v-if` 立刻卸载，而 `<transition mode="out-in">`
 * 还要先等旧页离场、再挂新页 —— 中间这一两帧里内容区**向左展开 88px**，
 * 页面看起来"先抖一下再进播放器"。这就是用户反复报的「先触发界面重排」。
 *
 * 解法：进播放页时**延后**收外壳，等播放页挂载完（它 `position:fixed; inset:0`，
 * 完全不透明，把下面的外壳盖住）再收 —— 收的动作发生在看不见的地方，零观感成本。
 * 反过来（播放页 → 列表）必须**立刻**把外壳放回来：那时播放页正在滑走，
 * 下面露出来的必须是完整的外壳，晚一帧就会露出空白。
 */
const shellChromeVisible = ref(true);
watch(isPlayerPage, (nowPlayer) => {
  if (nowPlayer) {
    // 等播放页真正挂上（两帧足够：enter 类切换 + 首帧绘制）
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (route.path === "/music/player") shellChromeVisible.value = false;
      }),
    );
  } else {
    shellChromeVisible.value = true;
  }
});

/**
 * 全局 hero 起飞。
 *
 * 挂在 document 的 **capture** 阶段：业务代码的 @click 在冒泡阶段才跑，
 * 那时可能已经 `router.push` 了（DOM 即将被替换），量 rect 会拿到中间态。
 * capture 阶段先于一切业务 handler，能拿到点击瞬间的真实布局。
 *
 * 只负责「起飞」：真正要等目标路由确认后才 hold —— 见 onHeroNavigate 注释。
 */
/**
 * 本次点击命中的源封面（可能为空）。
 *
 * 只记录元素、**不立即起飞** —— 很多入口的处理是 async 的（先解析播放地址再
 * `router.push`），提前起飞会让封面先消失、克隆层停着不动，等几百毫秒才开始飞。
 * 真正起飞放在 router.afterEach（路由已确认、DOM 未替换，rect 与点击瞬间一致）。
 */
let heroSourceEl: HTMLElement | null = null;

function onHeroPointerDown(ev: PointerEvent) {
  heroSourceEl = recordHeroSource(ev);
}

document.addEventListener("pointerdown", onHeroPointerDown, true);
onBeforeUnmount(() => document.removeEventListener("pointerdown", onHeroPointerDown, true));
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
/**
 * 待恢复的滚动位置。
 *
 * 恢复时机必须是「新页面 DOM 已插回、但这一帧还没绘制」——见下方
 * onRouteEnter 的长注释。这里用模块内的普通变量而不是 ref：
 * 它只在帧内被读写，不该触发任何组件重渲染。
 */
let pendingScrollTop: number | null = null;
let scrollRestoreRaf: number | null = null;
let scrollRestoreTries = 0;

/** 最多重试多少帧（约 0.5s）。覆盖「返回的页面数据异步到达、高度晚一截」的情况。 */
const SCROLL_RESTORE_MAX_FRAMES = 30;

function cancelScrollRestore(): void {
  if (scrollRestoreRaf !== null) {
    cancelAnimationFrame(scrollRestoreRaf);
    scrollRestoreRaf = null;
  }
  scrollRestoreTries = 0;
}

/** 立即尝试恢复；内容高度还不够时返回 false（由调用方下一帧重试）。 */
function applyPendingScroll(): boolean {
  if (pendingScrollTop === null) return true;
  const el = mainEl.value;
  if (!el) {
    pendingScrollTop = null;
    return true;
  }
  el.scrollTop = pendingScrollTop;
  // 高度不足时浏览器会把 scrollTop 钳到更小的值 —— 不能直接清掉待办
  if (Math.abs(el.scrollTop - pendingScrollTop) > 1) return false;
  pendingScrollTop = null;
  return true;
}

/**
 * 恢复返回页面的滚动位置。
 *
 * ⚠️ 不要再用 setTimeout(260ms) 兜底：那是旧实现的写法，等 260ms 期间
 * 歌单已经插回并在顶部绘制了好几帧，用户看到的就是「先闪回歌单顶部，
 * 再跳回点击时停留的位置」。返回列表比进去更常发生，这个闪回非常显眼。
 *
 * 正确时机是路由 transition 的 enter 钩子：此时新页面的 DOM 已经插回
 * （keep-alive 的缓存子树是整棵搬回来的，高度立刻恢复），而浏览器还没绘制这一帧。
 * 在这里同步写 scrollTop，用户从第一帧看到的就是正确位置。
 *
 * 兜底重试只服务「异步数据还没到、高度暂时不够」的页面：逐帧重试直到设置成功，
 * 命中即停。keep-alive 场景第一次就会成功，不会产生任何可见跳动。
 */
function restoreScrollForRoute(): void {
  cancelScrollRestore();
  if (pendingScrollTop === null) return;
  if (applyPendingScroll()) return;
  const tick = () => {
    scrollRestoreRaf = null;
    if (pendingScrollTop === null) return;
    if (applyPendingScroll()) return;
    if (++scrollRestoreTries > SCROLL_RESTORE_MAX_FRAMES) {
      pendingScrollTop = null;
      return;
    }
    scrollRestoreRaf = requestAnimationFrame(tick);
  };
  scrollRestoreRaf = requestAnimationFrame(tick);
}

/**
 * 路由 transition 的 enter 钩子：新页面已插入、尚未绘制。
 *
 * 这里只负责把滚动位置放回去，不掺和任何动画 —— 它和 hero 飞行、
 * 页面入场过渡互不依赖。
 */
function onRouteEnter(): void {
  restoreScrollForRoute();
}

router.beforeEach((_to, from) => {
  if (mainEl.value) {
    scrollMemory.set(from.path, mainEl.value.scrollTop);
  }
});
onBeforeUnmount(() => {
  cancelScrollRestore();
  pendingScrollTop = null;
});
router.afterEach((to) => {
  /*
   * 把「点击时起飞的那条飞行」交给目标页。
   *
   * 为什么不直接在 pointerdown 里 hold：那时还不知道这次点击会不会真的跳转。
   * 用户点了一首歌、`playOnline` 报「版权不可播」，路由不动，飞行就会孤零零
   * 停在半空。放到 afterEach 才 hold，能保证「只有真的跳了才让它等降落」。
   *
   * 代价是飞行层在 pointerdown 到路由切换之间是「已创建但未托管」的，
   * 所以 holdHeroFlight 里有 900ms 兜底超时。
   */
  /*
   * 路由已确认，这里才真正起飞。
   *
   * 此刻 DOM 还没被替换（Vue 的异步渲染在 afterEach 之后），源元素仍在文档里，
   * `getBoundingClientRect()` 与点击瞬间完全一致。
   */
  if (heroSourceEl) {
    const flight = startHeroFlight(heroSourceEl);
    heroSourceEl = null;
    if (flight) holdHeroFlight(flight);
  }

  /*
   * 记录这次导航要恢复的滚动位置。真正写入放在 onRouteEnter（enter 钩子）
   * 里，那里有逐帧兜底 —— 这里先标记，别在 DOM 还没换的时候就写。
   */
  const saved = scrollMemory.get(to.path);
  pendingScrollTop = saved !== undefined && saved > 0 ? saved : null;
  // ⚠️ 这里不能立刻写 scrollTop：afterEach 时 DOM 还是旧页面，
  // 在新 DOM 插回之前写等于把旧页面滚到目标位置，随后内容高度塌缩又被打回 0。
  // 真正的恢复点只有 onRouteEnter（transition 的 enter 钩子）。
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
      'has-player': player.song && shellChromeVisible && !isSettingsPage,
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
    <!-- 收外壳用 shellChromeVisible 而不是 !isPlayerPage：见 script 里的注释，
         直接跟随路由会在播放页挂载前把导航栏拆掉，内容区左移 88px = 可见的重排 -->
    <WindowTitleBar
      v-if="isDesktop && shellChromeVisible && !isDesktopLyricsPage && !isExtensionHostPage"
    />

    <!-- 主体：左侧导航 + 内容区 -->
    <div class="app-body">
      <!-- 左侧导航 Rail -->
      <nav
        v-if="shellChromeVisible && !isSettingsPage && !isDesktopLyricsPage && !isExtensionHostPage"
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
            <!--
              mode 在封面飞行期间切成默认（同时进出）：
              out-in 会等旧页离场后才挂载新页，而 View Transition 的新快照
              正是在那期间拍的 —— 新页不在 DOM 里，补间拿不到 hero，
              还会因为等待而让点击显得卡顿。见 utils/gameHeroTransition.ts。
            -->
            <transition
              :name="isPlayerPage ? 'player' : 'page'"
              :mode="isGamesArea ? undefined : 'out-in'"
              @enter="onRouteEnter"
            >
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
      v-if="
        player.song &&
        shellChromeVisible &&
        !isSettingsPage &&
        !isDesktopLyricsPage &&
        !isExtensionHostPage
      "
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

   设置页没有外层内容内边距；播放条的预留空间由下方组合选择器单独处理，
   避免 padding:0 重置 .has-player 的 padding-bottom。 */
.settings-page .main-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
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

/* 播放器路由：抽屉式滑入滑出。
 *
 * 注意：这只在**没有 hero 飞行**时生效（从别处直接进播放器，或目标 rect 量不到
 * 导致飞行取消）。hero 起飞时 <html> 上会挂 .lm-hero-flying，下面那条规则把
 * 整页位移关掉 —— 否则「整页从下滑上来」和「封面从迷你条飞过来」两条位移
 * 叠在一起，封面会走出一条诡异的斜线。
 */
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

/*
 * ⚠️ hero 飞行期间的路由过渡覆盖规则**不写在这里**，见文件末尾那个不带 scoped 的
 * <style> 块。
 *
 * 原因（构建产物实测，不是推测）：本块是 `scoped`，Vue 的 scoped CSS 编译器会把
 * `:global(html.lm-hero-flying) .player-enter-from` 编译成
 *
 *     html.lm-hero-flying{transform:none;opacity:1}
 *
 * —— **后代选择器整条被丢弃**。期望的 `html.lm-hero-flying .player-enter-from` 从未出现，
 * 所以这条覆盖从第一版（2f2f1d8）起就一直是死规则；`.player-enter-from` 上的
 * `transform: translateY(100%)` 照常生效，播放器页每次都从屏幕外 100vh 处开始滑入。
 * 这正是「黑屏 + 小封面停在原地」的真正根因：`land()` 量到的目标 rect 也在屏幕外。
 *
 * 教训：scoped 块里不要依赖 `:global()` 去拼后代选择器，直接开一个非 scoped 块。
 */

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

<!--
  hero 飞行期间的全局覆盖：**必须是独立、不带 scoped 的 style 块**。

  不能放进上面那个 scoped 块里用 `:global(...)` 拼后代选择器 —— 实测（构建产物）
  Vue 的 scoped 编译器会把 `:global(html.x) .player-enter-from` 压成
  `html.x{...}`，**后代选择器整条丢失**，规则成为死代码。

  两种状态都要覆盖，缺一不可：

  1. 位移（transform / opacity）
     Vue 的 enter 流程是：加 `-from` + `-active` 类 → 强制 reflow → 下一帧才移除
     `-from`。所以**挂载后的头一两帧里元素仍带着 translateY(100%)**，而 hero 的
     `land()` 正好在这段窗口里量目标 rect → 量到屏幕外 → 克隆层朝屏幕外飞，
     表现为「黑屏 + 小封面停在原地」。

  2. 时长（duration）
     `mode="out-in"` 会先等离场播完再挂新页。离场哪怕只剩 420ms 的 opacity 过渡，
     那段时间新旧都不在，屏幕是空的（深色主题下就是黑屏）。
     Vue 靠 getComputedStyle 的 transition-duration 判断何时结束，归零即可立即结束。

  两段合起来的效果：hero 飞行期间路由切换「瞬切、无位移」，全部视觉由飞行层承担。
-->
<style>
html.lm-hero-flying .player-enter-from,
html.lm-hero-flying .player-leave-to,
html.lm-hero-flying .page-enter-from,
html.lm-hero-flying .page-leave-to {
  transform: none !important;
  opacity: 1 !important;
}

html.lm-hero-flying .player-enter-active,
html.lm-hero-flying .player-leave-active,
html.lm-hero-flying .page-enter-active,
html.lm-hero-flying .page-leave-active {
  transition-duration: 0s !important;
}
</style>
