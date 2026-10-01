import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../ttlCache";

describe("TtlCache", () => {
  it("命中后不再执行 produce", async () => {
    const cache = new TtlCache<number>("t", { ttlMs: 1000, maxEntries: 8 });
    const produce = vi.fn().mockResolvedValue(1);
    expect(await cache.wrap("k", produce)).toBe(1);
    expect(await cache.wrap("k", produce)).toBe(1);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("skipCache 会绕过读取但仍写回", async () => {
    const cache = new TtlCache<number>("t", { ttlMs: 1000, maxEntries: 8 });
    const produce = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.wrap("k", produce)).toBe(1);
    expect(await cache.wrap("k", produce, { skipCache: true })).toBe(2);
    expect(produce).toHaveBeenCalledTimes(2);
    // 第二次结果已写回
    expect(cache.get("k")).toBe(2);
  });

  it("并发同 key 只执行一次（在途去重）", async () => {
    const cache = new TtlCache<number>("t", { ttlMs: 1000, maxEntries: 8 });
    let release!: (v: number) => void;
    const produce = vi.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const a = cache.wrap("k", produce);
    const b = cache.wrap("k", produce);
    release(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("produce 抛错时不写缓存，错误向上传播", async () => {
    const cache = new TtlCache<number>("t", { ttlMs: 1000, maxEntries: 8 });
    const produce = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(cache.wrap("k", produce)).rejects.toThrow("boom");
    expect(cache.get("k")).toBeUndefined();
    // 可以重试
    produce.mockResolvedValue(3);
    expect(await cache.wrap("k", produce)).toBe(3);
  });

  it("过期后重新执行", async () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<number>("t", { ttlMs: 1000, maxEntries: 8 });
      cache.set("k", 1);
      expect(cache.get("k")).toBe(1);
      vi.advanceTimersByTime(1001);
      expect(cache.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("成功/失败双 TTL：失败条目更快过期", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<{ ok: boolean }>("t", {
        ttlMs: 1000,
        okTtlMs: 10_000,
        isOk: (v) => v.ok,
        maxEntries: 8,
      });
      cache.set("ok", { ok: true });
      cache.set("bad", { ok: false });
      vi.advanceTimersByTime(1500);
      expect(cache.get("ok")).toEqual({ ok: true });
      expect(cache.get("bad")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("超过容量上限时按插入序淘汰最老的", () => {
    const cache = new TtlCache<number>("t", { ttlMs: 10_000, maxEntries: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("clear 清空全部条目", () => {
    const cache = new TtlCache<number>("t", { ttlMs: 10_000, maxEntries: 8 });
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
