<script setup lang="ts">
/**
 * 在线番剧播放器（ArtPlayer + hls.js + DanDanPlay 弹幕）。
 *
 * 架构要点：
 * - 视频区由 ArtPlayer 接管，customType.m3u8 接 hls.js（参照
 *   播放器参考项目/src/components/music/mv-player.tsx:26-52）。
 * - 倍速/选集/换源/上一集/下一集/弹幕开关 全部以 ArtPlayer 自定义 controls 插件
 *   形式挂在 top/right 控制条（彻底取代原手写 MD3 UI）。
 * - 关闭按钮做成 Teleport overlay 顶角浮动按钮，全屏时也始终可达。
 * - 选集抽屉保持为独立浮层（ArtPlayer 没有原生抽屉），点击「选集」图标切换显隐。
 * - 弹幕走 artplayer-plugin-danmuku（DanDanPlay JSON → {text,time,mode,color} 映射在
 *   src/utils/danmaku.ts）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
// artplayer 与弹幕插件改为**动态 import**（在 initPlayer 内 await）：两者加起来
// 体积不小且只有进入番剧播放页才会用到，静态引入会把它们拖进常驻包。
// 下面只保留类型导入（编译期擦除，不影响运行时体积）。
import type Artplayer from "artplayer";
import type { Danmu, Option as DanmukuOption } from "artplayer-plugin-danmuku";
// hls.js 仅在 customType 内动态引入，避免主包膨胀；这里只声明变量类型
type HlsInstance = { destroy(): void };
import { useSettingsStore } from "@/stores/settings";
import { useAnimeStore } from "@/stores/anime";
import { animeLog } from "@/utils/animeLog";
import { danmakuLog } from "@/utils/danmakuLog";
import {
  getDandanAnimeIdByBgmId,
  getDandanBangumi,
  getDandanDanmaku,
  searchDandanEpisodes,
} from "@/utils/dandanPlay";
import { adaptDandanToArt, type ArtDanmu } from "@/utils/danmaku";
import { translate } from "@shared/i18n";

const props = defineProps<{
  roadIndex: number;
  episodeIndex: number;
  /** 续播起点（毫秒），来自历史记录 */
  initialSeekMs?: number;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "switch", roadIndex: number, episodeIndex: number): void;
  (e: "chooseSource"): void;
}>();

const settings = useSettingsStore();
const anime = useAnimeStore();
const t = (key: string) => translate(settings.lang, key);

const container = ref<HTMLDivElement | null>(null);
/**
 * 覆盖层挂载点：创建 ArtPlayer 后把一块宿主 div 挂进 `art.$player`（ArtPlayer 根元素
 * `.art-video-player`，也是它原生全屏的那个元素）。按钮 / 选集面板 Teleport 到这里，
 * 才能：① 原生全屏时同样可见；② z-index 高于 ArtPlayer 各层——否则会被它的
 * controls / mask 盖住，表现就是「点了没反应」。
 */
const overlayHost = ref<HTMLElement | null>(null);
const drawerOpen = ref(false);
const danmakuOn = ref(settings.danmakuEnabled);

let art: Artplayer | null = null;
let hls: HlsInstance | null = null;
let reportTimer: number | undefined;
let danmakuLoadGen = 0; // 切换剧集时让旧弹幕加载请求失效

const episode = computed(() => {
  const road = anime.selectedRoads[props.roadIndex];
  return road?.episodes[props.episodeIndex];
});
const isFirst = computed(() => props.roadIndex === 0 && props.episodeIndex === 0);
const isLast = computed(() => {
  const roads = anime.selectedRoads;
  return (
    props.roadIndex >= roads.length - 1 &&
    props.episodeIndex >= (roads[roads.length - 1]?.episodes.length ?? 0) - 1
  );
});

// ---- 历史进度上报（每 5s / 结束 / 暂停）----
function reportHistory() {
  if (!art || !episode.value) return;
  void anime.saveHistoryProgress(
    episode.value,
    props.roadIndex,
    props.episodeIndex,
    Math.floor(art.currentTime * 1000),
    Math.floor((art.duration || 0) * 1000),
  );
}
function scheduleReport() {
  if (reportTimer) window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    reportTimer = undefined;
    reportHistory();
  }, 5000);
}

// ---- 弹幕：按当前剧集重新加载 ----
async function loadDanmakuForEpisode(): Promise<Danmu[]> {
  const gen = ++danmakuLoadGen;
  const ep = episode.value;
  if (!ep || !settings.danmakuEnabled) return [];

  // 1. 优先用 bgm.tv ID 反查 dandan animeId（最稳）
  const bgmId = anime.activeBangumiId;
  let dandanAnimeId: number | null = null;
  let matchedEpisodeId: number | null = null;

  if (bgmId) {
    const m = await getDandanAnimeIdByBgmId(bgmId);
    if (gen !== danmakuLoadGen) return [];
    if (m) {
      dandanAnimeId = m.animeId;
      const bangumi = await getDandanBangumi(m.animeId);
      if (gen !== danmakuLoadGen) return [];
      if (bangumi?.episodes) {
        // 按剧集号匹配（episode.name 多为「第 N 集」/「N」「OP…」等）
        const idx = props.episodeIndex;
        const e = bangumi.episodes[idx] ?? bangumi.episodes.find((x) => x.episodeTitle === ep.name);
        if (e) matchedEpisodeId = e.episodeId;
      }
    }
  }

  // 2. fallback：用标题搜（多版本时取第一条匹配）
  if (!matchedEpisodeId) {
    const title = anime.displayTitle;
    const list = await searchDandanEpisodes(title, ep.name);
    if (gen !== danmakuLoadGen) return [];
    if (list.length) matchedEpisodeId = list[0].episodeId;
  }

  if (!matchedEpisodeId) {
    void danmakuLog(
      `无可用 dandan episodeId（bgmId=${bgmId || "无"} title="${anime.displayTitle}" ep="${ep.name}"）`,
    );
    return [];
  }

  void danmakuLog(`开始拉弹幕 bgmId=${bgmId || "无"} dandanEp=${matchedEpisodeId}`);
  const resp = await getDandanDanmaku(matchedEpisodeId);
  if (gen !== danmakuLoadGen) return [];
  const { items } = adaptDandanToArt(resp.comments, {
    offsetMs: settings.danmakuTimeOffsetMs,
    dedup: true,
    dedupWindowSec: 5,
  });
  return items;
}

// ---- 主题色：跟随 --md-sys-color-primary ----
function readThemeColor(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--md-sys-color-primary")
    .trim();
  // MD3 token 是 #aabbcc 或 rgb(r,g,b) 形式
  if (!v) return "#1A5C9E";
  if (v.startsWith("#")) return v;
  const m = v.match(/rgb[a]?\(([^)]+)\)/);
  if (!m) return "#1A5C9E";
  const parts = m[1].split(",").map((x) => Number(x.trim()));
  if (parts.length < 3) return "#1A5C9E";
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function isHlsSource(stream: { url: string; remoteUrl: string }): boolean {
  return /\.m3u8(\?|#|$)/i.test(`${stream.remoteUrl} ${stream.url}`);
}

// ---- 切换剧集/换源后重挂 URL（ArtPlayer 的 switchUrl 走 m3u8 自定义类型）----
function attachStream(stream: { url: string; remoteUrl: string }) {
  if (!art) return;
  destroyHls();
  // ArtPlayer 自带 m3u8 处理用其内置 hls.js，但保险起见我们也接管：若用户开启弹幕后
  // m3u8 必须稳定，先用自定义 customType（参照 播放器参考项目）。
  art.type = isHlsSource(stream) ? "m3u8" : "auto";
  void art
    .switchUrl(stream.url)
    .then(() => {
      // 续播定位：切集/换源后跳到记录位置（仅当 new 实例已就绪才生效）
      if (art && props.initialSeekMs && Number.isFinite(art.duration)) {
        try {
          art.currentTime = Math.min(props.initialSeekMs / 1000, art.duration);
        } catch {
          /* 切换窗口内 player 已销毁则忽略 */
        }
      }
    })
    .catch((e: unknown) => {
      void animeLog(`switchUrl 失败: ${(e as Error).message}`);
    });
}

// ---- 自定义 controls：关闭 / 选集 / 换源 / 倍速 / 上一集 / 下一集 / 弹幕开关 ----
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
// 当前倍速（闭包变量，避免依赖 ArtPlayer 内部未暴露的 $speed）
let currentSpeed = 1;

function makeControls(): Artplayer["option"]["controls"] {
  // 类名不能叫 art-icon —— ArtPlayer 自身用 .art-icon 表示它的图标字体，复用会让
  // Material Symbols 的 ligature 失效（图标退化成它的名字文本，如 captions → CAPTIONS）。
  const icon = (name: string) => `<span class="material-symbols-outlined sm-icon">${name}</span>`;
  // 只放**播放相关**控件（上一集 / 倍速 / 弹幕 / 下一集）到控制栏右侧。
  // 导航类（选集 / 换源 / 关闭）与标题改到覆盖层（模板里的 .ep-topleft / .ep-topright）——
  // 它们此前用 `position: "top"` 落在控制栏上排左下角，既不好找又和「点进度条跳转」抢点击。
  return [
    {
      name: "luna-prev",
      position: "right",
      html: icon("skip_previous"),
      tooltip: t("anime.prevEp"),
      click: () => !isFirst.value && playNext(-1),
      style: isFirst.value ? { opacity: "0.35", pointerEvents: "none" } : {},
    },
    {
      name: "luna-speed",
      position: "right",
      html: `<span class="sm-speed">${currentSpeed}x</span>`,
      tooltip: t("anime.speed"),
      click: function (this: Artplayer) {
        const list = SPEEDS;
        const i = list.indexOf(currentSpeed);
        const next = list[(i + 1) % list.length];
        currentSpeed = next;
        this.playbackRate = next;
        const span = container.value?.querySelector(".sm-speed") as HTMLElement | null;
        if (span) span.textContent = `${next}x`;
      },
    },
    {
      name: "luna-danmaku",
      position: "right",
      html: icon("subtitles"),
      tooltip: "弹幕",
      click: function (this: Artplayer) {
        const d = this.plugins?.artplayerPluginDanmuku as
          { show: () => unknown; hide: () => unknown; isHide: boolean } | undefined;
        if (!d) return;
        if (d.isHide) {
          d.show();
          danmakuOn.value = true;
        } else {
          d.hide();
          danmakuOn.value = false;
        }
      },
      style: { opacity: settings.danmakuEnabled ? "1" : "0.35" },
    },
    {
      name: "luna-next",
      position: "right",
      html: icon("skip_next"),
      tooltip: t("anime.nextEp"),
      click: () => !isLast.value && playNext(1),
      style: isLast.value ? { opacity: "0.35", pointerEvents: "none" } : {},
    },
  ];
}

/** 上一集 / 下一集（同线路内切换，越界则进出相邻线路） */
function playNext(delta: number) {
  const roads = anime.selectedRoads;
  let ri = props.roadIndex;
  let ei = props.episodeIndex + delta;
  if (ei < 0) {
    if (ri === 0) return;
    ri -= 1;
    ei = (roads[ri]?.episodes.length ?? 0) - 1;
  } else if (ei >= (roads[ri]?.episodes.length ?? 0)) {
    if (ri >= roads.length - 1) return;
    ri += 1;
    ei = 0;
  }
  emit("switch", ri, ei);
}

async function ensureStream() {
  if (!anime.stream && episode.value) {
    await anime.resolveStream(episode.value);
  }
}

// ---- 取流失败兜底（沿用原行为：流地址缺失时显示提示 + 重试）----
function onError(detail?: string) {
  if (detail) void animeLog(`播放失败: ${detail}`);
  if (!anime.streamError) {
    anime.streamError = t("anime.streamFailed");
  }
}

function retry() {
  anime.clearStream();
  void ensureStream();
}

// ---- 选集面板（右侧滑出）----

function closeDrawer() {
  drawerOpen.value = false;
}

/** 选中某一集：立即切流并收起面板 */
function switchTo(roadIndex: number, episodeIndex: number) {
  drawerOpen.value = false;
  emit("switch", roadIndex, episodeIndex);
}

/** Esc 关闭面板（仅在面板打开时拦截，其余情况不干扰 ArtPlayer 自身快捷键） */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && drawerOpen.value) {
    e.stopPropagation();
    closeDrawer();
  }
}

// ---- ArtPlayer 实例化 ----
async function createPlayer() {
  const root = container.value;
  if (!root) return;
  destroyHls();
  art?.destroy(false);
  art = null;

  // 动态 import：进入播放页才加载 artplayer 与弹幕插件（不在常驻包里）
  const [{ default: Artplayer }, { default: artplayerPluginDanmuku }] = await Promise.all([
    import("artplayer"),
    import("artplayer-plugin-danmuku"),
  ]);

  const stream = anime.stream;
  const theme = readThemeColor();

  const danmukuOpts: DanmukuOption = {
    danmuku: async () => loadDanmakuForEpisode(),
    speed: settings.danmakuSpeed,
    opacity: settings.danmakuOpacity / 100,
    fontSize: settings.danmakuFontSize,
    // margin: 上/下边距用百分比，从 danmakuArea 推导
    margin: [
      `${Math.max(0, (100 - settings.danmakuArea) / 2)}%`,
      `${Math.max(0, (100 - settings.danmakuArea) / 2)}%`,
    ] as [`${number}%`, `${number}%`],
    mode: 0 as const,
    modes: [0, 1, 2] as const,
    antiOverlap: settings.danmakuAntiOverlap,
    visible: settings.danmakuEnabled,
    emitter: false, // 仅看，不发（DanDanPlay API 发弹幕需要鉴权；暂不实现）
  };

  art = new Artplayer({
    container: root,
    url: stream?.url ?? "",
    poster: anime.bangumiDetail?.images?.large ?? undefined,
    autoplay: true,
    autoMini: false,
    // 全屏保持 ArtPlayer 自带的（右下角）。我们的按钮挂进 art.$player，
    // 因此原生全屏时它们同样可见（见 overlayHost）。
    fullscreen: true,
    fullscreenWeb: false,
    // 关掉 ArtPlayer 自带的一堆默认控件，只留 play / volume / time / fullscreen。
    // 倍速、选集、换源、弹幕、上下一集全部由我们的自定义 controls 提供；否则默认控件
    // 与自定义控件混在一起，图标与位置重复、互相遮挡（也就有了「右下角不知道是干什么的」
    // 和「左上角点了没反应」）。
    playbackRate: false,
    aspectRatio: false,
    screenshot: false,
    setting: false,
    pip: false,
    flip: false,
    miniProgressBar: false,
    volume: 0.8,
    theme,
    type: stream && isHlsSource(stream) ? "m3u8" : "auto",
    customType: {
      m3u8: (video: HTMLVideoElement, src: string, player: Artplayer) => {
        // 优先用浏览器原生 HLS（Safari / WebKit），免去 hls.js 加载
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
          void video.play().catch(() => {});
          return;
        }
        void import("hls.js").then((mod) => {
          const HlsCtor = mod.default;
          if (!HlsCtor.isSupported()) {
            player.notice.show = "当前环境不支持 HLS 播放";
            return;
          }
          const hlsInstance = new HlsCtor({
            enableWorker: true,
            lowLatencyMode: false,
          });
          hlsInstance.on(HlsCtor.Events.ERROR, (_evt, data) => {
            if (!data.fatal) return;
            void animeLog(`hls.js 致命错误 type=${data.type} details=${data.details}`);
            onError(`hls ${data.type}/${data.details}`);
          });
          hlsInstance.on(HlsCtor.Events.MANIFEST_PARSED, () => {
            if (props.initialSeekMs && Number.isFinite(video.duration)) {
              video.currentTime = Math.min(props.initialSeekMs / 1000, video.duration);
            }
            void video.play().catch(() => {});
          });
          hlsInstance.loadSource(src);
          hlsInstance.attachMedia(video);
          hls = hlsInstance;
          player.on("destroy", () => hlsInstance.destroy());
        });
      },
    },
    plugins: [artplayerPluginDanmuku(danmukuOpts)],
    controls: makeControls(),
    // settings.lang 切换时这里 i18n 不重新创建控件（开关太多），提示文案靠 tooltip 静态翻译足够
  });

  art.on("video:timeupdate", scheduleReport);
  art.on("video:ended", reportHistory);
  art.on("error", (err: unknown) => {
    onError(err instanceof Error ? err.message : String(err));
  });
  art.on("destroy", () => {
    if (reportTimer) window.clearTimeout(reportTimer);
    reportHistory();
    destroyHls();
    overlayHost.value = null;
  });

  // 覆盖层宿主：挂进 ArtPlayer 根元素（= 原生全屏元素）——按钮 / 面板在全屏下才可见，
  // 且 z-index 高于 ArtPlayer 各层（它内部最高约 120，这里给 9000）才点得到。
  // 宿主是 JS 创建的节点，拿不到 scoped 样式，故用内联样式；pointer-events:none 让它
  // 不吃点击，只有具体的按钮 / 面板 / 遮罩各自 auto。
  //
  // ⚠️ 根元素在 `art.template.$player`，**不是** `art.$player`（后者是 undefined，
  //    会让宿主拿不到、整个覆盖层都不渲染）。后面两个是兜底。
  const playerEl =
    (art.template as { $player?: HTMLElement } | undefined)?.$player ??
    container.value?.querySelector<HTMLElement>(".art-video-player") ??
    (container.value?.firstElementChild as HTMLElement | null) ??
    null;
  if (playerEl) {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0;z-index:9000;pointer-events:none;";
    playerEl.appendChild(host);
    overlayHost.value = host;
  }

  // 动态 import 让 art 就绪晚于 onMounted 里的首次 attachStream（彼时 art 为 null 被
  // 守卫跳过）。这里补挂当前流，保持与旧同步行为一致的加载与续播定位。
  if (anime.stream) {
    void attachStream({ url: anime.stream.url, remoteUrl: anime.stream.remoteUrl ?? "" });
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  createPlayer();
  // 流就绪后挂载 / 切换剧集后刷新
  watch(
    () => anime.stream?.url,
    (url) => {
      if (url && art) attachStream({ url, remoteUrl: anime.stream?.remoteUrl ?? "" });
    },
    { immediate: true },
  );
  watch(
    () => [props.roadIndex, props.episodeIndex] as const,
    () => {
      // 切集后：重挂流；弹幕插件 load（标题由模板里的 .ep-title-* 响应式更新，无需手改 DOM）
      if (!art) return;
      void ensureStream();
      // 弹幕：plugin load（再触发一次）
      const d = art.plugins?.artplayerPluginDanmuku as
        { load: (d: Danmu[]) => Promise<unknown>; isHide?: boolean } | undefined;
      if (d && settings.danmakuEnabled) {
        void loadDanmakuForEpisode()
          .then((items) => {
            // 加载完成可能已切走：只在当前 player 仍存活时装载
            if (art && art.plugins?.artplayerPluginDanmuku === d) void d.load(items);
          })
          .catch((e: unknown) => {
            void animeLog(`弹幕加载失败: ${(e as Error).message}`);
          });
      }
    },
  );
  if (anime.stream) void attachStream({ url: anime.stream.url, remoteUrl: anime.stream.remoteUrl });
  void ensureStream();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (reportTimer) window.clearTimeout(reportTimer);
  destroyHls();
  art?.destroy(false);
  art = null;
});
</script>

<template>
  <Teleport to="body">
    <div class="anime-player">
      <!-- ArtPlayer 容器；customType.m3u8 在 createPlayer 里挂 hls.js。
           全屏用 ArtPlayer 自带的（右下角）；我们的按钮见下方 overlayHost。 -->
      <div ref="container" class="art-container" />
    </div>
  </Teleport>

  <!-- 播放器覆盖层：Teleport 进 ArtPlayer 根元素（art.$player）——
       这样用 ArtPlayer 自带的右下角全屏时，按钮 / 面板同样可见；且 z-index 高于
       ArtPlayer 各层，不会被控制栏 / mask 盖住（否则表现为「点了没反应」）。
       左上角：关闭 + 标题；右上角：选集 / 换源。 -->
  <Teleport v-if="overlayHost" :to="overlayHost">
    <div class="ep-topleft">
      <button class="ep-btn" :title="t('anime.exit')" @click="emit('close')">
        <span class="material-symbols-outlined">close</span>
      </button>
      <div class="ep-title">
        <span class="ep-title-name" :title="anime.displayTitle">{{ anime.displayTitle }}</span>
        <span v-if="episode" class="ep-title-ep">{{ episode.name }}</span>
      </div>
    </div>

    <div class="ep-topright">
      <button
        class="ep-btn"
        :class="{ on: drawerOpen }"
        :title="t('anime.episodes')"
        @click="drawerOpen = !drawerOpen"
      >
        <span class="material-symbols-outlined">list</span>
      </button>
      <button class="ep-btn" :title="t('anime.changeSource')" @click="emit('chooseSource')">
        <span class="material-symbols-outlined">swap_horiz</span>
      </button>
    </div>

    <!-- 选集面板：右侧滑出 + 遮罩；点遮罩 / 按 Esc / 再点右上角按钮均可关闭 -->
    <Transition name="ep-scrim">
      <div v-if="drawerOpen" class="ep-scrim" @click="closeDrawer"></div>
    </Transition>
    <Transition name="ep-panel">
      <aside v-if="drawerOpen" class="ep-panel" role="dialog" aria-modal="true">
        <div class="ep-panel-head">
          <span class="ep-panel-title">{{ t("anime.episodes") }}</span>
          <button class="ep-btn" :title="t('anime.exit')" @click="closeDrawer">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class="ep-panel-body">
          <template v-for="(road, ri) in anime.selectedRoads" :key="ri">
            <div class="road-name">{{ road.name }}</div>
            <div class="ep-grid">
              <button
                v-for="(ep, ei) in road.episodes"
                :key="ei"
                class="ep"
                :class="{ active: ri === props.roadIndex && ei === props.episodeIndex }"
                @click="switchTo(ri, ei)"
              >
                {{ ep.name }}
              </button>
            </div>
          </template>
        </div>
      </aside>
    </Transition>

    <!-- 取流状态 / 失败 -->
    <div v-if="anime.resolving" class="overlay state">
      <span class="material-symbols-outlined spin">progress_activity</span>
      <span>{{ t("anime.streamResolving") }}</span>
    </div>
    <div v-else-if="anime.streamError" class="overlay state error">
      <span>{{ anime.streamError }}</span>
      <m3e-button variant="filled" size="small" @click="retry">
        <span slot="icon" class="material-symbols-outlined">refresh</span>
        {{ t("anime.retry") }}
      </m3e-button>
    </div>

    <!-- 弹幕状态指示（DanDanPlay 无凭证 / 无匹配时显示原因）-->
    <div v-if="danmakuOn && !settings.danmakuEnabled" class="danmaku-hint">
      弹幕已开启，请在设置中配置 DanDanPlay 凭证
    </div>
  </Teleport>
</template>

<style scoped>
.anime-player {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: #000;
  animation: lm-fade-in 200ms var(--md-sys-motion-spring-effects-fast);
}
.art-container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #000;
}
/* 自定义控件里的 Material Symbols 图标（类名与 ArtPlayer 自带的 .art-icon 区分开） */
:deep(.sm-icon) {
  font-size: 24px;
  color: #fff;
  line-height: 1;
}
:deep(.sm-speed) {
  color: #fff;
  font-size: var(--md-sys-typescale-label-large-size);
  font-family: inherit;
  line-height: 1;
}

/* ---- 覆盖层 ----
   它们被 Teleport 进 ArtPlayer 根元素；宿主 div 用内联样式设了 pointer-events:none，
   所以下面每个可交互元素都要各自 pointer-events:auto。
   左上角 = 关闭 + 标题；右上角 = 选集 / 换源；选集面板从右侧滑出。 */
.ep-topleft,
.ep-topright {
  position: absolute;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}
.ep-topleft {
  left: 12px;
}
.ep-topright {
  right: 12px;
}
.ep-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
}
.ep-title-name {
  max-width: 44vw;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ep-title-ep {
  font-size: var(--md-sys-typescale-label-small-size);
  opacity: 0.85;
}
.ep-btn {
  pointer-events: auto;
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
  transition: background 160ms ease;
}
.ep-btn:hover {
  background: rgba(0, 0, 0, 0.7);
}
.ep-btn.on {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}
.ep-btn .material-symbols-outlined {
  font-size: 22px;
}

/* 选集面板：遮罩 + 从右侧滑出 */
.ep-scrim {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.42);
}
.ep-scrim-enter-active,
.ep-scrim-leave-active {
  transition: opacity 220ms ease;
}
.ep-scrim-enter-from,
.ep-scrim-leave-to {
  opacity: 0;
}
.ep-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 11;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: min(360px, 88vw);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  box-shadow: -8px 0 28px rgba(0, 0, 0, 0.4);
}
.ep-panel-enter-active,
.ep-panel-leave-active {
  transition: transform 260ms var(--md-sys-motion-spring-spatial);
}
.ep-panel-enter-from,
.ep-panel-leave-to {
  transform: translateX(100%);
}
.ep-panel-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
}
.ep-panel-title {
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 500;
}
.ep-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 18px;
}
.road-name {
  margin: 8px 0 6px;
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: 500;
  color: var(--md-sys-color-primary);
}
.ep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 6px;
}
.ep {
  height: 32px;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-small-size);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ep:hover {
  background: var(--md-sys-color-surface-container-highest);
}
.ep.active {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-weight: 500;
}

/* 状态层（宿主设了 pointer-events:none，这里要显式打开才能点「重试」；
   z-index 高于选集面板，出错时不会被面板 / 遮罩挡住） */
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: var(--md-sys-typescale-body-medium-size);
  pointer-events: auto;
  z-index: 12;
}
.overlay .material-symbols-outlined {
  font-size: 34px;
}
.spin {
  animation: lm-spin 1s linear infinite;
}
@keyframes lm-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes lm-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 弹幕提示（左下角悬浮） */
.danmaku-hint {
  position: absolute;
  left: 12px;
  bottom: 72px;
  padding: 6px 12px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: var(--md-sys-typescale-label-small-size);
  z-index: 5;
}
</style>
