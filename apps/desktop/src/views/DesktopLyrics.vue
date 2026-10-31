<script setup lang="ts">
/**
 * 桌面歌词窗口页面。
 *
 * 独立透明置顶窗口（label: desktop-lyrics）加载本路由；
 * 通过应用事件接收歌词状态。
 * 控制栏：点击歌词展开，5 秒无操作自动隐藏；
 * 设置可选择始终显示。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getCurrentWindow } from "@/ipc/window";
import { listen, type UnlistenFn } from "@/ipc/events";
import { useSettingsStore } from "@/stores/settings";
import { isDesktop } from "@/capabilities";
import SpectrumBars from "@/components/SpectrumBars.vue";
import {
  DL_SETTINGS_EVENT,
  DL_SPECTRUM_EVENT,
  DL_STATE_EVENT,
  emitDesktopLyricsBounds,
  emitDesktopLyricsControl,
  emitDesktopLyricsReady,
  isDesktopLyricsWindow,
  mergeDesktopLyricsState,
  type DesktopLyricsState,
  type DesktopLyricsUpdate,
} from "@/utils/desktopLyrics";
import { computeLineFill } from "@/utils/karaokeFill";
import { applyAnchorSize, applyTaskbarAnchor, watchDisplay } from "@/utils/desktopLyricsAnchor";

const settings = useSettingsStore();
const state = ref<DesktopLyricsState | null>(null);
const toolbarOpen = ref(settings.desktopLyricsToolbar === "always");
let autoHideTimer: number | null = null;

/**
 * 本地播放时钟（秒）。
 *
 * 主窗口只以 200ms 节流推送 `currentTime`，直接拿它做逐字填充会一跳一跳。
 * 这里在两次推送之间用 rAF 自走（按真实经过时间累加），收到推送再校准回
 * 权威值 —— 于是填充能平滑到帧级，而**推送频率不必提高**
 * （这正是上游 TaskbarLyrics 的取舍：逐字效果放前端做）。
 *
 * 只在播放中自走：暂停时冻结，避免歌词继续往前跑。
 */
const clock = ref(0);
let rafId: number | null = null;
let lastFrameAt = 0;

function tickClock(now: number): void {
  const prev = lastFrameAt || now;
  const dt = (now - prev) / 1000;
  lastFrameAt = now;
  // 上限 0.25s：窗口被挂起/最小化后回来时，别让时钟一次跳很远
  if (state.value?.playing && dt > 0 && dt < 0.25) {
    clock.value += dt;
  }
  rafId = requestAnimationFrame(tickClock);
}

function startClock(): void {
  if (rafId !== null) return;
  lastFrameAt = 0;
  rafId = requestAnimationFrame(tickClock);
}

function stopClock(): void {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
  lastFrameAt = 0;
}

/** 校准：以推送来的权威时间为准 */
function calibrate(time: number): void {
  // 偏差超过 0.35s 才硬拉，否则逐帧微调，避免画面抖动
  if (Math.abs(clock.value - time) > 0.35) clock.value = time;
  else clock.value = clock.value * 0.8 + time * 0.2;
}

/** 当前行填充比例（0-1）；未开逐字或该行无词级时间轴时由纯函数内部退化 */
const currentFill = computed(() => {
  const idx = currentIndex.value;
  const lines = state.value?.lines;
  if (idx < 0 || !lines || !settings.desktopLyricsWordByWord) return 1;
  const line = lines[idx];
  if (!line) return 1;
  const next = lines[idx + 1];
  return computeLineFill(
    { time: line.time, text: line.text, units: line.units },
    next?.time,
    clock.value,
  );
});

/** 逐字填充用 CSS 渐变实现：已唱部分实心、未唱部分半透明 */
const fillStyle = computed(() => {
  const pct = Math.round(currentFill.value * 100);
  if (!settings.desktopLyricsWordByWord) return {};
  return {
    backgroundImage: `linear-gradient(90deg, #fff ${pct}%, rgba(255,255,255,0.45) ${pct}%)`,
    "-webkit-background-clip": "text",
    backgroundClip: "text",
    color: "transparent",
    // 渐变必须跟随文本宽度，否则百分比落在元素盒子上而不是文字上
    display: "inline-block",
  } as Record<string, string>;
});

/**
 * 无歌词时才显示频谱。
 *
 * 判据是「当前没有可显示的歌词行」——包括纯音乐（三点行不算歌词内容）
 * 与整首歌没有歌词两种情况。
 */
const showSpectrum = computed(() => {
  if (settings.desktopLyricsIdleMode !== "spectrum") return false;
  const lines = state.value?.lines ?? [];
  return lines.length === 0 || currentIndex.value < 0;
});

const currentIndex = computed(() => {
  const lines = state.value?.lines ?? [];
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((state.value?.currentTime ?? 0) >= lines[i].time) idx = i;
    else break;
  }
  return idx;
});

const current = computed(() =>
  currentIndex.value >= 0 ? state.value?.lines[currentIndex.value] : undefined,
);
const next = computed(() =>
  currentIndex.value >= 0 ? state.value?.lines[currentIndex.value + 1] : undefined,
);

const mainText = computed(() => {
  if (current.value?.text) return current.value.text;
  if (state.value?.title) return state.value.title;
  return "暂无歌词";
});
const subText = computed(() => {
  if (!settings.desktopLyricsShowNext) return "";
  if (next.value?.text && next.value.text !== mainText.value) return `下一句 · ${next.value.text}`;
  return "";
});
/** 当前行的中文翻译（仅在开启且有翻译且与原文不同时显示） */
const translationText = computed(() => {
  if (!settings.desktopLyricsShowTranslation) return "";
  const tr = current.value?.translation;
  return tr && tr !== mainText.value ? tr : "";
});
/** 当前行的背景和声（AMLL 的 x-bg 子行；与主行同屏显示） */
const bgText = computed(() => {
  if (!settings.desktopLyricsShowTranslation) return "";
  const bg = current.value?.bg;
  return bg && bg !== mainText.value ? bg : "";
});

/** 控制栏是否可见（always 模式 / click 模式且已展开） */
const toolbarVisible = computed(
  () => settings.desktopLyricsToolbar === "always" || toolbarOpen.value,
);

/** 点击歌词区域切换控制栏 */
function toggleToolbar() {
  if (settings.desktopLyricsToolbar !== "click") return;
  toolbarOpen.value = !toolbarOpen.value;
  if (toolbarOpen.value) startAutoHide();
  else cancelAutoHide();
}

/** 操作控制栏时重置自动隐藏计时 */
function resetAutoHide() {
  if (settings.desktopLyricsToolbar !== "click") return;
  if (!toolbarOpen.value) return;
  startAutoHide();
}

function startAutoHide() {
  cancelAutoHide();
  autoHideTimer = window.setTimeout(() => {
    toolbarOpen.value = false;
    autoHideTimer = null;
  }, 5000);
}

function cancelAutoHide() {
  if (autoHideTimer !== null) {
    window.clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

// ---- 窗口控制 ----

let unlistenState: UnlistenFn | null = null;
let unlistenMoved: UnlistenFn | null = null;
let unlistenResized: UnlistenFn | null = null;
let unlistenSpectrum: UnlistenFn | null = null;
let unlistenSettings: UnlistenFn | null = null;
let unlistenDisplay: (() => void) | null = null;
let boundsTimer: number | null = null;
let anchorRestoreTimer: number | null = null;

/** 无歌词时显示的频谱数据（由主窗口推送） */
const spectrumBins = ref<number[] | null>(null);

function scheduleReportBounds() {
  if (boundsTimer !== null) return;
  boundsTimer = window.setTimeout(() => {
    boundsTimer = null;
    void reportBounds();
  }, 300);
}

/**
 * 窗口被移动。
 *
 * 锚定模式下**用户拖动会被拉回锚点** —— 但只在「确实偏离了」时才拉，
 * 且加一个短延时：用户拖到一半时立刻回弹会像卡住一样，
 * 松手后归位才符合「吸附」的预期。
 */
function onWindowMoved() {
  if (settings.desktopLyricsAnchor === "taskbar") {
    if (anchorRestoreTimer !== null) window.clearTimeout(anchorRestoreTimer);
    anchorRestoreTimer = window.setTimeout(() => {
      anchorRestoreTimer = null;
      void reanchor();
    }, 400);
    return;
  }
  scheduleReportBounds();
}

/**
 * 重新贴到任务栏。
 *
 * 只在 taskbar 模式生效；manual 模式什么都不做（尊重用户拖放的位置）。
 * 锚定失败（该屏幕没有任务栏 / 取不到显示器信息）时保持原位不动。
 */
async function reanchor() {
  if (!isDesktop) return;
  if (settings.desktopLyricsAnchor !== "taskbar") return;
  try {
    await applyAnchorSize(settings.desktopLyricsBounds.width, settings.desktopLyricsBounds.height);
    await applyTaskbarAnchor({
      align: settings.desktopLyricsAnchorAlign,
      offsetX: settings.desktopLyricsAnchorOffsetX,
      offsetY: settings.desktopLyricsAnchorOffsetY,
    });
  } catch {
    /* 锚定失败不影响歌词显示 */
  }
}

async function reportBounds() {
  if (!isDesktop) return;
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    const scale = window.devicePixelRatio || 1;
    await emitDesktopLyricsBounds({
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale),
    });
  } catch {
    /* ignore */
  }
}

function togglePlay() {
  resetAutoHide();
  void emitDesktopLyricsControl("toggle");
}
function onDblClick() {
  if (settings.desktopLyricsDoubleClick !== "toggle") return;
  resetAutoHide();
  void emitDesktopLyricsControl("toggle");
}
function prevSong() {
  resetAutoHide();
  void emitDesktopLyricsControl("prev");
}
function nextSong() {
  resetAutoHide();
  void emitDesktopLyricsControl("next");
}
function closeLyrics() {
  void emitDesktopLyricsControl("close");
  if (isDesktop) void getCurrentWindow().close();
}

// ---- 生命周期 ----

onMounted(async () => {
  if (!isDesktop) return;
  if (!(await isDesktopLyricsWindow())) return;

  /**
   * ⚠️ 必须**自己**加载设置。
   *
   * 桌面歌词是独立渲染进程，它有自己的 Pinia store 实例；而 App.vue 的
   * onMounted 在别的窗口类型（drawing / extension）会提前 return，
   * 桌面歌词窗口**不在那条主界面初始化路径上**，所以 settings.load() 从来
   * 没被调用过 —— store 里全是 DEFAULTS。
   *
   * 后果：`settings.desktopLyricsAnchor` 永远是默认的 "manual"，
   * 于是 reanchor() 第一道守卫就 return，锚定**完全不生效**（表现为
   * 「设置里选了吸附任务栏，窗口纹丝不动」）。其余读 settings 的地方
   * （字号 / 不透明度 / 逐字开关 / 无歌词显示）同样一直是默认值。
   */
  try {
    await settings.load();
  } catch {
    /* 读不到设置就用默认值，不能因此让歌词窗口起不来 */
  }

  window.addEventListener("blur", () => {
    cancelAutoHide();
    toolbarOpen.value = false;
  });
  try {
    unlistenState = await listen<DesktopLyricsUpdate>(DL_STATE_EVENT, (e) => {
      state.value = mergeDesktopLyricsState(state.value, e.payload);
      // 每次推送都校准本地时钟，逐字填充因此始终贴着权威进度
      calibrate(e.payload.currentTime);
      startClock();
    });
    const win = getCurrentWindow();
    void win.setAlwaysOnTop(settings.desktopLyricsAlwaysOnTop);
    void win.setIgnoreCursorEvents(settings.desktopLyricsClickThrough);
    unlistenMoved = await win.onMoved(onWindowMoved);
    unlistenResized = await win.onResized(scheduleReportBounds);
    unlistenSpectrum = await listen<{ bins: number[] }>(DL_SPECTRUM_EVENT, (e) => {
      spectrumBins.value = e.payload?.bins ?? null;
    });
    // 主窗口改了设置 → 重新 load 并重新锚定（见 DL_SETTINGS_EVENT 注释）
    unlistenSettings = await listen<null>(DL_SETTINGS_EVENT, async () => {
      try {
        await settings.load();
      } catch {
        /* 读取失败保持现状 */
      }
      await reanchor();
    });
    // 任务栏锚定：进入时贴一次，之后显示器变化再贴（不再轮询）
    await reanchor();
    unlistenDisplay = watchDisplay(() => void reanchor());
    emitDesktopLyricsReady();
  } catch {
    /* ignore */
  }
});

watch(
  () => settings.desktopLyricsAlwaysOnTop,
  (v) => {
    if (isDesktop) void getCurrentWindow().setAlwaysOnTop(v);
  },
);

watch(
  () => settings.desktopLyricsClickThrough,
  (v) => {
    if (isDesktop) void getCurrentWindow().setIgnoreCursorEvents(v);
  },
);

// 锚定相关设置变化时立刻重新贴（用户改锚点/对齐/偏移应即时生效）
watch(
  () => [
    settings.desktopLyricsAnchor,
    settings.desktopLyricsAnchorAlign,
    settings.desktopLyricsAnchorOffsetX,
    settings.desktopLyricsAnchorOffsetY,
  ],
  ([anchor], [prevAnchor]) => {
    if (anchor === "taskbar") {
      void reanchor();
      return;
    }
    // 从「吸附任务栏」切回「手动拖放」：把**当前实际位置**记成手动位置。
    //
    // 不这么做的话，设置里留着的还是吸附之前那次拖放的旧坐标：窗口当场不动，
    // 但下次启动会跳回那个旧位置，用户会觉得「位置丢了」。
    if (prevAnchor === "taskbar") scheduleReportBounds();
  },
);

onBeforeUnmount(() => {
  cancelAutoHide();
  stopClock();
  if (boundsTimer !== null) window.clearTimeout(boundsTimer);
  if (anchorRestoreTimer !== null) window.clearTimeout(anchorRestoreTimer);
  unlistenState?.();
  unlistenMoved?.();
  unlistenResized?.();
  unlistenSpectrum?.();
  unlistenSettings?.();
  unlistenDisplay?.();
});
</script>

<template>
  <div
    class="desktop-lyrics"
    :class="{
      'toolbar-visible': toolbarVisible,
      locked: settings.desktopLyricsLocked,
    }"
    :style="{
      fontSize: settings.desktopLyricsFontSize + 'px',
      opacity: settings.desktopLyricsOpacity / 100,
    }"
    @dblclick.prevent="onDblClick"
  >
    <div class="lyrics-main" @click.stop="toggleToolbar">
      <!-- 无歌词时的替代显示：实时频谱（纯音乐/未匹配到歌词） -->
      <div v-if="showSpectrum" class="spectrum-slot">
        <SpectrumBars :bins="spectrumBins" :playing="state?.playing ?? false" />
      </div>

      <template v-else>
        <Transition :name="'dl-' + settings.desktopLyricsAnimation" mode="out-in">
          <div :key="currentIndex" class="line-stack">
            <!--
              逐字填充：用 background-clip:text + 渐变实现「已唱实心、未唱半透明」。
              不用两个叠层是因为叠层要求两份文本像素级对齐，字体渲染会有亚像素差，
              在高分屏上边缘会出现彩边。
            -->
            <p class="line current" :style="fillStyle">{{ mainText }}</p>
            <p v-if="bgText" class="line bg-vocal">{{ bgText }}</p>
            <p v-if="translationText" class="line translation">{{ translationText }}</p>
          </div>
        </Transition>
        <p v-if="subText" class="line next">{{ subText }}</p>
      </template>
    </div>

    <Transition name="dl-bar">
      <div v-if="toolbarVisible" class="control-bar" @click.stop @mousemove="resetAutoHide">
        <span class="meta" :title="state?.title || ''">
          {{ state?.title || "—" }}<template v-if="state?.artist"> · {{ state.artist }}</template>
        </span>
        <span class="spacer"></span>
        <button class="ctr" title="上一首" @click="prevSong">
          <span class="material-symbols-outlined">skip_previous</span>
        </button>
        <button class="ctr play" title="播放/暂停" @click="togglePlay">
          <span class="material-symbols-outlined">
            {{ state?.playing ? "pause" : "play_arrow" }}
          </span>
        </button>
        <button class="ctr" title="下一首" @click="nextSong">
          <span class="material-symbols-outlined">skip_next</span>
        </button>
        <button class="ctr close" title="关闭桌面歌词" @click="closeLyrics">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style>
/* 透明窗口背景必须在全局作用域（非 scoped）下生效 */
body,
html {
  background: transparent !important;
  margin: 0;
}
</style>

<style scoped>
.desktop-lyrics {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  color: #fff;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.55);
  -webkit-app-region: no-drag;
  overflow: hidden;
  transition: box-shadow 200ms var(--md-sys-motion-spring-effects-fast);
}
.desktop-lyrics.toolbar-visible {
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.15),
    0 0 24px rgba(0, 0, 0, 0.25);
}
.desktop-lyrics.toolbar-visible::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 18px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.2), transparent);
  pointer-events: none;
}
.desktop-lyrics:not(.locked) {
  -webkit-app-region: drag;
}
.desktop-lyrics .control-bar {
  -webkit-app-region: no-drag;
}

.lyrics-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  transition: padding-top 180ms var(--md-sys-motion-spring-effects-fast);
  position: relative;
  z-index: 1;
}
/* 频谱占据歌词的同一块视觉区域，高度留足以免柱状图被压扁 */
.spectrum-slot {
  width: 100%;
  height: 2.2em;
  min-height: 40px;
  padding: 0 6px;
}
.desktop-lyrics.toolbar-visible .lyrics-main {
  padding-top: 34px;
}
.line {
  margin: 0;
  line-height: 1.3;
  text-align: center;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.line.current {
  font-weight: 700;
  background: rgba(0, 0, 0, 0.25);
  padding: 2px 16px;
  border-radius: 999px;
}
.line.next {
  font-size: 0.6em;
  opacity: 0.55;
  font-weight: 500;
}
.line-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
}
.line.translation {
  font-size: 0.62em;
  opacity: 0.82;
  font-weight: 500;
}
/* 背景和声子行：比翻译更小更暗，与主行形成层级 */
.line.bg-vocal {
  font-size: 0.55em;
  opacity: 0.6;
  font-weight: 500;
}

.control-bar {
  position: absolute;
  top: 6px;
  right: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 999px;
  background: rgba(20, 20, 24, 0.72);
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  z-index: 2;
}
.control-bar .meta {
  font-size: 12px;
  opacity: 0.75;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.control-bar .spacer {
  flex: 1;
}
.control-bar .ctr {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #fff;
  cursor: pointer;
}
.control-bar .ctr:hover {
  background: rgba(255, 255, 255, 0.18);
}
.control-bar .ctr.play {
  background: rgba(255, 255, 255, 0.92);
  color: #000;
}
.control-bar .ctr.close:hover {
  background: rgba(255, 80, 80, 0.85);
}
.control-bar .ctr .material-symbols-outlined {
  font-size: 17px;
  font-variation-settings: "FILL" 1;
}

/* 歌词切换动画：淡入 */
.dl-fade-enter-active,
.dl-fade-leave-active {
  transition: opacity 300ms var(--md-sys-motion-spring-effects-fast);
}
.dl-fade-enter-from,
.dl-fade-leave-to {
  opacity: 0;
}

/* 歌词切换动画：上滑 */
.dl-slide-enter-active,
.dl-slide-leave-active {
  transition:
    opacity 320ms var(--md-sys-motion-spring-effects-fast),
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dl-slide-enter-from {
  opacity: 0;
  transform: translateY(18px);
}
.dl-slide-leave-to {
  opacity: 0;
  transform: translateY(-14px);
}

/* 歌词切换动画：缩放 */
.dl-scale-enter-active,
.dl-scale-leave-active {
  transition:
    opacity 280ms var(--md-sys-motion-spring-effects-fast),
    transform 280ms cubic-bezier(0.34, 1.4, 0.64, 1);
}
.dl-scale-enter-from {
  opacity: 0;
  transform: scale(0.9);
}
.dl-scale-leave-to {
  opacity: 0;
  transform: scale(1.06);
}

/* 歌词切换动画：模糊浮现 */
.dl-glow-enter-active,
.dl-glow-leave-active {
  transition:
    opacity 360ms var(--md-sys-motion-spring-effects-fast),
    filter 360ms var(--md-sys-motion-spring-effects-fast),
    transform 360ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dl-glow-enter-from {
  opacity: 0;
  filter: blur(8px);
  transform: translateY(8px);
}
.dl-glow-leave-to {
  opacity: 0;
  filter: blur(10px);
}

/* 控制条出现/消失 */
.dl-bar-enter-active,
.dl-bar-leave-active {
  transition:
    opacity 200ms var(--md-sys-motion-spring-effects-fast),
    transform 220ms var(--md-sys-motion-spring-spatial-fast);
}
.dl-bar-enter-from,
.dl-bar-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
