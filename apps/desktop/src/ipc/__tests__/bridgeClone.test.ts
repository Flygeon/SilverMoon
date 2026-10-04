/**
 * 桥的「结构化克隆安全」回归测试。
 *
 * 背景（用户实报）：本地音乐点「应用」写标签时报
 * `An object could not be cloned.` —— 渲染进程里的 `state.original` / `state.fields`
 * 是 Vue 响应式 **Proxy**，Electron 的 `ipcRenderer.invoke` 走结构化克隆，
 * 遇到 Proxy 直接抛 `DataCloneError`。
 *
 * 这个测试把「payload 过桥前必须可被结构化克隆」钉死，并保证二进制 / Date 不被破坏。
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
        structuredClone(args); // 真实 ipcRenderer.invoke 的克隆语义
        return { ok: true, data: null };
      },
      invokeBatch: async (calls: unknown) => {
        sent.push(calls);
        structuredClone(calls);
        return { ok: true, data: [] };
      },
      call: async (_channel: string, payload: unknown) => {
        sent.push(payload);
        structuredClone(payload);
        return { ok: true, data: null };
      },
      emitTo: async (_label: string, _event: string, payload: unknown) => {
        sent.push(payload);
        structuredClone(payload);
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
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual({ op: "backupLocal", fields: { title: "a", artist: "b" } });
  });

  it("解开 ref().value 的对象与数组", () => {
    const nested = ref({ list: [{ x: 1 }], meta: { y: 2 } });
    const payload = toCloneablePayload(nested.value);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual({ list: [{ x: 1 }], meta: { y: 2 } });
  });

  it("浅拷贝救不了嵌套 Proxy —— 这正是必须在边界深解的原因", () => {
    const state = reactive({ fields: { nested: { deep: 1 } } });
    // 直接展开：外层是普通对象，内层 nested 仍是 Proxy
    expect(() => structuredClone({ ...state.fields })).toThrow();
    expect(() => structuredClone(toCloneablePayload({ ...state.fields }))).not.toThrow();
  });

  it("二进制原样透传（写文件 / 缩略图要用）", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = toCloneablePayload({ data: bytes });
    expect(out.data).toBe(bytes);
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(() => structuredClone(out)).not.toThrow();
  });

  it("ArrayBuffer / Date 保持原类型（非容器类实例不重建）", () => {
    const buf = new ArrayBuffer(4);
    const date = new Date(0);
    const out = toCloneablePayload({ buf, date });
    expect(out.buf).toBe(buf);
    expect(out.date).toBe(date);
    expect(structuredClone(out).date).toBeInstanceOf(Date);
  });

  it("响应式 Map / Set：必须连元素一起重建（musicTags store 的 overrides 就是 Map）", () => {
    // 只把容器换成普通 Map、元素仍是 Proxy 的话，结构化克隆照样抛错
    expect(() => structuredClone(reactive(new Map([["a", { b: 1 }]])))).toThrow();
    const map = toCloneablePayload(reactive(new Map([["a", { b: 1 }]])));
    expect(() => structuredClone(map)).not.toThrow();
    expect(map.get("a")).toEqual({ b: 1 });

    const set = toCloneablePayload(reactive(new Set([{ a: 1 }])));
    expect(() => structuredClone(set)).not.toThrow();
    expect([...set]).toEqual([{ a: 1 }]);

    const nested = toCloneablePayload({ m: reactive(new Map([["x", 1]])) });
    expect(() => structuredClone(nested)).not.toThrow();
  });

  it("普通 Map / Set 仍然可用（不被转成数组或对象）", () => {
    const map = new Map([["a", 1]]);
    const set = new Set([1, 2]);
    const out = toCloneablePayload({ map, set });
    expect(out.map).toBeInstanceOf(Map);
    expect(out.set).toBeInstanceOf(Set);
    expect(out.map.get("a")).toBe(1);
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

describe("桥的各个出口都不再抛 DataCloneError", () => {
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
    await expect(invokeBatchCommands(calls)).resolves.toEqual([]);
  });

  it("emitToWindow：响应式 payload 也能过桥", async () => {
    stubBridge();
    await expect(emitToWindow("main", "evt", reactive({ a: { b: 1 } }))).resolves.toBeUndefined();
  });
});
