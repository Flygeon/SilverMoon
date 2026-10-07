/**
 * Chromium / V8 启动开关的单元测试（P3）。
 *
 * 这些值决定**每个渲染进程**的 V8 堆行为，改错会让应用频繁 GC 或直接 OOM，
 * 因此取值规则必须有测试钉住。测试只覆盖纯解析逻辑——真正的 appendSwitch
 * 由 `main.ts` 在 app ready 之前调用一次，靠启动日志核对。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_JS_HEAP_MB,
  MIN_JS_HEAP_MB,
  applyPerfSwitches,
  describePerfSwitches,
  resolvePerfSwitches,
  type CommandLineLike,
} from "../perf";

describe("resolvePerfSwitches", () => {
  it("默认：堆上限 2048MB、关闭 BFCache、不限制渲染进程数", () => {
    const p = resolvePerfSwitches({});
    expect(p.jsFlags).toBe(`--max-old-space-size=${DEFAULT_JS_HEAP_MB}`);
    expect(p.disableFeatures).toBe("BackForwardCache");
    expect(p.rendererProcessLimit).toBeNull();
  });

  it("空串按未设置处理", () => {
    const p = resolvePerfSwitches({ SILVERMOON_JS_HEAP_MB: "  ", SILVERMOON_DISABLE_BFCACHE: "" });
    expect(p.jsFlags).toBe(`--max-old-space-size=${DEFAULT_JS_HEAP_MB}`);
    expect(p.disableFeatures).toBe("BackForwardCache");
  });

  it("合法的堆上限被采用", () => {
    expect(resolvePerfSwitches({ SILVERMOON_JS_HEAP_MB: "4096" }).jsFlags).toBe(
      "--max-old-space-size=4096",
    );
    expect(resolvePerfSwitches({ SILVERMOON_JS_HEAP_MB: String(MIN_JS_HEAP_MB) }).jsFlags).toBe(
      `--max-old-space-size=${MIN_JS_HEAP_MB}`,
    );
  });

  it("0 表示显式不设置堆上限", () => {
    expect(resolvePerfSwitches({ SILVERMOON_JS_HEAP_MB: "0" }).jsFlags).toBeNull();
  });

  it("非法或过小的值回落到默认，而不是抛异常（启动参数不该让应用起不来）", () => {
    for (const bad of ["abc", "-1", "16", "100"]) {
      expect(resolvePerfSwitches({ SILVERMOON_JS_HEAP_MB: bad }).jsFlags).toBe(
        `--max-old-space-size=${DEFAULT_JS_HEAP_MB}`,
      );
    }
  });

  it("SILVERMOON_DISABLE_BFCACHE=0 时保留 BFCache", () => {
    expect(resolvePerfSwitches({ SILVERMOON_DISABLE_BFCACHE: "0" }).disableFeatures).toBeNull();
    expect(resolvePerfSwitches({ SILVERMOON_DISABLE_BFCACHE: "1" }).disableFeatures).toBe(
      "BackForwardCache",
    );
  });

  it("渲染进程上限默认关闭；只有正整数才启用", () => {
    expect(resolvePerfSwitches({}).rendererProcessLimit).toBeNull();
    expect(
      resolvePerfSwitches({ SILVERMOON_RENDERER_PROCESS_LIMIT: "4" }).rendererProcessLimit,
    ).toBe(4);
    expect(
      resolvePerfSwitches({ SILVERMOON_RENDERER_PROCESS_LIMIT: "0" }).rendererProcessLimit,
    ).toBeNull();
    expect(
      resolvePerfSwitches({ SILVERMOON_RENDERER_PROCESS_LIMIT: "x" }).rendererProcessLimit,
    ).toBeNull();
    expect(
      resolvePerfSwitches({ SILVERMOON_RENDERER_PROCESS_LIMIT: "-3" }).rendererProcessLimit,
    ).toBeNull();
  });
});

describe("applyPerfSwitches", () => {
  function recorder() {
    const calls: [string, string | undefined][] = [];
    const cmd: CommandLineLike = {
      appendSwitch(name, value) {
        calls.push([name, value]);
      },
    };
    return { cmd, calls };
  }

  it("按计划调用 appendSwitch", () => {
    const { cmd, calls } = recorder();
    applyPerfSwitches(cmd, { SILVERMOON_RENDERER_PROCESS_LIMIT: "3" });
    expect(calls).toEqual([
      ["js-flags", `--max-old-space-size=${DEFAULT_JS_HEAP_MB}`],
      ["disable-features", "BackForwardCache"],
      ["renderer-process-limit", "3"],
    ]);
  });

  it("关闭的项不产生调用", () => {
    const { cmd, calls } = recorder();
    applyPerfSwitches(cmd, {
      SILVERMOON_JS_HEAP_MB: "0",
      SILVERMOON_DISABLE_BFCACHE: "0",
    });
    expect(calls).toEqual([]);
  });

  it("返回值就是实际应用的计划（供启动日志核对）", () => {
    const { cmd } = recorder();
    const plan = applyPerfSwitches(cmd, { SILVERMOON_JS_HEAP_MB: "1024" });
    expect(plan.jsFlags).toBe("--max-old-space-size=1024");
  });
});

describe("describePerfSwitches", () => {
  it("全开时给出可读的一行", () => {
    const s = describePerfSwitches({
      jsFlags: "--max-old-space-size=2048",
      disableFeatures: "BackForwardCache",
      rendererProcessLimit: 4,
    });
    expect(s).toBe(
      "js-flags=--max-old-space-size=2048 | disable-features=BackForwardCache | renderer-process-limit=4",
    );
  });

  it("全关时也能表达", () => {
    expect(
      describePerfSwitches({ jsFlags: null, disableFeatures: null, rendererProcessLimit: null }),
    ).toBe("js-flags=off | bfcache=on | renderer-process-limit=off");
  });
});
