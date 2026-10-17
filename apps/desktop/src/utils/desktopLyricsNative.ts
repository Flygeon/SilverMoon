/**
 * 桌面歌词（Rust 原生窗口）的渲染进程封装。
 *
 * ## 与旧实现的区别
 *
 * 旧版用 Electron 的 \`BrowserWindow\`（label: desktop-lyrics）承载歌词窗口，
 * 但它**无法真嵌入任务栏**（实测：被 Chromium 抢回位置 + 渲染变黑）。
 * 现在窗口由独立的 Rust 进程创建（apps/desktop/lyrics），渲染进程只做三件事：
 * 推状态、推频谱、推设置。
 *
 * 本模块是**唯一**与那个进程打交道的地方 —— 业务代码不要直接碰 IPC 通道。
 */
import { callBridge } from "@/ipc/bridge";
import { isDesktop } from "@/capabilities";
import type { LyricLine } from "@shared/types";

/** 歌词进程握手信息。 */
export interface LyricsNativeInfo {
  hwnd: number;
  /** 是否成功真嵌入任务栏；false 表示窗口可能不在预期位置 */
  embedded: boolean;
}

export interface LyricsNativeSettings {
  fontSize?: number;
  opacity?: number;
  showTranslation?: boolean;
  showNext?: boolean;
  wordByWord?: boolean;
  align?: string;
  offsetX?: number;
  offsetY?: number;
}

/** 歌词进程是否可用（起不来时全部调用静默失败，不影响播放）。 */
let available = false;
let startPromise: Promise<LyricsNativeInfo | null> | null = null;

function invoke<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  return callBridge<T>("lyrics", { op, ...extra });
}

/**
 * 启动歌词窗口。幂等 —— 重复调用复用同一个 promise。
 *
 * @returns 握手信息；进程起不来时返回 null（调用方据此提示用户）
 */
export function startLyricsWindow(): Promise<LyricsNativeInfo | null> {
  if (!isDesktop) return Promise.resolve(null);
  if (startPromise) return startPromise;
  startPromise = invoke<LyricsNativeInfo | null>("start")
    .then((info) => {
      available = info !== null;
      // ⚠️ 失败时**必须清掉缓存**。
      //
      // 否则一次失败会被永久记住：之后每次调用都直接返回那个缓存的 null，
      // 用户把开关关了又开也救不回来（除非显式走 stopLyricsWindow 清缓存）。
      // 表现就是「第一次没起来，之后再怎么点都没反应」。
      if (info === null) startPromise = null;
      return info;
    })
    .catch(() => {
      // 启动失败不能让播放流程崩掉 —— 歌词是锦上添花。
      // 同样要清缓存，让用户能够重试。
      available = false;
      startPromise = null;
      return null;
    });
  return startPromise;
}

/** 关闭歌词窗口。 */
export async function stopLyricsWindow(): Promise<void> {
  if (!isDesktop) return;
  startPromise = null;
  available = false;
  try {
    await invoke("stop");
  } catch {
    /* 已经关了 */
  }
}

/** 推歌词状态。未启动时静默忽略。 */
export function pushLyricsState(payload: {
  lines: LyricLine[];
  currentTime: number;
  playing: boolean;
  title: string;
  artist: string;
  wordByWord: boolean;
}): void {
  if (!isDesktop || !available) return;
  void invoke("state", {
    state: {
      // 只带 start/end：units 里的 text/obscene 逐字渲染用不到，
      // 每 200ms 推一次全量文本会白白放大载荷。
      lines: payload.lines.map((l) => ({
        time: l.time,
        text: l.text,
        translation: l.translation,
        bg: l.bg?.text,
        units:
          payload.wordByWord && l.units?.length
            ? l.units.map((u) => ({ start: u.start, end: u.end }))
            : undefined,
      })),
      currentTime: payload.currentTime,
      playing: payload.playing,
      title: payload.title,
      artist: payload.artist,
    },
  }).catch(() => {});
}

/** 推频谱（无歌词时的替代显示）。 */
export function pushLyricsSpectrum(bins: number[]): void {
  if (!isDesktop || !available) return;
  void invoke("spectrum", { bins }).catch(() => {});
}

/** 推设置。 */
export function pushLyricsSettings(settings: LyricsNativeSettings): void {
  if (!isDesktop || !available) return;
  void invoke("settings", { settings }).catch(() => {});
}
