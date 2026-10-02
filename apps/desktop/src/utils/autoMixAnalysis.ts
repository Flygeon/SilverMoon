/**
 * AutoMix 音频分析编排 + 缓存。
 *
 * 流程：查缓存 → 未命中则取音频字节 → decodeAudioData 解码成单声道 PCM
 * → 交给 Worker 做 BPM / 节拍网格 / 静音边界 → 写 IndexedDB 缓存。
 *
 * ## 一个容易被忽略的约束：过渡发生在**歌尾**
 *
 * 参考项目里逐字歌词只分析前 300 秒（歌词都在开头）。但 AutoMix 的过渡点在
 * **当前曲的结尾**与**下一曲的开头** —— 只分析开头会导致「到歌尾时没有节拍网格」，
 * 对拍直接失效。所以超过阈值的长曲子要**头尾各分析一段**，再把两段网格按绝对时间合并。
 *
 * ## 缓存
 *
 * 与逐字歌词分开一个 IndexedDB 库（不是同一个 store）。
 * 原因：IndexedDB 的版本号是「每个库一个」，往 lumiluna 库里加 store 要把它升到 v2，
 * 而 wordCache 仍以 v1 打开 —— 两者版本不一致会直接抛 VersionError。
 * 独立库最省事，也避免互相影响。
 */
import { isDesktop } from "@/capabilities";

/** 分析的音频来源 */
export interface AutoMixSource {
  kind: "local" | "online" | "webdav";
  filePath?: string;
  url?: string;
}

/** 单个区域的分析结果 */
export interface RegionAnalysis {
  bpm: number;
  /** 绝对时间（秒）的拍点 */
  beatGrid: number[];
  silenceStart: number;
  silenceEnd: number;
  confidence: number;
  onsetCount: number;
}

/** 一首歌的完整分析结果 */
export interface TrackAnalysis {
  bpm: number;
  beatGrid: number[];
  /** 开头静音秒数（可安全裁掉） */
  silenceStart: number;
  /** 结尾静音秒数（可安全裁掉） */
  silenceEnd: number;
  confidence: number;
  /** 分析覆盖的时长（秒），用于判断是否够用 */
  durationSec: number;
  /** 算法版本；改了算法就 +1，旧缓存自动失效 */
  analyzerVersion: number;
  /** 分析耗时毫秒（调试用） */
  elapsedMs: number;
}

/** 算法版本：改动分析逻辑时必须 +1，否则旧缓存会被继续使用 */
export const ANALYZER_VERSION = 1;

/** 短于这个时长就整首分析 */
const MAX_FULL_SECONDS = 300;
/** 长曲子头尾各分析多少秒 */
const EDGE_SECONDS = 150;
/** 分析用的采样率（降采样能显著省内存与算力，对 BPM 检测足够） */
const ANALYZE_RATE = 22050;

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = "lumiluna-automix";
const STORE = "trackAnalysis";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function analysisGet(key: string): Promise<TrackAnalysis | null> {
  try {
    const db = await openDb();
    return await new Promise<TrackAnalysis | null>((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => {
        const d = req.result as TrackAnalysis | undefined;
        // 版本不符视为未命中，会自动重算
        resolve(d && d.analyzerVersion === ANALYZER_VERSION ? d : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function analysisSet(key: string, value: TrackAnalysis): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 缓存写失败不影响播放 */
  }
}
// ---------------------------------------------------------------- 音频获取与解码

async function getAudioBytes(source: AutoMixSource): Promise<ArrayBuffer> {
  if (source.kind === "local" && source.filePath && isDesktop) {
    const { readFile } = await import("@/ipc/fs");
    const data = await readFile(source.filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  if ((source.kind === "online" || source.kind === "webdav") && source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`音频获取失败 HTTP ${res.status}`);
    return await res.arrayBuffer();
  }
  throw new Error("无可分析的音频源");
}

/**
 * 解码并重采样为单声道 PCM。
 *
 * 用 OfflineAudioContext 让浏览器原生解码（支持 mp3/flac/aac/ogg），
 * 再靠它自己的重采样降到 ANALYZE_RATE —— 比自己写重采样稳。
 *
 * 起始偏移通过 OfflineAudioContext 的采样率与 source.start(0, offset, duration) 实现：
 * 只渲染需要的区间，长曲子不必整首进内存。
 */
async function decodeMono(
  bytes: ArrayBuffer,
  offsetSec: number,
  durationSec: number,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const Ctx: typeof OfflineAudioContext =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const frames = Math.max(1, Math.ceil(durationSec * ANALYZE_RATE));
  const ctx = new Ctx(1, frames, ANALYZE_RATE);
  // decodeAudioData 需要一份独立副本：它会把传入的 ArrayBuffer detach 掉
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  const from = Math.max(0, Math.floor(offsetSec * decoded.sampleRate));
  const len = Math.min(decoded.length - from, Math.ceil(durationSec * decoded.sampleRate));
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  // 取第 0 声道即可：拍点在各声道一致，且省一半算力
  src.connect(ctx.destination);
  src.start(0, from / decoded.sampleRate, Math.max(0, len / decoded.sampleRate));
  const rendered = await ctx.startRendering();
  return { pcm: rendered.getChannelData(0), sampleRate: rendered.sampleRate };
}

// ---------------------------------------------------------------- Worker

interface WorkerResult {
  result: RegionAnalysis & { id: string; ok: boolean; error?: string };
  elapsedMs: number;
}

let worker: Worker | null = null;
let seq = 0;

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/autoMix.worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return worker;
}

function analyzeRegion(pcm: Float32Array, sampleRate: number): Promise<RegionAnalysis> {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    const id = `r${++seq}`;
    const onMessage = (e: MessageEvent<WorkerResult>) => {
      const d = e.data;
      if (!d?.result || d.result.id !== id) return;
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      if (!d.result.ok) {
        reject(new Error(d.result.error || "分析失败"));
        return;
      }
      resolve({
        bpm: d.result.bpm,
        beatGrid: d.result.beatGrid,
        silenceStart: d.result.silenceStart,
        silenceEnd: d.result.silenceEnd,
        confidence: d.result.confidence,
        onsetCount: d.result.onsetCount,
      });
    };
    const onError = (ev: ErrorEvent) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      reject(new Error(ev.message || "分析 Worker 错误"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    // PCM 用 transferable 传过去，零拷贝（传完本地这份就不可用了）
    w.postMessage({ id, pcm, sampleRate }, [pcm.buffer]);
  });
}

// ---------------------------------------------------------------- 编排

/** 把两段（头/尾）区域结果合并成整首的结果。 */
function mergeRegions(
  head: RegionAnalysis,
  tail: RegionAnalysis | null,
  offsetOfTail: number,
  durationSec: number,
): TrackAnalysis {
  // BPM 取置信度更高的那一段；两段都没把握就取 head
  const useTail = !!tail && tail.confidence > head.confidence && tail.bpm > 0;
  const primary = useTail ? tail! : head;
  const grid = [...head.beatGrid];
  if (tail) {
    // 尾段网格平移到绝对时间，并去掉与头段重叠的部分
    const shifted = tail.beatGrid.map((t) => t + offsetOfTail);
    const lastHead = grid.length ? grid[grid.length - 1] : -Infinity;
    for (const t of shifted) if (t > lastHead + 0.001) grid.push(t);
  }
  grid.sort((a, b) => a - b);
  return {
    bpm: primary.bpm,
    beatGrid: grid,
    // 头部静音只可能来自头段；尾部静音只可能来自尾段
    silenceStart: head.silenceStart,
    silenceEnd: tail ? tail.silenceEnd : head.silenceEnd,
    confidence: Math.max(head.confidence, tail?.confidence ?? 0),
    durationSec,
    analyzerVersion: ANALYZER_VERSION,
    elapsedMs: 0,
  };
}
/** 缓存 key（与逐字歌词一致的命名习惯）。 */
export function analysisKey(source: AutoMixSource, id: string): string {
  return `${source.kind}:${id}`;
}

/**
 * 分析一首歌。命中缓存直接返回；否则解码 + 分析 + 写缓存。
 *
 * `durationSec` 传 0 时按「整首未知」处理，只分析开头一段（够用来判断 BPM）。
 * 失败一律返回 null 而不抛 —— 调用方据此降级为普通淡化，绝不能因为分析失败中断播放。
 */
export async function analyzeTrack(
  source: AutoMixSource,
  durationSec: number,
  cacheKey: string,
  log?: (msg: string, detail?: unknown) => void,
): Promise<TrackAnalysis | null> {
  const cached = await analysisGet(cacheKey);
  if (cached) {
    log?.("分析缓存命中", { cacheKey, bpm: cached.bpm, beats: cached.beatGrid.length });
    return cached;
  }
  const t0 = Date.now();
  try {
    const bytes = await getAudioBytes(source);
    log?.("音频已获取", { bytes: bytes.byteLength });

    // 短曲子整首分析；长曲子头尾各取一段 —— 过渡点在歌尾，只分析开头不够用
    const full = durationSec > 0 && durationSec <= MAX_FULL_SECONDS;
    const headLen = full ? durationSec : EDGE_SECONDS;
    const headPcm = await decodeMono(bytes, 0, headLen);
    const head = await analyzeRegion(headPcm.pcm, headPcm.sampleRate);

    let tail: RegionAnalysis | null = null;
    let tailOffset = 0;
    if (!full && durationSec > MAX_FULL_SECONDS) {
      tailOffset = Math.max(0, durationSec - EDGE_SECONDS);
      const tailPcm = await decodeMono(bytes, tailOffset, EDGE_SECONDS);
      tail = await analyzeRegion(tailPcm.pcm, tailPcm.sampleRate);
    }

    const merged = mergeRegions(head, tail, tailOffset, durationSec);
    merged.elapsedMs = Date.now() - t0;
    await analysisSet(cacheKey, merged);
    log?.("分析完成", {
      bpm: merged.bpm,
      beats: merged.beatGrid.length,
      confidence: merged.confidence,
      silenceStart: merged.silenceStart,
      silenceEnd: merged.silenceEnd,
      elapsedMs: merged.elapsedMs,
    });
    return merged;
  } catch (e) {
    log?.("分析失败（将降级为普通淡化）", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 清空分析缓存（调试用）。 */
export async function clearAnalysisCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 忽略 */
  }
}
