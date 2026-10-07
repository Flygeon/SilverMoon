/**
 * 内存基准测试的单元测试。
 *
 * 只测**纯逻辑**（采样归一化、汇总、会话状态机）——这些是报告正确性的根，
 * 也是唯一能在无 Electron 环境下验证的部分。真实 RSS 必须在装了应用后按
 * `electron/bench.ts` 文件头的五组口径实测。
 */
import { describe, expect, it } from "vitest";

import {
  BenchSession,
  buildSample,
  summarize,
  type RawProcessMetric,
  MAX_MARK_LABEL,
} from "../bench";

/** 构造一条 `app.getAppMetrics()` 风格的原始项。 */
function raw(
  pid: number,
  type: string,
  name: string,
  workingSetKB: number,
  peakKB: number = workingSetKB,
): RawProcessMetric {
  return {
    pid,
    type,
    name,
    memory: { workingSetSize: workingSetKB, peakWorkingSetSize: peakKB },
    cpu: { percentCPUUsage: 1.25 },
  };
}

describe("buildSample", () => {
  it("把 KB 换算成 MB，并求和为整机工作集", () => {
    const s = buildSample([raw(1, "Browser", "", 102400), raw(2, "Tab", "main", 204800)], 0);
    expect(s.processes[0].workingSetMB).toBe(100);
    expect(s.processes[1].workingSetMB).toBe(200);
    expect(s.totalMB).toBe(300);
  });

  it("缺字段时按 0 处理，不抛异常", () => {
    const s = buildSample([{ pid: 9, type: "GPU" }], 12);
    expect(s.processes[0].workingSetMB).toBe(0);
    expect(s.processes[0].peakMB).toBe(0);
    expect(s.processes[0].cpu).toBe(0);
    expect(s.processes[0].name).toBe("");
    expect(s.totalMB).toBe(0);
    expect(s.t).toBe(12);
  });

  it("保留一位小数", () => {
    // 1536 KB = 1.5 MB；2560 KB = 2.5 MB
    const s = buildSample([raw(1, "Browser", "", 1536)], 0);
    expect(s.processes[0].workingSetMB).toBe(1.5);
  });
});

describe("summarize", () => {
  const mk = (
    t: number,
    total: number,
    procs: { pid: number; type: string; name: string; ws: number; peak: number }[] = [],
  ) => ({
    t,
    totalMB: total,
    processes: procs.map((p) => ({
      pid: p.pid,
      type: p.type,
      name: p.name,
      workingSetMB: p.ws,
      peakMB: p.peak,
      cpu: 0,
    })),
  });

  it("空采样返回零值汇总", () => {
    const s = summarize([], [], 0);
    expect(s.sampleCount).toBe(0);
    expect(s.baselineMB).toBe(0);
    expect(s.processPeaks).toEqual([]);
  });

  it("基线取首条、末值取末条，峰值与增量正确", () => {
    const samples = [mk(0, 300), mk(2000, 420), mk(4000, 360)];
    const s = summarize(samples, [], 4000);
    expect(s.baselineMB).toBe(300);
    expect(s.finalMB).toBe(360);
    expect(s.maxMB).toBe(420);
    expect(s.maxAtMs).toBe(2000);
    expect(s.minMB).toBe(300);
    expect(s.deltaMaxMB).toBe(120);
    expect(s.deltaFinalMB).toBe(60);
    expect(s.sampleCount).toBe(3);
  });

  it("按 type+name 归并进程峰值，并按最大工作集降序", () => {
    const samples = [
      mk(0, 300, [
        { pid: 1, type: "Tab", name: "main", ws: 150, peak: 200 },
        { pid: 2, type: "GPU", name: "", ws: 60, peak: 60 },
      ]),
      mk(2000, 480, [
        { pid: 1, type: "Tab", name: "main", ws: 320, peak: 400 },
        { pid: 2, type: "GPU", name: "", ws: 60, peak: 70 },
      ]),
    ];
    const s = summarize(samples, [], 2000);
    expect(s.processPeaks).toHaveLength(2);
    // 主窗口渲染进程最大工作集 320，排第一
    expect(s.processPeaks[0].name).toBe("main");
    expect(s.processPeaks[0].maxWorkingSetMB).toBe(320);
    // 进程自报峰值取会话内最大
    expect(s.processPeaks[0].peakWorkingSetMB).toBe(400);
    // GPU 名称为空 → 用 type+pid 归并，仍能独立统计
    expect(s.processPeaks[1].type).toBe("GPU");
    expect(s.processPeaks[1].maxWorkingSetMB).toBe(60);
  });

  it("markSummary 给出各标记相对基线的增量", () => {
    const samples = [mk(0, 300), mk(2000, 420), mk(4000, 360)];
    const marks = [
      { t: 2000, label: "逐页", totalMB: 420 },
      { t: 4000, label: "静置", totalMB: 360 },
    ];
    const s = summarize(samples, marks, 4000);
    expect(s.markSummary).toHaveLength(2);
    expect(s.markSummary[0]).toMatchObject({ label: "逐页", deltaMB: 120 });
    expect(s.markSummary[1]).toMatchObject({ label: "静置", deltaMB: 60 });
  });

  it("匿名同名进程不会互相污染（按 pid 归并）", () => {
    const samples = [
      mk(0, 100, [
        { pid: 7, type: "Tab", name: "", ws: 50, peak: 50 },
        { pid: 8, type: "Tab", name: "", ws: 50, peak: 50 },
      ]),
    ];
    expect(summarize(samples, [], 0).processPeaks).toHaveLength(2);
  });
});

describe("BenchSession", () => {
  function makeSession(metrics: RawProcessMetric[][]) {
    let i = 0;
    let clock = 0;
    const session = new BenchSession(
      () => metrics[Math.min(i, metrics.length - 1)],
      () => clock,
    );
    return {
      session,
      advance(ms: number) {
        clock += ms;
      },
      /** 让下一次 take() 读到下一组指标 */
      next() {
        i += 1;
      },
    };
  }

  it("start 立刻采一条基线，status 反映计数", () => {
    const { session } = makeSession([[raw(1, "Browser", "", 102400)]]);
    const st = session.start(1000);
    expect(st.running).toBe(true);
    expect(st.sampleCount).toBe(1);
    expect(st.intervalMs).toBe(1000);
    session.stop();
    expect(session.running).toBe(false);
  });

  it("采样间隔有下限，避免过密干扰被测对象", () => {
    const { session } = makeSession([[raw(1, "Browser", "", 1024)]]);
    const st = session.start(10);
    expect(st.intervalMs).toBe(500);
    session.stop();
  });

  it("未采样前 mark 返回 null", () => {
    const { session } = makeSession([[raw(1, "Browser", "", 1024)]]);
    expect(session.mark("冷启动")).toBeNull();
  });

  it("mark 截断超长标签并记录当时的工作集", () => {
    const { session } = makeSession([[raw(1, "Browser", "", 204800)]]);
    session.start(1000);
    const m = session.mark("x".repeat(200));
    expect(m).not.toBeNull();
    expect(m!.label).toHaveLength(MAX_MARK_LABEL);
    expect(m!.totalMB).toBe(200);
    session.stop();
  });

  it("空标签不产生标记", () => {
    const { session } = makeSession([[raw(1, "Browser", "", 1024)]]);
    session.start(1000);
    expect(session.mark("   ")).toBeNull();
    session.stop();
  });

  it("start 会清空上一轮，保证基线干净", () => {
    const { session, next } = makeSession([
      [raw(1, "Browser", "", 102400)],
      [raw(1, "Browser", "", 512000)],
    ]);
    session.start(1000);
    next();
    session.take();
    expect(session.status().sampleCount).toBe(2);
    // 重新开始 → 清空，只留新的基线
    const st = session.start(1000);
    expect(st.sampleCount).toBe(1);
    expect(st.markCount).toBe(0);
    expect(session.report().summary.baselineMB).toBe(500);
    session.stop();
  });

  it("report 带版本号与 ISO 时间戳，且时长随时钟推进", () => {
    const { session, advance } = makeSession([[raw(1, "Browser", "", 102400)]]);
    session.start(1000);
    advance(5000);
    session.take();
    const r = session.report();
    expect(r.version).toBe(1);
    expect(Number.isNaN(Date.parse(r.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(r.endedAt))).toBe(false);
    expect(r.samples).toHaveLength(2);
    expect(r.summary.durationMs).toBe(5000);
    session.stop();
  });

  it("clear 只清数据，不改变运行状态", () => {
    const { session } = makeSession([[raw(1, "Browser", "", 1024)]]);
    session.start(1000);
    session.clear();
    expect(session.status().sampleCount).toBe(0);
    expect(session.running).toBe(true);
    session.stop();
  });
});
