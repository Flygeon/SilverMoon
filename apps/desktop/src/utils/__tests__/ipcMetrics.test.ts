/**
 * IPC 计量的回归测试。
 *
 * 这一层很容易「看起来在工作」而实际没记录（比如开关读错、样本被立刻丢弃），
 * 所以把三件事钉死：
 * 1. 默认**关闭**（不给普通用户加开销）；
 * 2. 打开后确实记录，且聚合数字正确；
 * 3. 环形缓冲生效 —— 长时间运行不会把内存吃掉。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getIpcStats,
  isIpcMetricsEnabled,
  recordIpcCall,
  resetIpcStats,
  setIpcMetricsEnabled,
} from "../ipcMetrics";

beforeEach(() => {
  resetIpcStats();
  setIpcMetricsEnabled(false);
});

afterEach(() => {
  resetIpcStats();
  setIpcMetricsEnabled(false);
});

describe("ipcMetrics", () => {
  it("默认关闭：不记录任何样本", () => {
    expect(isIpcMetricsEnabled()).toBe(false);
    recordIpcCall("list_files", { limit: 10 }, performance.now(), false);
    expect(getIpcStats()).toEqual([]);
  });

  it("打开后记录，并按命令名聚合", () => {
    setIpcMetricsEnabled(true);
    // 用「起点往前 5ms」造出确定的耗时，避免依赖真实调度
    recordIpcCall("list_files", { limit: 10 }, performance.now() - 5, false);
    recordIpcCall("list_files", { limit: 10 }, performance.now() - 15, false);
    recordIpcCall("get_thumbnails", { fileIds: ["a"] }, performance.now() - 1, false);

    const rows = getIpcStats();
    expect(rows).toHaveLength(2);

    // 按总耗时降序：list_files 两次（≥5 + ≥15）必然排在 get_thumbnails 前面
    expect(rows[0].cmd).toBe("list_files");
    expect(rows[0].count).toBe(2);
    expect(rows[1].cmd).toBe("get_thumbnails");
    expect(rows[1].count).toBe(1);

    // 占比合计为 1（四舍五入误差内）
    const share = rows.reduce((a, r) => a + r.totalShare, 0);
    expect(Math.abs(share - 1)).toBeLessThan(1e-6);
  });

  it("统计失败次数与最大耗时", () => {
    setIpcMetricsEnabled(true);
    recordIpcCall("scan_start", {}, performance.now() - 1, true);
    recordIpcCall("scan_start", {}, performance.now() - 30, false);

    const [row] = getIpcStats();
    expect(row.count).toBe(2);
    expect(row.errors).toBe(1);
    // maxMs 取的是样本最大值（≥30 那次）
    expect(row.maxMs).toBeGreaterThanOrEqual(30);
    expect(row.p95Ms).toBeGreaterThanOrEqual(1);
  });

  it("载荷大小按参数估算，循环引用不会抛错", () => {
    setIpcMetricsEnabled(true);
    recordIpcCall("list_files", { a: "x".repeat(100) }, performance.now(), false);
    const [row] = getIpcStats();
    expect(row.avgArgBytes).toBeGreaterThan(100);

    // 循环引用：估算器是**有界遍历**，不会抛、也不会无限递归（见 MAX_DEPTH）
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => recordIpcCall("bad", cyclic, performance.now(), false)).not.toThrow();
    const bad = getIpcStats().find((r) => r.cmd === "bad");
    // 返回的是有限值（深度被截断），而不是曾经的 0 或 NaN
    expect(Number.isFinite(bad?.avgArgBytes)).toBe(true);
    expect(bad?.avgArgBytes).toBeGreaterThan(0);
  });

  it("二进制按 byteLength 计，不去序列化（性能回归）", () => {
    setIpcMetricsEnabled(true);
    // 1 MB 的 Uint8Array。
    // 初版用 JSON.stringify 估算，会先造出上百万项的数字数组字符串（约 4 MB）——
    // 而 writeFile / saveThumbnail 这类调用恰好都带 Uint8Array，
    // 等于给它们平白加一倍工作量。这里钉住「直接用 byteLength」这条路径。
    const bytes = new Uint8Array(1024 * 1024);
    const t0 = performance.now();
    recordIpcCall("write_file", { path: "/x", data: bytes }, performance.now(), false);
    const elapsed = performance.now() - t0;

    const [row] = getIpcStats();
    // 1 MB 上下（允许其它字段的少量开销）
    expect(row.avgArgBytes).toBeGreaterThanOrEqual(1024 * 1024);
    // 关键：必须远快于序列化 1 MB。给足余量（慢机器也不该超过 50ms）
    expect(elapsed).toBeLessThan(50);
  });

  it("环形缓冲有界：超出上限时丢弃最旧的样本", () => {
    setIpcMetricsEnabled(true);
    // 上限是 512（MAX_SAMPLES），灌 700 次
    for (let i = 0; i < 700; i++) {
      recordIpcCall("busy", {}, performance.now(), false);
    }
    const [row] = getIpcStats();
    expect(row.count).toBe(512);
  });

  it("reset 清空统计", () => {
    setIpcMetricsEnabled(true);
    recordIpcCall("x", {}, performance.now(), false);
    expect(getIpcStats()).toHaveLength(1);
    resetIpcStats();
    expect(getIpcStats()).toEqual([]);
  });
});
