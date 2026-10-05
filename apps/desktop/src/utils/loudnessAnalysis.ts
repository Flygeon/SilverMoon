/**
 * 响度归一化编排。
 *
 * 流程：查缓存 → 命中直接返回；未测量则取音频字节 → `OfflineAudioContext`
 * 解码成单声道 PCM → `measureLufs()`（纯 JS，见 loudness.ts）→ 写 IndexedDB 缓存。
 *
 * 全部异步、不阻塞播放；任何失败都静默返回 `null`（= 这首歌不参与归一化，
 * 按原音量播放）。绝不因为测不出响度而影响播放。
 *
 * ## 为什么不复用 wordAnalysis 的 PCM
 *
 * 两者都是「解码 → 分析 → 缓存」，但生命周期不同：
 * - 逐字分析：**必须**取整首歌（起音要覆盖每行歌词）
 * - 响度测量：只取开头一段就够（响度在前 30s 内已收敛）
 *
 * 各取各的更省：响度不必等整首解码完，也就不会和逐字分析抢同一份
 * `decodeAudioData`（该 API 会 detach 传入的 ArrayBuffer，并发调用会互相打架）。
 */
import { isDesktop } from "@/capabilities";
import { loudnessCacheGet, loudnessCacheSet, cacheKeyFor } from "./loudnessCache";
import { measureLufs } from "./loudness";

/** 只解码开头这么多秒：响度在此之前已收敛，再长只是白烧 CPU。 */
const MAX_SECONDS = 30;
/** 解码目标采样率：与逐字分析一致（44.1k），并且 44.1k 下 K 加权系数已验证。 */
const DECODE_RATE = 44100;

export interface LoudnessSource {
  kind: "local" | "online" | "webdav";
  filePath?: string;
  url?: string;
}

async function getAudioBytes(source: LoudnessSource): Promise<ArrayBuffer> {
  if (source.kind === "local" && source.filePath && isDesktop) {
    const { readFile } = await import("@/ipc/fs");
    const data = await readFile(source.filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  if ((source.kind === "online" || source.kind === "webdav") && source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`在线音频获取失败 (HTTP ${res.status})`);
    return await res.arrayBuffer();
  }
  throw new Error("无法获取音频源");
}

/**
 * 解码开头 `seconds` 秒为单声道 PCM。
 *
 * 用 `OfflineAudioContext` 的 `source.start(0, 0, duration)` 截断，
 * 避免把整首歌都解出来 —— 这是这里唯一和 wordAnalysis 不同的地方。
 */
async function decodeHeadPcm(
  bytes: ArrayBuffer,
  seconds: number,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  // 先整段解一次拿到真实时长（decodeAudioData 不接受截断输入）
  const probe = new OfflineAudioContext(1, 1, DECODE_RATE);
  const decoded = await probe.decodeAudioData(bytes.slice(0));
  const duration = Math.min(seconds, decoded.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("音频时长无效");
  }

  const frames = Math.ceil(duration * DECODE_RATE);
  const ctx = new OfflineAudioContext(1, frames, DECODE_RATE);
  const buf = await ctx.decodeAudioData(bytes.slice(0));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, 0, duration);
  const rendered = await ctx.startRendering();
  return { pcm: rendered.getChannelData(0), sampleRate: rendered.sampleRate };
}

/**
 * 测出这首歌的响度（LUFS），带缓存。
 *
 * @returns LUFS；测不出来时返回 null（调用方应按原音量播放）
 */
export async function getLoudness(source: LoudnessSource, key: string): Promise<number | null> {
  const cacheKey = cacheKeyFor(key, source);
  const cached = await loudnessCacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const bytes = await getAudioBytes(source);
    const { pcm, sampleRate } = await decodeHeadPcm(bytes, MAX_SECONDS);
    const lufs = measureLufs(pcm, sampleRate);
    // 只缓存成功的测量：失败（不支持的格式、网络问题）下次可以重试
    if (lufs !== null) {
      await loudnessCacheSet(cacheKey, lufs);
    }
    return lufs;
  } catch {
    // 静默降级：测不出响度不是错误，不该打扰用户
    return null;
  }
}
