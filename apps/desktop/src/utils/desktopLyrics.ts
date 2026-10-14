/**
 * 桌面歌词：独立透明置顶窗口的原生/事件封装。
 *
 * 主窗口负责创建/关闭窗口，并通过事件推送歌词状态；
 * 桌面歌词窗口负责展示与回传控件命令、位置尺寸。
 */
import { createWindow, getCurrentWindow, getWindowByLabel } from "@/ipc/window";
import { LogicalPosition, LogicalSize } from "@/ipc/dpi";
import { emitTo } from "@/ipc/events";
import { isDesktop } from "@/capabilities";
import type { DesktopLyricsBounds } from "@/stores/settings";

export const DESKTOP_LYRICS_LABEL = "desktop-lyrics";

export const DL_STATE_EVENT = "desktop-lyrics:state";
export const DL_READY_EVENT = "desktop-lyrics:ready";
export const DL_CONTROL_EVENT = "desktop-lyrics:control";
export const DL_BOUNDS_EVENT = "desktop-lyrics:bounds";
/**
 * 主窗口 → 桌面歌词：频谱数据（无歌词时的替代显示）。
 *
 * 单独一条通道而不是塞进 DL_STATE_EVENT：频谱是**高频**数据（约 15-20Hz），
 * 而歌词状态是低频（200ms）且载荷大（整份歌词行 + 逐字时间轴）。
 * 混在一起会让每次频谱刷新都重传整份歌词。
 */
export const DL_SPECTRUM_EVENT = "desktop-lyrics:spectrum";

/** 推送频谱数据（主窗口调用） */
export async function emitDesktopLyricsSpectrum(bins: number[]): Promise<void> {
  if (!isDesktop) return;
  try {
    await emitTo(DESKTOP_LYRICS_LABEL, DL_SPECTRUM_EVENT, { bins });
  } catch {
    /* 窗口尚未就绪 */
  }
}

export interface DesktopLyricLine {
  time: number;
  text: string;
  translation?: string;
  romaji?: string;
  /** 背景和声子行文本（无则空）——桌面歌词窗口按副行展示 */
  bg?: string;
  /**
   * 逐字时间轴（秒，绝对时间）。
   *
   * 只在 `desktopLyricsWordByWord` 开启时下发，且**只在歌词真正变化时**随
   * 整包推送 —— 播放进度不走这条通道（它走 200ms 节流的 currentTime），
   * 逐字填充由桌面窗口自己用 rAF 按 audio 时间外推。
   * 这样既拿到逐字效果，又不必提高推送频率（上游 TaskbarLyrics 的教训）。
   */
  units?: DesktopLyricUnit[];
}

export interface DesktopLyricUnit {
  /** 起始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
}

export interface DesktopLyricsState {
  lines: DesktopLyricLine[];
  currentTime: number;
  playing: boolean;
  title: string;
  artist: string;
}

export type DesktopLyricsControlAction = "toggle" | "next" | "prev" | "close";

export interface DesktopLyricsControl {
  action: DesktopLyricsControlAction;
}

/** 当前窗口是否是桌面歌词窗口 */
export async function isDesktopLyricsWindow(): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    const win = getCurrentWindow();
    return win.label === DESKTOP_LYRICS_LABEL;
  } catch {
    return false;
  }
}

/** 主窗口：创建桌面歌词窗口（存在则先复用） */
export async function openDesktopLyricsWindow(bounds: DesktopLyricsBounds): Promise<void> {
  if (!isDesktop) return;
  const existing = await getWindowByLabel(DESKTOP_LYRICS_LABEL);
  if (existing) {
    existing.show();
    existing.setFocus();
    return;
  }
  const base = window.location.href.split("#")[0];
  createWindow(DESKTOP_LYRICS_LABEL, {
    url: `${base}#/desktop-lyrics`,
    title: "桌面歌词",
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    shadow: false,
    resizable: true,
    minWidth: 260,
    minHeight: 70,
    x: bounds.x ?? undefined,
    y: bounds.y ?? undefined,
    width: bounds.width,
    height: bounds.height,
    visible: true,
  });
}

/** 主窗口：关闭桌面歌词窗口 */
export async function closeDesktopLyricsWindow(): Promise<void> {
  if (!isDesktop) return;
  try {
    const win = await getWindowByLabel(DESKTOP_LYRICS_LABEL);
    if (win) await win.close();
  } catch {
    /* 窗口可能已销毁 */
  }
}

/** 主窗口：向桌面歌词窗口推送歌词状态 */
export async function emitDesktopLyricsState(state: DesktopLyricsState): Promise<void> {
  if (!isDesktop) return;
  try {
    await emitTo(DESKTOP_LYRICS_LABEL, DL_STATE_EVENT, state);
  } catch {
    /* 窗口尚未就绪 */
  }
}

/** 桌面歌词窗口：通知主窗口已就绪，触发主窗口回推状态 */
export async function emitDesktopLyricsReady(): Promise<void> {
  if (!isDesktop) return;
  try {
    await emitTo("main", DL_READY_EVENT, null);
  } catch {
    /* ignore */
  }
}

/** 桌面歌词窗口：向主窗口发送控制命令 */
export async function emitDesktopLyricsControl(action: DesktopLyricsControlAction): Promise<void> {
  if (!isDesktop) return;
  try {
    await emitTo("main", DL_CONTROL_EVENT, { action } satisfies DesktopLyricsControl);
  } catch {
    /* ignore */
  }
}

/** 桌面歌词窗口：上报窗口位置/尺寸，主窗口负责持久化 */
export async function emitDesktopLyricsBounds(bounds: DesktopLyricsBounds): Promise<void> {
  if (!isDesktop) return;
  try {
    await emitTo("main", DL_BOUNDS_EVENT, bounds);
  } catch {
    /* ignore */
  }
}

/** 主窗口：把子窗口的逻辑坐标转成可保存的设置对象 */
export function toLogicalBounds(
  position: { x: number; y: number },
  size: { width: number; height: number },
): DesktopLyricsBounds {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/** 在逻辑坐标与物理坐标间按 scale 换算（窗口事件给的是物理坐标） */
export function physicalToLogical(physical: {
  x: number;
  y: number;
  width: number;
  height: number;
}): DesktopLyricsBounds {
  return { x: physical.x, y: physical.y, width: physical.width, height: physical.height };
}

export { LogicalPosition, LogicalSize };
