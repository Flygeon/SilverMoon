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
 * 取开头 `seconds` 秒的单声道 PCM。
 *
 * ## 为什么不是"渲染一段"
 *
 * 之前的实现是「整曲解码两次 + 渲染出前 N 秒」：
 *
 * ~~~text
 * decodeAudioData(bytes.slice(0))   // ← 整曲解码 #1（只为拿 duration）
 * decodeAudioData(bytes.slice(0))   // ← 整曲解码 #2（真正用来渲染）
 * startRendering()                  // ← 再产出一份
 * ~~~
 *
 * `decodeAudioData` **没有"只解一段"的 API**，它总是把整个文件解成 AudioBuffer。
 * 4 分钟立体声 44.1 kHz ≈ 85 MB，解两次就是 **~170 MB 峰值** —— 而响度只需要前 30 秒。
 *
 * 现在改成：**只解一次**，然后直接从解码结果里拷出需要的那一段。
 * 既省掉第二次解码，也省掉渲染产物。
 *
 * ## 立体声 → 单声道
 *
 * 刻意保留"多声道取平均"而不是只取第 0 声道：原实现用一个单声道
 * `OfflineAudioContext` 承接立体声源，浏览器会做 L/R 平均；只取左声道
 * 会改变读数（虽然通常 < 0.5 LU）。这里手工平均，语义与原来一致。
 */
async function decodeHeadPcm(
  bytes: ArrayBuffer,
  seconds: number,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
  // 不再 slice(0)：decodeAudioData 会 detach 传入的 buffer，而调用方之后不再使用它，
  // 因此省掉一份压缩字节的拷贝。
  const decoded = await ctx.decodeAudioData(bytes);

  const take = Math.min(seconds, decoded.duration);
  if (!Number.isFinite(take) || take <= 0) {
    throw new Error("音频时长无效");
  }
  const frames = Math.min(decoded.length, Math.ceil(take * decoded.sampleRate));
  const channels = decoded.numberOfChannels;

  // 只分配"要用的那一段"（30 s ≈ 5 MB），而不是整曲。
  const pcm = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < frames; i++) pcm[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < frames; i++) pcm[i] /= channels;
  }

  // 这里之后不再引用 decoded —— 整个 AudioBuffer（~85 MB）即可被 GC。
  return { pcm, sampleRate: decoded.sampleRate };
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
