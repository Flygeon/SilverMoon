/**
 * AutoMix 分析 Worker：只负责收消息、调算法、回消息。
 *
 * 真正的算法在 `@/utils/autoMixAlgo`（纯函数，可被单元测试直接覆盖）。
 * 之所以这么分：早先算法写在 worker 里，测试只能「复制一份」来测，
 * 结果采样率相关的 bug 逃过了测试 —— 详见 autoMixAlgo.test.ts 的说明。
 *
 * PCM 用 transferable 传入，零拷贝；整首歌的 FFT + 自相关在主线程要几百毫秒，
 * 放 Worker 里做 UI 全程不卡。
 */
export {};

import { buildBeatGrid, detectSilence, estimateBpm, onsetEnvelope } from "@/utils/autoMixAlgo";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

interface AnalyzeJob {
  id: string;
  pcm: Float32Array;
  sampleRate: number;
}

interface AnalyzeResult {
  id: string;
  ok: boolean;
  error?: string;
  bpm: number;
  beatGrid: number[];
  silenceStart: number;
  silenceEnd: number;
  onsetCount: number;
  confidence: number;
}

ctx.onmessage = (e: MessageEvent) => {
  const job = e.data as AnalyzeJob;
  const { id, pcm, sampleRate } = job;
  const started = Date.now();
  try {
    const durationSec = pcm.length / sampleRate;
    // frameRate 已经是「每秒多少帧」，可直接当作包络的时间基
    const { env, frameRate: envRate } = onsetEnvelope(pcm, sampleRate);

    let onsets = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > 0) onsets++;

    const { bpm, confidence, period } = estimateBpm(env, envRate);
    const beatGrid = period > 0 ? buildBeatGrid(env, envRate, period, durationSec) : [];
    const { silenceStart, silenceEnd } = detectSilence(pcm, sampleRate);

    const result: AnalyzeResult = {
      id,
      ok: true,
      bpm: Math.round(bpm * 10) / 10,
      beatGrid,
      silenceStart: Math.round(silenceStart * 1000) / 1000,
      silenceEnd: Math.round(silenceEnd * 1000) / 1000,
      onsetCount: onsets,
      confidence: Math.round(confidence * 1000) / 1000,
    };
    ctx.postMessage({ result, elapsedMs: Date.now() - started });
  } catch (err) {
    ctx.postMessage({
      result: {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        bpm: 0,
        beatGrid: [],
        silenceStart: 0,
        silenceEnd: 0,
        onsetCount: 0,
        confidence: 0,
      } satisfies AnalyzeResult,
      elapsedMs: Date.now() - started,
    });
  }
};
