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

/** 被打桩的 JsonStore 落盘内容（键 → 值） */
const persisted: Record<string, Record<string, string>> = {};

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
      persisted[key] = value as Record<string, string>;
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
  vi.unstubAllGlobals();
});

describe("biliQrPoll 凭据归一化", () => {
  it("跳转链的逗号形态转成 cookie 形态（%2C），并留一份原始形态备选", async () => {
    stubPoll();
    const bili = await freshBili();
    const s = await bili.biliQrPoll("qrcode-key");

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
    const s = await bili.biliQrPoll("qrcode-key");

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
    const s = await bili.biliQrPoll("qrcode-key");

    expect(s.code).toBe(86101);
    expect(persisted["cookies"]).toBeUndefined();
    expect(s.alt).toBeUndefined();
  });
});
