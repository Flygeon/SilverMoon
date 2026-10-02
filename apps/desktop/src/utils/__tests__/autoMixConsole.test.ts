import { describe, expect, it, vi } from "vitest";
import { beforeEach } from "vitest";

// autoMixConsole 经 autoMixAnalysis → @/capabilities 间接引入 mock.ts，
// 后者在模块顶层读 location，node 环境下必须 mock 掉。
vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

beforeEach(() => {
  // 上面的 mock 是模块级的；这里只确保每个用例从干净的日志状态开始
  vi.resetModules();
});

/**
 * 控制台调试接口的**真实挂载**测试。
 *
 * 之前只测过「命令名清单」这种字符串级别的存在性，没有真正把
 * installAutoMixConsole 跑起来 —— 而它恰恰是「挂到 window 上」这种
 * 很容易静默失败的操作（window 不存在、覆盖已有对象、命令没绑上）。
 */

describe("installAutoMixConsole", () => {
  it("真的把 __automix 挂到 window 上，且命令可用", async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal("window", store);
    // 静音 console 输出，避免测试日志噪音
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { installAutoMixConsole } = await import("@/utils/autoMixConsole");
    const status = { enabled: true, duration: 8, currentDeck: "a" };
    const last = { rate: 1.03, reasons: ["x"] };
    installAutoMixConsole(
      () => status,
      () => last,
    );

    const api = (window as unknown as { __automix?: Record<string, () => unknown> }).__automix;
    expect(api).toBeDefined();

    // 每个命令都必须存在且可调用
    for (const name of [
      "enable",
      "disable",
      "verbose",
      "status",
      "trace",
      "last",
      "clear",
      "clearCache",
      "forceMix",
      "help",
    ]) {
      expect(typeof api![name], `缺少命令 ${name}`).toBe("function");
    }

    // status / last 应把注入的值取回来（证明闭包接线正确）
    expect(api!.status()).toBe(status);
    expect(api!.last()).toBe(last);
    // trace 第一次应为空数组（还没有流程记录）
    expect(Array.isArray(api!.trace())).toBe(true);

    log.mockRestore();
    vi.unstubAllGlobals();
  });

  it("verbose 反映 enable/disable 的真实状态", async () => {
    vi.stubGlobal("window", {} as unknown as Window);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { installAutoMixConsole } = await import("@/utils/autoMixConsole");
    const { setVerbose } = await import("@/utils/autoMixLog");
    setVerbose(false);
    installAutoMixConsole(
      () => ({}),
      () => null,
    );
    const api = (
      window as unknown as {
        __automix: { verbose: () => boolean; enable: () => void; disable: () => void };
      }
    ).__automix;
    expect(api.verbose()).toBe(false);
    api.enable();
    expect(api.verbose()).toBe(true);
    api.disable();
    expect(api.verbose()).toBe(false);
    log.mockRestore();
    vi.unstubAllGlobals();
  });

  it("没有 window 时不抛错（SSR / 测试环境安全）", async () => {
    vi.stubGlobal("window", undefined);
    const { installAutoMixConsole } = await import("@/utils/autoMixConsole");
    expect(() =>
      installAutoMixConsole(
        () => ({}),
        () => null,
      ),
    ).not.toThrow();
    vi.unstubAllGlobals();
  });
});

/**
 * 流程日志的真实行为（环形缓冲 + 级别）。
 */
describe("autoMixLog", () => {
  it("记录后能读回，且带时间戳与级别", async () => {
    const { mixLog, mixWarn, mixError, getEntries, clearEntries } =
      await import("@/utils/autoMixLog");
    clearEntries();
    mixLog("普通");
    mixWarn("警告");
    mixError("错误");
    const rows = getEntries();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.level)).toEqual(["info", "warn", "error"]);
    expect(rows.map((r) => r.msg)).toEqual(["普通", "警告", "错误"]);
    for (const r of rows) expect(typeof r.t).toBe("number");
    clearEntries();
  });

  it("clearEntries 清空", async () => {
    const { mixLog, getEntries, clearEntries } = await import("@/utils/autoMixLog");
    clearEntries();
    mixLog("a");
    clearEntries();
    expect(getEntries().length).toBe(0);
  });

  it("环形缓冲上限 100，超出丢弃最旧", async () => {
    const { mixLog, getEntries, clearEntries } = await import("@/utils/autoMixLog");
    clearEntries();
    for (let i = 0; i < 150; i++) mixLog("m" + i);
    const rows = getEntries();
    expect(rows.length).toBe(100);
    expect(rows[0].msg).toBe("m50");
    expect(rows[99].msg).toBe("m149");
    clearEntries();
  });

  it("getEntries 返回副本，外部改动不影响内部缓冲", async () => {
    const { mixLog, getEntries, clearEntries } = await import("@/utils/autoMixLog");
    clearEntries();
    mixLog("only");
    const a = getEntries();
    a.push({ t: 0, level: "info", msg: "伪造" });
    expect(getEntries().length).toBe(1);
    clearEntries();
  });

  it("forceMix 请求会被 consume 读走且只生效一次", async () => {
    const { requestForceMix, consumeForceMix } = await import("@/utils/autoMixLog");
    // 先清掉可能残留的标记
    consumeForceMix();
    expect(consumeForceMix()).toBe(false);
    requestForceMix();
    expect(consumeForceMix()).toBe(true);
    expect(consumeForceMix()).toBe(false);
  });
});
