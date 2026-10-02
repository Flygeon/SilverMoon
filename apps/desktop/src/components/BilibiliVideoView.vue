<script setup lang="ts">
/**
 * B 站视频详情与播放（全屏浮层）。
 *
 * 播放器 = ArtPlayer（UI / 控件 / 弹幕）+ 自建 MSE DASH 引擎（取流）：
 * - 取流走**非 WBI** 的 `/x/player/playurl` + `fnval=4048` + `try_look=1`，
 *   由 `utils/biliDash.ts` 用 MediaSource 合流音视频轨。只有这条路线拿得到
 *   1080P+（渐进式 durl 被上游钳在 720P，WBI 变体更是只有 480P，详见该文件注释）。
 * - durl 仅在 MSE 不可用（编码不支持）时兜底，此时最高 720P，界面会说明原因。
 * - CDN 的防盗链 Referer 由 `utils/biliDash` 的取流显式带上（PCDN 域名不在
 *   主进程 webRequest 白名单内）。
 * - 弹幕走 B 站 `list.so`（XML），映射成 ArtPlayer 弹幕格式（utils/bilibili.ts）。
 * - 清晰度 / 分 P 切换在下方信息区；store 重取 playurl 后这里重新挂源。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type Artplayer from "artplayer";
import type { Option as DanmukuOption } from "artplayer-plugin-danmuku";
import BilibiliComments from "@/components/BilibiliComments.vue";
import BilibiliRelatedList from "@/components/BilibiliRelatedList.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import {
  biliCount,
  biliDuration,
  biliFormatLabel,
  biliPubdate,
  type BiliStream,
} from "@/utils/bilibili";
import { BiliDashSession } from "@/utils/biliDash";
import { applyTimeOffset, type ArtDanmu } from "@/utils/danmaku";
import { useAmbilight } from "@/composables/useAmbilight";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "login"): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const container = ref<HTMLDivElement | null>(null);

// ---- 氛围光（ambient light）----
const ambilightCanvas = ref<HTMLCanvasElement | null>(null);
const viewRef = ref<HTMLElement | null>(null);

const ambilight = useAmbilight(
  {
    enabled: computed(() => settings.ambilightEnabled),
    blur: computed(() => settings.ambilightBlur),
    spread: computed(() => settings.ambilightSpread),
    opacity: computed(() => settings.ambilightOpacity),
    saturation: computed(() => settings.ambilightSaturation),
    brightness: computed(() => settings.ambilightBrightness),
  },
  ambilightCanvas,
);

/**
 * 光晕外观。
 *
 * 三层组合（对应参考项目 projector + filter 的分工）：
 * - `blur()`：把 48px 宽的小画布抹成一片柔和的色块；
 * - `saturate()/brightness()`：让颜色更「亮眼」，否则糊完会发灰；
 * - `opacity`：压暗，让光晕只作为背景存在。
 *
 * **画布铺满整个视图**，而不是只包住播放器或「顶栏+播放器+侧栏」的并集。
 * 沉浸感的关键就在这里：只要光在某处断掉，那里就会出现一条接缝，
 * 顶栏 / 侧栏 / 评论区就会被看成一块块独立的卡片。铺满之后整页落在同一片光上，
 * 中间没有间隙。参考项目也是把光晕当整页背景在铺。
 *
 * `spread` 在这里是「向外多铺多少」：铺满仍要外扩一圈，是为了让 `blur()` 的边缘
 * 落在视口之外 —— 否则四周会出现一圈被模糊拉暗的暗角。
 */
const ambilightStyle = computed(() => {
  const spread = Math.max(0, settings.ambilightSpread);
  // canvas 是 replaced element：必须显式给宽高，只给 inset 不会拉伸
  const size = 100 + spread * 2;
  return {
    left: `${-spread}%`,
    top: `${-spread}%`,
    width: `${size}%`,
    height: `${size}%`,
    opacity: String(Math.max(0, Math.min(100, settings.ambilightOpacity)) / 100),
    filter: [
      `blur(${Math.max(0, settings.ambilightBlur)}px)`,
      `saturate(${Math.max(0, settings.ambilightSaturation)}%)`,
      `brightness(${Math.max(0, settings.ambilightBrightness)}%)`,
    ].join(" "),
  };
});

const descExpanded = ref(false);

/** 媒体加载失败提示（ArtPlayer 会自动重连，这里负责把原因讲清楚并给条退路） */
const playerError = ref("");

let art: Artplayer | null = null;
let danmakuGen = 0;
/** 当前 DASH（MSE）会话；走 MP4 兜底时为 null */
let dash: BiliDashSession | null = null;

const detail = computed(() => bili.detail);
const play = computed(() => bili.play);
const videoUrl = computed(() => play.value?.durl[0] ?? "");
/** 是否有可播源（DASH 或渐进式 MP4 任一即可） */
const hasSource = computed(() => !!videoUrl.value || (play.value?.dashVideo.length ?? 0) > 0);
const qualities = computed(() => play.value?.qualities ?? []);
const parts = computed(() => detail.value?.parts ?? []);
const showParts = computed(() => parts.value.length > 1);
const title = computed(() => detail.value?.title || bili.current?.title || t("bili.title"));

function readThemeColor(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--md-sys-color-primary")
    .trim();
  if (v.startsWith("#")) return v;
  const m = v.match(/rgb[a]?\(([^)]+)\)/);
  if (!m) return "#1A5C9E";
  const partsRgb = m[1].split(",").map((x) => Number(x.trim()));
  if (partsRgb.length < 3) return "#1A5C9E";
  return `#${partsRgb
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 弹幕加载：按当前 cid 拉取 + 应用时间轴偏移。切 P 时通过 danmakuGen 作废旧请求。 */
async function loadDanmaku(): Promise<ArtDanmu[]> {
  const gen = ++danmakuGen;
  if (!settings.danmakuEnabled) return [];
  const cid = bili.activeCid;
  if (!cid) return [];
  const items = await bili.loadDanmaku(cid);
  if (gen !== danmakuGen) return [];
  // 复用番剧侧同一实现，避免两处 clamp 规则分叉
  return applyTimeOffset(items, settings.danmakuTimeOffsetMs);
}

type DanmakuPlugin = {
  /** 无参调用才会 reset + 重新走 `option.danmuku`；传数组是「追加」，慎用 */
  load: (d?: ArtDanmu[]) => Promise<unknown>;
  show?: () => void;
  hide?: () => void;
  isHide?: boolean;
  /** 实时改配置（透明度 / 字号 / 速度 / 边距等），无需重建播放器 */
  config?: (option: Record<string, unknown>) => void;
};

function danmakuPlugin(): DanmakuPlugin | undefined {
  return art?.plugins?.artplayerPluginDanmuku as DanmakuPlugin | undefined;
}

/**
 * 重装弹幕。
 *
 * ⚠️ 必须**无参**调用 `plugin.load()`。
 *
 * 插件的 `load(data)` 只有在不传参时才执行 `reset()` + 清空 `queue/states/$refs`；
 * 传数组时它只做「逐条 emit 追加」。而这个函数在每次挂源（首次播放、切清晰度、
 * 切分 P）后都会被调用，配着构造时的 `danmuku` 回调（也是无参 load）一起，
 * 同一条弹幕会被叠加 2~N 次 —— 表现为屏幕上弹幕成倍重复。
 *
 * 无参 load 会 reset 并重新调用 `option.danmuku`（即 `loadDanmaku()`），
 * 天然带上当前 cid 与时间轴偏移，也是唯一能清空的路径。
 */
async function reloadDanmaku(): Promise<void> {
  const plugin = danmakuPlugin();
  if (!plugin) return;
  await plugin.load();
}

/**
 * 把弹幕外观设置实时推给插件。
 *
 * 这些值原来只在 createPlayer 构造时读一次，设置页改完必须重开视频才生效。
 * 插件提供 `config()` 可热改，这里直接复用。
 */
function applyDanmakuAppearance(): void {
  const plugin = danmakuPlugin();
  if (!plugin?.config) return;
  const area = Math.max(0, 100 - settings.danmakuArea) / 2;
  plugin.config({
    speed: settings.danmakuSpeed,
    opacity: settings.danmakuOpacity / 100,
    fontSize: settings.danmakuFontSize,
    antiOverlap: settings.danmakuAntiOverlap,
    margin: [`${area}%`, `${area}%`],
  });
}

async function createPlayer(url: string | null): Promise<void> {
  const root = container.value;
  if (!root) return;
  const [{ default: Artplayer }, { default: artplayerPluginDanmuku }] = await Promise.all([
    import("artplayer"),
    import("artplayer-plugin-danmuku"),
  ]);

  const area = Math.max(0, 100 - settings.danmakuArea) / 2;
  const danmukuOpts: DanmukuOption = {
    danmuku: () => loadDanmaku(),
    speed: settings.danmakuSpeed,
    opacity: settings.danmakuOpacity / 100,
    fontSize: settings.danmakuFontSize,
    margin: [`${area}%`, `${area}%`] as [`${number}%`, `${number}%`],
    mode: 0 as const,
    modes: [0, 1, 2] as const,
    antiOverlap: settings.danmakuAntiOverlap,
    /**
     * **必须恒为 true**。
     *
     * 这个字段是插件的「初始可见性」，插件构造时只读一次：传 false 会让容器
     * 透明度为 0 且 isHide=true，而 load() **不会**把它改回来（实测：无论随后
     * load 多少条，option.visible 始终是 false，弹幕永远不显示）。
     *
     * 默认设置里 danmakuEnabled 就是 false，所以照着它传值 = 弹幕功能一上来就是
     * 坏的。这里改成恒定可见，由 syncDanmakuVisibility() 用 show()/hide() 表达意图。
     */
    visible: true,
    emitter: false,
  };

  art = new Artplayer({
    container: root,
    url: url ?? "",
    poster: detail.value?.cover || undefined,
    // DASH 走 MSE：这里只创建空 <video>，真正的数据由 BiliDashSession 推进
    type: "auto",
    autoplay: true,
    autoMini: false,
    fullscreen: true,
    fullscreenWeb: false,
    playbackRate: true,
    aspectRatio: false,
    screenshot: false,
    setting: false,
    pip: true,
    flip: false,
    miniProgressBar: false,
    volume: settings.biliVolume,
    theme: readThemeColor(),
    plugins: [artplayerPluginDanmuku(danmukuOpts)],
  });

  // 按设置把弹幕显示 / 隐藏落到实处（构造时的 visible 只决定初始态）
  syncDanmakuVisibility();
  applyDanmakuAppearance();

  // 把 <video> 交给氛围光（ArtPlayer 的 video 就是它内部的播放元素）
  ambilight.attach(art.video);

  // 恢复上次的倍速
  if (settings.biliPlaybackRate !== 1) art.playbackRate = settings.biliPlaybackRate;

  // 音量 / 倍速变化写回设置（重开浮层不再复位；对标 PiliPlus 的 storage_pref）
  art.on("video:volumechange", () => {
    const v = art?.volume;
    if (typeof v === "number" && Number.isFinite(v)) settings.biliVolume = v;
  });
  art.on("video:ratechange", () => {
    const r = art?.playbackRate;
    if (typeof r === "number" && Number.isFinite(r)) settings.biliPlaybackRate = r;
  });

  // 观看进度上报：播放中按时长节流，暂停时补一次（与番剧播放器同款节奏）
  art.on("video:timeupdate", () => bili.tickProgress(currentSeconds()));
  art.on("video:pause", () => bili.reportProgress(currentSeconds()));

  // 媒体错误（多为 CDN 防盗链 403/503）——ArtPlayer 会自己重连几轮，
  // 但界面上一片「重新连接」看不出原因，这里显式提示并提供重试。
  art.on("error", () => {
    playerError.value = t("bili.playbackFailed");
  });
  art.on("video:playing", () => {
    playerError.value = "";
  });
}

function retryPlayback(): void {
  playerError.value = "";
  void mountSource();
}

/**
 * 选中的 DASH 视频轨。
 *
 * 两个约束一起满足：
 * - **优先 avc1**：Chromium 对 hev1/av01 的硬解支持因机器而异，avc1 最稳。若某一档
 *   只有 av01（4K/8K 常见），宁可退到低一档的 avc1，也不要直接播不了；
 * - **不高于 `currentQn`**：用户手动选了 480P 就不该偷偷给 1080P。
 *
 * `dashVideo` 在 utils 里已按清晰度 / 码率降序排好，故池子里第一项即最高档。
 */
function pickVideoTrack(currentQn: number): BiliStream | null {
  const list = play.value?.dashVideo ?? [];
  if (!list.length) return null;
  const avc = list.filter((s) => s.codecs.startsWith("avc1"));
  const pool = avc.length ? avc : list;
  return pool.find((s) => s.id <= currentQn) ?? pool[0];
}

/**
 * 挂载播放源。
 *
 * 优先 DASH（MSE 合流）：只有它拿得到 1080P 及以上。若当前环境 / 编码不支持
 * MSE（例如 av01 且系统解码器缺失），退回渐进式 MP4 的 durl —— 那是 720P，
 * 但至少能播，且失败原因会明确写在界面上。
 */
async function mountSource(): Promise<void> {
  playerError.value = "";
  const p = play.value;
  if (!p) return;

  const videoTrack = pickVideoTrack(p.quality || bili.activeQn);
  const audioTrack = p.dashAudio[0] ?? null;

  // 清掉上一轮 DASH 会话（切清晰度 / 切分 P 时 MediaSource 不能复用）
  dash?.destroy();
  dash = null;

  if (videoTrack && BiliDashSession.canPlay(videoTrack, audioTrack)) {
    await mountDash(videoTrack, audioTrack);
    return;
  }

  // 兜底：渐进式 MP4（最高 720P）
  if (p.durl[0]) {
    await mountPlayer(p.durl[0], "auto");
    return;
  }
  if (videoTrack) {
    playerError.value = t("bili.dashUnsupported");
  }
}

/** 用 MSE 会话喂 ArtPlayer（ArtPlayer 只负责 UI 与控件，数据由我们推进）。 */
async function mountDash(videoTrack: BiliStream, audioTrack: BiliStream | null): Promise<void> {
  if (!art) {
    await createPlayer(null);
  }
  const el = art?.video;
  if (!el || !art) return;

  const session = new BiliDashSession();
  dash = session;
  // 切清晰度时保留当前播放位置；首次起播用 store 读到的续播点
  const startTime =
    el.currentTime > 0 && Number.isFinite(el.currentTime) ? el.currentTime : (bili.resumeAt ?? 0);

  try {
    await session.load(el, {
      video: videoTrack,
      audio: audioTrack,
      startTime,
      onError: (e) => {
        playerError.value = e instanceof Error ? e.message : String(e);
      },
      onReady: () => {
        playerError.value = "";
        void el.play().catch(() => undefined);
      },
    });
  } catch (e) {
    if (dash === session) {
      dash = null;
      playerError.value = e instanceof Error ? e.message : String(e);
    }
    session.destroy();
  }
  await reloadDanmaku();
}

async function mountPlayer(url: string, type: "auto" | "m3u8" = "auto"): Promise<void> {
  if (!url) return;
  playerError.value = "";
  if (!art) {
    await createPlayer(url);
  } else {
    try {
      art.type = type;
      await art.switchUrl(url);
    } catch (e) {
      console.warn("[bilibili] switchUrl 失败：", e);
    }
  }
  await reloadDanmaku();
}

let unwatchUrl: (() => void) | null = null;
let unwatchDanmakuOpts: (() => void) | null = null;
let unwatchDanmakuSwitch: (() => void) | null = null;
let unwatchAmbilight: (() => void) | null = null;

/** 关闭浮层：直接改 store 状态（不经过 emit 中转，避免多一层出错点） */
function close(): void {
  // 带上当前位置，store 会在关闭前最后上报一次
  bili.closeVideo(currentSeconds());
}

/** 当前播放位置（拿不到就是 0）。 */
function currentSeconds(): number {
  const t = art?.currentTime;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

/** Esc 关闭浮层（全屏时交给 ArtPlayer 自己处理 Esc 退全屏） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || document.fullscreenElement) return;
  // 登录弹窗盖在这层之上（z-index 260），Esc 应先关它。
  // 弹窗自己会消费 Esc；这里不判就会「一次 Esc 连关两层」——
  // 播放页被拆掉，而弹窗还悬在 feed 上。
  if (document.querySelector("m3e-dialog[open]")) return;
  close();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  if (hasSource.value) void mountSource();

  // 画布铺满整个视图，不需要测量任何区域（尺寸由 CSS 百分比给）
  // 弹幕外观改动实时生效（不必重开视频）
  unwatchDanmakuOpts = watch(
    () => [
      settings.danmakuOpacity,
      settings.danmakuFontSize,
      settings.danmakuArea,
      settings.danmakuSpeed,
      settings.danmakuAntiOverlap,
    ],
    () => applyDanmakuAppearance(),
  );
  // 氛围光：开启时若播放器已就绪，补一次 attach（开关可能晚于播放器创建才打开）
  unwatchAmbilight = watch(
    () => settings.ambilightEnabled,
    async (on) => {
      if (!on) return;
      // 画布 v-if 刚挂上时还没有上下文，等一帧再接管 <video>
      await nextTick();
      ambilight.attach(art?.video ?? null);
    },
  );

  // 总开关：开着的时候把弹幕装回来（关掉时由 hide() 隐藏，但列表也需要清）
  unwatchDanmakuSwitch = watch(
    () => settings.danmakuEnabled,
    (on) => {
      syncDanmakuVisibility();
      if (on) void reloadDanmaku();
    },
  );

  // 播放地址变化（首帧到达 / 切清晰度 / 切分 P）时重挂
  unwatchUrl = watch(
    () => [play.value?.quality, play.value?.durl[0], bili.activeCid].join("|"),
    () => {
      if (hasSource.value) void mountSource();
    },
  );
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  unwatchUrl?.();
  unwatchUrl = null;
  unwatchDanmakuOpts?.();
  unwatchDanmakuOpts = null;
  unwatchDanmakuSwitch?.();
  unwatchDanmakuSwitch = null;
  unwatchAmbilight?.();
  unwatchAmbilight = null;

  // 卸载（切页 / 关应用）前把进度落一次，否则这一段观看记录会丢
  bili.reportProgress(currentSeconds());
  bili.stopHeartbeat();
  danmakuGen += 1;
  ambilight.attach(null);
  dash?.destroy();
  dash = null;
  art?.destroy(false);
  art = null;
});

/**
 * 把「设置里的弹幕开关」同步到插件。
 *
 * 插件的 visible 选项只在构造时生效，此后的显隐必须走 show()/hide()。
 */
function syncDanmakuVisibility(): void {
  const plugin = danmakuPlugin();
  if (!plugin?.show || !plugin?.hide) return;
  if (settings.danmakuEnabled) plugin.show();
  else plugin.hide();
}

/** 点 UP 主头像 / 昵称进主页（带当前播放位置，关浮层前会先上报进度）。 */
function openUp(): void {
  bili.openCurrentUp(currentSeconds());
}

function partLabel(index: number, fallback: string): string {
  return fallback || `P${index + 1}`;
}

// ---- 互动（点赞 / 投币 / 收藏 / 分享）----
const coinOpen = ref(false);

function sendCoin(n: number): void {
  coinOpen.value = false;
  void bili.addCoin(n);
}

/** 点气泡外面就关掉（与 WindowTitleBar 的外观菜单同一套做法） */
function onDocPointerDown(e: PointerEvent): void {
  if (!coinOpen.value) return;
  if ((e.target as HTMLElement | null)?.closest(".act-wrap")) return;
  coinOpen.value = false;
}

const metaItems = computed(() => {
  const d = detail.value;
  if (!d) return [] as string[];
  return [
    d.pubdate ? biliPubdate(d.pubdate) : "",
    d.stat.view ? `${biliCount(d.stat.view)}${t("bili.plays")}` : "",
    d.stat.danmaku ? `${biliCount(d.stat.danmaku)}${t("bili.danmakus")}` : "",
  ].filter(Boolean);
});
</script>

<template>
  <div ref="viewRef" class="bili-view" :class="{ 'has-ambilight': settings.ambilightEnabled }">
    <!--
      氛围光画布：铺满整个视图的一片共用背景。
      挂在视图根节点下（而不是播放器里）的原因：
        - 挂在播放器里会被 .content 的 overflow 裁掉，也够不到顶栏与侧栏；
        - 铺满之后顶栏 / 播放器 / 侧栏 / 评论区都落在同一片光上，中间没有接缝。
    -->
    <canvas
      v-if="settings.ambilightEnabled"
      ref="ambilightCanvas"
      class="ambilight"
      aria-hidden="true"
      :style="ambilightStyle"
    />

    <!-- 顶栏（用原生 button：浮层里的操作必须 100% 可点，不依赖自定义元素的事件转发） -->
    <header class="head lm-glass">
      <button class="head-btn" type="button" :title="t('bili.close')" @click="close">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <span class="head-title" :title="title">{{ title }}</span>
      <span class="spacer" />
      <!--
        顶栏刻意只保留「返回」。
        曾经这里挤了三个按钮：
          - 弹幕开关：插件自带控制栏（$controlsCenter 的 apd-toggle / apd-config）
            已经完整覆盖，重复入口只会和它抢同一份状态，已删；
          - 「在浏览器打开」（open_in_new）：用户明确不需要，已删 —— 不要再加回来；
          - 分享：详情页信息区已有一个分享按钮（复制链接），顶栏这个同样是重复，已删。
      -->
    </header>

    <!-- 左栏（播放器 / 信息 / 评论） + 右栏（相关推荐）；窗口放不下时自动折成一栏 -->
    <div class="content">
      <div class="main">
        <!-- 播放器 -->
        <div class="player-area">
          <div ref="container" class="art-container" />
          <div v-if="bili.playStatus === 'loading'" class="player-overlay">
            <m3e-loading-indicator class="lm-loading" />
            <span>{{ t("bili.resolving") }}</span>
          </div>
          <div v-else-if="bili.playStatus === 'error' && !hasSource" class="player-overlay error">
            <span class="material-symbols-outlined">error</span>
            <span class="err-text">{{ bili.playError || t("bili.resolveFailed") }}</span>
            <m3e-button variant="filled" size="small" @click="bili.selectQuality(bili.activeQn)">
              <span slot="icon" class="material-symbols-outlined">refresh</span>
              {{ t("bili.retry") }}
            </m3e-button>
          </div>
          <div v-else-if="playerError" class="player-overlay error">
            <span class="material-symbols-outlined">error</span>
            <span class="err-text">{{ playerError }}</span>
            <span class="err-hint">{{ t("bili.playbackHint") }}</span>
            <m3e-button variant="filled" size="small" @click="retryPlayback">
              <span slot="icon" class="material-symbols-outlined">refresh</span>
              {{ t("bili.retry") }}
            </m3e-button>
          </div>
        </div>

        <!-- 信息区 -->
        <div class="detail-body">
          <div v-if="bili.detailStatus === 'loading' && !detail" class="detail-loading">
            <m3e-loading-indicator class="lm-loading" />
            {{ t("bili.loadingDetail") }}
          </div>

          <template v-else-if="detail">
            <h2 class="title">{{ detail.title }}</h2>
            <div class="submeta">
              <span v-for="(m, i) in metaItems" :key="i">{{ i > 0 ? "· " : "" }}{{ m }}</span>
            </div>

            <div class="owner-row">
              <!-- 头像 + 昵称整块可点：进 UP 主主页 -->
              <button
                class="owner-link"
                type="button"
                :title="t('bili.userHome')"
                :disabled="!detail.owner.mid"
                @click="openUp"
              >
                <span class="avatar">
                  <img
                    v-if="detail.owner.face"
                    :src="detail.owner.face"
                    alt=""
                    referrerpolicy="no-referrer"
                  />
                  <span v-else class="material-symbols-outlined">person</span>
                </span>
                <span class="owner-name" :title="detail.owner.name">{{
                  detail.owner.name || t("bili.unknownUp")
                }}</span>
                <span class="material-symbols-outlined go">chevron_right</span>
              </button>
              <span class="grow" />
              <m3e-button
                v-if="detail.owner.mid"
                :variant="bili.relation?.followed ? 'tonal' : 'filled'"
                size="small"
                :disabled="bili.acting.follow"
                @click="bili.toggleFollow()"
              >
                <span slot="icon" class="material-symbols-outlined">{{
                  bili.relation?.followed ? "check" : "add"
                }}</span>
                {{ bili.relation?.followed ? t("bili.followed") : t("bili.follow") }}
              </m3e-button>
            </div>

            <!-- 互动：点赞 / 投币 / 收藏 / 分享（对应参考布局里那排胶囊按钮） -->
            <div class="actions">
              <button
                class="act"
                :class="{ on: bili.relation?.liked }"
                type="button"
                :title="t('bili.likeAction')"
                :disabled="bili.acting.like"
                @click="bili.toggleLike()"
              >
                <span class="material-symbols-outlined">thumb_up</span>
                <span class="tabular-nums">{{ biliCount(detail.stat.like) }}</span>
              </button>

              <div class="act-wrap">
                <button
                  class="act"
                  :class="{ on: (bili.relation?.coin ?? 0) > 0 }"
                  type="button"
                  :title="t('bili.coinAction')"
                  @click="coinOpen = !coinOpen"
                >
                  <span class="material-symbols-outlined">monetization_on</span>
                  <span class="tabular-nums">{{ biliCount(detail.stat.coin) }}</span>
                </button>
                <Transition name="coin-pop">
                  <div v-if="coinOpen" class="coin-pop lm-glass">
                    <button class="coin-opt" type="button" @click="sendCoin(1)">
                      <span class="material-symbols-outlined">monetization_on</span>
                      {{ t("bili.coinOne") }}
                    </button>
                    <button class="coin-opt" type="button" @click="sendCoin(2)">
                      <span class="material-symbols-outlined">monetization_on</span>
                      {{ t("bili.coinTwo") }}
                    </button>
                  </div>
                </Transition>
              </div>

              <button
                class="act"
                :class="{ on: bili.relation?.favored }"
                type="button"
                :title="t('bili.favAction')"
                :disabled="bili.acting.fav"
                @click="bili.toggleFavorite()"
              >
                <span class="material-symbols-outlined">{{
                  bili.relation?.favored ? "star" : "star_border"
                }}</span>
                <span class="tabular-nums">{{ biliCount(detail.stat.favorite) }}</span>
              </button>

              <button class="act" type="button" @click="bili.shareVideo()">
                <span class="material-symbols-outlined">share</span>
                {{ t("bili.share") }}
              </button>
            </div>

            <div v-if="qualities.length" class="block">
              <div class="block-label">{{ t("bili.quality") }}</div>
              <div class="chips">
                <!-- @click.prevent 是必需的：m3e-filter-chip 的 handleClick 开头是
                     「if (e.defaultPrevented) return;」，不 preventDefault 它就会自己翻转
                     selected；而 Vue 的 @click 先执行，于是第一下被翻回未选中 →
                     表现为「点两次才切换清晰度」 -->
                <m3e-filter-chip
                  v-for="q in qualities"
                  :key="q"
                  class="chip"
                  :selected="q === bili.activeQn"
                  @click.prevent="bili.selectQuality(q)"
                >
                  {{ biliFormatLabel(play!, q) }}
                </m3e-filter-chip>
              </div>
            </div>

            <div v-if="showParts" class="block">
              <div class="block-label">{{ t("bili.parts") }}（{{ parts.length }}）</div>
              <div class="parts-grid">
                <button
                  v-for="(p, i) in parts"
                  :key="p.cid"
                  class="part"
                  :class="{ active: p.cid === bili.activeCid }"
                  :title="partLabel(i, p.part)"
                  @click="bili.selectPart(p.cid, currentSeconds())"
                >
                  <span class="part-name">{{ partLabel(i, p.part) }}</span>
                  <span class="part-time tabular-nums">{{ biliDuration(p.duration) }}</span>
                </button>
              </div>
            </div>

            <div class="block">
              <div class="block-label">{{ t("bili.desc") }}</div>
              <p class="desc" :class="{ expanded: descExpanded }">
                {{ detail.desc || t("bili.noDesc") }}
              </p>
              <m3e-button
                v-if="(detail.desc || '').length > 120"
                variant="text"
                size="small"
                @click="descExpanded = !descExpanded"
              >
                {{ descExpanded ? t("bili.collapse") : t("bili.expand") }}
              </m3e-button>
            </div>
          </template>

          <div v-else-if="bili.playError" class="detail-error">
            <span class="material-symbols-outlined">error</span>
            <span>{{ bili.playError }}</span>
          </div>
        </div>
        <BilibiliComments @login="emit('login')" />
      </div>

      <!-- 右栏：相关推荐（sticky，长评论区滚动时始终可见） -->
      <aside class="side">
        <BilibiliRelatedList
          :videos="bili.related"
          :status="bili.relatedStatus"
          @open="bili.openVideo"
        />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.bili-view {
  position: fixed;
  inset: 0;
  /* 必须高于 BilibiliUserView(210)。
     两个方向各自成立：
       - UP 主页 → 点视频：主页仍挂载，视频叠在它上面，关掉视频即回到主页；
       - 视频详情 → 点 UP 头像：由 store.openUser 主动关掉视频浮层，
         所以不会出现「UP 主页被压在视频底下、点了没反应」。 */
  z-index: 220;
  display: flex;
  flex-direction: column;
  background: var(--md-sys-color-surface);
  animation: bili-fade-in 200ms var(--md-sys-motion-spring-effects-fast);
}
@keyframes bili-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--lm-hairline);
  /* 与 WindowTitleBar 同一套做法：留白处即窗口拖拽区（浮层盖在标题栏上，
     顶层那条 drag 区域仍在生效），可点元素必须显式 no-drag —— 见下 */
  -webkit-app-region: drag;
}
.head-title {
  min-width: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head .spacer {
  flex: 1;
}
.head-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  /* 关键：不排除拖拽的话，按钮落在标题栏那条 drag 区域里，点击会被当成拖窗口
     （表现就是「点了没反应」）。WindowTitleBar 的 .tb-actions 同理。 */
  -webkit-app-region: no-drag;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.head-btn:hover {
  background: var(--md-sys-color-surface-container-high);
}
.head-btn:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: -2px;
}
.head-btn .material-symbols-outlined {
  font-size: 20px;
}
.head-btn.off {
  opacity: 0.45;
}

/* 左栏（播放器 / 信息 / 评论） + 右栏（相关推荐）：一栏放不下就折成上下 */
.content {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 22px;
  /* 左右留白要够：氛围光会向两侧外扩，padding 太小光晕会被视口边缘切掉 */
  padding: 18px 22px 40px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.main {
  flex: 1 1 560px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.side {
  flex: 0 1 336px;
  min-width: 264px;
  /* 评论区很长，右栏跟着滚就没法边看边选了 */
  position: sticky;
  top: 0;
  padding: 10px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.player-area {
  position: relative;
  width: 100%;
  /* 宽度由左栏决定，高度按 16:9 跟随；窗口很矮时限制一下不撑破视口 */
  aspect-ratio: 16 / 9;
  max-height: 62vh;
  background: #000;
}
/*
 * 氛围光画布。
 *
 * 关键点：
 * - absolute + 负 inset：比播放器更大（外扩量由内联 style 的 inset 给），
 *   模糊后的边缘才能溢出到播放器之外形成光晕；
 * - z-index: -1 让它落在播放器**下面**（播放器 .art-container 是 z-index auto，
 *   但同层下 negative 一定更靠后）；
 * - pointer-events: none / user-select: none：纯装饰，不能吃掉播放器上的点击；
 * - will-change/transform: translateZ(0)：把它提升为独立合成层，
 *   避免每帧重绘整个播放器区域（不加的话模糊会连带父层一起重算，明显掉帧）。
 */
/*
 * 氛围光画布：视图根下的一片绝对定位背景，覆盖「顶栏 + 播放器 + 右侧相关推荐」。
 * 位置与尺寸由内联 style 给（测量出的像素矩形 + 外扩）。
 */
.ambilight {
  position: absolute;
  z-index: 0;
  display: block;
  pointer-events: none;
  user-select: none;
  will-change: filter;
}
/*
 * ============ 氛围光沉浸模式 ============
 *
 * 目标是「一片连续的氛围表面」：顶栏、播放器、右侧相关推荐、底部评论区全部融为
 * 一体，中间没有卡片间隙、没有描边。
 *
 * 关键认识：视图根的底色原本是**不透明**的 `--md-sys-color-surface`。
 * 光晕画布在它下面，所以只靠「把某几块调透明」是不够的 —— 只要还有任何一层不透明
 * surface 挡在画布与内容之间，就会出现色块边界。因此这里统一做三件事：
 *   1. 根底色置空，整页真正「透」到光晕上；
 *   2. 所有内容分区的卡片底与发丝描边一律去掉（顶栏/侧栏/评论输入框/评论楼中楼）；
 *   3. 需要区分层级的地方改用**留白**而不是底色与描边。
 */
.bili-view.has-ambilight {
  isolation: isolate;
  /*
   * 根底保留一层主题色，而不是置空。两个原因：
   * 1. 画布铺满视图，但 blur() 会在最外圈把画面拉暗；有底色垫底，边缘过渡更自然；
   * 2. 这是 position: fixed 的全屏浮层 —— 根若透明，浮层之外会透出下层 App（串页）。
   * 让内容「融进光里」靠的是把各分区的卡片底与描边全部摊平，而不是把根抠空。
   */
  background: var(--md-sys-color-surface);
}
.bili-view.has-ambilight .head,
.bili-view.has-ambilight .content {
  position: relative;
  z-index: 1;
}

/* ---- 顶栏：去掉 lm-glass 底色、底部分隔线与毛玻璃，纯粹让光透上来 ---- */
.bili-view.has-ambilight .head {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-bottom-color: transparent;
}

/* ---- 播放器：黑底会盖住光晕，交给光晕自己 ---- */
.bili-view.has-ambilight .player-area {
  background: transparent;
}

/*
 * ---- 右侧相关推荐 / 评论输入框 / 评论区：全部去卡片底与描边 ----
 *
 * 这几块原本各自是 surface-container-low + inset 发丝描边（也就是你看到的卡片边）。
 * 沉浸模式下统一摊平：只保留 padding 与外层间距来表达分组。
 */
/* .side 在本组件内；.composer / .comments 在子组件里，必须 :deep() 穿透 scoped */
.bili-view.has-ambilight .side {
  background: transparent;
  box-shadow: none;
}
.bili-view.has-ambilight :deep(.composer) {
  background: transparent;
  box-shadow: none;
}

/* 评论区的顶部分隔线也去掉：它会在光晕中间划一道横线 */
.bili-view.has-ambilight :deep(.comments) {
  border-top-color: transparent;
}

/*
 * 楼中楼（回复）原本是 surface-container 底 + 圆角，会形成嵌套卡片。
 * 沉浸模式下改为左侧竖线缩进 —— 既表达从属关系，又不切碎光晕。
 */
.bili-view.has-ambilight :deep(.comments .subs) {
  background: transparent;
  padding-left: 12px;
  border-left: 2px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 55%, transparent);
  border-radius: 0;
}

/* 评论项之间靠留白分隔（不再有卡片） */
.bili-view.has-ambilight :deep(.comments .list) {
  gap: 20px;
}

/*
 * 缩略图占位与时长角标保持原样：它们是内容本身（图片占位/时间信息），
 * 不是分区卡片，透出光晕反而更脏。
 */
.art-container {
  position: absolute;
  inset: 0;
}
.player-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: var(--md-sys-typescale-body-medium-size);
}
.player-overlay .material-symbols-outlined {
  font-size: 34px;
}
.player-overlay.error {
  color: #ffb4ab;
}
.player-overlay .err-text {
  max-width: min(560px, 80%);
  text-align: center;
  color: #fff;
}
.player-overlay .err-hint {
  max-width: min(560px, 80%);
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.75);
}

/* 滚动交给 .content（整页一起滚），这里只负责信息区的排版 */
.detail-body {
  padding: 16px 0 0;
}
.detail-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--md-sys-color-on-surface-variant);
}

.title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 600;
  line-height: 1.35;
}
.submeta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.owner-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.grow {
  flex: 1;
}

/* ---- 互动按钮（点赞 / 投币 / 收藏 / 分享）---- */
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 14px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
  transition:
    background 160ms var(--md-sys-motion-spring-effects-fast),
    transform 200ms var(--md-sys-motion-spring-spatial-fast);
}
.act:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-highest);
}
.act:active:not(:disabled) {
  transform: scale(0.96);
}
.act:disabled {
  opacity: 0.5;
  cursor: default;
}
.act:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
/* 已激活（已赞 / 已投币 / 已收藏）：走主色容器，一眼能看出状态 */
.act.on {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.act .material-symbols-outlined {
  font-size: 18px;
}

.act-wrap {
  position: relative;
}
.coin-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: 6px;
  border: 1px solid var(--lm-hairline);
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-elevation-3);
}
.coin-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  text-align: left;
  cursor: pointer;
}
.coin-opt:hover {
  background: var(--md-sys-color-surface-container-high);
}
.coin-opt .material-symbols-outlined {
  font-size: 18px;
  color: var(--md-sys-color-primary);
}
.coin-pop-enter-active,
.coin-pop-leave-active {
  transition:
    opacity 120ms var(--md-sys-motion-spring-effects-fast),
    transform 200ms var(--md-sys-motion-spring-spatial-fast);
}
.coin-pop-enter-from,
.coin-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.owner-link {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 10px 4px 4px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.owner-link:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-high);
}
.owner-link:disabled {
  cursor: default;
}
.owner-link:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.owner-name {
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.owner-link .go {
  font-size: 18px;
  color: var(--md-sys-color-on-surface-variant);
}

.block {
  margin-top: 20px;
}
.block-label {
  margin-bottom: 8px;
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chips m3e-filter-chip {
  --m3e-chip-container-height: 32px;
}

.parts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px;
}
.part {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.part:hover {
  background: var(--md-sys-color-surface-container-high);
}
.part.active {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-weight: 500;
}
.part-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.part-time {
  flex: none;
  opacity: 0.8;
}

.desc {
  margin: 0 0 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.7;
  color: var(--md-sys-color-on-surface-variant);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.desc.expanded {
  display: block;
  overflow: visible;
}

.detail-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  color: var(--md-sys-color-error);
}
</style>
