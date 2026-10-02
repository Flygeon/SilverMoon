import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { toAssetUrl } from "@/ipc/invoke";
import { capabilities, isDesktop } from "@/capabilities";
import { useSettingsStore } from "@/stores/settings";
import { useNeteaseStore } from "@/stores/netease";
import { useAudioEffectsStore } from "@/stores/audioEffects";
// parseLrc 由 @/utils/lyricTimeline 提供（原先定义在本文件，已移出供歌词源复用）
import { META_RE, parseLrc } from "@/utils/lyricTimeline";
import { resolveKugouUrl } from "@/utils/kugou";
import { lrcGet, lrcSet, needsProxiedCover, resolveCover } from "@/utils/onlineCache";
import { emitDesktopLyricsState } from "@/utils/desktopLyrics";
import {
  fetchCloudLyrics,
  normalizeTitle,
  type LyricSource,
  type LyricSourcePref,
  type QqFallbackReason,
} from "@/utils/preciseLyrics";
import { translate } from "@shared/i18n";
import { applyPreciseWordTimes, getPreciseWordTimes } from "@/utils/wordAnalysis";
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
  const activeLine = ref(-1);
  const coverColors = ref<string[]>([]);

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
  /** 已准备的下一个 deck（预载完成，等待过渡） */
  let prepared: { index: number; analysis: TrackAnalysis | null; src: string } | null = null;
  /** 过渡是否已为本曲触发过（避免 timeupdate 反复触发） */
  let mixTriggeredFor: string | null = null;
  /** 本次播放是否真的用上了 AutoMix（决定结束时要等过渡还是直接切） */
  /** 预载进行中（避免 timeupdate 反复触发 prepareNext） */
  let preparing: Promise<void> | null = null;
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

      // 预载下一曲并 seek 到跳过静音后的位置
      to.el.src = prepared.src;
      to.el.load();
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
      oldEl.src = "";
      oldEl.load();
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

    // 并行分析：当前曲 + 下一曲
    const curDur = duration.value || (song.value?.durationMs ?? 0) / 1000;
    const [curAnalysis, nextAnalysis] = await Promise.all([
      analyze(cur.source, cur.id, curDur),
      analyzeNextItem(item, src),
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
        applyPreciseWordTimes(lines, precise);
      }
    } finally {
      wordAnalysisInflight.delete(key);
    }
  }

  /** 正在获取 QQ 官方逐字歌词的歌曲 key，避免同一首重复请求 */
  const qqLyricsInflight = new Set<string>();

  /** 等待 audio 元素元数据就绪并返回时长（毫秒）；超时/不可用返回 undefined */
  function waitAudioDuration(timeoutMs: number): Promise<number | undefined> {
    return new Promise((resolve) => {
      const el = audioEl.value;
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
   * - "qq" / "kg" / "meting"：已应用对应云端歌词；"local"：已回退本地歌词（原因见 lyricFallbackReason）。
   */
  const lyricsSource = ref<"qq" | "kg" | "meting" | "local" | null>(null);
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
    // 与 LRC 流程一致：开启「自动识别前奏/间奏」时隐藏作词/作曲等元数据行
    if (useSettingsStore().detectInstrumental) {
      const filtered = result.lines.filter((l) => !META_RE.test(l.text));
      if (filtered.length) applied = filtered;
    }
    lyrics.value = applied;
    song.value.lyrics = applied;
    updateActiveLine();
    lyricsSource.value = result.source;
    lyricFallbackReason.value = null;
    lyricFallbackDetail.value = null;
    const srcLabel = result.source === "qq" ? "QQ" : result.source === "kg" ? "酷狗" : "Meting";
    console.info(
      `[逐字歌词] 命中${srcLabel}：${result.songTitle}（${srcLabel} id=${result.songId}，${applied.length} 行，${result.wordLevel ? "含逐字时间轴" : "仅逐行"}，${result.fromCache ? "来自缓存" : "在线获取"}）`,
    );
    return true;
  }

  /**
   * 「更精确的逐字歌词」编排（回退链 QQ → 酷狗 → [登录网易云后追加 Meting] → 本地）：
   * - 设置关闭 → 保持原流程（FFT 精排），不显示来源徽标；
   * - 开启 → 按用户偏好（手动切换的记忆）或默认 QQ 优先，依次尝试云端逐字歌词，
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
      // 用户偏好：local = 直接本地；qq/kg/meting = 对应来源优先的回退链
      const prefKey = lyricPrefKey(meta);
      const pref = prefKey ? settings.lyricSourcePrefs[prefKey] : undefined;
      // 已退出网易云时，历史 meting 偏好不再作为首选（自动回到默认回退链）
      const effectivePref = pref === "meting" && !neteaseLoggedIn ? undefined : pref;
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
   * 未登录网易云：qq → kg → local → qq；已登录：qq → kg → meting → local → qq。
   * 记忆偏好（下次播放同一歌曲默认使用该来源），切云端时强制重新获取。
   */
  async function switchLyricSource() {
    const meta = lastLyricMeta.value;
    const settings = useSettingsStore();
    const neteaseLoggedIn = settings.neteaseEnabled && useNeteaseStore().loggedIn;
    if (!meta || !song.value || !settings.preciseLyrics || !meta.durationMs) return;
    const order: LyricSourcePref[] = neteaseLoggedIn
      ? ["qq", "kg", "meting", "local"]
      : ["qq", "kg", "local"];
    const cur = lyricsSource.value ?? "qq";
    const next = order[(order.indexOf(cur as LyricSourcePref) + 1) % order.length];
    const prefKey = lyricPrefKey(meta);
    if (prefKey) {
      settings.lyricSourcePrefs[prefKey] = next; // 记忆偏好
    }
    const lang = settings.lang;
    const labels: Record<LyricSourcePref, string> = {
      qq: translate(lang, "player.lyricSourceQq"),
      kg: translate(lang, "player.lyricSourceKg"),
      meting: translate(lang, "player.lyricSourceMeting"),
      local: translate(lang, "player.lyricSourceLocal"),
    };

    if (next === "local") {
      showLyricNotice(`${translate(lang, "player.lyricSourceSwitched")}${labels[next]}`);
      // 切回本地歌词（含 FFT 精排）
      lyrics.value = localLyrics.value;
      song.value.lyrics = localLyrics.value;
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
    lyrics.value = parsed;
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

  /** 播放在线歌曲：拉歌词、取封面主色、推 SMTC（封面直连 pic URL） */
  async function loadOnlineSong(item: OnlineSong) {
    loadingSong.value = true;
    try {
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
      try {
        // lrc 字段可能是 URL（需拉取），也可能是内嵌歌词文本；
        // 歌词文本按歌曲 id 缓存到 IndexedDB，重启后不再请求网络
        const lrc = item.lrc || "";
        let text = "";
        if (lrc.startsWith("http")) {
          const cached = await lrcGet(item.id);
          if (cached !== null) {
            text = cached;
          } else {
            text = await (await fetch(lrc)).text();
            void lrcSet(item.id, text);
          }
        } else if (lrc.includes("[")) {
          text = lrc;
        }
        if (text.trim()) parsed = parseLrc(text, useSettingsStore().detectInstrumental);
      } catch {
        /* 在线歌词拉取失败不阻塞播放 */
      }
      song.value = {
        id: item.id,
        title: item.name,
        artist: item.artist,
        album: item.album ?? "",
        cover: item.pic,
        src: item.url,
        lyrics: parsed,
        coverUrl: item.pic,
        kind: "online",
      };
      // 听歌时长统计：开始新会话
      beginSession(song.value);
      activeLine.value = -1;
      // 与 loadSong 一致：歌词挂在 store 的 lyrics ref 上，LyricsView 读它
      lyrics.value = parsed;
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
      // 未命中则后台下载并写缓存，下次进入/重启直接读本地
      void resolveCover(item.pic).then((cover) => {
        if (song.value?.id !== item.id || cover === item.pic) return;
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
      void capabilities
        .smtcSetMedia({
          title: item.name,
          artist: item.artist || null,
          album: item.album ?? null,
          durationMs: 0,
          filePath: "",
          coverUrl: item.pic,
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
      lyrics.value = parsed;
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
    if (!prepared) return;
    mixLog("预载的下一曲已失效（" + reason + "）", { index: prepared.index });
    prepared = null;
    mixTriggeredFor = null;
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
