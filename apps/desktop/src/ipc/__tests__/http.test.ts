/**
 * 宿主网络层回归测试（Tauri 版）。
 *
 * 背景：这类 bug 不报错、只是「静默拿到空 body」，或「按错误的长度截取」。
 * Electron 版曾因为主进程对文本响应传字符串、渲染端却 `new Uint8Array(字符串)`
 * （原始值被当成长度 → 空数组），让 QQ / 酷狗的逐字歌词全部报
 * `Unexpected end of JSON input`。
 *
 * 迁到 Tauri 后，`src/ipc/http.ts` 的职责变了：
 * - **不再**自己重建 `Response`（插件直接返回标准 Response）；
 * - **仍然**要剥掉 `content-encoding` / `content-length`（Rust 已解压，长度是压缩前的）；
 * - 仍然要在已 abort 的 signal 上立刻拒绝，不白跑一趟。
 *
 * 因此这里改测「薄封装」的契约：把 `@tauri-apps/plugin-http` 打桩，
 * 断言 `src/ipc/http.ts` 对响应的处理与对中断的处理。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 记录插件收到的参数，并控制它返回什么。 */
const calls: { url: string; init: RequestInit }[] = [];
let responder: (url: string, init: RequestInit) => Promise<Response> = async () => {
  throw new Error("responder 未设置");
};

// 打桩插件：src/ipc/http.ts 是动态 import 它的，因此这里 mock 模块本身。
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  },
}));

import { fetch as hostFetch } from "../http";
import { toBytes } from "../bridge";

const JSON_BODY = JSON.stringify({ error_code: 0, data: { lists: [{ SongName: "测试歌曲" }] } });

/** 造一个「在 Tauri 里跑」的 window（hasBridge() 认这个）。 */
function stubTauri(): void {
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: {} };
}

function clearWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  calls.length = 0;
}

/** 还原响应形态：插件原样透传上游头，body 是流。 */
function responseWith(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, { status, statusText: "OK", headers });
}

afterEach(clearWindow);

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
  it("能解析文本型响应", async () => {
    stubTauri();
    responder = async () =>
      responseWith(JSON_BODY, { "content-type": "application/json; charset=utf-8" });
    const res = await hostFetch("http://127.0.0.1/x");
    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toMatchObject({ error_code: 0 });
  });

  it("剥掉 content-encoding / content-length（body 已解压，原样透传会误导调用方）", async () => {
    stubTauri();
    responder = async () =>
      responseWith(JSON_BODY, {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": "99999",
      });
    const res = await hostFetch("http://127.0.0.1/x");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("二进制响应按字节还原", async () => {
    stubTauri();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    responder = async () => responseWith(png, { "content-type": "image/png" });
    const res = await hostFetch("http://127.0.0.1/x");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png]);
  });

  it("已中断的 signal 立刻以 AbortError 拒绝，不会静默挂住", async () => {
    stubTauri();
    responder = async () => responseWith(JSON_BODY);
    const controller = new AbortController();
    controller.abort();
    await expect(
      hostFetch("http://127.0.0.1/x", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    // 关键：压根不该打给插件
    expect(calls.length).toBe(0);
  });

  it("把调用方的 URL / method / headers 透传给插件", async () => {
    stubTauri();
    responder = async () => responseWith(JSON_BODY);
    await hostFetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(calls[0].url).toBe("https://u.y.qq.com/cgi-bin/musicu.fcg");
    expect(calls[0].init.method).toBe("POST");
  });

  it("没有 signal 时自动套一个超时用的 signal", async () => {
    stubTauri();
    responder = async () => responseWith(JSON_BODY);
    await hostFetch("http://127.0.0.1/x");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * \`Origin\` 抑制的回归测试。
 *
 * ## 这个坑长什么样
 *
 * \`tauri-plugin-http\` 会**自动注入** \`Origin\`，值为 webview 来源
 * （本应用是 \`tauri://localhost\`）。而很多第三方接口对 \`Origin\` 做校验，
 * 看到不认识的来源直接拒绝。实测 B 站：
 *
 *   UA 单独                          → 200
 *   UA + Origin=tauri://localhost    → 403（返回风控 HTML）
 *
 * 症状是「B 站扫码 403、WBI 密钥取不到」，而**报错信息完全指不到根因**。
 * 且 \`Origin\` 不在插件的禁头表里，所以开 \`unsafe-headers\` 也拦不住它 ——
 * 只能由我们显式传空串，插件才肯移除（commands.rs:363-369）。
 *
 * 这里钉住三件事，任何一条被改掉都会让 B 站再次 403：
 * 1. 调用方没传 Origin 时，我们补一个空串（插件据此移除该头）；
 * 2. 调用方**显式**传了 Origin 时，绝不覆盖（B 站个人空间接口依赖它）；
 * 3. 原有的 headers 不被丢弃。
 */
describe("Origin 抑制（B 站 403 的根因）", () => {
  it("调用方没传 Origin 时，补空串交给插件移除", async () => {
    stubTauri();
    responder = async () => responseWith(JSON_BODY);
    await hostFetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { "User-Agent": "UA" },
    });
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get("origin")).toBe("");
    expect(sent.get("user-agent")).toBe("UA");
  });

  it("调用方显式传了 Origin 时绝不覆盖（个人空间接口靠它过白名单）", async () => {
    stubTauri();
    responder = async () => responseWith(JSON_BODY);
    await hostFetch("https://api.bilibili.com/x/space/wbi/acc/info", {
      headers: { Origin: "https://space.bilibili.com" },
    });
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get("origin")).toBe("https://space.bilibili.com");
  });

  it("Cookie 等自定义头不被丢弃（unsafe-headers 生效的前提）", async () => {
    stubTauri();
    responder = async () => responseWith(JSON_BODY);
    await hostFetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { Cookie: "SESSDATA=abc", Referer: "https://www.bilibili.com" },
    });
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get("cookie")).toBe("SESSDATA=abc");
    expect(sent.get("referer")).toBe("https://www.bilibili.com");
  });
});
