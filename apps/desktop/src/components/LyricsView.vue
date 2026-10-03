<script setup lang="ts">
/**
 * 歌词视图 —— 每行绝对定位 + **独立弹簧位移**（对齐 AMLL 的滚动模型）。
 *
 * 关键点（勿改为容器滚动）：
 * - 每行绝对定位，靠各自的 translateY 位移，而不是滚动容器。容器 scrollTo 只能整体
 *   平移，做不出 Apple Music 里「每行独立缓动 + 逐行错开」的波浪感。
 * - 位移量按行实际 offsetHeight 累加，因此双语歌词、不同字号都能精确对齐。
 * - 切行时按与当前行的距离错开启动，形成级联。
 *
 * 相对早先版本的改动（对齐 AMLL）：
 * - 位移由 CSS transition + setTimeout 级联改为**弹簧物理积分**：目标位置突变时速度
 *   连续，切行不会有一顿一顿的重启感；跳转 / 间奏自动切慢速档。
 * - 行高、模糊、透明度的计算都缓存，样式只在数值真的变化时写。
 * - 模糊加上限并跳过视口外的行，避免几十层高斯卷积。
 * - 逐字填充复用已缓存的词元素，不再每帧 querySelectorAll。
 * - 支持对唱右对齐（line.duet）与背景和声子行（line.bg）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore, type LyricFontKey } from "@/stores/settings";
import { translate } from "@shared/i18n";
import { getPosYSpringPolicy, Spring } from "@/utils/spring";
import { wordFloatOffsetEm } from "@/utils/wordFloat";
import { SeekDetector } from "@/utils/seekDetector";
import type { LyricLine, WordUnit } from "@shared/types";

const player = usePlayerStore();
const settings = useSettingsStore();

/** 副行文本：按设置的模式取翻译或罗马音（无则空串） */
function subText(line: LyricLine): string {
  return settings.lyricSubMode === "translation" ? (line.translation ?? "") : (line.romaji ?? "");
}

const containerRef = ref<HTMLDivElement | null>(null);
const lineRefs = ref<HTMLDivElement[]>([]);

/** 歌词字体栈（与阅读器字体一致） */
const LYRIC_FONTS: Record<LyricFontKey, string> = {
  system:
    '"SarasaGothicSC-Regular","SFPro-Regular","Helvetica Neue","Microsoft YaHei",system-ui,sans-serif',
  sans: '"Helvetica Neue","Microsoft YaHei","Hiragino Sans GB",sans-serif',
  serif: 'Georgia,"Songti SC","SimSun",serif',
  kai: '"KaiTi","STKaiti","Kai",cursive',
  yuan: '"Yuanti SC","YouYuan","Microsoft JhengHei UI",sans-serif',
};
const lyricFontFamily = computed(() => LYRIC_FONTS[settings.lyricFont] ?? LYRIC_FONTS.system);

/**
 * 当前行停靠高度。参考用 innerHeight/3.5；这里按容器高度计算以适应分栏布局。
 * 用 2.6 而非 3.5：整块歌词区在右栏偏上，除以 3.5 会把当前行顶到接近顶部。
 */
const lyricsOffset = () => (containerRef.value ? containerRef.value.clientHeight / 2.6 : 240);

/** 模糊上限（px）：对齐 AMLL 的 min(5, blur)，避免远行拖垮 GPU */
const MAX_BLUR = 5;
/** 超出此距离的行不再施加模糊（容器遮罩已经让它们不可见） */
const BLUR_DISTANCE_LIMIT = 6;

/** 间奏三点：主体时长低于此值（秒）不显示——进退场都放不下，会在屏幕上闪一下 */
const DOTS_MIN_DURATION = 0.91;
/** 三点进入「呼吸」模式的时长下限（秒），与 AMLL 的 3s 一致 */
const DOTS_BREATHE_DURATION = 3.0;

function t(key: string) {
  return translate(settings.lang, key);
}

function setLineRef(el: Element | null, index: number) {
  if (el) lineRefs.value[index] = el as HTMLDivElement;
}

// ---- 每行的运行时状态（弹簧 + 级联延迟 + 上一次写入的样式值）----

interface RowRuntime {
  spring: Spring;
  /** 级联启动剩余延迟（秒）：>0 时先停在原处，到点再设目标 */
  delay: number;
  /** 待应用的目标位移 */
  target: number;
  /** 是否已设过目标（首帧要直接就位） */
  primed: boolean;
}

let rows: RowRuntime[] = [];
/** 缓存的行高（px）：只在 dirty 时重测，避免每帧读 offsetHeight 触发重排 */
let heights: number[] = [];
let heightsDirty = true;

/** 缓存的位移（第 to 行相对当前行的目标位移） */
function getLayout(now: number, to: number): number {
  const lineGap = settings.lyricLineGap;
  let res = 0;
  if (to > now) {
    for (let i = now; i < to; i++) res += (heights[i] ?? 0) + lineGap;
  } else {
    for (let i = now; i > to; i--) res -= (heights[i - 1] ?? 0) + lineGap;
  }
  return res + lyricsOffset();
}

function measureHeights(): void {
  const n = player.lyrics.length;
  const next = new Array<number>(n);
  for (let i = 0; i < n; i++) next[i] = lineRefs.value[i]?.offsetHeight ?? 0;
  heights = next;
  heightsDirty = false;
}

/** 保证 rows 与歌词行数对齐（新增的行直接就位，不响应历史位置） */
function syncRows(): void {
  const n = player.lyrics.length;
  if (rows.length > n) rows = rows.slice(0, n);
  while (rows.length < n) {
    rows.push({ spring: new Spring(0), delay: 0, target: 0, primed: false });
  }
}

// ---- 逐字填充：缓存当前行的词元素，避免每帧 querySelectorAll ----

/** 一个词元素与它对应的词数据（DOM 顺序与 units 顺序一致） */
interface WordEntry {
  el: HTMLElement;
  unit: WordUnit;
}

let activeWords: WordEntry[] = [];
let activeBgWords: WordEntry[] = [];
/** 缓存的填充进度，避免同值重复写样式 */
let lastFill = new WeakMap<HTMLElement, number>();
/** 缓存的上浮位移（em），同理 */
let lastFloat = new WeakMap<HTMLElement, number>();

function refreshWordEls(): void {
  const idx = player.activeLine;
  const el = idx >= 0 ? lineRefs.value[idx] : null;
  const line = idx >= 0 ? player.lyrics[idx] : undefined;
  const build = (selector: string, units?: WordUnit[]): WordEntry[] => {
    if (!el || !units?.length) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(selector))
      .map((node, i) => ({ el: node, unit: units[i] }))
      .filter((e) => e.unit);
  };
  // .bg-word 不会命中 .word（类名逐 token 匹配），两者互不干扰
  activeWords = build(".word", line?.units);
  activeBgWords = build(".bg-word", line?.bg?.units);
}

/**
 * 按播放位置推进逐字填充。
 *
 * 时间源必须是 audioEl.currentTime（实时播放位置），而不是 4Hz 的 currentTime ref
 * ——后者会让填充按 ~250ms 阶梯跳动，产生顿感。background-position-x = 100 - 填充%。
 */
function updateWordFill(): void {
  if (!settings.wordLyrics) return;
  const idx = player.activeLine;
  const line = player.lyrics[idx];
  if (!line?.units?.length) return;
  const now = player.audioEl?.currentTime ?? player.currentTime;
  fillUnits(activeWords, now, false);
  // 和声行的上浮幅度是主行的两倍（AMLL 的 `if (isBG) up *= 2`）
  if (line.bg?.units?.length) fillUnits(activeBgWords, now, true);
}

function fillUnits(entries: WordEntry[], now: number, isBg: boolean): void {
  for (const { el, unit } of entries) {
    // ---- 逐字填充 ----
    let pct = 0;
    if (now >= unit.end) pct = 100;
    else if (now > unit.start) pct = ((now - unit.start) / (unit.end - unit.start)) * 100;
    const rounded = Math.round(pct * 100) / 100;
    if (lastFill.get(el) !== rounded) {
      lastFill.set(el, rounded);
      el.style.backgroundPosition = `${(100 - rounded).toFixed(2)}% 0`;
    }

    // ---- 主词上浮（对齐 AMLL createFloatAnimation）----
    const up = wordFloatOffsetEm(unit, now, isBg);
    const roundedUp = Math.round(up * 1000) / 1000;
    if (lastFloat.get(el) !== roundedUp) {
      lastFloat.set(el, roundedUp);
      el.style.setProperty("--word-float", `${roundedUp}em`);
    }
  }
}

// ---- 主循环 ----

let rafId = 0;
let lastFrame = 0;
let lastActive = -2;
const seekDetector = new SeekDetector();

/** 行是否处于视口内（含上下各留一行余量） */
function inViewport(y: number, h: number, containerH: number): boolean {
  return y + h >= -40 && y <= containerH + 40;
}

function rafLoop(ts: number): void {
  rafId = requestAnimationFrame(rafLoop);
  const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.1) : 0;
  lastFrame = ts;

  const lines = player.lyrics;
  const activeIdx = player.activeLine;
  if (activeIdx !== lastActive) {
    lastActive = activeIdx;
    heightsDirty = true;
    // 当前行 DOM 结构会随 active 变化（整行文本 ↔ 逐词 span），需重新取词元素
    void nextTick(refreshWordEls);
  }
  if (heightsDirty) measureHeights();
  syncRows();

  const containerH = containerRef.value?.clientHeight ?? 0;
  const mediaTime = player.audioEl?.currentTime ?? player.currentTime;
  const seeking = seekDetector.detect(mediaTime, player.playing);
  const now = activeIdx >= 0 ? activeIdx : 0;

  for (let i = 0; i < lines.length; i++) {
    const row = rows[i];
    const el = lineRefs.value[i];
    if (!row || !el) continue;
    const line = lines[i];

    const target = getLayout(now, i);
    if (!row.primed) {
      row.spring.setPosition(target);
      row.primed = true;
      row.target = target;
      row.delay = 0;
    } else if (target !== row.target) {
      row.target = target;
      if (seeking) {
        // 跳转：不排队列，直接换慢速弹簧追过去
        row.delay = 0;
        row.spring.updateParams(getPosYSpringPolicy(true, !!line.instrumental));
        row.spring.setTargetPosition(target);
      } else {
        // 级联：距离当前行越远启动越晚；超过 10 行直接同步，避免长尾
        let n = i - activeIdx + 1;
        if (n > 10) n = 0;
        row.delay = n > 0 ? n * 0.06 : 0;
        const prevIdx = lines[i - 1]?.time;
        const intervalMs = prevIdx !== undefined ? (line.time - prevIdx) * 1000 : undefined;
        row.spring.updateParams(getPosYSpringPolicy(false, !!line.instrumental, intervalMs));
      }
    }

    if (row.delay > 0) {
      row.delay -= dt;
    } else {
      row.spring.setTargetPosition(target);
    }
    row.spring.update(dt);

    const y = row.spring.getCurrentPosition();
    el.style.transform = `translateY(${y.toFixed(2)}px)`;

    const distance = Math.abs(i - activeIdx);
    const visible = inViewport(y, heights[i] ?? 0, containerH);
    // 视口外的行不参与合成（AMLL 用的是 1e-4，几乎不可见但保留元素）
    const opacity = !visible ? 0 : i === activeIdx ? 1 : Math.max(0.22, 1 - distance * 0.22);
    if (el.style.opacity !== String(opacity)) el.style.opacity = String(opacity);

    // 模糊：加到上限就停；焦点行 / 视口外 / 过远的行都不施加
    const blur =
      settings.lyricBlur && visible && i !== activeIdx && distance <= BLUR_DISTANCE_LIMIT
        ? Math.min(MAX_BLUR, distance)
        : 0;
    const filter = blur ? `blur(${blur}px)` : "none";
    if (el.style.filter !== filter) el.style.filter = filter;
  }

  updateWordFill();
}

// ---- 生命周期与失效 ----

/** 行高 / 位移目标失效，等下一帧重算 */
function invalidateHeights(): void {
  heightsDirty = true;
}

watch(
  () => player.lyrics,
  async () => {
    // 换歌：清空运行态，所有行下一帧直接就位（primed=false → setPosition），
    // 不会从 0 位一起飞入。
    rows = [];
    activeWords = [];
    activeBgWords = [];
    lastFill = new WeakMap<HTMLElement, number>();
    lastFloat = new WeakMap<HTMLElement, number>();
    heightsDirty = true;
    seekDetector.reset();
    // v-for 按 index 复用元素，旧的内联 transform / 滤镜会残留一帧；先清掉再让 rAF 重写。
    // 词上的 --word-float 同理：不清掉的话，新歌第一帧会沿用上一首的浮起高度。
    await nextTick();
    for (const el of lineRefs.value) {
      if (!el) continue;
      el.style.transform = "";
      el.style.opacity = "";
      el.style.filter = "";
      for (const w of Array.from(el.querySelectorAll<HTMLElement>(".word, .bg-word"))) {
        w.style.removeProperty("--word-float");
      }
    }
  },
);

watch(
  () => [
    settings.lyricFontSize,
    settings.lyricLineHeight,
    settings.lyricLineGap,
    settings.lyricTranslationSize,
    settings.lyricTranslationGap,
    settings.lyricSubMode,
    settings.wordLyrics,
  ],
  () => {
    heightsDirty = true;
    void nextTick(refreshWordEls);
  },
);

let ro: ResizeObserver | null = null;

onMounted(() => {
  heightsDirty = true;
  ro = new ResizeObserver(() => invalidateHeights());
  if (containerRef.value) ro.observe(containerRef.value);
  rafId = requestAnimationFrame(rafLoop);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  cancelAnimationFrame(rafId);
});

const hasLyrics = computed(() => player.lyrics.length > 0);

// ---- 间奏三点：分档 ----

/** 三点行的总时长（秒） */
function dotsDuration(line: LyricLine): number {
  const u = line.units;
  if (!u?.length) return 0;
  return u[u.length - 1].end - u[0].start;
}

/**
 * 三点行的呈现档位：
 * - `hidden`：时长太短（< 0.91s），进退场都放不下，不显示；
 * - `hold`：不够一个呼吸周期（< 3s），错峰淡入后常亮；
 * - `breathe`：完整呼吸循环。
 */
function dotsClass(line: LyricLine): string {
  if (!line.instrumental) return "";
  const d = dotsDuration(line);
  if (d < DOTS_MIN_DURATION) return "dots-hidden";
  return d < DOTS_BREATHE_DURATION ? "dots-hold" : "dots-breathe";
}

/** 和声子行是否排在主行之前（按首词时间判断，与 AMLL 的 isBgFirst 同口径） */
function bgFirst(line: LyricLine): boolean {
  const bgStart = line.bg?.units?.[0]?.start ?? line.time;
  const mainStart = line.units?.[0]?.start ?? line.time;
  return bgStart < mainStart;
}
</script>

<template>
  <div ref="containerRef" class="lyrics-container">
    <div class="lyrics">
      <div
        v-for="(line, i) in player.lyrics"
        :key="i"
        :ref="(el) => setLineRef(el as Element | null, i)"
        class="lyric-item"
        :class="[
          {
            active: i === player.activeLine,
            instrumental: line.instrumental,
            duet: line.duet,
          },
          i === player.activeLine ? dotsClass(line) : '',
        ]"
        :style="{
          fontSize: settings.lyricFontSize + 'px',
          lineHeight: settings.lyricLineHeight,
          fontFamily: lyricFontFamily,
        }"
        @click="player.seekToLyric(i)"
      >
        <!-- 背景和声子行：默认在主行下方；首词更早时排到上方（AMLL 的 isBgFirst） -->
        <p
          v-if="line.bg && bgFirst(line)"
          class="lyric-bg"
          :class="{ 'with-words': settings.wordLyrics && i === player.activeLine }"
        >
          <template v-if="settings.wordLyrics && i === player.activeLine && line.bg.units?.length">
            <span v-for="(u, wi) in line.bg.units" :key="wi" class="bg-word">{{ u.text }}</span>
          </template>
          <template v-else>{{ line.bg.text }}</template>
        </p>

        <p class="lyric-text" :class="{ pop: i === player.activeLine }">
          <template v-if="settings.wordLyrics && i === player.activeLine && line.units?.length">
            <span v-for="(u, wi) in line.units" :key="wi" class="word">{{ u.text }}</span>
          </template>
          <template v-else>{{ line.text }}</template>
        </p>

        <p
          v-if="line.bg && !bgFirst(line)"
          class="lyric-bg"
          :class="{ 'with-words': settings.wordLyrics && i === player.activeLine }"
        >
          <template v-if="settings.wordLyrics && i === player.activeLine && line.bg.units?.length">
            <span v-for="(u, wi) in line.bg.units" :key="wi" class="bg-word">{{ u.text }}</span>
          </template>
          <template v-else>{{ line.bg.text }}</template>
        </p>

        <p
          v-if="subText(line)"
          class="lyric-translation"
          :style="{
            fontSize: settings.lyricTranslationSize + '%',
            marginTop: settings.lyricTranslationGap + 'px',
          }"
        >
          {{ subText(line) }}
        </p>
      </div>
    </div>

    <div v-if="!hasLyrics" class="empty-lyrics">
      <span class="material-symbols-outlined">lyrics</span>
      <p>{{ t("player.noLyrics") }}</p>
      <p class="sub">{{ t("player.lyricsHint") }}</p>
    </div>
  </div>
</template>

<style scoped>
.lyrics-container {
  position: relative;
  height: 100%;
  overflow: hidden;
  z-index: 2;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    black 22%,
    black 74%,
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, transparent 0%, black 22%, black 74%, transparent 100%);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}

.lyrics {
  position: relative;
  max-width: 100%;
}

.lyric-item {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  padding: 0 25px;
  box-sizing: border-box;
  color: rgba(255, 255, 255, 0.2);
  /* 逐字填充色：非当前行两者同色（无填充效果，整行暗） */
  --word-sung: rgba(255, 255, 255, 0.2);
  --word-unsung: rgba(255, 255, 255, 0.2);
  font-weight: bold;
  letter-spacing: 0.6px;
  cursor: pointer;
  transform-origin: left center;
  will-change: transform, filter, opacity;
}

.lyric-item.active {
  color: rgba(255, 255, 255, 1);
  /* 当前行：已唱纯白、未唱半透明 */
  --word-sung: #ffffff;
  --word-unsung: rgba(255, 255, 255, 0.35);
}

/* 对唱行：靠右对齐（AMLL 的 .lyricDuetLine） */
.lyric-item.duet {
  text-align: right;
  transform-origin: right center;
}

.lyric-text {
  word-wrap: break-word;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.35);
}

/* 背景和声子行：更小、更暗，与主行形成层级（AMLL 的 .lyricBgLine） */
.lyric-bg {
  font-size: 0.7em;
  font-weight: 500;
  opacity: 0.4;
  letter-spacing: 0.4px;
  word-wrap: break-word;
}
.lyric-item.active .lyric-bg {
  opacity: 0.55;
}

/* 逐字填充：Apple Music 式。
 * 固定结构渐变（sung→unsung 47%/53% 软边）+ 移动 background-position，
 * 比每帧改渐变 stop 更平滑省资源。非当前行整行纯文本渲染。
 * 唱完的字 translateY 上浮并保持（不回弹），直到行结束随行重置。
 */
.word,
.bg-word {
  display: inline-block;
  white-space: pre; /* 保留英文词间空格（空格已并入词尾） */
  /*
   * 上浮位移由 JS 逐帧写入 --word-float，对齐 AMLL 的 createFloatAnimation：
   * 词一开始就起浮、到词末浮满（ease-out），结束时停在最大位移。
   * 刻意不加 transition —— 位移本身就是时间驱动的连续量，再加一层过渡
   * 等于做二阶滞回，会拖后腿并且与填充进度脱节。
   */
  transform: translateY(var(--word-float, 0em));
}
.lyric-item.active .word {
  color: transparent;
  background-image: linear-gradient(
    to right,
    var(--word-sung) 0%,
    var(--word-sung) 47%,
    var(--word-unsung) 53%,
    var(--word-unsung) 100%
  );
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position: 100% 0; /* 默认全暗；JS 每帧推进 */
  -webkit-background-clip: text;
  background-clip: text;
}
/* 和声子行沿用同一套填充，但用自己更暗的配色 */
.lyric-item.active .bg-word {
  color: transparent;
  background-image: linear-gradient(
    to right,
    var(--word-sung) 0%,
    var(--word-sung) 47%,
    var(--word-unsung) 53%,
    var(--word-unsung) 100%
  );
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  opacity: 0.55;
}
/*
 * 前奏/间奏三点：放大一点，不影响其他歌词尺寸（scale 不改布局）。
 * 三点的位移不参与上浮（AMLL 的 InterludeDots 只做缩放/呼吸，没有 translateY），
 * 所以这里不引用 --word-float，与上面 .word 的规则按选择器优先级并存。
 */
.lyric-item.active.instrumental .word {
  transform-origin: center;
  transform: scale(1.5);
  margin: 0 4px; /* 放大后相邻点不重叠 */
}

/*
 * 三点分档（对齐 AMLL 的 InterludeDots 状态机）：
 * - hidden：时长不足 0.91s，进退场都放不下，不显示；
 * - hold：不足 3s，错峰淡入后常亮；
 * - breathe：按 ~4s 周期做 1.25↔0.4 的呼吸缩放。
 * 入场先静默 500ms，给上一行上移留出视觉缓冲（AMLL 的 ENTER_HOLD_MS）。
 */
.lyric-item.instrumental .word {
  opacity: 0;
}
.lyric-item.active.dots-hidden .word {
  opacity: 0;
}
.lyric-item.active.dots-hold .word {
  animation: dots-enter 0.75s ease-out forwards;
}
.lyric-item.active.dots-breathe .word {
  animation:
    dots-enter 0.75s ease-out forwards,
    dots-breathe 4s ease-in-out 1.25s infinite;
}
.lyric-item.active.dots-hold .word:nth-child(2) {
  animation-delay: 0.58s;
}
.lyric-item.active.dots-hold .word:nth-child(3) {
  animation-delay: 0.66s;
}
.lyric-item.active.dots-breathe .word:nth-child(2) {
  animation-delay: 0.58s, 1.33s;
}
.lyric-item.active.dots-breathe .word:nth-child(3) {
  animation-delay: 0.66s, 1.41s;
}
/* 只动 opacity：.word 的 transform 已经被 scale(1.5) / sung 上浮占用，
 * 在动画里改 transform 会把三点的放大效果抹掉 */
@keyframes dots-enter {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 0.9;
  }
}
@keyframes dots-breathe {
  0%,
  100% {
    opacity: 0.9;
  }
  50% {
    opacity: 0.35;
  }
}

/* 行级入场弹簧：切到当前行时一次 scale 回弹（单次动画，不顿） */
.lyric-text.pop {
  transform-origin: left center;
  animation: lyric-pop 0.5s cubic-bezier(0.34, 1.2, 0.64, 1);
}
.lyric-item.duet .lyric-text.pop {
  transform-origin: right center;
}
@keyframes lyric-pop {
  from {
    transform: scale(0.97);
  }
  to {
    transform: scale(1);
  }
}

.lyric-translation {
  font-weight: 500;
  opacity: 0.72;
}

.empty-lyrics {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
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
</style>
