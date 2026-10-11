/**
 * IPC 调用的计量与统计。
 *
 * ## 为什么需要它
 *
 * `doc/IPC-PERFORMANCE.md` 里列了若干优化项，但**都没有数据支撑** ——
 * 「把 JSON 换成二进制能快多少」在测量之前只是猜测。
 * 本模块提供最小可用的计量：每次调用的耗时与载荷大小，按命令名聚合。
 *
 * ## 设计约束（都对齐全项目既有约定）
 *
 * - **默认关闭**：只在显式打开时记录。开着它会有每调用一次的开销，
 *   而这是个桌面应用，绝大多数用户不需要为诊断付这个成本。
 * - **不阻塞、不抛错**：与 `bootTiming.ts` 一致，计量本身绝不能成为故障源。
 * - **有界内存**：每个命令只留最近 N 次样本（环形缓冲），
 *   不会因长时间运行把内存吃掉。
 *
 * ## 怎么用
 *
 * ```js
 * // 控制台打开（立即开始记录）
 * localStorage.setItem("silvermoon:ipcMetrics", "1")
 * // 操作一会儿后查看
 * window.__silvermoonIpcStats()
 * ```
 *
 * 输出按「总耗时」降序，一眼能看出哪个命令最贵。
 */

/** 单个命令的聚合统计。 */
export interface IpcStat {
  /** 命令名 */
  cmd: string;
  /** 调用次数 */
  count: number;
  /** 总耗时（ms）—— 用于排序，找出「最贵」的命令 */
  totalMs: number;
  /** 平均耗时（ms） */
  avgMs: number;
  /** 最大耗时（ms）—— 找出「偶尔卡一下」的命令 */
  maxMs: number;
  /** P95 耗时（ms，近似：对样本排序后取 95 分位） */
  p95Ms: number;
  /** 失败的次数 */
  errors: number;
  /** 参数 JSON 的近似字节数（累计 / 平均） */
  argBytes: number;
  avgArgBytes: number;
}

/** 每个命令保留的样本数上限（环形缓冲）。 */
const MAX_SAMPLES = 512;

/** 单次调用的记录。 */
interface Sample {
  ms: number;
  argBytes: number;
  error: boolean;
}

/** 命令名 → 样本环形缓冲。 */
const samples = new Map<string, Sample[]>();

/** 是否启用。默认关（见文件头「设计约束」）。 */
let enabled = false;

// 初始化时读一次开关。
// 用 try 包住：隐私模式下 localStorage 可能不可用（与 gpuCanvas.ts 同样处理）。
try {
  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("silvermoon:ipcMetrics") === "1"
  ) {
    enabled = true;
  }
} catch {
  /* 读不到就保持关闭 */
}

/** 运行时开关（控制台可调，无需重启）。 */
export function setIpcMetricsEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem("silvermoon:ipcMetrics", on ? "1" : "0");
  } catch {
    /* 存不下也不影响本次会话 */
  }
}

/** 当前是否启用。 */
export function isIpcMetricsEnabled(): boolean {
  return enabled;
}

/**
 * 估算过桥参数的大小（字节）。
 *
 * 用 `JSON.stringify` 的长度近似 —— 真实开销是 Rust 侧 serde 的序列化量，
 * 与之同量级。**只用于横向比较哪个命令载荷大**，不作绝对值使用。
 *
 * 失败返回 0：参数里若有循环引用（或 BigInt），stringify 会抛，
 * 而计量绝不能因此影响调用。
 */
function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 记录一次 IPC 调用。由 `bridge.ts` 的 `invokeRaw` 调用。
 *
 * @param cmd 命令名
 * @param args 参数（用于估算载荷）
 * @param startedAt `performance.now()` 的起点
 * @param error 本次调用是否失败
 */
export function recordIpcCall(cmd: string, args: unknown, startedAt: number, error: boolean): void {
  if (!enabled) return;
  try {
    const ms = performance.now() - startedAt;
    const argBytes = estimateBytes(args);
    let list = samples.get(cmd);
    if (!list) {
      list = [];
      samples.set(cmd, list);
    }
    list.push({ ms, argBytes, error });
    // 环形缓冲：超出上限时丢最旧的，保证内存有界
    if (list.length > MAX_SAMPLES) list.shift();
  } catch {
    /* 计量失败绝不影响调用 */
  }
}

/** 取某次排序后数组的分位数（0～1）。空数组返回 0。 */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * 取出当前统计（按总耗时降序）。
 *
 * 顺带把「总耗时占比」算进返回值，方便直观看谁是大头 ——
 * 优化应当从占比最高的那项开始。
 */
export function getIpcStats(): (IpcStat & { totalShare: number })[] {
  const rows: (IpcStat & { totalShare: number })[] = [];
  let grandTotal = 0;
  for (const [cmd, list] of samples) {
    if (!list.length) continue;
    const times = list.map((s) => s.ms);
    const totalMs = times.reduce((a, b) => a + b, 0);
    grandTotal += totalMs;
    const sorted = [...times].sort((a, b) => a - b);
    const argTotal = list.reduce((a, s) => a + s.argBytes, 0);
    rows.push({
      cmd,
      count: list.length,
      totalMs,
      avgMs: totalMs / list.length,
      maxMs: sorted[sorted.length - 1],
      p95Ms: percentile(sorted, 0.95),
      errors: list.filter((s) => s.error).length,
      argBytes: argTotal,
      avgArgBytes: argTotal / list.length,
      totalShare: 0, // 先占位，grandTotal 算完再填
    });
  }
  for (const r of rows) r.totalShare = grandTotal > 0 ? r.totalMs / grandTotal : 0;
  return rows.sort((a, b) => b.totalMs - a.totalMs);
}

/** 清空统计。 */
export function resetIpcStats(): void {
  samples.clear();
}

// 控制台入口：即使没打开计量，也允许直接调用查看（会提示为空）。
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__silvermoonIpcStats = () => {
    const rows = getIpcStats();
    if (!rows.length) {
      console.info(
        "[ipc] 还没有数据。先打开计量：" +
          "localStorage.setItem('silvermoon:ipcMetrics','1') 然后刷新",
      );
      return rows;
    }
    // 用 console.table 输出：控制台里可直接排序查看
    console.table(
      rows.map((r) => ({
        命令: r.cmd,
        次数: r.count,
        总耗时ms: +r.totalMs.toFixed(1),
        占比: (r.totalShare * 100).toFixed(1) + "%",
        平均ms: +r.avgMs.toFixed(2),
        P95ms: +r.p95Ms.toFixed(2),
        最大ms: +r.maxMs.toFixed(1),
        失败: r.errors,
        平均参数B: Math.round(r.avgArgBytes),
      })),
    );
    return rows;
  };
  (window as unknown as Record<string, unknown>).__silvermoonIpcReset = resetIpcStats;
}
