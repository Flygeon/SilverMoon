/**
 * B 站扫码登录的凭据归一化回归测试。
 *
 * 钉的是这条链路上最容易踩的两个坑：
 *
 * 1. 跳转链（`crossDomain?...`）的 query 是 urlencoded 形态 —— 实测
 *    `SESSDATA=35f5d9fc,1667303493,e6e01*51` 是**字面逗号**，而同串里 `gourl` 的
 *    `:` `/` 却是转义的。但 cookie 值按 RFC 6265 不允许逗号，浏览器存的是 `%2C`
 *    形态；直接把 query 原值当 cookie 发，服务端一律按未登录处理（-101），
 *    界面就永远卡在「已授权，但账号信息获取失败」。
 * 2. 渲染进程读不到 `Set-Cookie`（Fetch 规范把它列为禁止响应头），所以凭据只能来自
 *    跳转链；一旦宿主通道把它挂回来了（见 `src/ipc/http.ts`），响应头就是更权威的
 *    来源，不能再被跳转链覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/** 被打桩的 JsonStore 落盘内容（键 → 值） */
const persisted: Record<string, Record<string, string | number> | null> = {};

vi.mock("@/ipc/store", () => ({
  JsonStore: class {
    readonly path: string;
    constructor(path: string) {
      this.path = path;
    }
    async get(): Promise<null> {
      return null;
    }
    async set(key: string, value: unknown): Promise<void> {
      persisted[key] = value as Record<string, string | number> | null;
    }
    async save(): Promise<void> {}
  },
}));

vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

/** 造「宿主通道」形态的响应：真 Response + 挂回的 getSetCookie（与 ipc/http.ts 同款）。 */
function hostResponse(body: unknown, setCookie: string[] = []): Response {
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  if (setCookie.length) {
    Object.defineProperty(res.headers, "getSetCookie", {
      value: () => [...setCookie],
      configurable: true,
    });
  }
  return res;
}

/** 真实链路形态的登录跳转链（逗号未被转义，`:` `/` 被转义） */
const RAW_SESSDATA = "35f5d9fc,1667303493,e6e01*51";
const COOKIE_SESSDATA = "35f5d9fc%2C1667303493%2Ce6e01*51";
const RAW_JCT = "ee6c28743e5d1149f60e24040403e9a5";
const LOGIN_URL =
  "https://passport.biligame.com/crossDomain?DedeUserID=28970049" +
  "&DedeUserID__ckMd5=0ee5803628e6e65f&Expires=1667303493" +
  `&SESSDATA=${RAW_SESSDATA}` +
  `&bili_jct=${RAW_JCT}&gourl=https%3A%2F%2Fwww.bilibili.com%2F`;

const POLL_BODY = {
  code: 0,
  message: "0",
  data: { code: 0, message: "", url: LOGIN_URL, refresh_token: "rt" },
};

/** 每个用例都用全新的模块实例（cookie 罐是模块级状态） */
async function freshBili() {
  vi.resetModules();
  return await import("@/utils/bilibili");
}

function stubPoll(setCookie: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => hostResponse(POLL_BODY, setCookie)),
  );
}

beforeEach(() => {
  delete persisted["cookies"];
  delete persisted["tvAuth"];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("biliQrPoll 凭据归一化", () => {
  it("跳转链的逗号形态转成 cookie 形态（%2C），并留一份原始形态备选", async () => {
    stubPoll();
    const bili = await freshBili();
    const s = await bili.biliQrPoll("qrcode-key", "web");

    expect(s.code).toBe(0);
    expect(persisted["cookies"]?.SESSDATA).toBe(COOKIE_SESSDATA);
    // 十六进制值不该被改动
    expect(persisted["cookies"]?.bili_jct).toBe(RAW_JCT);
    expect(persisted["cookies"]?.DedeUserID).toBe("28970049");
    // 备选形态 = 跳转链原值（逗号形态），供 nav 验不过时换用
    expect(s.alt?.SESSDATA).toBe(RAW_SESSDATA);
  });

  it("响应头里已有凭据时以响应头为准，不被跳转链覆盖", async () => {
    stubPoll(["SESSDATA=from-header%2C1%2Cx*31; Path=/; Domain=.bilibili.com"]);
    const bili = await freshBili();
    const s = await bili.biliQrPoll("qrcode-key", "web");

    expect(persisted["cookies"]?.SESSDATA).toBe("from-header%2C1%2Cx*31");
    // 备选形态仍然给出：万一响应头那份才是服务端不认的，store 还要靠它再试一次
    expect(s.alt?.SESSDATA).toBe(RAW_SESSDATA);
  });

  it("非成功状态不写凭据", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        hostResponse({ code: 0, message: "0", data: { code: 86101, message: "未扫码" } }),
      ),
    );
    const bili = await freshBili();
    const s = await bili.biliQrPoll("qrcode-key", "web");

    expect(s.code).toBe(86101);
    expect(persisted["cookies"]).toBeUndefined();
    expect(s.alt).toBeUndefined();
  });

  it("外层风控错误不能伪装成尚未扫码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hostResponse({ code: -352, message: "风控校验失败" })),
    );
    const bili = await freshBili();
    await expect(bili.biliQrPoll("qrcode-key", "web")).rejects.toThrow("风控校验失败");
    expect(persisted["cookies"]).toBeUndefined();
  });

  it("缺失扫码状态时提示响应异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hostResponse({ code: 0, data: {} })),
    );
    const bili = await freshBili();
    await expect(bili.biliQrPoll("qrcode-key", "web")).rejects.toThrow("缺少有效状态码");
  });

  it("HTTP错误保留状态码而不是无限显示等待授权", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const bili = await freshBili();
    await expect(bili.biliQrPoll("qrcode-key", "web")).rejects.toThrow("HTTP 503");
  });
});

const TV_SUCCESS = {
  code: 0,
  data: {
    cookie_info: {
      cookies: [
        { name: "SESSDATA", value: "session%2Cencoded*value" },
        { name: "bili_jct", value: "test-csrf" },
        { name: "DedeUserID", value: "42" },
      ],
    },
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600,
  },
};

describe("TV 扫码", () => {
  it("默认 POST TV 生成接口，签名与上游排序编码规则一致", async () => {
    const fetchMock = vi.fn(async () =>
      hostResponse({ code: 0, data: { auth_code: "test-key", url: "https://example.test/qr" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const bili = await freshBili();
    expect(await bili.biliQrGenerate()).toEqual({
      key: "test-key",
      url: "https://example.test/qr",
    });
    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/x/passport-tv-login/qrcode/auth_code");
    expect(init.method).toBe("POST");
    expect(url.searchParams.get("mobi_app")).toBe("android_hd");
    expect(url.searchParams.get("platform")).toBe("android");
    const sign = url.searchParams.get("sign");
    url.searchParams.delete("sign");
    const query = [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    expect(sign).toBe(
      createHash("md5")
        .update(query + "b5475a8825547a4fc26c7d518eaaa02e")
        .digest("hex"),
    );
  });

  it.each([86039, 86038, -352])("读取外层状态 %s，不写入凭据", async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hostResponse({ code, message: "pending" })),
    );
    const bili = await freshBili();
    expect(await bili.biliQrPoll("test-key")).toEqual({ code, message: "pending" });
    expect(persisted.cookies).toBeUndefined();
  });

  it("原样保存结构化 Cookie 及 TV 令牌，退出后清空", async () => {
    const fetchMock = vi.fn(async () => hostResponse(TV_SUCCESS));
    vi.stubGlobal("fetch", fetchMock);
    const bili = await freshBili();
    const start = Date.now();
    expect((await bili.biliQrPoll("test-key")).code).toBe(0);
    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(requestUrl).pathname).toBe("/x/passport-tv-login/qrcode/poll");
    expect(new URL(requestUrl).searchParams.get("auth_code")).toBe("test-key");
    expect(init.method).toBe("POST");
    expect(persisted.cookies?.SESSDATA).toBe("session%2Cencoded*value");
    expect(persisted.tvAuth).toMatchObject({
      accessToken: "test-access",
      refreshToken: "test-refresh",
    });
    expect(persisted.tvAuth?.expiresAt).toBeGreaterThanOrEqual(start + 3600000);
    await bili.biliLogout();
    expect(persisted.cookies).toEqual({});
    expect(persisted.tvAuth).toBeNull();
  });

  it("缺失凭据的成功响应不能当成登录成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hostResponse({ code: 0, data: {} })),
    );
    const bili = await freshBili();
    await expect(bili.biliQrPoll("test-key")).rejects.toThrow("未返回完整登录凭据");
    expect(persisted.cookies).toBeUndefined();
  });

  it("已关闭或切换的 TV 请求不能落盘凭据", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hostResponse(TV_SUCCESS)),
    );
    const bili = await freshBili();
    await bili.biliQrPoll("test-key", "tv", () => false);
    expect(persisted.cookies).toBeUndefined();
    expect(persisted.tvAuth).toBeUndefined();
  });

  it("手动网页备用使用原端点，网页登录清理 TV 令牌", async () => {
    const fetchMock = vi.fn(async () =>
      hostResponse({ code: 0, data: { qrcode_key: "web-key", url: "https://example.test/web" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const bili = await freshBili();
    expect((await bili.biliQrGenerate("web")).key).toBe("web-key");
    const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(requestUrl).toContain("/web/qrcode/generate");
    persisted.tvAuth = { accessToken: "old-account" };
    stubPoll();
    await bili.biliQrPoll("web-key", "web");
    expect(persisted.tvAuth).toBeNull();
  });
});
