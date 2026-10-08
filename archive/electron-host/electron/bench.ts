/**
 * 内存基准测试（P0）。
 *
 * ## 为什么需要它
 *
 * `app.metrics`（见 `electron/ipc.ts`）只给**某一瞬间**的各进程工作集。要回答
 * 「这次改动到底省了多少内存」，需要的是**一段操作过程**的曲线：冷启动基线、
 * 逐页浏览、播放峰值、番剧取流、静置回落。人工点「刷新」记数字既不可比、也难复现。
 *
 * 这里把它做成一个**会话**：开始后按固定间隔自动采样，用户照常操作，需要时打一个
 * 带标签的标记（mark），结束后导出 JSON 报告。这样每次跑的都是同一套口径。
 *
 * ## 五组口径（务必固定，否则前后不可比）
 *
 * 1. **冷启动基线**：启动应用 → 等首屏稳定 10s → 标记「冷启动」。
 * 2. **逐页浏览**：依次进入 图片 / 视频 / 音乐 / 书籍 / 设置 并滚动到底 → 回主页 → 标记。
 * 3. **播放峰值**：播放一首 4 分钟本地歌曲 30s → 标记（看主窗口渲染进程的 peak）。
 * 4. **番剧取流**：打开番剧页取一次流 → 关闭 → 标记（验证隐藏窗是否按需创建/销毁）。
 * 5. **静置回落**：静置 5 分钟 → 标记（看是否回落，判断泄漏）。
 *
 * ## 设计约束
 *
 * - 本模块**不 import electron**：采样源由调用方注入（`() => app.getAppMetrics()`）。
 *   这样 `buildSample` / `summarize` 是纯函数，能在 vitest 里直接跑。
 * - 采样有**硬上限**（`MAX_SAMPLES`）：基准工具自己不能成为内存问题。
 */

/** 采样间隔下限：再密下去，采样本身会干扰被测对象。 */
export const MIN_INTERVAL_MS = 500;
/** 默认采样间隔。 */
export const DEFAULT_INTERVAL_MS = 2000;
/** 采样条数上限（2s × 3600 ≈ 2 小时），防止长会话把基准数据撑爆。 */
export const MAX_SAMPLES = 3600;
/** 单个标签的长度上限，避免 UI/报告被异常输入撑坏。 */
export const MAX_MARK_LABEL = 64;

/**
 * `app.getAppMetrics()` 返回项的最小结构。
 *
 * 只声明用得到的字段：这样本模块不必依赖 electron 的类型，也就可在纯 Node 下测试。
 */
export interface RawProcessMetric {
  pid: number;
  type: string;
  name?: string;
  memory?: { workingSetSize?: number; peakWorkingSetSize?: number };
  cpu?: { percentCPUUsage?: number };
}

/** 单个进程的一次采样。 */
export interface BenchProcessSample {
  pid: number;
  type: string;
  name: string;
  workingSetMB: number;
  peakMB: number;
  cpu: number;
}

/** 一次采样（整机视角）。 */
export interface BenchSample {
  /** 相对会话开始的毫秒数 */
  t: number;
  /** 各进程工作集之和 */
  totalMB: number;
  processes: BenchProcessSample[];
}

/** 用户打下的标记（与最近一次采样同刻）。 */
export interface BenchMark {
  t: number;
  label: string;
  totalMB: number;
}

/** 某个逻辑进程（按 type+name 归并）在本会话内的峰值。 */
export interface BenchProcessPeak {
  /** `type` + `name` 归并键（name 为空时退化为 type+pid） */
  key: string;
  type: string;
  name: string;
  /** 进程自身报告的峰值工作集（app.getAppMetrics 的 peakWorkingSetSize） */
  peakWorkingSetMB: number;
  /** 本会话采样到的最大工作集 */
  maxWorkingSetMB: number;
}

/**
 * 标记的汇总。
 *
 * 每个标记对应五组口径里的一步，直接给出「相对冷启动基线涨了多少」——
 * 这是报告里最该先看的数字。
 */
export interface BenchMarkSummary {
  label: string;
  t: number;
  totalMB: number;
  /** 相对基线（首条采样）的增量 */
  deltaMB: number;
}

/** 会话汇总。 */
export interface BenchSummary {
  durationMs: number;
  sampleCount: number;
  /** 首次采样（冷启动基线） */
  baselineMB: number;
  /** 末次采样 */
  finalMB: number;
  minMB: number;
  minAtMs: number;
  maxMB: number;
  maxAtMs: number;
  /** 峰值相对基线的增量（内存优化真正要看的数字） */
  deltaMaxMB: number;
  /** 末尾相对基线的增量（判断是否回落） */
  deltaFinalMB: number;
  processPeaks: BenchProcessPeak[];
  /** 各标记相对基线的增量（按打点顺序） */
  markSummary: BenchMarkSummary[];
}

/** 完整报告（导出到磁盘的就是它）。 */
export interface BenchReport {
  /** 报告格式版本；字段变化时 +1，便于脚本判断兼容性 */
  version: 1;
  startedAt: string;
  endedAt: string;
  intervalMs: number;
  samples: BenchSample[];
  marks: BenchMark[];
  summary: BenchSummary;
}

/** 保留一位小数。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** KB → MB（app.getAppMetrics 的 workingSetSize 单位是 KB）。 */
function kbToMb(kb: number | undefined): number {
  return round1((kb ?? 0) / 1024);
}

/** 归一化一个进程名（空名退化，避免所有匿名进程挤成一格）。 */
function processKey(p: { type: string; name: string; pid: number }): string {
  return p.name ? `${p.type}\u0000${p.name}` : `${p.type}\u0000#${p.pid}`;
}

/**
 * 把一次 `app.getAppMetrics()` 结果归一化成一条采样。**纯函数**。
 *
 * @param raws 原始进程指标
 * @param t 相对会话开始的毫秒数
 */
export function buildSample(raws: readonly RawProcessMetric[], t: number): BenchSample {
  const processes: BenchProcessSample[] = raws.map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name ?? "",
    workingSetMB: kbToMb(m.memory?.workingSetSize),
    peakMB: kbToMb(m.memory?.peakWorkingSetSize),
    cpu: round1(m.cpu?.percentCPUUsage ?? 0),
  }));
  return {
    t,
    totalMB: round1(processes.reduce((sum, p) => sum + p.workingSetMB, 0)),
    processes,
  };
}

/**
 * 汇总一个会话。**纯函数**（无副作用、不依赖时间）。
 *
 * @param samples 采样序列（按时间升序）
 * @param marks 标记序列
 * @param durationMs 会话时长
 */
export function summarize(
  samples: readonly BenchSample[],
  marks: readonly BenchMark[],
  durationMs: number,
): BenchSummary {
  if (samples.length === 0) {
    return {
      durationMs: 0,
      sampleCount: 0,
      baselineMB: 0,
      finalMB: 0,
      minMB: 0,
      minAtMs: 0,
      maxMB: 0,
      maxAtMs: 0,
      deltaMaxMB: 0,
      deltaFinalMB: 0,
      processPeaks: [],
      markSummary: [],
    };
  }

  const baselineMB = samples[0].totalMB;
  const finalMB = samples[samples.length - 1].totalMB;

  let min = samples[0];
  let max = samples[0];
  for (const s of samples) {
    if (s.totalMB < min.totalMB) min = s;
    if (s.totalMB > max.totalMB) max = s;
  }

  // 按 type+name 归并峰值：pid 在会话内一般稳定，但重启后可变，用名字更可比
  const peaks = new Map<string, BenchProcessPeak>();
  for (const s of samples) {
    for (const p of s.processes) {
      const key = processKey(p);
      const prev = peaks.get(key);
      if (!prev) {
        peaks.set(key, {
          key,
          type: p.type,
          name: p.name,
          peakWorkingSetMB: p.peakMB,
          maxWorkingSetMB: p.workingSetMB,
        });
        continue;
      }
      if (p.peakMB > prev.peakWorkingSetMB) prev.peakWorkingSetMB = p.peakMB;
      if (p.workingSetMB > prev.maxWorkingSetMB) prev.maxWorkingSetMB = p.workingSetMB;
    }
  }

  const processPeaks = [...peaks.values()].sort((a, b) => b.maxWorkingSetMB - a.maxWorkingSetMB);

  const markSummary: BenchMarkSummary[] = marks.map((m) => ({
    label: m.label,
    t: m.t,
    totalMB: m.totalMB,
    deltaMB: round1(m.totalMB - baselineMB),
  }));

  return {
    durationMs: Math.max(0, Math.round(durationMs)),
    sampleCount: samples.length,
    baselineMB,
    finalMB,
    minMB: min.totalMB,
    minAtMs: min.t,
    maxMB: max.totalMB,
    maxAtMs: max.t,
    deltaMaxMB: round1(max.totalMB - baselineMB),
    deltaFinalMB: round1(finalMB - baselineMB),
    processPeaks,
    markSummary,
  };
}

/** 会话状态（给 UI 判断按钮可用性）。 */
export interface BenchStatus {
  running: boolean;
  intervalMs: number;
  sampleCount: number;
  markCount: number;
  /** 会话已运行毫秒数（未开始为 0） */
  elapsedMs: number;
}

/**
 * 一次基准会话。
 *
 * 采样源由构造参数注入 —— 生产环境传 `() => app.getAppMetrics()`，
 * 测试传一个假数组。类本身不依赖 electron。
 */
export class BenchSession {
  private samples: BenchSample[] = [];
  private marks: BenchMark[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = 0;
  /** 是否已 start 过。**不能用 startedAtMs === 0 代替**：
   *  注入的时钟完全可能从 0 起算（测试即如此），那样会把"已开始"误判成"未开始"。 */
  private started = false;
  private intervalMs = DEFAULT_INTERVAL_MS;

  constructor(
    private readonly provider: () => readonly RawProcessMetric[],
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 是否正在自动采样。 */
  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * 开始（或重启）一次会话。
   *
   * 重复调用会先停掉上一轮并清空数据 —— 基准必须从干净状态起跑，
   * 否则「基线」会被上一轮的高水位污染。
   */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): BenchStatus {
    this.stop();
    this.clear();
    this.intervalMs = Math.max(MIN_INTERVAL_MS, Math.round(intervalMs));
    this.started = true;
    this.startedAtMs = this.now();
    this.take();
    this.timer = setInterval(() => this.take(), this.intervalMs);
    // 基准工具不该把 Electron 主进程钉住：Node 定时器默认会保持事件循环，
    // 显式 unref 让应用在只有采样器存活时也能正常退出。
    (this.timer as unknown as { unref?: () => void }).unref?.();
    return this.status();
  }

  /** 停止自动采样（保留已采数据，仍可 report）。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 手动采一条（自动采样之外补点用）。 */
  take(): BenchSample {
    const raw = buildSample(this.provider(), this.elapsed());
    this.samples.push(raw);
    // 硬上限：超出后丢最老的（保留最近窗口，避免基准数据自己变成内存问题）
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
    return raw;
  }

  /** 打一个标记，标签与最近一次采样同刻。 */
  mark(label: string): BenchMark | null {
    if (this.samples.length === 0) return null;
    const trimmed = label.trim().slice(0, MAX_MARK_LABEL);
    if (!trimmed) return null;
    const last = this.samples[this.samples.length - 1];
    const m: BenchMark = { t: this.elapsed(), label: trimmed, totalMB: last.totalMB };
    this.marks.push(m);
    return m;
  }

  /** 清空全部数据（不改变运行状态）。 */
  clear(): void {
    this.samples = [];
    this.marks = [];
  }

  /** 当前状态。 */
  status(): BenchStatus {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      sampleCount: this.samples.length,
      markCount: this.marks.length,
      elapsedMs: this.started ? this.elapsed() : 0,
    };
  }

  /** 生成报告。 */
  report(): BenchReport {
    const durationMs = this.started ? this.elapsed() : 0;
    const endedAtMs = this.now();
    return {
      version: 1,
      startedAt: new Date(this.started ? this.startedAtMs : endedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      intervalMs: this.intervalMs,
      samples: this.samples,
      marks: this.marks,
      summary: summarize(this.samples, this.marks, durationMs),
    };
  }

  private elapsed(): number {
    if (!this.started) return 0;
    return Math.max(0, this.now() - this.startedAtMs);
  }
}
