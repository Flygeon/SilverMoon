/**
 * 「首屏就绪」信号。
 *
 * ## 它解决什么
 *
 * 宿主（Tauri）在收到这个信号之前**不显示主窗口**。这是照搬 Electron 时代的
 * READY 握手：先让原生启动动画顶着，等界面真正可看了再切过去。
 *
 * 为什么不能「窗口一出来就显示」：那样用户看到的是**中间态** ——
 * 空白网格、还没换肤的配色。等就绪再显示，第一眼就是成品。
 *
 * ## 什么时候算就绪
 *
 * 由调用方决定，目前有两处（谁先到算谁）：
 * 1. library.refresh() 首屏数据到位 —— 有内容可看；
 * 2. App.vue 主题应用后的兜底 —— 覆盖「启动落在非媒体库路由」的情形。
 *
 * ## 兜底是必须的
 *
 * armAppReadyFallback() 设一个硬上限：无论前面发生什么，到点都发信号。
 * 少了它，前端一旦抛错窗口就永远不显示 —— 那比慢几秒严重得多。
 * （宿主侧另有一道 10 秒看门狗，两道互不依赖。）
 */
import { capabilities, isDesktop } from "@/capabilities";

let sent = false;
let fallbackTimer: number | null = null;

/** 记录已发的信号，便于在宿主日志里对齐（幂等，只发第一次）。 */
function send(reason: string): void {
  if (sent) return;
  sent = true;
  if (fallbackTimer !== null) {
    window.clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (!isDesktop) return;
  try {
    capabilities.appReady(reason);
  } catch {
    /* 非桌面 / 桥不可用时静默：绝不能让就绪信号本身把启动搞挂 */
  }
}

/** 标记首屏就绪（幂等）。reason 只用于日志。 */
export function signalAppReady(reason: string): void {
  send(reason);
}

/**
 * 硬兜底：ms 之后无论如何都发信号。
 *
 * 重复调用只有第一次生效（避免多处 arm 互相覆盖）。
 */
export function armAppReadyFallback(ms = 1500): void {
  if (sent || fallbackTimer !== null) return;
  fallbackTimer = window.setTimeout(() => send("兜底超时"), ms);
}
