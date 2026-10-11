/**
 * 把 IPC 计量接到「可事后读取」的通路上。
 *
 * ## 为什么单独一个模块
 *
 * `ipcMetrics.ts` 是零依赖的（`bridge.ts` 要 import 它，不能反向依赖 capabilities，
 * 否则形成 `ipcMetrics → capabilities → ipc/invoke → bridge → ipcMetrics` 的循环）。
 * 而「把报告写进日志」必须用到 `capabilities.appLog`，所以装配放在这里，
 * 由 `main.ts` 在挂载后惰性引入。
 *
 * ## 为什么必须能写日志
 *
 * 初版只做了 `console.table` —— 那只有**人坐在 devtools 前**才看得到。
 * 但排查的真实形态是「跑一遍操作，事后看留下的数据」，
 * 而且我需要能读到它。写进 `lumiluna_login_debug.log` 后两件事都成立。
 *
 * ## 自动上报
 *
 * 开启计量后每 60 秒检查一次：**只有样本数变过**才写（避免空转刷日志）。
 * 因此你只要开启一次、正常用一会儿，数据就会自己落到日志里。
 */
import { capabilities } from "@/capabilities";

import {
  formatIpcReport,
  isIpcMetricsEnabled,
  resetIpcStats,
  setIpcMetricsEnabled,
  totalSampleCount,
} from "./ipcMetrics";

/** 自动上报间隔（毫秒）。 */
const AUTO_DUMP_MS = 60_000;

/** 上次上报时的样本数，用于「有新活动才写」的判断。 */
let lastReported = 0;

/** 自动上报定时器句柄（0 表示未启动）。 */
let timer = 0;

/** 把当前报告写进日志文件。失败静默 —— 诊断绝不能影响应用。 */
async function dumpToLog(reason: string): Promise<string> {
  const report = formatIpcReport();
  try {
    // appLog 落在 <临时目录>/lumiluna_login_debug.log（见 Rust 侧 login_debug_log）
    await capabilities.appLog(`[ipc] ${reason}\n${report}`);
  } catch {
    /* 写日志失败不影响调用方 */
  }
  return report;
}

/** 启动自动上报（幂等）。 */
function startAutoDump(): void {
  if (timer) return;
  timer = window.setInterval(() => {
    if (!isIpcMetricsEnabled()) return;
    const n = totalSampleCount();
    // 没有新样本就不写：长时间挂机不会把日志刷爆
    if (n === lastReported) return;
    lastReported = n;
    void dumpToLog("自动上报");
  }, AUTO_DUMP_MS);
}

/**
 * 在 window 上装控制台接口。
 *
 * ```js
 * __silvermoonIpcEnable()   // 开启（无需刷新，立即生效）
 * __silvermoonIpcDump()     // 立刻把报告写进日志，并返回文本
 * __silvermoonIpcDisable()  // 关闭
 * ```
 */
export function installIpcMetricsConsole(): void {
  const w = window as unknown as Record<string, unknown>;

  w.__silvermoonIpcEnable = () => {
    setIpcMetricsEnabled(true);
    lastReported = 0;
    startAutoDump();
    return "IPC 计量已开启（每 60 秒自动写入日志；也可用 __silvermoonIpcDump() 立即写）";
  };

  w.__silvermoonIpcDisable = () => {
    setIpcMetricsEnabled(false);
    return "IPC 计量已关闭";
  };

  w.__silvermoonIpcDump = () => {
    void dumpToLog("手动上报");
    return formatIpcReport();
  };

  w.__silvermoonIpcResetAll = () => {
    resetIpcStats();
    lastReported = 0;
    return "统计已清空";
  };

  // 上次会话已开启时，本次启动直接续上
  if (isIpcMetricsEnabled()) startAutoDump();
}
