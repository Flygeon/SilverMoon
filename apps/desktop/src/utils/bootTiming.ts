/**
 * 渲染进程启动打点（把首屏各阶段耗时写进主进程 main.log）。
 *
 * 为什么需要它：主进程早有 `[启动] xxx: NNms` 打点（见 electron/main.ts），
 * 但渲染侧一个都没有 —— 于是「启动慢」只能猜。实测（Linux/xvfb）主进程
 * bootstrap 仅约 32ms，而 Vue 挂载 ~214ms、首屏内容 ~270ms、splash 收起 ~552ms，
 * 瓶颈全在渲染进程，却没有任何可观测指标。
 *
 * 设计要点：
 * - **零依赖、零 await**：打点走主进程 `app.logBoot`（不走 Rust 的 app_log，
 *   那条要侧车在线，而启动打点必须在「后端未就绪」时也能记录）；
 * - **不阻塞**：fire-and-forget，失败静默。打点绝不能成为新的启动成本；
 * - 以模块加载（≈ 入口 chunk 执行）为 t0，与 Chromium 的 navigationStart 对齐不够准，
 *   但对「阶段之间谁贵」足够。
 */

import { capabilities } from "@/capabilities";

/** t0：本模块被求值的时间，近似「入口 chunk 开始执行」 */
const bootT0 = typeof performance !== "undefined" ? performance.now() : 0;

/** 已打过的点，避免重复（HMR / 重复调用） */
const reported = new Set<string>();

/**
 * 记录一个启动阶段耗时（相对 t0）。
 *
 * @param mark 阶段名（中文，与主进程日志风格一致）
 */
export function markBoot(mark: string): void {
  if (reported.has(mark)) return;
  reported.add(mark);
  try {
    const since = typeof performance !== "undefined" ? performance.now() - bootT0 : 0;
    capabilities.appLogBoot(mark, since);
  } catch {
    /* 打点失败绝不影响启动 */
  }
}

/** 首个内容绘制（FCP）出现时打点；浏览器不支持时静默跳过。 */
export function markFirstPaint(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          markBoot("首帧内容绘制(FCP)");
          obs.disconnect();
          return;
        }
      }
    });
    obs.observe({ type: "paint", buffered: true });
  } catch {
    /* 不支持 paint 观测时忽略 */
  }
}
