import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { toAssetUrl } from "@/ipc/invoke";
import { capabilities, isDesktop } from "@/capabilities";
import { useSettingsStore } from "@/stores/settings";
import { useNeteaseStore } from "@/stores/netease";
import { useAudioEffectsStore } from "@/stores/audioEffects";
// parseLrc 由 @/utils/lyricTimeline 提供（原先定义在本文件，已移出供歌词源复用）
import { META_RE, insertInterludeDots, parseLrc } from "@/utils/lyricTimeline";
import { resolveKugouUrl } from "@/utils/kugou";
import { lrcGet, lrcSet, needsProxiedCover, resolveCover } from "@/utils/onlineCache";
import {
  applyTagLyrics,
  cacheLyricsForSong,
  lyricsFromText,
  taggedLyricsForSong,
} from "@/utils/musicTagLyrics";
import { useMusicTagsStore } from "@/stores/musicTags";
import { useDesktopStore, WAKE_REASON } from "@/stores/desktop";
import { emitDesktopLyricsState } from "@/utils/desktopLyrics";
import {
  fetchCloudLyrics,
  normalizeTitle,
  prefetchCloudLyrics,
  type LyricSource,
  type LyricSourcePref,
  type QqFallbackReason,
} from "@/utils/preciseLyrics";
import { translate } from "@shared/i18n";
import { applyPreciseWordTimes, getPreciseWordTimes } from "@/utils/wordAnalysis";
import { getLoudness } from "@/utils/loudnessAnalysis";
import { loudnessGain } from "@/utils/loudness";
import { maskObsceneUnits } from "@/utils/obscene";
import { DualDeck } from "@/utils/dualDeck";
import { audioEffectEngine } from "@/utils/audioEffects";
import { planMix, type AutoMixSettings, type MixPlan } from "@/utils/autoMixEngine";
import {
  analyzeTrack,
  analysisKey,
  clearAnalysisCache,
  type AutoMixSource,
  type TrackAnalysis,
} from "@/utils/autoMixAnalysis";
import {
  clearEntries as clearMixLog,
  consumeForceMix,
  getEntries as getMixLog,
  requestForceMix,
  mixError,
  mixLog,
  mixWarn,
  setVerbose as setMixVerbose,
} from "@/utils/autoMixLog";
import type {
  LyricLine,
  MediaEntry,
  NowPlaying,
  OnlineSong,
  PlaySessionEnd,
  PlaySessionStart,
  QueueItem,
  Song,
  WebDavEntry,
} from "@shared/types";

/** 浏览器预览下没有 asset 协议，直接返回原路径避免抛错 */
function toMediaSrc(path: string): string {
  return isDesktop ? toAssetUrl(path) : path;
}

/** 只有 http(s) 封面才值得走「下载 → dataURL → IndexedDB 缓存」那条路 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// 双语 LRC 解析器已移至 utils/lyricTimeline.ts，此处转发保持对外 API
export { parseLrc };

export function decodeBuffer(buffer: ArrayBuffer): string {
  const encodings = ["utf-8", "gbk", "big5", "shift_jis"];
  for (const enc of encodings) {
    try {
      const decoder = new TextDecoder(enc, { fatal: true });
      return decoder.decode(new Uint8Array(buffer));
    } catch (e) {
      continue;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buffer));
}

/** 封面主色提取（4 象限均值采样，欧氏距离去重） */
export function getDominantColors(
  img: HTMLImageElement | ImageBitmap,
  colorCount = 4,
  minColorDistance = 60,
): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return ["rgba(128,128,128,0.8)"];
  canvas.width = 100;
  canvas.height = 100 * (img.height / img.width);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return ["rgba(128,128,128,0.8)"];
  }
  const { data, width, height } = imageData;
  const regionColors: number[][] = [];
  const dominant: number[][] = [];
  const hw = Math.floor(width / 2);
  const hh = Math.floor(height / 2);
  const step = 5;
  const regions = [
    { x1: 0, y1: 0, x2: hw, y2: hh },
    { x1: hw, y1: 0, x2: width, y2: hh },
    { x1: 0, y1: hh, x2: hw, y2: height },
    { x1: hw, y1: hh, x2: width, y2: height },
  ];
  regions.forEach((r) => {
    let tr = 0,
      tg = 0,
      tb = 0,
      count = 0;
    for (let y = r.y1; y < r.y2; y += step) {
      for (let x = r.x1; x < r.x2; x += step) {
        const i = (y * width + x) * 4;
        tr += data[i];
        tg += data[i + 1];
        tb += data[i + 2];
        count++;
      }
    }
    if (count > 0) {
      regionColors.push([Math.round(tr / count), Math.round(tg / count), Math.round(tb / count)]);
    }
  });
  regionColors.forEach(([r, g, b]) => {
    const unique = dominant.every(
      ([er, eg, eb]) =>
        Math.sqrt((r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2) >= minColorDistance,
    );
    if (unique) dominant.push([r, g, b]);
  });
  while (dominant.length < colorCount) {
    dominant.push(dominant[dominant.length % dominant.length] || [128, 128, 128]);
  }
  return dominant.map(([r, g, b]) => `rgba(${r},${g},${b},0.8)`);
}

export type RepeatMode = "off" | "all" | "one";

export const usePlayerStore = defineStore("player", () => {
  const song = ref<NowPlaying | null>(null);
  const playing = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const currentIndex = ref(0);
  /** 队列只存轻量条目（本地 MediaEntry / 在线 OnlineSong）；切歌时按需拉全量 */
  const queue = ref<QueueItem[]>([]);
  const loadingSong = ref(false);
  const lastError = ref<string | null>(null);
  const shuffleMode = ref(false);
  const repeatMode = ref<RepeatMode>("off");
  const shuffledIndices = ref<number[]>([]);

  // ── 听歌时长统计：会话状态（非响应式，timeupdate 高频读写不触发重渲染）──
  let sessionId: string | null = null;
  let sessionTrack: NowPlaying | null = null;
  let sessionStartedAt = 0;
  let sessionListenedMs = 0;
  let lastTickPos = 0;

  /** 结束当前会话并写入数据库 */
  function flushSession(completed: boolean) {
    if (!sessionId || !sessionTrack) return;
    const listenedMs = Math.max(0, Math.round(sessionListenedMs));
    const now = Date.now();
    const endedAt = now;
    // 计算实际完成度：用 positionRef 值（非响应式已同步）
    const pos = currentTime.value;
    const dur = duration.value || sessionTrack.durationMs || 0;
    const isCompleted = completed || (dur > 0 && (pos / dur >= 0.8 || listenedMs >= dur * 0.8));
    const payload: PlaySessionEnd = {
      id: sessionId,
      trackId: song.value?.id ?? sessionTrack.id,
      source: (sessionTrack.kind === "local"
        ? "local"
        : sessionTrack.kind === "online"
          ? "online"
          : "webdav") as "local" | "online" | "webdav",
      startedAt: sessionStartedAt,
      endedAt,
      listenedMs,
      completed: isCompleted,
      title: sessionTrack.title || null,
      artist: sessionTrack.artist || null,
      album: sessionTrack.album || null,
      filePath: ("filePath" in sessionTrack ? sessionTrack.filePath : null) || null,
      fileName: null,
      contentHash: null,
      coverUrl: sessionTrack.coverUrl || null,
      srcUrl: null,
      qualityBr: null,
    };
    void capabilities.endPlaySession(payload).catch(() => {});
    sessionId = null;
    sessionTrack = null;
    sessionListenedMs = 0;
    lastTickPos = 0;
  }

  /** 开始新播放会话 */
  function beginSession(track: NowPlaying) {
    // 先 flush 旧会话
    if (sessionId && sessionTrack) {
      const pos = currentTime.value;
      const dur = duration.value || sessionTrack.durationMs || 0;
      const isCompleted = dur > 0 && (pos / dur >= 0.8 || sessionListenedMs >= dur * 0.8);
      flushSession(isCompleted);
    }
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionId = id;
    sessionTrack = track;
    sessionStartedAt = Date.now();
    sessionListenedMs = 0;
    lastTickPos = 0;
    const payload: PlaySessionStart = {
      id,
      trackId: track.id,
      source: (track.kind === "local" ? "local" : track.kind === "online" ? "online" : "webdav") as
        "local" | "online" | "webdav",
      startedAt: sessionStartedAt,
      title: track.title || null,
      artist: track.artist || null,
      album: track.album || null,
      filePath: ("filePath" in track ? track.filePath : null) || null,
      fileName: null,
      contentHash: null,
      coverUrl: track.coverUrl || null,
      srcUrl: track.kind === "online" ? track.src : null,
      qualityBr: null,
    };
    void capabilities.startPlaySession(payload).catch(() => {});
  }

  function setIndex(i: number) {
    currentIndex.value = i;
  }

  const lyrics = ref<LyricLine[]>([]);
  /**
   * 未遮蔽的歌词原文。
   *
   * 遮蔽是有损的（原文被 `*` 替换后无法还原），所以必须留一份原始副本：
   * 用户中途切换遮蔽模式时要能重新派生，而不是在已遮蔽的文本上二次遮蔽。
   */
  const lyricsRaw = ref<LyricLine[]>([]);
  const activeLine = ref(-1);
  const coverColors = ref<string[]>([]);

  /**
   * 歌词的唯一写入口：写入原文，并按当前设置派生遮蔽后的展示文本。
   *
   * 遮蔽放在这里（渲染前）而不是组件里，原因见 utils/obscene.ts：遮蔽会改变字形宽度，
   * 在渲染时才换字会让逐字填充的行程与实测宽度错位。同时保证主歌词视图与桌面歌词
   * 窗口拿到的是同一份文本。
   */
  function setLyrics(lines: LyricLine[]): void {
    lyricsRaw.value = lines;
    let shown = lines;
    try {
      shown = maskObsceneUnits(lines, useSettingsStore().obsceneMask);
    } catch {
      // 设置未就绪（纯函数单测 / 启动早期）：保持原文，不影响播放
    }
    lyrics.value = shown;
    if (song.value) song.value.lyrics = shown;
  }

  /** 遮蔽模式变化：用原文重新派生（歌词不变时也会调） */
  function refreshObsceneMask(): void {
    if (!lyricsRaw.value.length) return;
    setLyrics(lyricsRaw.value);
  }

  // 遮蔽模式是展示层设置：改了要立刻用**原文**重算，不能在已遮蔽的文本上二次遮蔽。
  // settings store 在模块初始化时可能还没建好，所以 watch 放到 try 里。
  try {
    const st = useSettingsStore();
    watch(
      () => st.obsceneMask,
      () => refreshObsceneMask(),
    );
  } catch {
    // 无 Pinia 实例（纯函数单测）：跳过，遮蔽功能降级为不生效
  }

  /** Windows SMTC 状态推送节流：上次同步时间戳（毫秒） */
  let lastSmtcSync = 0;

  /**
   * 全局唯一的 audio 元素，由 store 持有而非某个组件。
   * PlayerView 会被路由销毁，若音频挂在它身上，返回列表页后
   * MiniPlayer 的控制会全部失效、播放也会中断。
   */
  const audioEl = ref<HTMLAudioElement | null>(null);

  /**
   * 给一个 audio 元素挂上全部状态同步监听。
   *
   * 抽成函数是为了 AutoMix 的「deck 提升」：过渡结束后，原来作为「下一曲」的
   * 那个元素会变成当前元素，必须给它挂上同一套监听，否则进度条/歌词/SMTC
   * 会全部停在旧元素上不动。
   */
  function bindElement(el: HTMLAudioElement): void {
    /**
     * 只有「当前 deck」才能驱动状态。
     *
     * AutoMix 过渡期间两个元素都在播，若不加这道闸，下一曲的 timeupdate 会把
     * 进度条/歌词拽到它的时间轴上，界面会来回跳。非当前元素的事件一律忽略。
     */
    const isActive = () => audioEl.value === el;
    el.addEventListener("timeupdate", () => {
      if (!isActive()) return;
      currentTime.value = el.currentTime;
      // 听歌时长累计：仅播放中且正向增量
      if (playing.value && el.currentTime > lastTickPos) {
        sessionListenedMs += (el.currentTime - lastTickPos) * 1000;
      }
      lastTickPos = el.currentTime;
      updateActiveLine();
      syncSmtc();
      syncDesktopLyrics();
      // AutoMix：快到曲末时预载并执行过渡
      maybeAutoMix();
    });
    el.addEventListener("loadedmetadata", () => {
      if (!isActive()) return;
      duration.value = el.duration;
      syncSmtc(true);
      // 元数据就绪后后台预载下一曲（分析 + 取源），这样过渡时不必等网络。
      // 用 void 不阻塞；失败会在 prepareNext 内部降级。
      void prepareNext();
    });
    el.addEventListener("play", () => {
      if (!isActive()) return;
      playing.value = true;
      useAudioEffectsStore().resume();
      syncSmtc(true);
      syncDesktopLyrics(true);
    });
    el.addEventListener("pause", () => {
      if (!isActive()) return;
      playing.value = false;
      useAudioEffectsStore().suspend();
      syncSmtc(true);
      syncDesktopLyrics(true);
    });
    el.addEventListener("seeked", () => {
      if (!isActive()) return;
      // seek 后更新 lastTickPos，避免下一步 timeupdate 误增
      lastTickPos = el.currentTime;
      syncSmtc(true);
    });
    el.addEventListener("ended", () => {
      if (!isActive()) return;
      /**
       * 过渡进行中：这次「自然播完」正是交叉淡化的收尾，切歌由 runMix 负责。
       *
       * ⚠️ 这道闸不能删，删了会**切歌后没声音**：
       * planMix 的 fadeOutAt = 曲长 − 过渡时长，过渡恰好收在曲尾，所以本事件
       * 必然与进行中的过渡撞上。此时若照常 next()，playFromQueue →
       * invalidatePrepared 会把**正在淡入的那个 deck** 的源清掉
       * （pause + removeAttribute("src") + load()），而 runMix 随后仍会把 audioEl
       * 提升到那个已经没源的 deck 上；提升时的 playFromQueue(skipStart) 又抑制了起播
       * → 结果就是「进度条跑完切下一首，直接没声音」。
       *
       * 与 maybeAutoMix 开头的 `if (mixing.value) return;` 是同一道闸，此处此前遗漏。
       */
      if (mixing.value) return;
      playing.value = false;
      // 听歌时长：标记完成
      flushSession(true);
      void next();
    });
    el.addEventListener("error", () => {
      if (!isActive()) return;
      playing.value = false;
      lastError.value = `无法播放：${song.value?.title ?? ""}`;
    });
  }

  /**
   * 把一个 audio 元素的**当前状态**同步进 store。
   *
   * 为什么必须有这个函数（deck 提升的关键一步）：
   * 新 deck 在「还不是当前元素」时就已加载完成并触发过 loadedmetadata，
   * 但那次事件被 isActive() 闸掉了（否则下一曲的进度会污染界面）；
   * 等它被提升为当前元素时，startPlayback 又被 skipStart 抑制，不会再设 src、
   * 也就不会有第二次 loadedmetadata。于是 duration 永远停在 0 ——
   * 界面上表现为剩余时间显示成 --1:0-26 这种负数。
   *
   * 所以提升后必须**主动**补一次同步，不能指望未来某个事件。
   */
  function syncFromElement(el: HTMLAudioElement): void {
    if (audioEl.value !== el) return;
    if (Number.isFinite(el.currentTime)) currentTime.value = el.currentTime;
    // duration 在元数据就绪前是 NaN；只在有效时写入，避免把好值覆盖成 NaN
    if (Number.isFinite(el.duration) && el.duration > 0) duration.value = el.duration;
    // playing 同理：新元素的 play/pause 事件都是在"还不是当前元素"时触发的，
    // 全被 isActive() 丢弃了，只能按元素当前的真实状态补一次。
    playing.value = !el.paused;
    lastTickPos = el.currentTime;
    // 立刻把纠正后的状态推给系统媒体控件与桌面歌词。
    // 它们本来也会在下一次 timeupdate（≤250ms）自愈，但过渡刚结束时
    // 封面/标题/进度会短暂显示上一首的信息，主动推一次更干净。
    syncSmtc(true);
    syncDesktopLyrics(true);
  }

  function ensureAudio(): HTMLAudioElement {
    if (audioEl.value) return audioEl.value;
    const el = new Audio();
    el.preload = "auto";
    bindElement(el);
    audioEl.value = el;
    useAudioEffectsStore().registerAudioElement(el);
    return el;
  }

  /** PlayerView 用它挂可视化，不再转移所有权 */
  function bindAudio(_el?: HTMLAudioElement) {
    ensureAudio();
  }

  function detachAudio() {
    // audio 由 store 持有，离开播放器页时无需做任何事
  }

  // ---------------------------------------------------------------- AutoMix（自动混音）

  /**
   * AutoMix 由双 deck 引擎 + 分析 + 过渡执行三部分组成。
   *
   * 关键点：不使用 AutoMix 时**完全不创建第二个 deck**，因此对现有播放零影响。
   */
  const mixDeck = ref<"a" | "b">("a");
  /** 最近一次过渡的决策（调试面板 / __automix.last() 展示） */
  const lastMixPlan = ref<MixPlan | null>(null);
  /** 过渡进行中 */
  const mixing = ref(false);
  /** 预分析状态，供 UI 显示 */
  const analysisStatus = ref<"idle" | "analyzing" | "ready" | "failed">("idle");

  let dualDeck: DualDeck | null = null;
  /** 已发起的预分析：key -> Promise，避免重复分析 */
  const analysisInflight = new Map<string, Promise<TrackAnalysis | null>>();
  /** 已准备的下一个 deck（预载完成，等待过渡）。 */
  let prepared: { index: number; analysis: TrackAnalysis | null; src: string } | null = null;
  /** 过渡是否已为本曲触发过（避免 timeupdate 反复触发） */
  let mixTriggeredFor: string | null = null;

  /**
   * 过渡世代号。
   *
   * 切歌/预载失效时自增，进行中的 runMix 据此**立即放弃**，而不是继续走完
   * 「淡出 → 淡入 → 提升 deck」。否则一旦淡入的那个 deck 的源被清掉
   * （invalidatePrepared 会这么做），提升它就会得到一个没有源的元素 → 没声音。
   *
   * 与 Rust 侧 anime.rs 的 RESOLVE_GEN 是同一个套路。
   */
  let mixGeneration = 0;
  /** 预载进行中（避免 timeupdate 反复触发 prepareNext） */
  let preparing: Promise<void> | null = null;
  /**
   * 为下一曲预载音频的那个元素（**不播放**，只让它把元数据 / 缓冲准备好）。
   *
   * 需要它是因为在线 / WebDAV 曲目本身不带时长，而预载歌词的匹配要求 ±1s 的时长 ——
   * 只能先把源挂上去、等 loadedmetadata。主元素此刻正放着当前曲，不能动；另一个 deck
   * 反正过渡时也要用同一个 src，顺手先挂上还省掉一次加载。
   */
  let preloadEl: HTMLAudioElement | null = null;

  /** 本次是否被 __automix.forceMix() 强制放行 */
  let forceAllowOnce = false;
  /** AutoMix 过渡交接期间，抑制 loadXxx 内部的 startPlayback */
  let suppressStart = false;

  function mixSettings(): AutoMixSettings {
    const s = useSettingsStore();
    return {
      enabled: s.autoMixEnabled,
      durationSec: s.autoMixDuration,
      beatMatch: s.autoMixBeatMatch,
      trimSilence: s.autoMixTrimSilence,
      maxRateDeviation: s.autoMixMaxRateDeviation / 100,
    };
  }

  /**
   * 执行一次过渡：把当前 deck 淡出、把下一曲 deck 淡入。
   *
   * 这是整个 AutoMix 唯一真正「出声」的地方。设计上：
   * - 失败一律退回直接切歌（next()），绝不让播放停住；
   * - 过渡结束后把「下一曲」提升为当前曲，会话/歌词/封面等状态照常更新。
   */
  async function runMix(): Promise<boolean> {
    const cfg = mixSettings();
    if (!prepared) {
      mixLog("没有预载的下一曲，跳过过渡");
      return false;
    }
    const el = audioEl.value;
    if (!el) return false;

    const item = queue.value[prepared.index];
    if (!item) return false;

    mixing.value = true;
    // 领一个世代号：过渡途中若有切歌/失效（invalidatePrepared 会自增），
    // 下面的检查会让我们放弃这次过渡（见 mixGeneration 的注释）。
    const myGen = ++mixGeneration;
    try {
      const cur = currentSource();
      const curDur = duration.value || (song.value?.durationMs ?? 0) / 1000;
      const curAnalysis = cur ? await analyze(cur.source, cur.id, curDur) : null;
      const plan = planMix(curDur, curAnalysis, prepared.analysis, el.currentTime, cfg);
      lastMixPlan.value = plan;
      mixLog("过渡方案已确定", plan);
      for (const r of plan.reasons) mixLog("  · " + r);

      const decks = ensureDualDeck();
      /**
       * currentDeck 是**正在播当前曲**的元素，永远等于 audioEl.value。
       *
       * 第一次过渡时它就是主 audio 元素；过渡结束后我们会把 audioEl 换成
       * 另一个元素（deck 提升），所以这里必须动态取，不能固定用 "a"。
       */
      const currentDeck = decks.deckFor(el) ?? decks.adopt(mixDeck.value, el);
      // 主元素在 ensureAudio 里已经挂过监听；标记一下，避免它以后
      // 作为「下一曲 deck」被提升时又 bindElement 一次（事件会翻倍）。
      if (currentDeck.el === el && audioEl.value === el) currentDeck.listenersBound = true;
      const oldEl = el;
      const to = decks.other(currentDeck.id);
      // 只有当前元素在音效链之外时才需要补挂（已在链上时 deckFor 已命中）
      decks.tryRoute(currentDeck);
      decks.tryRoute(to);
      decks.setGain(currentDeck, 1);
      decks.setGain(to, 0);

      /*
       * 预载下一曲并 seek 到跳过静音后的位置。
       *
       * src 没变就不重挂：歌词预载阶段已经把源挂到同一个元素上等过元数据，
       * 重新赋值 + load() 会白白丢掉已缓冲的数据（在线曲就是重新下一次）。
       * deck 提升之后元素被复用，源已经不同，走的仍是原来的重挂路径。
       */
      if (to.el.src !== prepared.src || to.el.readyState === 0) {
        to.el.src = prepared.src;
        to.el.load();
      }
      await new Promise<void>((resolve) => {
        const onReady = () => resolve();
        to.el.addEventListener("loadedmetadata", onReady, { once: true });
        // 3 秒拿不到元数据也别卡住，直接按原样开始
        setTimeout(resolve, 3000);
      });
      try {
        to.el.currentTime = plan.nextStartAt;
      } catch {
        /* 元数据未就绪时 seek 可能失败，忽略 */
      }
      if (plan.rate !== null) to.el.playbackRate = plan.rate;

      mixLog("开始播放下一曲 deck", { rate: plan.rate, startAt: plan.nextStartAt });
      await to.el.play().catch(() => {});

      // 等当前曲播到淡出点
      while (el.currentTime < plan.fadeOutAt - 0.05) {
        await new Promise((r) => setTimeout(r, 50));
        if (!mixing.value) break;
        if (myGen !== mixGeneration) break;
      }

      /*
       * 中断检查：必须在 crossfade **之前**。
       *
       * 走到这里说明过渡期间发生了切歌/预载失效 —— invalidatePrepared 已经把
       * 淡入 deck（to）的源清掉了。此时若继续 crossfade 并把 audioEl 提升到 to，
       * 就会得到一个「有增益、没源」的元素：界面在走、但完全没声音。
       *
       * 正确做法是放弃过渡并**把当前 deck 的增益恢复成 1**，让控制权干净地
       * 交回给正常切歌路径（runMix 的返回值调用方并不使用，兜底是 ended 事件）。
       */
      if (myGen !== mixGeneration) {
        decks.setGain(currentDeck, 1);
        decks.setGain(to, 0);
        mixWarn("过渡途中发生切歌/失效，放弃本次混音（已恢复当前 deck 增益）");
        return false;
      }

      await decks.crossfade(currentDeck, to, plan.durationSec * 1000);

      // ---- deck 提升：把「下一曲」变成当前曲 ----
      // 顺序很重要：先让 to 成为 audioEl，再暂停旧元素。
      // 反过来的话，旧元素的 pause 事件（此时它还是 active）会把 playing 置 false。
      const target = prepared.index;
      mixDeck.value = to.id;
      audioEl.value = to.el;
      // 旧元素停掉并断开源，避免它继续占用解码资源
      el.pause();
      oldEl.removeAttribute("src");
      oldEl.load();
      // 元素角色互换：原来「为下一曲预载」的元素成了当前元素，另一边（刚停下的）
      // 变成下一次为「新的下一曲」预载音频用的元素。不跟着换，下一次预载会被
      // primePreloadSource 的「正在播就不碰」判断挡掉。
      preloadEl = oldEl;
      decks.setGain(currentDeck, 0);
      decks.setGain(to, 1);
      // audio 元素换了，音效链的「主元素」登记也要跟着换，否则 resume/suspend 作用在旧元素上
      useAudioEffectsStore().registerAudioElement(to.el);

      // 补挂状态同步监听（只在第一次复用时挂，避免事件翻倍）
      if (!to.listenersBound) {
        to.listenersBound = true;
        bindElement(to.el);
      }

      // 把「下一曲」正式提升为当前曲：复用现有加载路径更新全部状态
      // （skipStart 让 loadXxx 内部的 startPlayback 不生效，因为 deck 已经在播）
      currentIndex.value = target;
      mixTriggeredFor = null;
      prepared = null;
      mixing.value = false;
      await playFromQueue(target, { skipStart: true });
      /*
       * 必须**排在 playFromQueue 之后**：loadXxx 内部会把 duration/currentTime
       * 清零（它是为"从零起播"设计的），而我们这里是"已经在播了"，
       * 所以要在它之后把新元素的真实值补回来。
       */
      syncFromElement(to.el);
      mixLog("过渡完成，当前曲已切换", {
        index: target,
        deck: to.id,
        duration: duration.value,
        currentTime: currentTime.value,
      });
      return true;
    } catch (e) {
      mixError("过渡失败，回退为直接切歌", e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      mixing.value = false;
      prepared = null;
      forceAllowOnce = false;
    }
  }

  /**
   * 由 timeupdate 驱动的检查：快到曲末时准备并执行过渡。
   *
   * 只在前瞻窗口内触发一次（mixTriggeredFor 去重），避免 timeupdate 每秒触发多次。
   */
  function maybeAutoMix(): void {
    const s = useSettingsStore();
    /*
     * 强制过渡标记只在「本来就该判断过渡」的时刻消费。
     *
     * 早先在函数入口就 consumeForceMix()：而 timeupdate 每秒触发多次，
     * 于是第一次进来就把标记吃掉了（哪怕当时离曲末还差几分钟），
     * 随后 forceAllowOnce 一直为真 —— 等于把 AutoMix 悄悄打开了。
     */
    if (mixing.value) return;
    if (!s.autoMixEnabled && !forceAllowOnce) {
      // 未启用时才去问「是否有强制请求」；有则本次放行
      if (!consumeForceMix()) return;
      forceAllowOnce = true;
      mixLog("收到强制过渡请求，本次放行");
    }
    if (!audioEl.value || queue.value.length === 0) return;
    if (repeatMode.value === "one") return;
    const dur = duration.value;
    if (!(dur > 0)) return;
    const cfg = mixSettings();
    // 前瞻窗口：过渡时长 + 2 秒余量（预载分析需要时间）
    const lead = cfg.durationSec + 2;
    const remain = dur - audioEl.value.currentTime;
    if (remain > lead) return;

    /*
     * 还没有预载好就先不标记「已触发」。
     *
     * 分析是异步的（本地曲要读文件+解码，在线曲还要下载），可能晚于窗口到达。
     * 若此时就置位 mixTriggeredFor，之后每次 timeupdate 都会被去重挡掉，
     * 结果这次过渡被静默跳过 —— 用户只看到一次硬切，日志里也看不出原因。
     * 所以只有在「已准备好」或「已经太晚、必须放弃」时才落标记。
     */
    const tooLate = remain < 0.5;
    if (!prepared && !tooLate) {
      // 还没准备好，但还有时间：催一次预载，下一帧再判断。
      // 不落 mixTriggeredFor，否则预载完成后就再也不会被触发了。
      void prepareNext();
      return;
    }

    const token = song.value?.id ?? "";
    if (mixTriggeredFor === token) return;
    mixTriggeredFor = token;
    if (!prepared) {
      mixLog("错过过渡窗口（预载未完成），本曲直接切换", { remain });
      return;
    }
    mixLog("进入过渡窗口", { remain, lead, hasPrepared: true });
    void runMix();
  }
  /**
   * 预载下一曲到另一个 deck。
   *
   * 这一步只「准备」不「播放」：设好 src、seek 到跳过静音后的位置、暂停着等待。
   * 提前载入是为了让过渡那一刻不需要等网络 —— 否则会听到「淡出结束但下一曲没声」。
   */
  async function prepareNext(): Promise<void> {
    // 去重：timeupdate 与 loadedmetadata 都可能触发，重复预载会重复分析
    if (preparing) return preparing;
    preparing = doPrepareNext().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function doPrepareNext(): Promise<void> {
    const s = useSettingsStore();
    // 注意：这里**不能** consumeForceMix()。强制过渡的标记由 maybeAutoMix 消费，
    // 并通过 forceAllowOnce 告知本次是否放行，否则预载阶段就把它吃掉、强制失效。
    if (!s.autoMixEnabled && !forceAllowOnce) return;
    if (queue.value.length === 0) return;
    const idx = nextQueueIndex();
    if (idx === null) return;
    const item = queue.value[idx];

    // 已经为这一曲准备过就不再重复
    if (prepared?.index === idx) return;

    const cur = currentSource();
    if (!cur) {
      mixWarn("当前曲没有可分析的音频源，跳过 AutoMix");
      return;
    }

    // 拉下一曲的播放地址（本地曲不需要联网）
    const src = await resolveQueueItemSrc(item);
    if (!src) {
      mixWarn("无法解析下一曲地址，跳过 AutoMix");
      return;
    }

    /*
     * 预载触发时机：loadedmetadata（换歌后）与 play（提前预载的下一曲 deck 开始出声）。
     * 后者会打断当前曲 —— 但 AutoMix 只监听「当前元素」的事件（见 bindElement 的
     * isActive 闸门），另一条 deck 的 loadedmetadata 根本不会走到这里，所以只有
     * 真正切换成当前曲时才会再进来一次。
     */
    primePreloadSource(src);

    // 并行分析：当前曲 + 下一曲 + 歌词（歌词那一路见 prefetchNextLyrics）
    const curDur = duration.value || (song.value?.durationMs ?? 0) / 1000;
    const [curAnalysis, nextAnalysis] = await Promise.all([
      analyze(cur.source, cur.id, curDur),
      analyzeNextItem(item, src),
      prefetchNextLyrics(item, src, preloadEl),
    ]);

    prepared = { index: idx, analysis: nextAnalysis, src };
    mixLog("下一曲已准备", {
      index: idx,
      rate: null,
      nextStartAt: nextAnalysis?.silenceStart ?? 0,
      curBpm: curAnalysis?.bpm ?? null,
      nextBpm: nextAnalysis?.bpm ?? null,
    });
  }

  /**
   * 预载「下一曲」的逐字歌词：把源与时长凑齐，交给 prefetchCloudLyrics 落缓存。
   *
   * 为什么值得做：预载发生在前瞻窗口（过渡时长 + 2s，默认 10s）之前，而且这边还要等
   * 音频元数据，实际有几十秒的余量。这段时间里把歌词的搜索 + 下载做掉，等真正切歌时
   * fetchCloudLyrics 直接命中缓存、`schedulePreciseQqLyrics` 瞬间换上官方逐字轴，
   * 而不是让用户听着一首没有歌词的歌等网络。
   *
   * 几条边界：
   * - 关闭「更精确的逐字歌词」时直接跳过（那份能力本来就不会被用上，别白花流量）；
   * - 时长只对**本地 / 在线**曲目必需且可取：本地取元数据，在线 / WebDAV 等预载元素
   *   报出元数据；拿不到时长就不预载（±1s 匹配没了会误配，宁可不做）；
   * - WebDAV 曲目除了云端回退链，播放时还会去拉同目录的 .lrc（localLyrics）——
   *   预载的元素那边会顺带把它塞进 IndexedDB，切过去时读缓存即可，不必再等一次网络；
   * - 失败不抛、不提示：预载只是加速，失败了下次取词照旧走完整回退链。
   */
  async function prefetchNextLyrics(
    item: QueueItem,
    src: string,
    el: HTMLAudioElement | null,
  ): Promise<void> {
    const s = useSettingsStore();
    if (!s.preciseLyrics) return;
    try {
      let meta: { id: string; title: string; artist: string; durationMs?: number } | null = null;
      if (isWebDav(item)) {
        const title = item.name.replace(/\.[^.]+$/, "");
        const lrcMs = await prefetchWebdavLyrics(item.path);
        meta = {
          id: `webdav:${item.path}`,
          title,
          artist: "WebDAV",
          durationMs: lrcMs ?? (await waitAudioDuration(3000, el)),
        };
      } else if (isOnline(item)) {
        meta = {
          id: item.id,
          title: item.name,
          artist: item.artist,
          // 在线列表自带时长（酷狗）就直接用，省掉一次元数据等待
          durationMs: item.durationMs ?? (await waitAudioDuration(3000, el)),
        };
      } else {
        const full = await capabilities.getSong(item.id);
        meta = {
          id: item.id,
          title: full.meta.title ?? full.file.name.replace(/\.[^.]+$/, ""),
          artist: full.meta.artist ?? "",
          durationMs: full.meta.durationMs ?? undefined,
        };
      }
      if (!meta.durationMs) {
        mixLog("下一曲歌词预载跳过（拿不到时长，无法做 ±1s 匹配）", { id: meta.id });
        return;
      }
      const prefKey = lyricPrefKey(meta);
      const pref = prefKey ? s.lyricSourcePrefs[prefKey] : undefined;
      // 与 schedulePreciseQqLyrics 同一套约束：未登录时 meting 偏好不再作为首选；
      // 「设置里关掉 AMLL」也要拦掉历史偏好，否则预载会白请求一个已关掉的来源。
      const neteaseLoggedIn = s.neteaseEnabled && useNeteaseStore().loggedIn;
      const metingMiss = pref === "meting" && !neteaseLoggedIn;
      const amllMiss = pref === "amll" && !s.amllLyricsEnabled;
      const effectivePref = metingMiss || amllMiss ? undefined : pref;
      if (effectivePref === "local") {
        mixLog("下一曲歌词预载跳过（用户偏好本地歌词）", { id: meta.id });
        return;
      }
      mixLog("开始预载下一曲歌词", { id: meta.id, title: meta.title, src });
      await prefetchCloudLyrics({
        title: meta.title,
        artist: meta.artist || undefined,
        durationMs: meta.durationMs,
        preferredSource: effectivePref,
        fallbackToMeting: neteaseLoggedIn,
        amllBase: s.amllLyricBase,
      });
    } catch (e) {
      mixWarn("下一曲歌词预载失败（不影响播放）", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * WebDAV 曲目的预载：把同目录同名 .lrc 拉下来写进 IndexedDB 缓存。
   *
   * 与 loadWebDavSong 里那段完全同源（包括只认 `[` 的判定），区别只是**不解析、不应用**：
   * 目标是让切过去时 lrcGet 直接命中，顺便把时长（最后一行时间，粗估）带回来。
   * 同一首歌只拉一次，重复预载直接被缓存挡掉。
   */
  async function prefetchWebdavLyrics(path: string): Promise<number | undefined> {
    const id = `webdav:${path}`;
    try {
      if ((await lrcGet(id)) !== null) return undefined;
      const lrcPath = path.replace(/\.[^.]+$/, "") + ".lrc";
      const res = await fetch(await capabilities.webdavMediaUrl(lrcPath));
      if (!res.ok) return undefined;
      const text = await res.text();
      if (!text.includes("[")) return undefined;
      void lrcSet(id, text);
      // 与 loadWebDavSong 的兜底同一个估法：最后一行时间 +1s
      let last = 0;
      for (const line of parseLrc(text, false)) last = Math.max(last, line.time);
      return last > 0 ? (last + 1) * 1000 : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 预载元素：**不播放**，只让它把「下一曲」的源挂上去、拿到元数据。
   *
   * 单独抽一个函数是为了让意图集中：`preloadEl.src === src` 时不重挂，避免把已经
   * 缓冲好的数据丢掉；已经切到这首（元素正在播）时不碰它，否则会把当前播放打断。
   */
  function primePreloadSource(src: string): void {
    const el = preloadEl;
    if (!el || el === audioEl.value || el.src === src) return;
    el.src = src;
    el.preload = "auto";
    el.load();
  }

  /** 队列条目的稳定标识（与分析缓存 key 一一对应）。 */
  function queueItemId(item: QueueItem): string {
    if (isWebDav(item)) return `webdav:${item.path}`;
    if (isOnline(item)) return item.id;
    return item.id;
  }

  /**
   * 解析队列条目的可播放地址（**不切换当前播放**）。
   *
   * 与 startPlayback 分离：预载只想知道 URL 与来源，不想动当前播放状态。
   * 三种来源各有各的取法，与 loadOnlineSong / loadWebDavSong 保持同一套语义。
   */
  async function resolveQueueItemSrc(item: QueueItem): Promise<string | null> {
    try {
      if (isWebDav(item)) {
        return await capabilities.webdavMediaUrl(item.path);
      }
      if (isOnline(item)) {
        // 酷狗的 url 可能为空、需要单独解析（与播放路径一致）
        if (item.url) return item.url;
        if (item.server === "kugou" && item.hash) {
          return (await resolveKugouUrl(item)) || null;
        }
        return null;
      }
      const full = await capabilities.getSong(item.id);
      return toMediaSrc(full.file.path);
    } catch (e) {
      mixWarn("解析下一曲地址失败", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /** 分析队列里的某个条目（需要先解析出可播放地址）。 */
  async function analyzeNextItem(item: QueueItem, src: string) {
    const id = queueItemId(item);
    if (isWebDav(item)) return analyze({ kind: "webdav", url: src }, id, 0);
    if (isOnline(item)) return analyze({ kind: "online", url: src }, id, 0);
    // 本地曲：src 是 asset:// URL，分析要的是磁盘路径
    const full = await capabilities
      .getSong(item.id)
      .then((s) => s.file.path)
      .catch(() => null);
    return analyze({ kind: "local", filePath: full ?? undefined }, id, 0);
  }

  /** 下一个要播的队列下标（考虑随机/循环）；没有则 null。 */
  function nextQueueIndex(): number | null {
    if (queue.value.length === 0) return null;
    if (repeatMode.value === "one") return null;
    if (shuffleMode.value) {
      const pos = shuffledIndices.value.indexOf(currentIndex.value);
      const nextPos = pos + 1;
      if (nextPos < shuffledIndices.value.length) return shuffledIndices.value[nextPos];
      return repeatMode.value === "all" ? (shuffledIndices.value[0] ?? null) : null;
    }
    const next = currentIndex.value + 1;
    if (next < queue.value.length) return next;
    return repeatMode.value === "all" ? 0 : null;
  }
  /** 惰性创建双 deck（只在 AutoMix 真正要用的那一刻）。 */
  function ensureDualDeck(): DualDeck {
    if (!dualDeck) {
      dualDeck = new DualDeck(audioEffectEngine, (msg, detail) => mixLog(msg, detail));
      // 预载歌词时用来读元数据的元素：就是过渡时会被淡入的那个 deck。
      // 在这里创建等价于「只在 AutoMix 真正投入使用时才多一个 audio 元素」，
      // 不用 AutoMix 的用户仍然只有一个元素（零回归面，与 DualDeck 的设计一致）。
      preloadEl = dualDeck.other(mixDeck.value).el;
    }
    return dualDeck;
  }

  /**
   * 把当前歌曲的音频源描述出来，供分析器使用。
   *
   * 本地曲给 filePath，在线曲给 url —— 与逐字歌词用的是同一套语义。
   */
  function currentSource(): { source: AutoMixSource; id: string } | null {
    const s = song.value;
    if (!s) return null;
    // NowPlaying 自带 kind 与两个来源字段，直接据此判断
    if (s.kind === "local") {
      return s.filePath ? { source: { kind: "local", filePath: s.filePath }, id: s.id } : null;
    }
    // 在线 / WebDAV 都用可播放 URL 直接拉取分析
    return s.src ? { source: { kind: s.kind, url: s.src }, id: s.id } : null;
  }

  /** 分析某首歌，带 inflight 去重。 */
  function analyze(source: AutoMixSource, id: string, durationSec: number) {
    const key = analysisKey(source, id);
    const existing = analysisInflight.get(key);
    if (existing) return existing;
    analysisStatus.value = "analyzing";
    mixLog("开始分析", { key, durationSec });
    const p = analyzeTrack(source, durationSec, key, (m, d) => mixLog(m, d))
      .then((r) => {
        analysisStatus.value = r ? "ready" : "failed";
        return r;
      })
      .finally(() => analysisInflight.delete(key));
    analysisInflight.set(key, p);
    return p;
  }
  const currentLyric = computed(() =>
    activeLine.value >= 0 ? lyrics.value[activeLine.value]?.text : "",
  );

  function updateActiveLine() {
    let idx = -1;
    for (let i = 0; i < lyrics.value.length; i++) {
      if (currentTime.value >= lyrics.value[i].time) idx = i;
      else break;
    }
    activeLine.value = idx;
  }

  /** 推送播放状态给 Windows 系统媒体控件；默认节流 500ms，关键节点用 force 立即同步 */
  function syncSmtc(force = false) {
    if (!isDesktop || !song.value) return;
    const now = Date.now();
    if (!force && now - lastSmtcSync < 500) return;
    lastSmtcSync = now;
    void capabilities
      .smtcSetPlayback({
        playing: playing.value,
        positionMs: Math.round(currentTime.value * 1000),
        durationMs: Math.round(duration.value * 1000),
      })
      .catch(() => {});
  }
  /** 推送歌词状态给桌面歌词窗口；默认节流 200ms，切歌等关键节点用 force 立即同步 */
  let lastDesktopLyricsSync = 0;
  function syncDesktopLyrics(force = false) {
    if (!isDesktop) return;
    const settings = useSettingsStore();
    if (!settings.desktopLyricsEnabled || !song.value) return;
    const now = Date.now();
    if (!force && now - lastDesktopLyricsSync < 200) return;
    lastDesktopLyricsSync = now;
    void emitDesktopLyricsState({
      lines: lyrics.value.map((l) => ({
        time: l.time,
        text: l.text,
        translation: l.translation,
        romaji: l.romaji,
        bg: l.bg?.text,
      })),
      currentTime: currentTime.value,
      playing: playing.value,
      title: song.value.title,
      artist: song.value.artist ?? "",
    }).catch(() => {});
  }

  watch([lyrics, song, playing], () => syncDesktopLyrics(true));

  function generateShuffleOrder() {
    const indices = Array.from({ length: queue.value.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    shuffledIndices.value = indices;
  }

  // ---- 队列项工具（本地 / 在线统一取展示字段）----

  function isOnline(item: QueueItem): item is OnlineSong {
    return "url" in item;
  }

  function isWebDav(item: QueueItem): item is WebDavEntry {
    return "isDir" in item;
  }

  function queueTitle(item: QueueItem): string {
    if (isOnline(item) || isWebDav(item)) return item.name;
    return item.title || item.name;
  }

  function queueArtist(item: QueueItem): string {
    if (isWebDav(item)) return "WebDAV";
    return isOnline(item) ? item.artist : item.artist || "未知艺术家";
  }

  function queueDuration(item: QueueItem): number | null {
    if (isOnline(item) || isWebDav(item)) return null;
    return item.durationMs ?? null;
  }

  /** 正在分析的歌曲 key，避免同一首重复分析 */
  const wordAnalysisInflight = new Set<string>();

  /**
   * 后台触发逐字精排（Phase 2）：有缓存直接应用；无缓存异步分析，完成后应用。
   * 不阻塞播放；失败静默降级为粗排。仅在开启「逐字歌词」时执行。
   */
  async function scheduleWordAnalysis(
    meta: {
      id: string;
      kind: "local" | "online" | "webdav";
      filePath?: string;
      url?: string;
    },
    lines: LyricLine[],
  ) {
    if (!useSettingsStore().wordLyrics) return;
    const key = `${meta.kind}:${meta.id}`;
    if (wordAnalysisInflight.has(key)) return;
    wordAnalysisInflight.add(key);
    try {
      const precise = await getPreciseWordTimes(
        { kind: meta.kind, filePath: meta.filePath, url: meta.url },
        lines,
        key,
      );
      // 防止分析完成时已切歌：当前歌曲仍是同一首才应用
      if (precise && song.value?.id === meta.id) {
        // 就地改写原文（lines 与 lyricsRaw 同引用），再重新派生一次展示文本：
        // 遮蔽生效时 lyrics 是另一份数组，不重派生就会留着旧的逐字时间轴。
        applyPreciseWordTimes(lines, precise);
        if (lyricsRaw.value === lines) setLyrics(lines);
      }
    } finally {
      wordAnalysisInflight.delete(key);
    }
  }

  /** 正在获取 QQ 官方逐字歌词的歌曲 key，避免同一首重复请求 */
  const qqLyricsInflight = new Set<string>();

  /**
   * 等待 audio 元素元数据就绪并返回时长（毫秒）；超时/不可用返回 undefined。
   *
   * @param el 缺省为当前播放元素。AutoMix 预载歌词时传的是**另一个 deck**：
   *   下一曲的元数据早就由预载阶段取到了，直接读它即可，不必等主元素换过去。
   */
  function waitAudioDuration(
    timeoutMs: number,
    el: HTMLAudioElement | null = audioEl.value,
  ): Promise<number | undefined> {
    return new Promise((resolve) => {
      if (!el) {
        resolve(undefined);
        return;
      }
      if (Number.isFinite(el.duration) && el.duration > 0) {
        resolve(el.duration * 1000);
        return;
      }
      // 成功与超时两条路径都必须摘掉监听：audio 是单例，只挂不摘会随调用次数
      // 线性累积（闭包还持有 resolve）。
      const onMeta = () => {
        cleanup();
        resolve(Number.isFinite(el.duration) ? el.duration * 1000 : undefined);
      };
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener("loadedmetadata", onMeta);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeoutMs);
      el.addEventListener("loadedmetadata", onMeta);
    });
  }

  /**
   * 歌词来源状态：仅当「更精确的逐字歌词」开启且当前歌曲完成一次尝试后才有值。
   * - "amll" / "qq" / "kg" / "meting"：已应用对应云端歌词；
   * - "local"：已回退本地歌词（原因见 lyricFallbackReason）。
   *
   * 类型直接取 LyricSourcePref，不再重复写一份字面量联合：回退链加一档来源时
   * 这里若漏改，TS 会在 switchLyricSource 的 Record 处报错，但徽标分支未必——
   * 复用同一个来源别名能把「加来源」这件事收敛到一处。
   */
  const lyricsSource = ref<LyricSourcePref | null>(null);
  /** 控制台日志里的来源名（Record 保证新增来源时必须补键，避免日志显示 undefined） */
  const LYRIC_SRC_LABEL: Record<LyricSource, string> = {
    amll: "AMLL",
    qq: "QQ",
    kg: "酷狗",
    meting: "Meting",
  };
  const lyricFallbackReason = ref<QqFallbackReason | null>(null);
  /** 回退的详细错误（徽标悬停展示，便于免 DevTools 排查） */
  const lyricFallbackDetail = ref<string | null>(null);

  /** 回退提示 toast（全局渲染在 App.vue），4s 自动消失 */
  const lyricNotice = ref("");
  let lyricNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  function showLyricNotice(message: string) {
    lyricNotice.value = message;
    if (lyricNoticeTimer) clearTimeout(lyricNoticeTimer);
    lyricNoticeTimer = setTimeout(() => (lyricNotice.value = ""), 4000);
  }

  /** 记录回退：更新来源徽标状态 + console.warn + 全局 toast 提示 */
  function completeFallback(reason: QqFallbackReason, detail?: string) {
    lyricsSource.value = "local";
    lyricFallbackReason.value = reason;
    lyricFallbackDetail.value = detail ?? null;
    console.warn(`[逐字歌词] 回退本地歌词：${reason}${detail ? `（${detail}）` : ""}`);
    const lang = useSettingsStore().lang;
    const reasonLabel = translate(lang, `player.lyricReason_${reason}`);
    showLyricNotice(`${translate(lang, "player.lyricFallbackToast")}（${reasonLabel}）`);
  }

  /** 当前歌曲的歌词获取上下文（手动切换来源时复用） */
  const lastLyricMeta = ref<{
    id: string;
    kind: "local" | "online" | "webdav";
    title: string;
    artist: string;
    durationMs?: number;
  } | null>(null);
  /** 当前歌曲的本地歌词（parseLrc 结果，切回本地/回退时使用） */
  const localLyrics = ref<LyricLine[]>([]);

  /** 来源偏好 key（与匹配缓存一致：归一化标题|时长ms） */
  function lyricPrefKey(meta: { title: string; durationMs?: number }): string | null {
    if (!meta.durationMs) return null;
    return `${normalizeTitle(meta.title)}|${Math.round(meta.durationMs)}`;
  }

  /** 应用云端歌词（含 META 行过滤）；返回是否应用成功 */
  function applyCloudLyrics(result: {
    lines: LyricLine[];
    source: LyricSource;
    songId: string;
    songTitle: string;
    wordLevel: boolean;
    fromCache: boolean;
  }): boolean {
    if (!song.value || !result.lines.length) return false;
    let applied = result.lines;
    const st = useSettingsStore();
    // 与 LRC 流程一致：开启「自动识别前奏/间奏」时隐藏作词/作曲等元数据行
    if (st.detectInstrumental) {
      const filtered = result.lines.filter((l) => !META_RE.test(l.text));
      if (filtered.length) applied = filtered;
      // 云端歌词只给真实歌词行，长前奏 / 长间奏 / 结尾器乐段会留下大片空白；
      // 本地 LRC 那条链路本来就有三点标记，这里补上同一套，免得两边表现不一致。
      applied = insertInterludeDots(applied, { tailEnd: (song.value.durationMs ?? 0) / 1000 });
    }
    setLyrics(applied);
    updateActiveLine();
    lyricsSource.value = result.source;
    lyricFallbackReason.value = null;
    lyricFallbackDetail.value = null;
    // 来源 → 日志标签：三元表达式在加第三、第四个来源时可读性会崩，改查表。
    // 取局部表而不是 utils 里的 SOURCE_LABEL：那份是匹配失败 detail 用的内部常量
    // （未导出），且这里是纯日志文案，不值得为此把 utils 的内部细节提升为公开接口。
    const srcLabel = LYRIC_SRC_LABEL[result.source];
    console.info(
      `[逐字歌词] 命中${srcLabel}：${result.songTitle}（${srcLabel} id=${result.songId}，${applied.length} 行，${result.wordLevel ? "含逐字时间轴" : "仅逐行"}，${result.fromCache ? "来自缓存" : "在线获取"}）`,
    );
    return true;
  }

  /**
   * 「更精确的逐字歌词」编排（回退链 AMLL → QQ → 酷狗 → [登录网易云后追加 Meting] → 本地）：
   * - 设置关闭 → 保持原流程（FFT 精排），不显示来源徽标；
   * - 开启 → 按用户偏好（手动切换的记忆）或默认 AMLL 优先，依次尝试云端逐字歌词，
   *   成功则替换当前歌词、标记来源并跳过 FFT；全部失败则提示回退原因并走 FFT 回退。
   * 串行编排避免云端结果与 FFT 结果互相覆盖的竞态。
   */
  async function schedulePreciseQqLyrics(
    meta: {
      id: string;
      kind: "local" | "online" | "webdav";
      title: string;
      artist: string;
      durationMs?: number;
    },
    fallbackLines: LyricLine[],
    analysisSource: {
      id: string;
      kind: "local" | "online" | "webdav";
      filePath?: string;
      url?: string;
    },
  ) {
    const settings = useSettingsStore();
    const neteaseLoggedIn = settings.neteaseEnabled && useNeteaseStore().loggedIn;
    const runFallback = () => scheduleWordAnalysis(analysisSource, fallbackLines);
    if (!settings.preciseLyrics) {
      lyricsSource.value = null; // 功能未启用，不显示来源徽标
      runFallback();
      return;
    }
    if (!meta.durationMs) {
      // 无时长无法做 ±1s 匹配
      completeFallback("missing-info");
      runFallback();
      return;
    }
    // 记忆当前歌曲上下文与本地歌词，供手动切换来源使用
    lastLyricMeta.value = { ...meta };
    localLyrics.value = fallbackLines;

    const key = `${meta.kind}:${meta.id}`;
    if (qqLyricsInflight.has(key)) return; // 进行中，结果到达时统一处理
    qqLyricsInflight.add(key);
    try {
      // 用户偏好：local = 直接本地；amll/qq/kg/meting = 对应来源优先的回退链
      const prefKey = lyricPrefKey(meta);
      const pref = prefKey ? settings.lyricSourcePrefs[prefKey] : undefined;
      // 已退出网易云时，历史 meting 偏好不再作为首选（自动回到默认回退链）
      const metingMiss = pref === "meting" && !neteaseLoggedIn;
      // 同理：历史 amll 偏好也要受「设置里关掉 AMLL」约束。utils 里的开关判断只作用于
      // 默认回退顺序（preferredSource 会先入队，早于那次检查），所以在调用点补一道，
      // 否则用户关掉 AMLL 后，之前手动切到过 AMLL 的歌仍会继续请求 AMLL。
      const amllMiss = pref === "amll" && !settings.amllLyricsEnabled;
      const effectivePref = metingMiss || amllMiss ? undefined : pref;
      if (effectivePref === "local") {
        lyricsSource.value = "local";
        lyricFallbackReason.value = null; // 主动选择，非回退
        lyricFallbackDetail.value = null;
        console.info("[逐字歌词] 按用户偏好使用本地歌词:", meta.title);
        runFallback();
        return;
      }
      const result = await fetchCloudLyrics({
        title: meta.title,
        artist: meta.artist || undefined,
        durationMs: meta.durationMs,
        preferredSource: effectivePref,
        fallbackToMeting: neteaseLoggedIn,
        // AMLL TTML DB 基地址来自设置（社区镜像 / 自建），空串时 utils 内部回退默认基地址。
        // 注意：amllLyricsEnabled 开关**不在这里判** —— fetchCloudLyrics 内部读设置决定是否
        // 走 AMLL，调用点重复判断反而会让两条链路的开关语义有机会分叉。
        amllBase: settings.amllLyricBase,
      });
      // 防止完成时已切歌：当前歌曲仍是同一首才应用
      if (song.value?.id !== meta.id) {
        console.info("[逐字歌词] 取词完成时已切歌，丢弃结果");
        return;
      }
      const stillEnabled = useSettingsStore().preciseLyrics;
      if (result.ok && stillEnabled) {
        if (applyCloudLyrics(result)) return; // 已应用官方时间轴，跳过 FFT 精排
      }
      if (stillEnabled && !result.ok) {
        completeFallback(result.reason, result.detail);
      }
      // 设置被关闭 / 结果不可用 → 走原 FFT 流程（设置关闭时不打扰用户）
      runFallback();
    } catch (e) {
      if (song.value?.id === meta.id && useSettingsStore().preciseLyrics) {
        completeFallback("search-failed", e instanceof Error ? e.message : String(e));
      }
      runFallback();
    } finally {
      qqLyricsInflight.delete(key);
    }
  }

  /**
   * 手动切换歌词来源（播放器徽标点击）：
   * 未登录网易云：amll → qq → kg → local → amll；
   * 已登录：amll → qq → kg → meting → local → amll。
   * 记忆偏好（下次播放同一歌曲默认使用该来源），切云端时强制重新获取。
   *
   * 循环起点与自动回退链保持一致（AMLL 打头、local 收尾）：cur 为空时（首次点切换）
   * 从 amll 起算，正好把「下一档」指到 QQ，而不是又原地切回 AMLL。
   */
  async function switchLyricSource() {
    const meta = lastLyricMeta.value;
    const settings = useSettingsStore();
    const neteaseLoggedIn = settings.neteaseEnabled && useNeteaseStore().loggedIn;
    if (!meta || !song.value || !settings.preciseLyrics || !meta.durationMs) return;
    // 关掉 AMLL 时手动循环也要跳过它：否则用户会「切到一个已经在设置里关掉的来源」，
    // 且 utils 只在默认回退顺序里判开关，手动 preferredSource 会绕过它。
    // order 恒以 qq 打头、local 收尾，不会出现空数组或切不到本地的情况。
    const order: LyricSourcePref[] = (["amll", "qq", "kg"] as LyricSourcePref[])
      .filter((s) => s !== "amll" || settings.amllLyricsEnabled)
      .concat(neteaseLoggedIn ? ["meting", "local"] : ["local"]);
    // lyricsSource 已是 LyricSourcePref，无需再断言；"local" 也在 order 里，必然命中。
    // cur 若已不在 order 中（例如刚关掉 AMLL），indexOf 得 -1 → 落到 order[0]，是期望行为。
    const cur: LyricSourcePref = lyricsSource.value ?? "amll";
    const next = order[(order.indexOf(cur) + 1) % order.length];
    const prefKey = lyricPrefKey(meta);
    if (prefKey) {
      settings.lyricSourcePrefs[prefKey] = next; // 记忆偏好
    }
    const lang = settings.lang;
    const labels: Record<LyricSourcePref, string> = {
      amll: translate(lang, "player.lyricSourceAmll"),
      qq: translate(lang, "player.lyricSourceQq"),
      kg: translate(lang, "player.lyricSourceKg"),
      meting: translate(lang, "player.lyricSourceMeting"),
      local: translate(lang, "player.lyricSourceLocal"),
    };

    if (next === "local") {
      showLyricNotice(`${translate(lang, "player.lyricSourceSwitched")}${labels[next]}`);
      // 切回本地歌词（含 FFT 精排）
      setLyrics(localLyrics.value);
      updateActiveLine();
      lyricsSource.value = "local";
      lyricFallbackReason.value = null;
      lyricFallbackDetail.value = null;
      console.info("[逐字歌词] 手动切换为本地歌词:", meta.title);
      void scheduleWordAnalysis(
        {
          id: meta.id,
          kind: meta.kind,
          filePath: meta.kind === "local" ? song.value.filePath : undefined,
          url: meta.kind === "online" || meta.kind === "webdav" ? song.value.src : undefined,
        },
        localLyrics.value,
      );
      return;
    }
    // 切云端来源：该来源优先的回退链，强制忽略结果缓存
    const key = `${meta.kind}:${meta.id}`;
    if (qqLyricsInflight.has(key)) return; // 已有获取进行中，等待其结果
    qqLyricsInflight.add(key);
    showLyricNotice(`${translate(lang, "player.lyricSourceSwitched")}${labels[next]}`);
    lyricsSource.value = null; // 获取中隐藏徽标
    try {
      const result = await fetchCloudLyrics({
        title: meta.title,
        artist: meta.artist || undefined,
        durationMs: meta.durationMs,
        preferredSource: next,
        force: true,
        fallbackToMeting: neteaseLoggedIn,
        // 同上：AMLL 基地址透传，开关由 utils 内部读设置
        amllBase: settings.amllLyricBase,
      });
      if (song.value?.id !== meta.id) return;
      if (result.ok) {
        applyCloudLyrics(result);
        return;
      }
      completeFallback(result.reason, result.detail);
    } catch (e) {
      completeFallback("search-failed", e instanceof Error ? e.message : String(e));
    } finally {
      qqLyricsInflight.delete(key);
    }
  }

  /** 应用一首已取回的本地完整 Song（解析歌词、提取封面主色、推送 SMTC） */
  /**
   * 响度归一化：测出当前曲响度并把增益施加到 Web Audio 链上。
   *
   * 异步、不阻塞起播：先按 1.0（不改音量）起播，测完再平滑切到目标增益。
   * 测不出来（格式不支持 / 网络失败 / 全静音）就一直是 1.0 —— 按原音量播。
   *
   * 用歌曲 id 做「结果归属」检查：快速切歌时上一首的异步结果不能污染当前曲。
   */
  async function applyLoudness(
    source: { kind: "local" | "online" | "webdav"; filePath?: string; url?: string },
    key: string,
  ): Promise<void> {
    const st = useSettingsStore();
    if (!st.loudnessNormalize) {
      audioEffectEngine.setLoudnessGain(1);
      return;
    }
    const lufs = await getLoudness(source, key);
    if (song.value?.id !== key) return; // 已经切歌了，丢弃这次结果
    const gain = loudnessGain(lufs, st.loudnessTarget);
    audioEffectEngine.setLoudnessGain(gain);
  }

  async function loadSong(s: Song) {
    const title = s.meta.title ?? s.file.name.replace(/\.[^.]+$/, "");
    const artist = s.meta.artist ?? "";
    const album = s.meta.album ?? "";
    const parsed = s.lyrics ? parseLrc(s.lyrics, useSettingsStore().detectInstrumental) : [];
    song.value = {
      id: s.file.id,
      title,
      artist,
      album,
      cover: s.coverBase64 ?? "",
      src: toMediaSrc(s.file.path),
      lyrics: parsed,
      filePath: s.file.path,
      durationMs: s.meta.durationMs ?? undefined,
      kind: "local",
    };
    // 听歌时长统计：开始新会话（自动 flush 旧会话）
    beginSession(song.value);
    activeLine.value = -1;
    setLyrics(parsed);
    coverColors.value = [];
    currentTime.value = 0;
    duration.value = 0;
    // 新歌：清空歌词来源状态，等待本次 QQ 尝试结果
    lyricsSource.value = null;
    lyricFallbackReason.value = null;
    lyricFallbackDetail.value = null;
    if (s.coverBase64) {
      const img = new Image();
      img.onload = () => {
        coverColors.value = getDominantColors(img);
      };
      img.src = s.coverBase64;
    }
    // 响度归一化：懒测量，异步不阻塞起播（见 applyLoudness）
    void applyLoudness({ kind: "local", filePath: s.file.path }, s.file.id);
    // 「更精确的逐字歌词」：QQ → 酷狗 → [登录网易云后 Meting] → 本地回退链（同名 + 时长差 ≤1s），
    // 云端全部失败再走本地 FFT 精排（schedulePreciseQqLyrics 内部串行处理）
    void schedulePreciseQqLyrics(
      {
        id: s.file.id,
        kind: "local",
        title,
        artist,
        durationMs: s.meta.durationMs ?? undefined,
      },
      parsed,
      { id: s.file.id, kind: "local", filePath: s.file.path, url: undefined },
    );
    // 推送元数据给 Windows 系统媒体控件；真实时长由 loadedmetadata 后的 syncSmtc 兜底
    void capabilities
      .smtcSetMedia({
        title,
        artist: artist || null,
        album: album || null,
        durationMs: Math.round(s.meta.durationMs ?? 0),
        filePath: s.file.path,
        coverUrl: null,
      })
      .catch(() => {});
  }

  /** 唯一的起播路径：设源 → load → play */
  async function startPlayback() {
    const src = song.value?.src;
    if (!src) return;
    // AutoMix 过渡期间：deck 已在播放这一曲，不要重设 src
    if (suppressStart) return;
    const el = ensureAudio();
    lastError.value = null;
    el.src = src;
    el.load();
    try {
      await el.play();
    } catch (e) {
      // 自动播放被拒或解码失败；playing 由 error/pause 事件同步
      lastError.value = String(e);
    }
  }

  /** 按 id 拉取完整歌曲并立即播放 */
  async function loadById(fileId: string) {
    loadingSong.value = true;
    try {
      const full = await capabilities.getSong(fileId);
      await loadSong(full);
      await startPlayback();
      void capabilities.recordPlay(fileId);
    } catch (e) {
      lastError.value = String(e);
    } finally {
      loadingSong.value = false;
    }
  }

  /**
   * 「写音乐标签」：把在线歌曲的标签覆盖套到播放状态上。
   *
   * 内存里有记录就直接用；没有则读一次磁盘缓存（写标签时落盘，重启后仍生效）。
   * 读取失败一律静默返回 undefined —— 标签覆盖不该阻塞播放。
   */
  async function applyTagOverride(item: OnlineSong) {
    const tags = useMusicTagsStore();
    try {
      const hit = tags.get(item) ?? (await tags.resolve(item));
      return hit ? (tags.playbackOverride(item) ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 「写音乐标签」应用 / 还原默认之后，让正在播放的在线曲目立刻生效。
   *
   * - 在线曲目：重新套用覆盖（含封面、SMTC 元数据、标签歌词）；
   * - 本地曲目：元数据由 Dialog 侧刷新库并重新拉取，这里不动。
   */
  async function refreshTagOverrides(): Promise<void> {
    const current = song.value;
    if (!current || current.kind !== "online") return;
    const target = queue.value.find((it) => isOnline(it) && it.id === current.id) as
      OnlineSong | undefined;
    if (!target) return;
    const override = await applyTagOverride(target);
    current.title = override?.title || target.name;
    current.artist = override?.artist || target.artist;
    current.album = override?.album || target.album || "";
    const cover = override?.coverUrl || target.pic;
    current.cover = cover;
    current.coverUrl = cover;
    // 标签歌词优先；没有覆盖歌词时保持当前歌词不动（平台歌词可能已解析好）
    const tagged = await taggedLyricsForSong(target);
    if (tagged) {
      const lines = lyricsFromText(tagged);
      if (lines.length) {
        current.lyrics = lines;
        setLyrics(lines);
      }
    }
    if (cover && isHttpUrl(cover)) {
      void resolveCover(cover).then((resolved) => {
        if (song.value?.id !== current.id || resolved === cover) return;
        song.value.cover = resolved;
      });
    }
    if (cover) {
      const img = new Image();
      img.onload = () => {
        if (song.value?.id === current.id) coverColors.value = getDominantColors(img);
      };
      img.src = cover;
    }
    void capabilities
      .smtcSetMedia({
        title: current.title,
        artist: current.artist || null,
        album: current.album || null,
        durationMs: Math.round((duration.value || 0) * 1000),
        filePath: "",
        coverUrl: current.coverUrl ?? null,
      })
      .catch(() => {});
  }

  // Dialog 应用 / 还原默认后广播 `silvermoon:music-tag-updated`，这里跟着刷新一次
  if (typeof window !== "undefined") {
    window.addEventListener("silvermoon:music-tag-updated", () => {
      void refreshTagOverrides();
    });
  }

  /** 播放在线歌曲：拉歌词、取封面主色、推 SMTC（封面直连 pic URL） */
  async function loadOnlineSong(item: OnlineSong) {
    loadingSong.value = true;
    try {
      // 「写音乐标签」写入的在线标签覆盖：内存里已有就直接用，没有则读一次磁盘缓存。
      // 必须放在下面所有 song.value / SMTC / 歌词调用之前，之后整段逻辑都读覆盖后的值。
      const overridden = await applyTagOverride(item);
      // 酷狗列表接口不返回直链：首次播放由 MusicView 解析，这里兜底
      // 「上一首 / 下一首 / 自动续播」——解析结果写回队列项，避免重复请求
      if (!item.url && item.server === "kugou") {
        item.url = await resolveKugouUrl(item);
        if (!item.url) {
          lastError.value = translate(useSettingsStore().lang, "kugou.noSource").replace(
            "{name}",
            item.name,
          );
          return;
        }
        // 无版权 / 非会员时上游只给开头一小段：如实提示，
        // 否则用户会以为播放器坏了
        if (item.trial) {
          showLyricNotice(
            translate(useSettingsStore().lang, "kugou.trialOnly").replace("{name}", item.name),
          );
        }
      }
      let parsed: LyricLine[] = [];
      // 平台歌词原文（可能是 URL 拉下来的，也可能是内嵌文本）：
      // 提到 try 外面，因为下面的标签歌词覆盖也要用它
      let lrcText = "";
      try {
        // lrc 字段可能是 URL（需拉取），也可能是内嵌歌词文本；
        // 歌词文本按歌曲 id 缓存到 IndexedDB，重启后不再请求网络
        const lrc = item.lrc || "";
        let text = "";
        lrcText = lrc.includes("[") ? lrc : "";
        if (lrc.startsWith("http")) {
          const cached = await lrcGet(item.id);
          if (cached !== null) {
            text = cached;
          } else {
            text = await (await fetch(lrc)).text();
            lrcText = text;
            void lrcSet(item.id, text);
          }
        } else if (lrc.includes("[")) {
          text = lrc;
        }
        if (text.trim()) parsed = parseLrc(text, useSettingsStore().detectInstrumental);
        // 平台歌词存成「原始快照」：只写一次，供在线歌曲的「还原默认」把歌词也退回去
        void cacheLyricsForSong(item, text);
      } catch {
        /* 在线歌词拉取失败不阻塞播放 */
      }
      // 「写音乐标签」写入的歌词优先于平台歌词（覆盖读取失败时静默回退平台歌词）
      const taggedLrc = await applyTagLyrics(item, lrcText, parsed);
      parsed = taggedLrc.lines;
      song.value = {
        id: item.id,
        title: overridden?.title || item.name,
        artist: overridden?.artist || item.artist,
        album: overridden?.album || item.album || "",
        cover: overridden?.coverUrl || item.pic,
        src: item.url,
        lyrics: parsed,
        coverUrl: overridden?.coverUrl || item.pic,
        kind: "online",
      };
      // 听歌时长统计：开始新会话
      beginSession(song.value);
      // 响度归一化：在线源同样参与（网易云/酷狗/B 站各来源响度差异很大）
      void applyLoudness({ kind: "online", url: item.url }, item.id);
      activeLine.value = -1;
      // 与 loadSong 一致：歌词挂在 store 的 lyrics ref 上，LyricsView 读它
      setLyrics(parsed);
      // 新歌：清空歌词来源状态，等待本次 QQ 尝试结果
      lyricsSource.value = null;
      lyricFallbackReason.value = null;
      lyricFallbackDetail.value = null;
      coverColors.value = [];
      currentTime.value = 0;
      duration.value = 0;
      // 封面主色：在线图需 CORS，加载失败则由 getDominantColors 内部兜底。
      // 酷狗图床没有 CORS 头，这里直连必定失败 ⇒ 跳过，交给下面 resolveCover
      // 拿到的 dataURL 再取色（dataURL 不受跨域限制）。
      if (!needsProxiedCover(item.pic)) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          coverColors.value = getDominantColors(img);
        };
        img.src = item.pic;
      }
      // 封面本地缓存：命中 IndexedDB 立即替换为 dataURL（不阻塞起播）；
      // 未命中则后台下载并写缓存，下次进入/重启直接读本地。
      // 注意用「套用覆盖后」的封面 URL：写标签换了封面的歌，缓存要跟着换。
      const displayCover = song.value.cover;
      void resolveCover(displayCover).then((cover) => {
        if (song.value?.id !== item.id || cover === displayCover) return;
        song.value.cover = cover;
        const cachedImg = new Image();
        cachedImg.onload = () => {
          coverColors.value = getDominantColors(cachedImg);
        };
        cachedImg.src = cover;
      });
      await startPlayback();
      // 「更精确的逐字歌词」：在线歌曲时长来自音频元数据（未就绪则等待），
      // 命中 QQ 官方逐字歌词则替换（并跳过 FFT）；失败回退本地分析
      const onlineDurationMs = await waitAudioDuration(5000);
      // 用户写入的标签歌词是显式选择，逐字歌词回退链不要把它替换掉
      if (!taggedLrc.fromTag) {
        void schedulePreciseQqLyrics(
          {
            id: item.id,
            kind: "online",
            title: item.name,
            artist: item.artist,
            durationMs: onlineDurationMs,
          },
          parsed,
          { id: item.id, kind: "online", filePath: undefined, url: item.url },
        );
      }
      // SMTC / 桌面歌词同样用覆盖后的标题与封面
      void capabilities
        .smtcSetMedia({
          title: song.value.title,
          artist: song.value.artist || null,
          album: song.value.album || null,
          durationMs: 0,
          filePath: "",
          coverUrl: song.value.coverUrl ?? null,
        })
        .catch(() => {});
    } finally {
      loadingSong.value = false;
    }
  }

  /**
   * 播放 WebDAV 远程歌曲：
   * - src 走本地代理 URL（凭据在 Rust 侧，支持拖动进度）；
   * - 尝试拉取同目录同名 .lrc 作为本地歌词（失败不阻塞播放）；
   * - 逐字歌词回退链照常（云端按标题匹配 / FFT 经代理 fetch）。
   */
  async function loadWebDavSong(entry: WebDavEntry) {
    loadingSong.value = true;
    try {
      const src = await capabilities.webdavMediaUrl(entry.path);
      let parsed: LyricLine[] = [];
      try {
        const lrcPath = entry.path.replace(/\.[^.]+$/, "") + ".lrc";
        const lrcUrl = await capabilities.webdavMediaUrl(lrcPath);
        const res = await fetch(lrcUrl);
        if (res.ok) {
          const text = await res.text();
          if (text.includes("[")) {
            parsed = parseLrc(text, useSettingsStore().detectInstrumental);
          }
        }
      } catch {
        /* 无 lrc 或拉取失败不阻塞播放 */
      }
      const title = entry.name.replace(/\.[^.]+$/, "");
      song.value = {
        id: `webdav:${entry.path}`,
        title,
        artist: "WebDAV",
        album: "",
        cover: "",
        src,
        lyrics: parsed,
        kind: "webdav",
      };
      // 听歌时长统计：开始新会话
      beginSession(song.value);
      activeLine.value = -1;
      setLyrics(parsed);
      lyricsSource.value = null;
      lyricFallbackReason.value = null;
      lyricFallbackDetail.value = null;
      coverColors.value = [];
      currentTime.value = 0;
      duration.value = 0;
      await startPlayback();
      const durationMs = await waitAudioDuration(5000);
      void schedulePreciseQqLyrics(
        {
          id: song.value.id,
          kind: "webdav",
          title,
          artist: "",
          durationMs,
        },
        parsed,
        { id: song.value.id, kind: "webdav", filePath: undefined, url: src },
      );
      void capabilities
        .smtcSetMedia({
          title,
          artist: "WebDAV",
          album: null,
          durationMs: Math.round(durationMs ?? 0),
          filePath: "",
          coverUrl: null,
        })
        .catch(() => {});
    } catch (e) {
      lastError.value = String(e);
    } finally {
      loadingSong.value = false;
    }
  }

  /** 播放在线歌曲列表（搜索/歌单结果）入队并起播，index 为起播项 */
  async function playOnline(songs: OnlineSong[], index: number) {
    queue.value = songs;
    currentIndex.value = index;
    if (shuffleMode.value) generateShuffleOrder();
    await playFromQueue(index);
  }

  /**
   * PlayerView 挂载后调用。歌曲已在播放则不打断，
   * 仅在音频尚未起播时补一次（如刷新后直接进入播放器页）。
   */
  function initAudio() {
    const el = ensureAudio();
    if (song.value && !el.src) {
      void startPlayback();
    }
  }

  async function playFromQueue(index: number, opts: { skipStart?: boolean } = {}) {
    if (index < 0 || index >= queue.value.length) return;
    // 换歌了：上一轮为「旧下一曲」做的预载与去重标记都必须失效。
    // 这是所有切歌路径的唯一汇聚点（手动点选/上下一首/随机/自动）。
    // AutoMix 自身的交接（skipStart）不清，因为那时 prepared 正由 runMix 使用。
    if (!opts.skipStart) invalidatePrepared("切换曲目");
    currentIndex.value = index;
    const item = queue.value[index];
    // AutoMix 过渡时 deck 已经在播下一曲：这里只需要把「状态」切过去，
    // 不能再走 startPlayback（重设 src 会把正在播的音频打断）。
    if (opts.skipStart) suppressStart = true;
    try {
      if (isWebDav(item)) {
        await loadWebDavSong(item);
      } else if (isOnline(item)) {
        await loadOnlineSong(item);
      } else {
        await loadById(item.id);
      }
    } finally {
      suppressStart = false;
    }
  }

  /**
   * 让「预载的下一曲」失效。
   *
   * 必须清理的场景：用户手动切歌、切随机模式、改队列。
   * 此时 prepared.index 指向的可能已不是真正会播的下一首 ——
   * 若继续用，AutoMix 会把**另一首歌**混进来（听起来像随机插入了一段别人的音乐）。
   */
  function invalidatePrepared(reason: string): void {
    // 无论有没有预载都要自增：进行中的过渡据此放弃，避免它继续提升一个
    // 已经被本函数清源的 deck（那会表现为切歌后没声音）。
    mixGeneration++;
    if (!prepared) return;
    mixLog("预载的下一曲已失效（" + reason + "）", { index: prepared.index });
    prepared = null;
    mixTriggeredFor = null;
    // 预载元素上还挂着这首歌的源：留着既占解码 / 网络，也会让下一次预载的
    // 「src 没变就不重挂」判断失效。这里只是断开，元素本身留给过渡复用。
    if (preloadEl) {
      preloadEl.pause();
      preloadEl.removeAttribute("src");
      preloadEl.load();
    }
  }

  async function next() {
    if (queue.value.length === 0) return;
    if (repeatMode.value === "one") {
      const el = ensureAudio();
      el.currentTime = 0;
      // 开始新会话（旧会话已由 ended 事件 flush）
      if (song.value) beginSession(song.value);
      void el.play().catch(() => {});
      return;
    }
    let nextIndex: number;
    if (shuffleMode.value) {
      const currentShufflePos = shuffledIndices.value.indexOf(currentIndex.value);
      const nextShufflePos = currentShufflePos + 1;
      if (nextShufflePos >= shuffledIndices.value.length) {
        if (repeatMode.value === "all") {
          generateShuffleOrder();
          nextIndex = shuffledIndices.value[0];
        } else {
          playing.value = false;
          syncSmtc(true);
          return;
        }
      } else {
        nextIndex = shuffledIndices.value[nextShufflePos];
      }
    } else {
      nextIndex = currentIndex.value + 1;
      if (nextIndex >= queue.value.length) {
        if (repeatMode.value === "all") {
          nextIndex = 0;
        } else {
          playing.value = false;
          syncSmtc(true);
          return;
        }
      }
    }
    await playFromQueue(nextIndex);
  }

  async function previous() {
    if (queue.value.length === 0) return;
    if (audioEl.value && audioEl.value.currentTime > 3) {
      audioEl.value.currentTime = 0;
      return;
    }
    let prevIndex: number;
    if (shuffleMode.value) {
      const currentShufflePos = shuffledIndices.value.indexOf(currentIndex.value);
      prevIndex =
        currentShufflePos > 0
          ? shuffledIndices.value[currentShufflePos - 1]
          : shuffledIndices.value[shuffledIndices.value.length - 1];
    } else {
      prevIndex = currentIndex.value > 0 ? currentIndex.value - 1 : queue.value.length - 1;
    }
    await playFromQueue(prevIndex);
  }

  function toggleShuffle() {
    shuffleMode.value = !shuffleMode.value;
    if (shuffleMode.value) {
      generateShuffleOrder();
    }
    // 随机序变了 → 预载的「下一曲」多半不再是真正会播的那首
    invalidatePrepared("切换随机播放");
  }

  function cycleRepeat() {
    const modes: RepeatMode[] = ["off", "all", "one"];
    const currentIdx = modes.indexOf(repeatMode.value);
    repeatMode.value = modes[(currentIdx + 1) % modes.length];
    invalidatePrepared("切换循环模式");
  }

  function setQueue(entries: QueueItem[], startIndex = 0) {
    queue.value = entries;
    if (shuffleMode.value) {
      generateShuffleOrder();
    }
    currentIndex.value = startIndex;
    // 队列被整体替换：旧预载的 index 指向的已是另一个队列里的歌，必须失效
    invalidatePrepared("替换播放队列");
  }

  // ---- 队列操作（音乐列表行内操作使用）----

  /** 追加到队尾；当前队列为空时直接作为当前曲目起播 */
  async function addToQueue(item: QueueItem) {
    if (queue.value.length === 0) {
      queue.value = [item];
      currentIndex.value = 0;
      return;
    }
    queue.value = [...queue.value, item];
    if (shuffleMode.value) generateShuffleOrder();
  }

  /** 插到当前曲目之后（下一首播放） */
  function playNext(item: QueueItem) {
    if (queue.value.length === 0) {
      queue.value = [item];
      currentIndex.value = 0;
      return;
    }
    const insertAt = currentIndex.value + 1;
    queue.value = [...queue.value.slice(0, insertAt), item, ...queue.value.slice(insertAt)];
    if (shuffleMode.value) generateShuffleOrder();
  }

  /** 从队列移除；不允许移除正在播放的当前曲目 */
  function removeFromQueue(index: number) {
    if (index < 0 || index >= queue.value.length) return;
    if (index === currentIndex.value) return;
    queue.value = queue.value.filter((_, i) => i !== index);
    if (index < currentIndex.value) currentIndex.value -= 1;
    if (queue.value.length === 0) currentIndex.value = 0;
    if (shuffleMode.value) generateShuffleOrder();
  }

  /** 清空队列，仅保留当前曲目 */
  function clearQueue() {
    if (queue.value.length === 0) return;
    const current = queue.value[currentIndex.value];
    queue.value = current ? [current] : [];
    currentIndex.value = 0;
    if (shuffleMode.value) generateShuffleOrder();
  }

  function togglePlay() {
    if (!song.value) return;
    const el = ensureAudio();
    // 源尚未设置（如从 MiniPlayer 恢复播放）时补一次起播
    if (!el.src) {
      void startPlayback();
      return;
    }
    if (el.paused) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  function seek(t: number) {
    if (!audioEl.value || !Number.isFinite(t)) return;
    audioEl.value.currentTime = Math.max(0, t);
  }

  function setPlaybackRate(rate: number) {
    ensureAudio().playbackRate = rate;
  }

  function seekToLyric(i: number) {
    if (i < 0 || i >= lyrics.value.length) return;
    seek(lyrics.value[i].time);
  }

  // ---- Windows 系统媒体键（SMTC）----
  // 系统浮层/键盘媒体键触发的命令统一在这里分发到现有播放器动作
  void capabilities
    .onSmtcCommand((cmd) => {
      if (!song.value) return;
      switch (cmd.kind) {
        case "play":
          if (!playing.value) togglePlay();
          break;
        case "pause":
          if (playing.value) togglePlay();
          break;
        case "next":
          void next();
          break;
        case "prev":
          void previous();
          break;
        case "stop":
          if (playing.value) togglePlay();
          break;
        case "seek":
          seek((cmd.positionMs ?? 0) / 1000);
          syncSmtc(true);
          break;
      }
    })
    .catch(() => {});

  // 应用退出时尽力 flush 会话
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (sessionId && sessionTrack) {
        const pos = currentTime.value;
        const dur = duration.value || sessionTrack.durationMs || 0;
        const isCompleted = dur > 0 && (pos / dur >= 0.8 || sessionListenedMs >= dur * 0.8);
        flushSession(isCompleted);
      }
    });
  }

  // ---- AutoMix 对外接口 ----
  /**
   * 供控制台调试使用的 API。
   *
   * 暴露在 `__automix`（见 installAutoMixConsole），也直接从 store 调用，
   * 便于组件里做「立即分析一次」「查看上次决策」之类的操作。
   */
  function automixDebug() {
    const s = useSettingsStore();
    return {
      enabled: s.autoMixEnabled,
      duration: s.autoMixDuration,
      beatMatch: s.autoMixBeatMatch,
      trimSilence: s.autoMixTrimSilence,
      maxRateDeviationPct: s.autoMixMaxRateDeviation,
      mixing: mixing.value,
      analysisStatus: analysisStatus.value,
      prepared: prepared ? { index: prepared.index, hasAnalysis: !!prepared.analysis } : null,
      currentDeck: mixDeck.value,
      lastPlan: lastMixPlan.value,
      inflight: [...analysisInflight.keys()],
    };
  }

  // 播放期间阻止息屏：全屏看视频 / 桌面歌词挂在桌面上时不该黑屏。
  // 用 display 锁而非 system 锁——用户主动合盖或按电源键仍应能休眠。
  // 失败静默：平铺 WM 上可能没有 ScreenSaver 服务，不能因此影响播放。
  watch(playing, (nowPlaying) => {
    const desktopEnv = useDesktopStore();
    if (nowPlaying) void desktopEnv.keepAwake(WAKE_REASON.playback, "display");
    else void desktopEnv.allowSleep(WAKE_REASON.playback);
  });

  return {
    song,
    playing,
    currentTime,
    duration,
    currentIndex,
    audioEl,
    // AutoMix
    mixing,
    lastMixPlan,
    analysisStatus,
    automixDebug,
    setMixVerbose,
    getMixLog,
    clearMixLog,
    clearAnalysisCache,
    requestForceMix,
    queue,
    loadingSong,
    lastError,
    shuffleMode,
    repeatMode,
    lyrics,
    lyricsRaw,
    setLyrics,
    activeLine,
    coverColors,
    currentLyric,
    lyricsSource,
    lyricFallbackReason,
    lyricFallbackDetail,
    lyricNotice,
    switchLyricSource,
    bindAudio,
    detachAudio,
    loadSong,
    loadById,
    loadOnlineSong,
    refreshTagOverrides,
    loadWebDavSong,
    playOnline,
    initAudio,
    togglePlay,
    setIndex,
    seek,
    setPlaybackRate,
    seekToLyric,
    next,
    previous,
    toggleShuffle,
    cycleRepeat,
    setQueue,
    playFromQueue,
    addToQueue,
    playNext,
    removeFromQueue,
    clearQueue,
    isOnline,
    isWebDav,
    queueTitle,
    queueArtist,
    queueDuration,
  };
});
