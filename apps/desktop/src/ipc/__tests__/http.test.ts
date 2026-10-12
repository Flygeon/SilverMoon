/**
 * 宿主网络层回归测试。
 *
 * 背景：这类 bug 不报错、只是「静默拿到空 body」。曾因为主进程对文本响应传字符串、
 * 渲染端却 `new Uint8Array(字符串)`（原始值被当成长度 → 空数组），让 QQ / 酷狗的
 * 逐字歌词全部报 `Unexpected end of JSON input`。这里把两个方向都钉住。
 */
import { afterEach, describe, expect, it } from "vitest";

import { fetch as hostFetch } from "../http";
import { toBytes } from "../bridge";

const JSON_BODY = JSON.stringify({ error_code: 0, data: { lists: [{ SongName: "测试歌曲" }] } });

/** 造一个假的宿主桥，`call("http", …)` 直接返回给定响应。 */
function stubBridge(response: unknown, options: { onCall?: () => void } = {}): void {
  (globalThis as unknown as { window: unknown }).window = {
    __SILVERMOON__: {
      label: "main",
      platform: "win32",
      invoke: async () => ({ ok: true, data: null }),
      call: async (_channel: string, _payload: unknown) => {
        options.onCall?.();
        return { ok: true, data: response };
      },
      emitTo: async () => undefined,
    },
  };
}

function clearBridge(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

/** 主进程**当前**的响应形态：body 一律是字节。 */
function byteResponse(body: Uint8Array, headers: [string, string][] = []): unknown {
  return {
    status: 200,
    statusText: "OK",
    url: "http://127.0.0.1/x",
    headers: [["content-type", "application/json; charset=utf-8"], ...headers],
    body,
  };
}

afterEach(clearBridge);

describe("toBytes", () => {
  it("原样接受 Uint8Array / ArrayBuffer / number[]", () => {
    const src = new Uint8Array([1, 2, 3]);
    expect([...toBytes(src)]).toEqual([1, 2, 3]);
    expect([...toBytes(src.buffer)]).toEqual([1, 2, 3]);
    expect([...toBytes([1, 2, 3])]).toEqual([1, 2, 3]);
  });

  it("字符串按 UTF-8 编码，而不是塌成长度 0 的空数组（回归）", () => {
    const bytes = toBytes(JSON_BODY);
    expect(bytes.length).toBe(new TextEncoder().encode(JSON_BODY).length);
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes)).toBe(JSON_BODY);
  });

  it("空值不抛错，给空数组", () => {
    expect(toBytes(null).length).toBe(0);
    expect(toBytes(undefined).length).toBe(0);
  });
});

describe("宿主 fetch", () => {
  it("能解析文本型响应（字节形态）", async () => {
    stubBridge(byteResponse(new TextEncoder().encode(JSON_BODY)));
    const res = await hostFetch("http://127.0.0.1/x");
    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toMatchObject({ error_code: 0 });
  });

  it("即便宿主改回字符串形态，也不能变成空 body（回归防线）", async () => {
    stubBridge(byteResponse(JSON_BODY as unknown as Uint8Array));
    const res = await hostFetch("http://127.0.0.1/x");
    await expect(res.json()).resolves.toMatchObject({ error_code: 0 });
  });

  it("剥掉 content-encoding / content-length（字节已解压，原样透传会误导调用方）", async () => {
    stubBridge(
      byteResponse(new TextEncoder().encode(JSON_BODY), [
        ["content-encoding", "gzip"],
        ["content-length", "99999"],
      ]),
    );
    const res = await hostFetch("http://127.0.0.1/x");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("二进制响应按字节还原", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    stubBridge(byteResponse(png, [["content-type", "image/png"]]));
    const res = await hostFetch("http://127.0.0.1/x");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png]);
  });

  it("已中断的 signal 立刻以 AbortError 拒绝，不会静默挂住", async () => {
    let called = 0;
    stubBridge(byteResponse(new TextEncoder().encode(JSON_BODY)), {
      onCall: () => {
        called += 1;
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      hostFetch("http://127.0.0.1/x", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(0);
  });

  it("请求进行中触发 abort 也会拒绝", async () => {
    stubBridge(byteResponse(new TextEncoder().encode(JSON_BODY)));
    const controller = new AbortController();
    const pending = hostFetch("http://127.0.0.1/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
