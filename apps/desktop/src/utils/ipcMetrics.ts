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

/** 递归深度上限：超过就按常量估，避免深对象把计量本身变成开销。 */
const MAX_DEPTH = 4;
/** 单个数组/对象最多数多少个元素。 */
const MAX_ITEMS = 64;

/**
 * 估算过桥参数的大小（字节）。
 *
 * ⚠️ **不能用 `JSON.stringify(value).length`** —— 初版就是这么写的，有两个问题：
 *
 * 1. **二进制会被灾难性放大**：`JSON.stringify(new Uint8Array(1MB))` 会先造出一个
 *    上百万项的**数字数组字符串**（约 4 MB），既慢又占内存。而 `writeFile` /
 *    `saveThumbnail` 这类调用恰恰带着 `Uint8Array` —— 等于给它们平白加一倍工作量。
 * 2. 循环引用会抛（虽有 try/catch，但那样就测不到大小了）。
 *
 * 因此改为**有界遍历**：只数到 `MAX_DEPTH` / `MAX_ITEMS`；
 * 遇到二进制直接用 `byteLength`（O(1) 且精确）。
 *
 * 精度取舍：这是**相对指标**，用于比较「哪个命令载荷大」，不作绝对值使用。
 */
function estimateBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 4;
  switch (typeof value) {
    case "number":
      return 8;
    case "boolean":
      return 5;
    case "bigint":
      return 8;
    case "string":
      return value.length;
    case "function":
    case "symbol":
      return 0;
    default:
      break;
  }

  // 二进制：byteLength 精确且 O(1) —— 这正是要避开 JSON.stringify 的原因
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;

  // 到深度上限就按常量估（循环引用也会在此终止）
  if (depth >= MAX_DEPTH) return 8;

  if (Array.isArray(value)) {
    let n = 2;
    const len = Math.min(value.length, MAX_ITEMS);
    for (let i = 0; i < len; i++) n += estimateBytes(value[i], depth + 1) + 1;
    return n;
  }
  if (value instanceof Map)
    return 2 + Math.min((value as Map<unknown, unknown>).size, MAX_ITEMS) * 16;
  if (value instanceof Set) return 2 + Math.min((value as Set<unknown>).size, MAX_ITEMS) * 16;
  if (value instanceof Date) return 24;

  let n = 2;
  let counted = 0;
  for (const key in value as Record<string, unknown>) {
    if (counted++ >= MAX_ITEMS) break;
    n += key.length + estimateBytes((value as Record<string, unknown>)[key], depth + 1) + 4;
  }
  return n;
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

/** 当前累计的样本总数。用于「有新活动才上报」的判断。 */
export function totalSampleCount(): number {
  let n = 0;
  for (const list of samples.values()) n += list.length;
  return n;
}

/**
 * 生成**纯文本**报告（面向日志文件，不是控制台）。
 *
 * 为什么需要它：`console.table` 只能人在 devtools 里看，
 * 而排查往往是「跑一遍 → 看事后留下的数据」。写进日志文件后，
 * 事后可以直接读，也能贴给别人看。
 *
 * 格式固定为每行一条「cmd | 次数 | 总ms | 占比 | 平均 | P95 | 最大 | 失败 | 平均参数B」，
 * 便于 grep 与肉眼扫。
 *
 * @param topN 只列最贵的前 N 条（默认 15），避免日志被刷爆
 */
export function formatIpcReport(topN = 15): string {
  const rows = getIpcStats();
  if (!rows.length) return "（无样本）";
  const grandTotal = rows.reduce((a, r) => a + r.totalMs, 0);
  const calls = rows.reduce((a, r) => a + r.count, 0);
  const head =
    `共 ${calls} 次调用 / ${rows.length} 个命令 / 合计 ${grandTotal.toFixed(0)}ms` +
    (rows.length > topN ? `（下列前 ${topN} 条）` : "");
  const lines = rows
    .slice(0, topN)
    .map((r) =>
      [
        r.cmd,
        `${r.count}次`,
        `${r.totalMs.toFixed(0)}ms`,
        `${(r.totalShare * 100).toFixed(1)}%`,
        `均${r.avgMs.toFixed(2)}`,
        `P95 ${r.p95Ms.toFixed(1)}`,
        `峰${r.maxMs.toFixed(0)}`,
        r.errors ? `失败${r.errors}` : "失败0",
        `参${Math.round(r.avgArgBytes)}B`,
      ].join(" | "),
    );
  return [head, ...lines].join("\n");
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
