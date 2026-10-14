/**
 * 主窗口侧的频谱推送器。
 *
 * ## 为什么在主窗口而不是桌面歌词窗口采集
 *
 * `createMediaElementSource` 对同一个 audio 元素**只能调用一次**，
 * 而音频元素归主窗口的 player store 所有。桌面歌词窗口是独立渲染进程，
 * 它没有那个元素，也不可能拿到 —— 所以只能在主窗口读取频谱值，
 * 再把**结果**（64 个整数）推过去。这也是为什么不引第二条 AudioContext：
 * 那会导致同一路音频被两套图处理，出现设备占用或回音。
 *
 * ## 为什么单独一条事件通道
 *
 * 频谱约 20Hz，而歌词状态是 200ms 且载荷大（整份歌词 + 逐字时间轴）。
 * 混在一起会让每次频谱刷新都重传整份歌词。分开后各自的频率与载荷互不影响。
 */
import { isDesktop } from "@/capabilities";
import { emitDesktopLyricsSpectrum } from "@/utils/desktopLyrics";
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
    // 读不到就跳过这一帧，不要把 null 推过去覆盖掉上一帧画面
    if (bins) void emitDesktopLyricsSpectrum(bins).catch(() => {});
  }, INTERVAL_MS);
  return true;
}

/** 停止推送（关闭频谱显示 / 窗口关闭时调用）。 */
export function stopSpectrumPush(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}
