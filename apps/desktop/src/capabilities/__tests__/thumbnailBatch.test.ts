/**
 * 回归测试：批量缩略图**必须**走 Rust 的批量命令。
 *
 * 背景（真实缺陷）：Rust 侧写了 `get_thumbnails`（复数，一次往返吃下整批），
 * 但前端用的是 `invokeBatch` —— 后者的实现是 `Promise.all` 包 N 次**独立**
 * invoke，只是「前端并发发起」，往返次数一次没少（30 张卡片 = 30 次往返）。
 *
 * 这个 bug 不会被功能性测试发现（结果完全正确，只是慢），
 * 所以专门钉住「调用了哪个命令、调用了几次」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeCalls: { cmd: string; args?: Record<string, unknown> }[] = [];

vi.mock("@/ipc/invoke", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    // 模拟 Rust 契约：返回值与 fileIds 按下标一一对应
    const ids = (args?.fileIds as string[]) ?? [];
    return ids.map((id) => `/cache/${id}.jpg`);
  },
  invokeBatch: async (calls: { cmd: string }[]) => {
    // 若被走到，说明退回了 N 次往返的老实现
    invokeCalls.push({ cmd: `__invokeBatch(${calls.length})` });
    return calls.map(() => ({ ok: true, data: null }));
  },
  toAssetUrl: (p: string) => `asset://localhost/${p}`,
}));

beforeEach(() => {
  invokeCalls.length = 0;
  // hasBridge() 在模块加载时求值一次，因此在 import 之前铺好。
  // ⚠️ 还要补 location / localStorage：capabilities/mock.ts 在**模块加载期**
  // 就会执行 bulkImages()，其中读 location.search。缺了它整个 import 就抛
  // `ReferenceError: location is not defined`（这个报错与被测逻辑无关，
  // 但会掩盖真正的断言失败）。
  // 迁回 Electron 后 `hasBridge()` 检查的是 preload 注入的 `window.__SILVERMOON__`
  // （不再是 Tauri 的 `window.__TAURI_INTERNALS__`）—— 桥的存在性判定在模块加载时
  // 求值一次，所以必须在 import 之前铺好。这里给一份最小可用的桥。
  (globalThis as unknown as { window: unknown }).window = {
    __SILVERMOON__: {
      label: "main",
      platform: "win32",
      invoke: async () => ({ ok: true, data: null }),
      invokeBatch: async () => ({ ok: true, data: [] }),
      call: async () => ({ ok: true, data: null }),
      emitTo: async () => {},
    },
    location: { search: "", hash: "" },
  };
  (globalThis as unknown as { location: unknown }).location = { search: "", hash: "" };
  vi.resetModules();
});

describe("capabilities.getThumbnails", () => {
  it("走批量命令 get_thumbnails，而不是 N 次单张 invoke", async () => {
    const { capabilities } = await import("../index");
    const ids = Array.from({ length: 30 }, (_, i) => `f${i}`);

    const paths = await capabilities.getThumbnails(ids);

    // 关键断言：只发生**一次**调用，且命令名是复数形
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].cmd).toBe("get_thumbnails");
    // 整批 id 一次性传过去（而不是拆成 30 次）
    expect(invokeCalls[0].args?.fileIds).toEqual(ids);
    // 返回值形状不变：按下标一一对应，已转成 asset URL
    expect(paths).toHaveLength(30);
    expect(paths[0]).toContain("asset://");
  });

  it("空数组不发请求", async () => {
    const { capabilities } = await import("../index");
    expect(await capabilities.getThumbnails([])).toEqual([]);
    expect(invokeCalls).toHaveLength(0);
  });

  it("单张失败（null）不影响其它项", async () => {
    vi.doMock("@/ipc/invoke", () => ({
      invoke: async (_cmd: string, args?: Record<string, unknown>) => {
        const ids = (args?.fileIds as string[]) ?? [];
        return ids.map((id) => (id === "bad" ? null : `/cache/${id}.jpg`));
      },
      invokeBatch: async () => [],
      toAssetUrl: (p: string) => `asset://localhost/${p}`,
    }));
    vi.resetModules();
    const { capabilities } = await import("../index");
    const paths = await capabilities.getThumbnails(["ok1", "bad", "ok2"]);
    expect(paths.filter(Boolean)).toHaveLength(2);
    expect(paths.some((p) => p === null)).toBe(true);
  });
});
