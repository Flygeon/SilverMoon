<script setup lang="ts">
/**
 * AMLL 歌词视图 —— 直接嵌入 \`@applemusic-like-lyrics/core\` 的官方 \`DomLyricPlayer\`。
 *
 * 与自研的 LyricsView 是**并列的两套引擎**，由设置 \`lyricEngine\` 切换：
 * 这里把动效完全交给 AMLL（逐字 mask 渐变、行缩放、强调辉光、注音、背景和声滑动、
 * 间奏点、滚轮/触摸浏览），本项目只负责「喂数据 + 喂时间 + 翻译设置」。
 *
 * 接入要点（都是踩过的坑）：
 * - AMLL 的样式表 \`core/style.css\` 必须显式引入，包本身不做自动注入；
 * - 容器必须有**确定的像素高度**（AMLL 用 ResizeObserver 测量后自行定位），
 *   所以外层是 \`height:100%\` 的定位容器；
 * - 时间按**毫秒**推送，且要每帧调一次 \`update(deltaMs)\`；DOM 播放器不会自己跑 rAF；
 * - 翻译 / 音译由 AMLL 自己渲染（主行下方），不再需要本项目的 subText；
 * - 遮蔽已由 player store 在派生歌词文本时完成，这里必须把 AMLL 的掩码关掉，否则二次遮蔽。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { translate } from "@shared/i18n";
import { DomLyricPlayer, MaskObsceneWordsMode } from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
import { toAmllLyricBundle } from "@/utils/amllLyricAdapter";
import { lyricFontFamily } from "@/utils/lyricFont";
import type { LyricLineMouseEvent } from "@applemusic-like-lyrics/core";

const player = usePlayerStore();
const settings = useSettingsStore();

const hostRef = ref<HTMLDivElement | null>(null);

function t(key: string) {
  return translate(settings.lang, key);
}

/** 无歌词时的空态（与自研视图一致，两套引擎的空态文案不能不一样） */
const hasLyrics = computed(() => player.lyrics.length > 0);

let lp: DomLyricPlayer | null = null;
let rafId = 0;
let lastTs = 0;

/** 上一帧推送的毫秒时间戳，用于只在进度真的变化时同步（推送比逐帧便宜） */
let lastPushedMs = Number.NaN;

/** AMLL 行下标 → 项目歌词下标（点击跳转要用，见适配器的 indexMap 说明） */
let lineIndexMap: number[] = [];

function applySettings(): void {
  if (!lp) return;
  lp.setEnableSpring(settings.amllEnableSpring);
  lp.setEnableScale(settings.amllEnableScale);
  lp.setEnableBlur(settings.lyricBlur);
  lp.setHidePassedLines(settings.amllHidePassedLines);
  lp.setWordFadeWidth(settings.amllWordFadeWidth);
  lp.setAlignPosition(settings.amllAlignPosition);
  // 字体 / 字号：AMLL 以容器 computedStyle 的 font-size 为基准，直接写宿主样式即可
  const el = lp.getElement();
  el.style.fontSize = settings.lyricFontSize + "px";
  el.style.fontFamily = lyricFontFamily(settings.lyricFont);
  // 副行（翻译 / 音译）字号：AMLL 写死 0.5em，这里把它换算成绝对 em 交给下面的 :deep 规则
  el.style.setProperty(
    "--amll-sub-line-size",
    `${((settings.lyricTranslationSize / 100) * 0.5).toFixed(3)}em`,
  );
  // 和声行 AMLL 提供了变量，直接跟随翻译字号
  el.style.setProperty(
    "--amll-lp-bg-line-scale",
    ((settings.lyricTranslationSize / 100) * 0.7).toFixed(3),
  );
}

function feedLyrics(): void {
  if (!lp) return;
  const bundle = toAmllLyricBundle(player.lyrics, {
    wordLevel: settings.wordLyrics,
    subMode: settings.lyricSubMode,
  });
  lineIndexMap = bundle.indexMap;
  // 以当前播放位置为初始时间，避免换歌瞬间从 0 开始重排
  const initialMs = Math.max(0, (player.audioEl?.currentTime ?? player.currentTime) * 1000);
  lp.setLyricLines(bundle.lines, initialMs);
  lp.update(0);
  // 记下已推送的进度：setLyricLines 已经把时间对齐到 initialMs，
  // 下一帧就只推真实增量。**不能置成 NaN** —— NaN 会让下面的差值判断恒为 false，
  // 于是换歌之后再也不会推送进度（歌词永远停在 initialMs）。
  lastPushedMs = initialMs;
}

function rafLoop(ts: number): void {
  rafId = requestAnimationFrame(rafLoop);
  const delta = lastTs ? Math.min(ts - lastTs, 100) : 0;
  lastTs = ts;
  if (!lp) return;

  const mediaTime = player.audioEl?.currentTime ?? player.currentTime;
  const ms = Math.max(0, mediaTime * 1000);
  // 暂停时进度不变，但仍要推进 update：弹簧与间奏点动画需要收敛
  if (Math.abs(ms - lastPushedMs) >= 1) {
    lastPushedMs = ms;
    lp.setCurrentTime(ms);
  }
  lp.update(delta);
}

// ---- 事件 ----

/**
 * 点击歌词行跳转（与自研视图一致的行为）。
 *
 * 必须监听 AMLL 自定义的 \`line-click\` 而不是原生 click：原生事件不带行信息，
 * AMLL 会把它包装成 \`LyricLineMouseEvent\` 再以 \`line-\${type}\` 的名字派发（见其
 * DomLyricPlayer.onMouseEventHandler）。监听原生 click 的话 lineIndex 恒为 undefined。
 */
function onLineClick(evt: Event): void {
  const e = evt as LyricLineMouseEvent;
  // AMLL 的行下标要映射回项目下标（中间丢掉了间奏三点行、插入了和声行）
  const index = lineIndexMap[e.lineIndex];
  if (index === undefined) return;
  player.seekToLyric(index);
}

onMounted(() => {
  const host = hostRef.value;
  if (!host) return;

  lp = new DomLyricPlayer();
  const el = lp.getElement();
  el.style.width = "100%";
  el.style.height = "100%";
  host.appendChild(el);

  // 遮蔽在 store 里已做，这里关掉 AMLL 自己的，避免二次遮蔽
  lp.setLyricProcessConfig({ maskMode: MaskObsceneWordsMode.Disabled });
  applySettings();
  feedLyrics();
  // 自定义事件类型（AMLL 包装后的行级事件），不是原生 click
  el.addEventListener("line-click", onLineClick);

  // 播放状态必须初始同步：AMLL 用它推导「进度该推进多少」，漏了会把正常播放
  // 当成持续跳转（弹簧一直处于慢速档，切行发飘）。watch 只在变化时触发，开场要自己补。
  if (player.playing) lp.resume();
  else lp.pause();

  rafId = requestAnimationFrame(rafLoop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (lp) {
    lp.getElement().removeEventListener("line-click", onLineClick);
    lp.dispose();
    lp = null;
  }
});

// 换歌 / 歌词更新：重灌数据
watch(
  () => player.lyrics,
  () => {
    if (!lp) return;
    // 换歌瞬间按当前位置重建，避免新歌词按旧进度排一次出现闪动
    feedLyrics();
  },
);

// 播放 / 暂停：AMLL 需要知道播放状态才能正确推导跳转与暂停间奏动画
watch(
  () => player.playing,
  (playing) => {
    if (!lp) return;
    if (playing) lp.resume();
    else lp.pause();
  },
);

// 动效相关设置：直接透传给 AMLL
watch(
  () => [
    settings.amllEnableSpring,
    settings.amllEnableScale,
    settings.lyricBlur,
    settings.amllHidePassedLines,
    settings.amllWordFadeWidth,
    settings.amllAlignPosition,
    settings.lyricFontSize,
    settings.lyricFont,
    settings.lyricTranslationSize,
  ],
  () => applySettings(),
);

// 逐字开关 / 翻译音译切换都会改变灌进去的数据结构，需要重灌
watch(
  () => [settings.wordLyrics, settings.lyricSubMode],
  () => {
    if (lp) feedLyrics();
  },
);
</script>

<template>
  <!-- 外层负责定位与空态；内层 ref 只交给 AMLL，避免 Vue 与 AMLL 抢同一个容器的子节点 -->
  <div class="amll-lyrics-host">
    <div ref="hostRef" class="amll-lyrics-inner"></div>

    <div v-if="!hasLyrics" class="empty-lyrics">
      <span class="material-symbols-outlined">lyrics</span>
      <p>{{ t("player.noLyrics") }}</p>
      <p class="sub">{{ t("player.lyricsHint") }}</p>
    </div>
  </div>
</template>

<style scoped>
/*
 * AMLL 自己负责内部排版与滚动，这里只需要一个确定高度的定位容器。
 * 字体颜色等由 AMLL 的 .amll-lyric-player 样式控制（--amll-lp-color 默认白色）。
 */
.amll-lyrics-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: 2;
  color: #fff;
}

/* AMLL 需要确定高度的容器（它自己用 ResizeObserver 量），这里铺满外层 */
.amll-lyrics-inner {
  width: 100%;
  height: 100%;
}

/* 空态：与 LyricsView 保持一致的视觉语言 */
.empty-lyrics {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  pointer-events: none;
}
.empty-lyrics .material-symbols-outlined {
  font-size: 48px;
  opacity: 0.5;
  margin-bottom: 12px;
}
.empty-lyrics .sub {
  font-size: 13px;
  margin-top: 8px;
  opacity: 0.7;
}

/*
 * AMLL 把副行（翻译 / 音译）字号写死成 max(.5em, 10px)。这里用属性选择器而不是
 * 具体的模块哈希类名（`FmKaba_lyricSubLine` 这类名字会随 AMLL 版本变化），
 * 只覆盖字号，其余排版仍交给 AMLL。
 */
.amll-lyrics-inner :deep([class*="lyricSubLine"]) {
  font-size: max(var(--amll-sub-line-size, 0.5em), 10px);
}
</style>
