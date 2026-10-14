/**
 * 主窗口侧的频谱采集与推送。
 *
 * ## 为什么在主窗口采集
 *
 * \`createMediaElementSource\` 对同一个 audio 元素**只能调用一次**，
 * 而音频元素归主窗口的 player store 所有。Rust 歌词进程是**另一个进程**，
 * 它拿不到那个元素，也不可能拿到 —— 所以只能在主窗口读频谱值，
 * 再把**结果**（64 个整数）推过去。
 *
 * 这也解释了为什么不引第二条 AudioContext：同一路音频被两套图处理，
 * 会出现设备占用或回音。
 */
import { isDesktop } from "@/capabilities";
import { pushLyricsSpectrum } from "@/utils/desktopLyricsNative";
import { ensureSpectrum, readSpectrum } from "@/utils/spectrum";

/** 推送间隔（ms）。20Hz 对柱状图足够，再高只会徒增 IPC 而无视觉收益。 */
const INTERVAL_MS = 50;

let timer: number | null = null;

/**
 * 开始推送频谱。
 *
 * @param media 播放用的 audio 元素（用于接入分析链，仅首次需要）
 * @returns 是否成功启动（false = 分析链不可用，调用方应放弃频谱显示）
 */
export function startSpectrumPush(media: HTMLAudioElement | null): boolean {
  if (!isDesktop || !media) return false;
  if (timer !== null) return true;
  if (!ensureSpectrum(media)) return false;

  timer = window.setInterval(() => {
    const bins = readSpectrum();
    // 读不到就跳过这一帧，不要把空数据推过去覆盖掉上一帧画面
    if (bins) pushLyricsSpectrum(bins);
  }, INTERVAL_MS);
  return true;
}

/** 停止推送（关闭频谱显示 / 窗口关闭时调用）。 */
export function stopSpectrumPush(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}
