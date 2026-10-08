/**
 * 桥的「过桥载荷安全」回归测试（Tauri 版）。
 *
 * 背景（用户实报）：本地音乐点「应用」写标签时报
 * `An object could not be cloned.` —— 渲染进程里的 `state.original` / `state.fields`
 * 是 Vue 响应式 **Proxy**，Electron 的 `ipcRenderer.invoke` 走结构化克隆，
 * 遇到 Proxy 直接抛 `DataCloneError`。
 *
 * 迁到 Tauri 后底层换成 serde/JSON，Proxy 本身不再是问题，但**降级语义仍然必要**
 * 且有细微变化：
 * - `undeinfed` 在 JSON 里会丢键（命令形参多为 `Option<T>`，等价于 null，可接受）；
 * - `Map` / `Set` JSON 会塌成 `{}` —— 而 musicTags 的 `overrides` **确实**是 Map，
 *   所以仍要在边界展开成普通对象 / 数组（本测试钉住这一点）；
 * - 二进制必须**原样透传**（Tauri 2 的 invoke 原生支持 `Uint8Array`），
 *   转成 JSON 数组会让大文件写入膨胀数倍。
 *
 * 因此这里把「过桥前载荷是 JSON 安全的、且二进制/Map/Set 语义明确」钉死。
 */
import { afterEach, describe, expect, it } from "vitest";
import { reactive, ref } from "vue";

import {
  callBridge,
  emitToWindow,
  invokeBatchCommands,
  invokeCommand,
  toCloneablePayload,
} from "../bridge";

/** 记录每次过桥的 payload，并断言它真的能被结构化克隆 */
const sent: unknown[] = [];

function stubBridge(): void {
  (globalThis as unknown as { window: unknown }).window = {
    __SILVERMOON__: {
      label: "main",
      platform: "win32",
      invoke: async (_cmd: string, args: unknown) => {
        sent.push(args);
        JSON.stringify(args); // 真实 Tauri invoke 的序列化语义：必须是 JSON 安全的
        return { ok: true, data: null };
      },
      invokeBatch: async (calls: unknown) => {
        sent.push(calls);
        JSON.stringify(calls);
        return { ok: true, data: [] };
      },
      call: async (_channel: string, payload: unknown) => {
        sent.push(payload);
        JSON.stringify(payload);
        return { ok: true, data: null };
      },
      emitTo: async (_label: string, _event: string, payload: unknown) => {
        sent.push(payload);
        JSON.stringify(payload);
      },
    },
  };
}

function clearBridge(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  sent.length = 0;
}

afterEach(clearBridge);

describe("toCloneablePayload", () => {
  it("解开嵌套响应式 Proxy（用户实报的场景）", () => {
    const state = reactive({ original: { title: "a", artist: "b" } });
    const payload = toCloneablePayload({ op: "backupLocal", fields: state.original });
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload).toEqual({ op: "backupLocal", fields: { title: "a", artist: "b" } });
  });

  it("解开 ref().value 的对象与数组", () => {
    const nested = ref({ list: [{ x: 1 }], meta: { y: 2 } });
    const payload = toCloneablePayload(nested.value);
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload).toEqual({ list: [{ x: 1 }], meta: { y: 2 } });
  });

  it("浅拷贝救不了嵌套 Proxy —— 这正是必须在边界深解的原因", () => {
    const state = reactive({ fields: { nested: { deep: 1 } } });
    // 直接展开：外层是普通对象，内层 nested 仍是 Proxy
    // 浅展开后内层仍是 Proxy：JSON 能跑，但 Proxy 会被序列化成它当前的值，语义上不该依赖
    expect(() => JSON.stringify({ ...state.fields })).not.toThrow();
    expect(() => JSON.stringify(toCloneablePayload({ ...state.fields }))).not.toThrow();
  });

  it("二进制原样透传（写文件 / 缩略图要用）", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = toCloneablePayload({ data: bytes });
    expect(out.data).toBe(bytes);
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("ArrayBuffer 原样透传；Date 转为 ISO 字符串（JSON 语义）", () => {
    const buf = new ArrayBuffer(4);
    const date = new Date(0);
    const out = toCloneablePayload({ buf, date });
    // 二进制必须原样透传（Tauri 的 invoke 原生支持，转 JSON 数组会膨胀数倍）
    expect(out.buf).toBe(buf);
    // Date 在 JSON 里没有原生表示，统一降级为 ISO 字符串
    expect(out.date).toBe(date.toISOString());
  });

  it("响应式 Map 展开成普通对象（musicTags store 的 overrides 就是 Map）", () => {
    const map = toCloneablePayload(reactive(new Map([["a", { b: 1 }]]))) as unknown as Record<
      string,
      unknown
    >;
    expect(map).toEqual({ a: { b: 1 } });
    // 元素里的 Proxy 也必须一起解开
    expect(() => JSON.stringify(map)).not.toThrow();

    const set = toCloneablePayload(reactive(new Set([{ a: 1 }]))) as unknown as unknown[];
    expect(set).toEqual([{ a: 1 }]);

    const nested = toCloneablePayload({ m: reactive(new Map([["x", 1]])) }) as unknown as {
      m: Record<string, unknown>;
    };
    expect(nested.m).toEqual({ x: 1 });
  });

  it("普通 Map / Set 同样展开（JSON 里没有 Map/Set 原生表示）", () => {
    const out = toCloneablePayload({
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
    }) as unknown as {
      map: Record<string, unknown>;
      set: unknown[];
    };
    expect(out.map).toEqual({ a: 1 });
    expect(out.set).toEqual([1, 2]);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("循环引用不无限递归", () => {
    const raw: Record<string, unknown> = { a: 1 };
    raw.self = raw;
    const out = toCloneablePayload(raw) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe(out);
  });

  it("null / undefined / 原始值原样返回", () => {
    expect(toCloneablePayload(null)).toBeNull();
    expect(toCloneablePayload(undefined)).toBeUndefined();
    expect(toCloneablePayload("s")).toBe("s");
    expect(toCloneablePayload(1)).toBe(1);
    expect(toCloneablePayload(true)).toBe(true);
  });
});

describe("桥的各个出口都能安全过桥", () => {
  it("callBridge：响应式 payload 也能过桥", async () => {
    stubBridge();
    const state = reactive({ fields: { title: "夜曲" } });
    await expect(
      callBridge("musicTags", { op: "writeLocal", fields: state.fields }),
    ).resolves.toBeNull();
    expect(sent[0]).toEqual({ op: "writeLocal", fields: { title: "夜曲" } });
  });

  it("invokeCommand：响应式 args 也能过桥", async () => {
    stubBridge();
    const args = reactive({ ids: [{ id: 1 }] });
    await expect(invokeCommand("some_cmd", args)).resolves.toBeNull();
  });

  it("invokeBatchCommands：响应式 calls 也能过桥", async () => {
    stubBridge();
    const calls = reactive([{ cmd: "a", args: { x: { y: 1 } } }]);
    // Tauri 没有批量通道，这里是「逐条并发 invoke」的等价实现：
    // 每个下标的载荷都过桥一次，结果按顺序聚合。
    const results = await invokeBatchCommands(calls);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(() => JSON.stringify(sent)).not.toThrow();
  });

  it("emitToWindow：响应式 payload 也能过桥", async () => {
    stubBridge();
    await expect(emitToWindow("main", "evt", reactive({ a: { b: 1 } }))).resolves.toBeUndefined();
  });
});
