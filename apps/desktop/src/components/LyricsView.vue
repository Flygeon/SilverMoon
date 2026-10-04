<script setup lang="ts">
/**
 * 歌词视图 —— 每行绝对定位 + 两套**可切换的换行动效**（设置项 `lyricLineMotion`）。
 *
 * - `spring`（新版，默认）：对齐 AMLL —— 位移与缩放各一条弹簧逐帧积分；
 * - `legacy`（旧版）：AMLL 改造之前的实现 —— 每行独立 CSS transition + setTimeout 级联。
 *
 * 两套方案只差「换行时整摞歌词怎么走」：逐字填充、逐字上浮（WAAPI）、AMLL 歌词解析与
 * 特殊标记渲染（注音 / 和声 / 对唱 / 间奏三点）在两种方案下完全一致。
 *
 * 关键点（勿改为容器滚动）：
 * - 每行绝对定位，靠各自的 translateY 位移，而不是滚动容器。容器 scrollTo 只能整体
 *   平移，做不出 Apple Music 里「每行独立缓动 + 逐行错开」的波浪感。
 * - 位移量按行实际 offsetHeight 累加，因此双语歌词、不同字号都能精确对齐。
 * - 切行时按与当前行的距离错开启动，形成级联。
 *
 * 对齐 AMLL 的两处模型：
 * 1. **上浮交给 Web Animations API**（AMLL 的 createFloatAnimation）。逐帧读播放位置、
 *    再把进度写进 CSS 变量那条路会有台阶感：播放位置的推进粒度不等于帧率，且每帧写一个
 *    参与 transform 的未注册自定义属性要走主线程样式重算。交给 WAAPI 后由动画时间轴
 *    采样，位移连续，也不再逐帧占主线程。
 * 2. **失去焦点（读完后缩小 + 上移）由两条弹簧补间**（AMLL LyricLineGroup 的 posY 与
 *    LyricLineEl 的 scale）。布局层只负责算目标值：已读完的行 top 更靠上、scale 更小，
 *    补间交给弹簧逐帧积分，因此不会一次性跳变。
 *
 * 其他：行高 / 模糊 / 透明度都缓存，样式只在数值真的变化时写；模糊加上限并跳过视口外的
 * 行；逐字填充复用已缓存的词元素；支持对唱右对齐（line.duet）与背景和声子行（line.bg）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";
import { lyricFontFamily } from "@/utils/lyricFont";
import { getPosYSpringPolicy, Spring } from "@/utils/spring";
import { floatAnimationSpec } from "@/utils/wordFloat";
import {
  cascadeDelaySec,
  legacyCascadeDelayMs,
  legacyLineBlur,
  lineOffset,
  lyricLineBlur,
  lyricLineScale,
  LYRIC_SCALE_FOCUS,
  SCALE_SPRING_PARAMS,
  SCALE_SPRING_PARAMS_BG,
} from "@/utils/lyricFocus";
import { SeekDetector } from "@/utils/seekDetector";
import type { LyricLine, WordUnit } from "@shared/types";

const player = usePlayerStore();
const settings = useSettingsStore();

/** 副行文本：按设置的模式取翻译或罗马音；none 表示只显示原文 */
function subText(line: LyricLine): string {
  if (settings.lyricSubMode === "none") return "";
  return settings.lyricSubMode === "translation" ? (line.translation ?? "") : (line.romaji ?? "");
}

const containerRef = ref<HTMLDivElement | null>(null);
const lineRefs = ref<HTMLDivElement[]>([]);

/** 歌词字体栈（两套引擎共用，见 utils/lyricFont.ts） */
const lyricFont = computed(() => lyricFontFamily(settings.lyricFont));

/**
 * 当前行停靠高度。参考用 innerHeight/3.5；这里按容器高度计算以适应分栏布局。
 * 用 2.6 而非 3.5：整块歌词区在右栏偏上，除以 3.5 会把当前行顶到接近顶部。
 */
const lyricsOffset = () => (containerRef.value ? containerRef.value.clientHeight / 2.6 : 240);

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

// ---- 每行的运行时状态（位移弹簧 + 缩放弹簧 + 级联延迟）----

interface RowRuntime {
  /** 纵向位移弹簧（px） */
  spring: Spring;
  /** 缩放弹簧（百分比，100 = 原大小） */
  scale: Spring;
  /** 背景和声子行的缩放弹簧：和声行比主行收得更小（AMLL 的 bgScale = 75） */
  bgScale: Spring;
  /** 级联启动剩余延迟（秒）：>0 时先停在原处，到点再设目标 */
  delay: number;
  /** 待应用的目标位移 */
  target: number;
  /** 待应用的目标缩放 */
  scaleTarget: number;
  /** 待应用的和声行目标缩放 */
  bgScaleTarget: number;
  /** 是否已设过目标（首帧要直接就位） */
  primed: boolean;
}

let rows: RowRuntime[] = [];
/** 缓存的行高（px）：只在 dirty 时重测，避免每帧读 offsetHeight 触发重排 */
let heights: number[] = [];
let heightsDirty = true;
/**
 * 缓存每行的主歌词 / 和声子行元素。
 *
 * 缩放要分别作用在**各自的行元素**上（AMLL 里主行与和声行各有一个 scale 弹簧），
 * 而不是缩外层容器：外层同时还装着另一条行，缩外层会把两条行一起缩。
 * 主行块（.lyric-main）连同它的翻译 / 音译一起缩，和声行（.lyric-bg）单独缩。
 * 逐帧 querySelectorAll 太贵，所以在测行高时顺带取一次。
 */
let mainRefs: (HTMLElement | null)[] = [];
let bgRefs: HTMLElement[][] = [];

/**
 * 缓存的位移（第 to 行相对当前行的目标位移）。
 *
 * 与 AMLL 一致：只有「行高 + 行距」的累加，**没有逐行的额外抬升**。焦点行前进时
 * 所有行的位移量相同，也就是整摞歌词刚性滚动——这正是「唱完往上走」的观感来源。
 *
 * 不要再给已读行加额外的上移量：那是**逐行累加**的，每切一行整摞就被多顶一截，
 * 越靠上的已读行累计越多，表现就是切行瞬间「突然往上一跳」。
 */
function getLayout(now: number, to: number): number {
  return lineOffset(to, now, heights, settings.lyricLineGap, lyricsOffset());
}

function measureHeights(): void {
  const n = player.lyrics.length;
  const next = new Array<number>(n);
  const nextText = new Array<HTMLElement | null>(n);
  const nextBg = new Array<HTMLElement[]>(n);
  for (let i = 0; i < n; i++) {
    const el = lineRefs.value[i];
    next[i] = el?.offsetHeight ?? 0;
    nextText[i] = el?.querySelector<HTMLElement>(".lyric-main") ?? null;
    nextBg[i] = el ? Array.from(el.querySelectorAll<HTMLElement>(".lyric-bg")) : [];
  }
  heights = next;
  mainRefs = nextText;
  bgRefs = nextBg;
  heightsDirty = false;
}

/** 保证 rows 与歌词行数对齐（新增的行直接就位，不响应历史位置） */
function syncRows(): void {
  const n = player.lyrics.length;
  if (rows.length > n) rows = rows.slice(0, n);
  while (rows.length < n) {
    const scale = new Spring(LYRIC_SCALE_FOCUS);
    scale.updateParams(SCALE_SPRING_PARAMS);
    const bgScale = new Spring(LYRIC_SCALE_FOCUS);
    bgScale.updateParams(SCALE_SPRING_PARAMS_BG);
    rows.push({
      spring: new Spring(0),
      scale,
      bgScale,
      delay: 0,
      target: 0,
      scaleTarget: LYRIC_SCALE_FOCUS,
      bgScaleTarget: LYRIC_SCALE_FOCUS,
      primed: false,
    });
  }
}

// ---- 逐字填充（渐变推进）----

/** 一个词元素与它对应的词数据（DOM 顺序与 units 顺序一致） */
interface WordEntry {
  el: HTMLElement;
  unit: WordUnit;
}

let activeWords: WordEntry[] = [];
let activeBgWords: WordEntry[] = [];
/** 缓存的填充进度，避免同值重复写样式 */
let lastFill = new WeakMap<HTMLElement, number>();

/** 当前行上浮动画（WAAPI）。换行 / 换歌时必须显式取消，否则会残留在被复用的元素上 */
let floatAnims: Animation[] = [];

function cancelFloatAnims(): void {
  for (const a of floatAnims) {
    try {
      a.cancel();
    } catch {
      // 元素已被移除时 cancel 可能抛错，忽略——动画本身已随元素消失
    }
  }
  floatAnims = [];
}

/**
 * 把上浮动画对齐到「相对行首」的当前进度。
 *
 * WAAPI 动画有自己的时间轴，**不会**跟着播放器 seek 走：拖进度条时若不对齐，
 * 词的浮起高度就与音频脱节（跳回去后词还停在浮满的位置）。所以跳转那一帧要重新
 * 设 currentTime；已越过终点的动画直接停在终点，不重播（否则会看到词弹回去再浮上来）。
 *
 * @param relativeMs 当前播放位置相对该行起点的毫秒数
 */
function resyncFloatAnims(relativeMs: number): void {
  for (const a of floatAnims) {
    const timing = a.effect?.getComputedTiming();
    const end = Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0);
    a.currentTime = Math.max(0, Math.min(relativeMs, end));
    if (!player.playing) {
      a.pause();
    } else if (relativeMs < end) {
      a.play();
    } else {
      a.pause();
    }
  }
}

/**
 * 取当前行的词元素，并为它们建立上浮动画。
 *
 * 上浮用 WAAPI 而不是逐帧写 CSS 变量：见文件头注释。时间轴用「相对行首的偏移」，
 * 与 AMLL 一致（每个词按自己相对行首的 delay 起步）。跳转 / 中途切行时把
 * `currentTime` 直接对齐到当前进度，避免动画从 0 重跑（那会看到词集体弹一下）。
 */
function syncActiveWords(): void {
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

  cancelFloatAnims();
  // 逐字歌词关闭时整行是纯文本，没有词元素可浮；间奏三点不参与上浮（AMLL 同此）
  if (!settings.wordLyrics || !line || line.instrumental) return;

  const mediaTime = player.audioEl?.currentTime ?? player.currentTime;
  const relativeMs = Math.max(0, (mediaTime - line.time) * 1000);
  const start = (entries: WordEntry[], isBg: boolean) => {
    for (const { el: wordEl, unit } of entries) {
      const spec = floatAnimationSpec(unit, line.time, isBg);
      const anim = wordEl.animate(spec.keyframes, spec.options);
      // 与 AMLL 相同：先暂停、对齐进度，再决定是否继续播（已唱完的就停在终点）
      anim.pause();
      anim.currentTime = relativeMs;
      if (player.playing && relativeMs < spec.timing.endMs) anim.play();
      floatAnims.push(anim);
    }
  };
  start(activeWords, false);
  // 和声行的上浮幅度是主行的两倍（AMLL 的 if (isBG) up *= 2）
  start(activeBgWords, true);
}

/**
 * 按播放位置推进逐字填充。
 *
 * 时间源必须是 audioEl.currentTime（实时播放位置），而不是 4Hz 的 currentTime ref
 * ——后者会让填充按 ~250ms 阶梯跳动，产生顿感。background-position-x = 100 - 填充%。
 *
 * 注意：**上浮不在这里做**，它已交给 WAAPI（见 syncActiveWords）。
 */
function updateWordFill(): void {
  if (!settings.wordLyrics) return;
  const idx = player.activeLine;
  const line = player.lyrics[idx];
  if (!line?.units?.length) return;
  const now = player.audioEl?.currentTime ?? player.currentTime;
  for (const { el, unit } of activeWords) {
    let pct = 0;
    if (now >= unit.end) pct = 100;
    else if (now > unit.start) pct = ((now - unit.start) / (unit.end - unit.start)) * 100;
    const rounded = Math.round(pct * 100) / 100;
    if (lastFill.get(el) !== rounded) {
      lastFill.set(el, rounded);
      el.style.backgroundPosition = (100 - rounded).toFixed(2) + "% 0";
    }
  }
  const bgUnits = line.bg?.units;
  if (!bgUnits?.length) return;
  for (const { el, unit } of activeBgWords) {
    let pct = 0;
    if (now >= unit.end) pct = 100;
    else if (now > unit.start) pct = ((now - unit.start) / (unit.end - unit.start)) * 100;
    const rounded = Math.round(pct * 100) / 100;
    if (lastFill.get(el) !== rounded) {
      lastFill.set(el, rounded);
      el.style.backgroundPosition = (100 - rounded).toFixed(2) + "% 0";
    }
  }
}

// ---- 主循环 ----

let rafId = 0;
let lastFrame = 0;
let lastActive = -2;
const seekDetector = new SeekDetector();

/**
 * 行是否处于视口内。
 *
 * 余量取容器高度的 40%（对齐 AMLL 的 motionBuffer = containerHeight * .4），而不是
 * 几十像素：opacity / 模糊都是**离散档位**，切换只靠 0.4s 过渡平滑。若判定边界贴着
 * 容器边缘，量变发生在可见区域内，就会看到半透明区里「一下子变糊/变暗」。把边界推远
 * 到屏幕外，档位切换就都发生在看不见的地方。
 */
function inViewport(y: number, h: number, containerH: number): boolean {
  const buffer = containerH * 0.4;
  return y + h >= -buffer && y <= containerH + buffer;
}

// ---- 旧版换行动效：CSS transition + setTimeout 级联 ----
//
// 下面是 AMLL 改造之前的实现，设置里选「旧版」时启用。位移公式与新版共用 lineOffset
// （两版都是「行高 + 行距」的前缀和），差别只在补间方式与档位规则：
//
// - 补间：新版由 rAF 里的弹簧逐帧积分；旧版把目标位移写成内联 transform，交给
//   .lyric-item 上的 CSS transition（0.7s cubic-bezier(.19,.11,0,1)）自己缓动；
// - 级联：旧版 `(n*70 - n*10) ms`，且超过 10 行直接同步归位（新版改成收敛级数）；
// - 模糊：旧版就是 `blur(距离)px`，没封顶、也不区分已读 / 未读。
//
// 逐字填充与逐字上浮不在这里，两套方案共用一个 rAF 循环。

/** 旧版级联的 setTimeout 句柄：每次重新布局都要清掉，否则上一轮的定时器会盖掉新位移 */
let legacyTimers: number[] = [];
/** 旧版：待应用的布局刷新（放在 rAF 里做，避免 watch 里连读 offsetHeight 触发重排） */
let legacyLayoutPending = false;
/** 旧版：本次布局是否带级联过渡（换歌 / 行高变化直接就位，不走过渡） */
let legacyAnimateNext = false;

function cancelLegacyLayout(): void {
  legacyLayoutPending = false;
  legacyAnimateNext = false;
  for (const id of legacyTimers) clearTimeout(id);
  legacyTimers = [];
}

/**
 * 旧版换行：每一行的目标位移直接写进内联 transform，由 CSS transition 补间。
 *
 * @param animate 是否带级联过渡：换行 = true；换歌 / 初始化 / 行高变化 = false
 */
function applyLegacyLayout(opts: { animate: boolean }): void {
  for (const id of legacyTimers) clearTimeout(id);
  legacyTimers = [];
  const lines = player.lyrics;
  if (!lines.length) return;
  if (heightsDirty) measureHeights();
  const active = player.activeLine >= 0 ? player.activeLine : 0;

  for (let i = 0; i < lines.length; i++) {
    const el = lineRefs.value[i];
    if (!el) continue;

    const distance = Math.abs(i - active);
    const filter = legacyLineBlur(i, active, settings.lyricBlur)
      ? "blur(" + distance + "px)"
      : "none";
    if (el.style.filter !== filter) el.style.filter = filter;
    const opacity = i === active ? "1" : String(Math.max(0.22, 1 - distance * 0.22));
    if (el.style.opacity !== opacity) el.style.opacity = opacity;

    // 旧版没有「失去焦点缩放」：元素按 index 复用，残留的内联 scale 必须清掉
    const textEl = mainRefs[i];
    if (textEl && textEl.style.transform) textEl.style.transform = "";
    for (const bgEl of bgRefs[i] ?? []) {
      if (bgEl.style.transform) bgEl.style.transform = "";
    }

    const target = getLayout(active, i);
    const transform = "translateY(" + target.toFixed(2) + "px)";
    const delay = opts.animate ? legacyCascadeDelayMs(i - active) : 0;
    if (delay <= 0) {
      if (el.style.transform !== transform) el.style.transform = transform;
    } else {
      legacyTimers.push(
        window.setTimeout(() => {
          el.style.transform = transform;
        }, delay),
      );
    }
  }
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
    // 当前行 DOM 结构会随 active 变化（整行文本 ↔ 逐词 span），需重新取词元素并重建上浮动画
    void nextTick(syncActiveWords);
  }
  if (heightsDirty) measureHeights();

  /*
   * 旧版动效只借用本循环的两件事：测行高、按播放位置推进逐字填充。
   * 换行的位移与明暗交给 .legacy-motion 下的 CSS transition 与 setTimeout 级联
   * （applyLegacyLayout），因此这里直接跳过整段弹簧逻辑。上浮仍由 WAAPI 驱动，
   * 与下面 syncActiveWords 共用，不受方案切换影响。
   */
  if (settings.lyricLineMotion === "legacy") {
    if (legacyLayoutPending) {
      legacyLayoutPending = false;
      applyLegacyLayout({ animate: legacyAnimateNext });
    }
    updateWordFill();
    return;
  }

  syncRows();

  const containerH = containerRef.value?.clientHeight ?? 0;
  const mediaTime = player.audioEl?.currentTime ?? player.currentTime;
  const seeking = seekDetector.detect(mediaTime, player.playing);
  const now = activeIdx >= 0 ? activeIdx : 0;

  /*
   * 位移弹簧的参数**整帧只算一次**，并且应用到所有行（对齐 AMLL 的 updateSpringParams：
   * 它按当前行与上一行的时间差取一次 policy，再 setLinePosYSpringParams 推给所有 group）。
   *
   * 不能逐行按各自的 interval 去算：那样每行的刚度/阻尼都不同，同一摞歌词会以不同速度
   * 追赶各自的目标，行与行之间被拉出形变，观感就是「一抖一抖」而不是整体平移。
   * 间奏同理——AMLL 用全局的 isInterludeActive，这里取当前行是不是间奏三点。
   */
  const activeLine = activeIdx >= 0 ? lines[activeIdx] : undefined;
  const prevLineTime = activeIdx > 0 ? lines[activeIdx - 1]?.time : undefined;
  const activeIntervalMs =
    activeLine && prevLineTime !== undefined ? (activeLine.time - prevLineTime) * 1000 : undefined;
  const posYPolicy = seeking
    ? getPosYSpringPolicy(true, !!activeLine?.instrumental)
    : getPosYSpringPolicy(false, !!activeLine?.instrumental, activeIntervalMs);

  // 跳转：WAAPI 动画不跟播放器时间轴走，必须显式把它们对齐到新进度，
  // 否则拖完进度条后词的浮起高度与音频脱节。
  if (seeking && floatAnims.length) {
    const line = activeIdx >= 0 ? lines[activeIdx] : undefined;
    if (line) resyncFloatAnims(Math.max(0, (mediaTime - line.time) * 1000));
  }

  for (let i = 0; i < lines.length; i++) {
    const row = rows[i];
    const el = lineRefs.value[i];
    if (!row || !el) continue;

    const target = getLayout(now, i);
    if (!row.primed) {
      // 首帧 / 换歌 / 初始化：位移与缩放都直接就位，不播过渡
      // （否则新歌会从上一首的缩放档位「长大」到目标值）
      row.spring.setPosition(target);
      const initScale = lyricLineScale(i === activeIdx, player.playing);
      row.scale.setPosition(initScale);
      row.scaleTarget = initScale;
      row.bgScale.setPosition(LYRIC_SCALE_FOCUS);
      row.bgScaleTarget = LYRIC_SCALE_FOCUS;
      row.primed = true;
      row.target = target;
      row.delay = 0;
    } else if (target !== row.target) {
      row.target = target;
      if (seeking) {
        // 跳转：不排队列，直接换慢速弹簧追过去
        row.delay = 0;
        row.spring.updateParams(posYPolicy);
        row.spring.setTargetPosition(target);
      } else {
        // 级联：下方行逐行错开启动，增量按 1/1.05 衰减，总延迟收敛（AMLL 同此）
        row.delay = cascadeDelaySec(i - activeIdx);
        row.spring.updateParams(posYPolicy);
      }
    }

    if (row.delay > 0) {
      row.delay -= dt;
    } else {
      row.spring.setTargetPosition(target);
    }
    row.spring.update(dt);

    // ---- 失去焦点：非当前行在播放中缩到 97%（AMLL 的 SCALE_ASPECT）----
    const isActive = i === activeIdx;
    const scaleTarget = lyricLineScale(isActive, player.playing);
    if (scaleTarget !== row.scaleTarget) {
      row.scaleTarget = scaleTarget;
      row.scale.setTargetPosition(scaleTarget);
    }
    row.scale.update(dt);
    const sc = row.scale.getCurrentPosition() / 100;

    const y = row.spring.getCurrentPosition();
    // 外层只负责位移：与 AMLL 的分工一致（LyricLineGroup 管 posY）。
    // 缩放放在各自的行元素上，主行与和声行因此互不影响。
    const transform = "translateY(" + y.toFixed(2) + "px)";
    if (el.style.transform !== transform) el.style.transform = transform;

    // 主行缩放（AMLL LyricLineEl 的 lineTransforms.scale）
    const textEl = mainRefs[i];
    if (textEl) {
      const textTransform = "scale(" + sc.toFixed(4) + ")";
      if (textEl.style.transform !== textTransform) textEl.style.transform = textTransform;
    }

    // 和声子行比主行收得更小（AMLL 的 bgScale = 75）
    const bgTarget = lyricLineScale(isActive, player.playing, true);
    if (bgTarget !== row.bgScaleTarget) {
      row.bgScaleTarget = bgTarget;
      row.bgScale.setTargetPosition(bgTarget);
    }
    row.bgScale.update(dt);
    const bgEls = bgRefs[i];
    if (bgEls?.length) {
      const bgTransform = "scale(" + (row.bgScale.getCurrentPosition() / 100).toFixed(4) + ")";
      for (const bgEl of bgEls) {
        if (bgEl.style.transform !== bgTransform) bgEl.style.transform = bgTransform;
      }
    }

    const distance = Math.abs(i - activeIdx);
    const visible = inViewport(y, heights[i] ?? 0, containerH);
    // 视口外的行不参与合成（AMLL 用的是 1e-4，几乎不可见但保留元素）
    const opacity = !visible ? 0 : i === activeIdx ? 1 : Math.max(0.22, 1 - distance * 0.22);
    if (el.style.opacity !== String(opacity)) el.style.opacity = String(opacity);

    // 模糊：与 AMLL 同样按行距分档，已读行比同距离的未读行再糊一档
    const blur = lyricLineBlur(i, activeIdx, visible, settings.lyricBlur);
    const filter = blur ? "blur(" + blur + "px)" : "none";
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
    cancelFloatAnims();
    cancelLegacyLayout();
    heightsDirty = true;
    seekDetector.reset();
    // v-for 按 index 复用元素，旧的内联 transform / 滤镜会残留一帧；先清掉再让 rAF 重写。
    await nextTick();
    for (const el of lineRefs.value) {
      if (!el) continue;
      // 换歌是「重新就位」而不是「过渡」：先压掉 opacity / filter 的过渡，否则新歌词
      // 会从上一首的明暗档位淡过来。压一帧后恢复（同原实现的 no-transition 手法）。
      el.classList.add("no-transition");
      // 旧版：transition 还兼管位移，同样要压一帧，否则新歌的第一屏会从上一首滑过来
      if (settings.lyricLineMotion === "legacy") el.classList.add("legacy-no-transition");
      el.style.transform = "";
      el.style.opacity = "";
      el.style.filter = "";
      // 行元素上的缩放也是内联样式，同样要清掉（元素按 index 复用）
      const textEl = el.querySelector<HTMLElement>(".lyric-main");
      if (textEl) textEl.style.transform = "";
      for (const bgEl of Array.from(el.querySelectorAll<HTMLElement>(".lyric-bg"))) {
        bgEl.style.transform = "";
      }
    }
    // 强制回流，让上面清空的样式先落地，再恢复过渡（否则会被合并成一次带动画的变更）
    void containerRef.value?.offsetHeight;
    requestAnimationFrame(() => {
      for (const el of lineRefs.value) {
        el?.classList.remove("no-transition");
        el?.classList.remove("legacy-no-transition");
      }
      // 内联样式清空后立刻按新歌的位置就位（旧版位移走 CSS 过渡，必须显式重写 transform）
      if (settings.lyricLineMotion === "legacy") {
        heightsDirty = true;
        legacyLayoutPending = true;
        legacyAnimateNext = false;
      }
    });
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
    // 行高 / 字号变了，旧版的位移目标也要重算（等价旧实现的 updateLayout(..., 0)）
    settings.lyricLineMotion,
  ],
  () => {
    heightsDirty = true;
    if (settings.lyricLineMotion === "legacy") {
      // 行高变化没有过渡可言，直接就位；换方案时同样直接就位
      legacyLayoutPending = true;
      legacyAnimateNext = false;
    }
    void nextTick(syncActiveWords);
  },
);

/**
 * 旧版动效：跟着当前行重新布局，并按与当前行的距离错开启动（旧实现的 activeLine watch）。
 *
 * 新版（spring）不需要这个 watch —— 弹簧在 rAF 里追目标值，切行天然平滑。
 */
watch(
  () => player.activeLine,
  () => {
    if (settings.lyricLineMotion !== "legacy") return;
    // 等 Vue 把当前行的 DOM 换好（整行文本 ↔ 逐词 span）再量高度，否则会量到旧结构
    void nextTick(() => {
      heightsDirty = true;
      legacyLayoutPending = true;
      legacyAnimateNext = true;
    });
  },
);

// 暂停 / 恢复：上浮动画必须跟着停，否则暂停后词会继续往上浮
watch(
  () => player.playing,
  (playing) => {
    for (const a of floatAnims) {
      if (!playing) {
        a.pause();
        continue;
      }
      const timing = a.effect?.getComputedTiming();
      const end = Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0);
      if (a.playState !== "finished" && Number(a.currentTime ?? 0) < end) a.play();
    }
  },
);

let ro: ResizeObserver | null = null;

onMounted(() => {
  heightsDirty = true;
  /*
   * 旧版：挂载时就排一次布局。
   *
   * 切 Tab 会把本组件销毁重建（PlayerView 用 v-if），而重建时 activeLine 往往已经是
   * 某一行了——activeLine 的 watch 只在「变化」时触发，不会补这一次，于是整摞歌词会
   * 停在 translateY(0) 全部叠在顶部。新版没有这个问题：rAF 里的 primed 标志会在首帧
   * 直接把弹簧放到目标位置。
   */
  if (settings.lyricLineMotion === "legacy") {
    legacyLayoutPending = true;
    legacyAnimateNext = false;
  }
  ro = new ResizeObserver(() => {
    invalidateHeights();
    // 旧版：容器尺寸变化要重排（旧实现的 ResizeObserver 也是直接就位）
    if (settings.lyricLineMotion === "legacy") {
      legacyLayoutPending = true;
      legacyAnimateNext = false;
    }
  });
  if (containerRef.value) ro.observe(containerRef.value);
  rafId = requestAnimationFrame(rafLoop);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  cancelAnimationFrame(rafId);
  cancelFloatAnims();
  cancelLegacyLayout();
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
            // 旧版换行动效：位移补间由 CSS transition 承担（新版由弹簧逐帧积分）
            'legacy-motion': settings.lyricLineMotion === 'legacy',
          },
          i === player.activeLine ? dotsClass(line) : '',
        ]"
        :style="{
          fontSize: settings.lyricFontSize + 'px',
          lineHeight: settings.lyricLineHeight,
          fontFamily: lyricFont,
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

        <!--
          主行（原文 + 副行）包成一块，缩放作用在整块上：
          与 AMLL 一致——它的 LyricLineEl 同时装着主行与翻译 / 音译，缩放时一起收，
          只缩原文会让翻译行看起来「没跟着动」。
        -->
        <div class="lyric-main">
          <p class="lyric-text">
            <template v-if="settings.wordLyrics && i === player.activeLine && line.units?.length">
              <span v-for="(u, wi) in line.units" :key="wi" class="word">{{ u.text }}</span>
            </template>
            <template v-else>{{ line.text }}</template>
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
  will-change: transform, filter, opacity;
  /*
   * 只给 opacity / filter 加过渡，**刻意不含 transform**：
   * - transform 由 rAF 里的两条弹簧（位移 + 缩放）逐帧积分，目标突变时速度是连续的，
   *   再加 CSS 过渡等于把两套缓动叠在一起（二阶滞回），反而拖后腿；
   * - opacity / filter 是**离散档位**（按与当前行的距离取值），切行瞬间所有可见行
   *   同时跳一档。没有过渡的话就是整屏一次硬切，正是「唱完切下一句很生硬」的来源。
   * 参数对齐 AMLL 的 .lyricLineWrapper（opacity / filter 各 0.4s ease）。
   */
  transition:
    opacity 0.4s ease,
    filter 0.4s ease;
}

/* 换歌瞬间就位：不走过渡（与 transform 的弹簧无关，这里专治 opacity / filter） */
.lyric-item.no-transition {
  transition: none !important;
}

/*
 * 旧版换行动效（设置里选「旧版」时挂上）：位移同样交给 CSS 过渡，用的就是 AMLL 改造
 * 之前那条参考实现曲线。级联延迟（n*70 - n*10 ms，超过 10 行同步归位）在 JS 里用
 * setTimeout 错开（见 applyLegacyLayout），这里的过渡只负责每行自己的缓动。
 *
 * 新版（默认）刻意不含 transform：位移由弹簧逐帧积分，再加 CSS 过渡会把两套缓动叠起来。
 */
.lyric-item.legacy-motion {
  transition: all 0.7s cubic-bezier(0.19, 0.11, 0, 1);
}

/* 旧版换歌 / 初始化：位移与明暗都直接就位，避免从上一次的位置滑过来 */
.lyric-item.legacy-no-transition {
  transition: none !important;
}

/*
 * 旧版动效下没有「失去焦点缩放」：AMLL 改造之前非当前行不缩放。
 * JS 在 legacy 分支里会清掉残留的内联 scale，这里再加一道保险。
 */
.lyric-item.legacy-motion .lyric-main,
.lyric-item.legacy-motion .lyric-bg {
  transform: none;
}

.lyric-item.active {
  color: rgba(255, 255, 255, 1);
  /* 当前行：已唱纯白、未唱半透明 */
  --word-sung: #ffffff;
  --word-unsung: rgba(255, 255, 255, 0.35);
}

/* 对唱行：靠右对齐（AMLL 的 .lyricDuetLine）；缩放原点同样换到右侧 */
.lyric-item.duet {
  text-align: right;
}
.lyric-item.duet .lyric-main,
.lyric-item.duet .lyric-bg {
  transform-origin: right center;
}

/*
 * 主行块（原文 + 副行）：失去焦点的缩放作用在整块上（AMLL 的 LyricLineEl 同此），
 * 这样翻译行跟着原文一起收，不会看起来「没动」。
 * 原点默认左中；对唱行靠右对齐，原点必须跟着走，否则缩放会横向漂移。
 */
.lyric-main {
  transform-origin: left center;
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
  /* 和声行的缩放原点跟随主行：对唱行靠右时必须同侧，否则缩放会横向漂移 */
  transform-origin: left center;
}
.lyric-item.duet .lyric-bg {
  transform-origin: right center;
}
.lyric-item.active .lyric-bg {
  opacity: 0.55;
}

/* 逐字填充：Apple Music 式。
 * 固定结构渐变（sung→unsung 47%/53% 软边）+ 移动 background-position，
 * 比每帧改渐变 stop 更平滑省资源。非当前行整行纯文本渲染。
 *
 * 上浮不再由这里的 transform 承担：WAAPI 以 composite: add 叠加位移，
 * 因此这里**不要**再写 translateY，否则两处位移会叠加成双倍幅度。
 */
.word,
.bg-word {
  display: inline-block;
  white-space: pre; /* 保留英文词间空格（空格已并入词尾） */
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
 * 三点不参与上浮（AMLL 的 InterludeDots 只做缩放/呼吸，没有位移），
 * 所以 syncActiveWords 对 instrumental 行不建上浮动画。
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
/* 只动 opacity：.word 的 transform 已经被 scale(1.5) 占用，
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
