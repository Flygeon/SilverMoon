/**
 * B 站「反诈 / 带货过滤 / AI 总结 / 动态流」的回归测试。
 *
 * 这些能力都是「上游 JSON 形状 → 本地归一化」的纯数据搬运，最容易在三种地方翻车：
 *
 * 1. **带货判定**漏掉形态。商品评论既可能藏在 `content.urls` 的 extra 里，也可能只是
 *    正文里一条 `https://gaoneng.bilibili.com/tetris` 推广链；动态同理，商品卡在
 *    `module_dynamic.additional.type === 'ADDITIONAL_TYPE_GOODS'`。少判一种，用户就会
 *    在「屏蔽带货」开着的情况下照样刷到广告。
 * 2. **反诈四态混淆**。`ok`（匿名视角也可见）/ `shadow`（仅自己可见）/`hidden`（完全
 *    不可见）/`failed`（复查本身没跑通）走的是同一批接口的不同分支，判错等于给用户
 *    相反的结论 —— 比不报还糟。注意 `failed` 必须与 `hidden` 分开：匿名列表被风控
 *    打回时是「查不了」，不是「评论没了」。
 * 3. **WBI 签名链路**。`biliAiConclusion` 走 WBI，桩里若不同时给 nav 的 wbi_img，
 *    签名密钥拿不到，测试只会拿到一句「WBI 密钥获取失败」，掩盖真正的解析问题。
 *
 * 桩写法对齐同目录的 `bilibiliQrLogin.test.ts`：`@/ipc/store` 与 `@/capabilities`
 * 必须打掉（前者要落盘、后者要 host 通道），再用路由式 fetch 桩喂构造好的 JSON。
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

/** 每个用例都用全新的模块实例：cookie 罐与 WBI 密钥都是模块级状态。 */
async function freshBili() {
  vi.resetModules();
  return await import("@/utils/bilibili");
}

type Handler = (url: string, init: RequestInit) => unknown;
type Route = [needle: string, body: unknown | Handler];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 取请求头里的 Cookie（用来区分「匿名」与「本人视角」两次拉取）。 */
function cookieOf(init: RequestInit): string {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers.Cookie ?? "";
}

/**
 * 按 URL 片段路由的 fetch 桩：命中第一条 matcher 即返回。
 * 未命中直接抛错 —— 让「实现偷偷多打了一次接口」这种问题立刻暴露，而不是静默空响应。
 */
function stubFetch(routes: Route[]) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    for (const [needle, body] of routes) {
      if (url.includes(needle)) {
        return jsonResponse(typeof body === "function" ? (body as Handler)(url, init) : body);
      }
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** 匿名会话要先拿 buvid3，否则上游按风控回 -352（这里桩掉）。 */
const SPI: Route = ["/x/frontend/finger/spi", { code: 0, data: { b_3: "b3", b_4: "b4" } }];

/** nav 里的 wbi_img 是 WBI 密钥的唯一来源；两个文件名拼起来必须 ≥ 64 才会被采用。 */
const NAV_WBI = {
  code: 0,
  data: {
    wbi_img: {
      img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
      sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
    },
  },
};

/** 主列表响应：给一组一级评论，并置为已到底。 */
function mainBody(replies: unknown[]) {
  return {
    code: 0,
    data: {
      replies,
      cursor: { is_end: true, all_count: replies.length, pagination_reply: { next_offset: "" } },
    },
  };
}

/** 构造一条上游形态的一级评论；`urls` 用来挂商品 extra。 */
function rawReply(rpid: string, message = "这是一条评论", urls?: unknown) {
  return {
    rpid,
    mid: 100,
    like: 0,
    action: 0,
    count: 0,
    rcount: 0,
    content: { message, ...(urls === undefined ? {} : { urls }) },
    member: {
      mid: 100,
      uname: "测试用户",
      avatar: "//i0.hdslb.com/bfs/face/test.jpg",
      level_info: { current_level: 3 },
      vip: { vipStatus: 0 },
    },
    reply_control: { time_desc: "1天前", location: "IP属地：上海" },
    up_action: { like: false },
  };
}

beforeEach(() => {
  delete persisted["cookies"];
  vi.unstubAllGlobals();
});

describe("带货评论 / 动态判定", () => {
  it("content.urls 带 goods_item_id 的评论 isGoods=true，普通评论为 false", async () => {
    const goodsUrls = {
      "https://item.example.com/1": {
        extra: { goods_cm_control: 1, goods_item_id: "123", goods_prefetched_cache: "x" },
      },
    };
    stubFetch([
      SPI,
      [
        "/x/v2/reply/main",
        mainBody([
          rawReply("r1", "买它", goodsUrls),
          rawReply("r2", "普通评论"),
          rawReply("r3", "看这里 https://gaoneng.bilibili.com/tetris/page?a=1"),
        ]),
      ],
    ]);
    const bili = await freshBili();
    const page = await bili.biliReplies("1", 2);

    expect(page.replies.map((r) => r.isGoods)).toEqual([true, false, true]);
    // 判定不应污染正文解析
    expect(page.replies[1].message).toBe("普通评论");
  });

  it("动态流：ADDITIONAL_TYPE_GOODS 动态 goods=true 且带商品信息，普通动态为 false", async () => {
    const goodsItem = {
      id_str: "9001",
      type: "DYNAMIC_TYPE_DRAW",
      modules: {
        module_author: {
          mid: 42,
          name: "带货UP",
          face: "//i0.hdslb.com/bfs/face/a.jpg",
          pub_ts: 1700000000,
        },
        module_dynamic: {
          desc: { text: "这条挂了商品卡" },
          major: { draw: { items: [{ src: "//i0.hdslb.com/bfs/album/g1.jpg" }] } },
          additional: {
            type: "ADDITIONAL_TYPE_GOODS",
            goods: {
              title: "商品标题",
              jump_url: "https://item.taobao.com/item.htm?id=1",
              cover: "//i0.hdslb.com/bfs/goods/cover.jpg",
            },
          },
        },
        module_stat: { like: { count: 3 }, comment: { count: 1 }, forward: { count: 2 } },
      },
    };
    const plainItem = {
      id_str: "9002",
      type: "DYNAMIC_TYPE_WORD",
      modules: {
        module_author: {
          mid: 43,
          name: "普通UP",
          face: "//i0.hdslb.com/bfs/face/b.jpg",
          pub_ts: 1700000100,
        },
        module_dynamic: {
          desc: { text: "一条普通动态" },
          major: {
            draw: {
              items: [
                { src: "//i0.hdslb.com/bfs/album/p1.jpg" },
                { src: "//i0.hdslb.com/bfs/album/p2.jpg" },
              ],
            },
          },
        },
        module_stat: { like: { count: 1 }, comment: { count: 2 }, forward: { count: 3 } },
      },
    };
    stubFetch([
      SPI,
      [
        "/x/polymer/web-dynamic/v1/feed/all",
        { code: 0, data: { items: [goodsItem, plainItem], offset: "next-offset", has_more: true } },
      ],
    ]);
    const bili = await freshBili();
    const feed = await bili.biliDynamicFeed();

    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].goods).toBe(true);
    expect(feed.items[0].goodsTitle).toBe("商品标题");
    expect(feed.items[0].goodsUrl).toBe("https://item.taobao.com/item.htm?id=1");
    expect(feed.items[0].author.name).toBe("带货UP");

    expect(feed.items[1].goods).toBe(false);
    expect(feed.items[1].text).toBe("一条普通动态");
    expect(feed.items[1].images).toHaveLength(2);
    expect(feed.offset).toBe("next-offset");
    expect(feed.hasMore).toBe(true);
  });
});

describe("biliCheckReplyVisibility 反诈四态", () => {
  /** 本人视角的楼中楼接口：只有带 cookie 时才「找得到」。 */
  const selfView: Route = [
    "/x/v2/reply/reply",
    (_url: string, init: RequestInit) => {
      const logged = cookieOf(init).includes("SESSDATA");
      return {
        code: 0,
        data: {
          replies: logged ? [rawReply("r1")] : [],
          page: { count: logged ? 1 : 0, size: 20, num: 1 },
        },
      };
    },
  ];

  it("匿名主列表就能找到 → ok", async () => {
    stubFetch([SPI, ["/x/v2/reply/main", mainBody([rawReply("r1")])]]);
    const bili = await freshBili();
    const res = await bili.biliCheckReplyVisibility("1", "r1");

    expect(res.kind).toBe("ok");
  });

  it("匿名找不到、本人视角楼中楼能找到 → shadow（仅自己可见）", async () => {
    stubFetch([SPI, ["/x/v2/reply/main", mainBody([rawReply("other")])], selfView]);
    const bili = await freshBili();
    await bili.biliApplyCookies({ SESSDATA: "sess", bili_jct: "jct" });
    const res = await bili.biliCheckReplyVisibility("1", "r1");

    expect(res.kind).toBe("shadow");
  });

  it("一级评论两处都找不到 → hidden（本人视角接口直接报内容不存在）", async () => {
    stubFetch([
      SPI,
      ["/x/v2/reply/main", mainBody([rawReply("other")])],
      ["/x/v2/reply/reply", { code: -404, message: "啥都木有" }],
    ]);
    const bili = await freshBili();
    await bili.biliApplyCookies({ SESSDATA: "sess", bili_jct: "jct" });
    const res = await bili.biliCheckReplyVisibility("1", "r1", { message: "正文" });

    expect(res.kind).toBe("hidden");
    expect(res.message).toBe("正文");
  });

  it("楼中楼（root 非空）匿名与本人两遍都翻不到 → hidden", async () => {
    stubFetch([
      SPI,
      [
        "/x/v2/reply/reply",
        { code: 0, data: { replies: [], page: { count: 0, size: 20, num: 1 } } },
      ],
    ]);
    const bili = await freshBili();
    await bili.biliApplyCookies({ SESSDATA: "sess", bili_jct: "jct" });
    const res = await bili.biliCheckReplyVisibility("1", "r1", { root: "999" });

    expect(res.kind).toBe("hidden");
  });

  it("匿名主列表被风控打回 → failed（是「查不了」，绝不能当成 hidden）", async () => {
    stubFetch([SPI, ["/x/v2/reply/main", { code: -412, message: "请求被拦截" }], selfView]);
    const bili = await freshBili();
    const res = await bili.biliCheckReplyVisibility("1", "r1");

    expect(res.kind).toBe("failed");
    // detail 要指向「匿名列表拿不到」这个真实原因，而不是「评论不可见」
    expect(res.detail).toContain("无法匿名获取评论区");
  });

  it("请求直接抛错 → failed，detail 携带原始错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("网络连接失败");
      }),
    );
    const bili = await freshBili();
    const res = await bili.biliCheckReplyVisibility("1", "r1", { root: "999" });

    expect(res.kind).toBe("failed");
    expect(res.detail).toContain("网络连接失败");
  });
});

describe("biliAiConclusion AI 视频总结", () => {
  it("解析 model_result.summary 与 outline[].part_outline[]", async () => {
    stubFetch([
      ["/x/web-interface/nav", NAV_WBI],
      [
        "/x/web-interface/view/conclusion/get",
        {
          code: 0,
          data: {
            code: 0,
            model_result: {
              summary: "本视频讲述了……",
              outline: [
                {
                  title: "第一章",
                  part_outline: [
                    { timestamp: 12, content: "开场" },
                    { timestamp: 65, content: "第一个论点" },
                  ],
                },
              ],
            },
          },
        },
      ],
    ]);
    const bili = await freshBili();
    const res = await bili.biliAiConclusion("BV1xx411c7mD", "123456", 42);

    expect(res.summary).toBe("本视频讲述了……");
    expect(res.outline).toEqual([
      {
        title: "第一章",
        parts: [
          { timestamp: 12, content: "开场" },
          { timestamp: 65, content: "第一个论点" },
        ],
      },
    ]);
  });

  it("data.code=1（上游还在处理）抛「AI处理中，请稍后再试」", async () => {
    stubFetch([
      ["/x/web-interface/nav", NAV_WBI],
      ["/x/web-interface/view/conclusion/get", { code: 0, data: { code: 1 } }],
    ]);
    const bili = await freshBili();
    await expect(bili.biliAiConclusion("BV1xx411c7mD", "123456")).rejects.toThrow(
      "AI处理中，请稍后再试",
    );
  });

  it("其它非 0 的业务码抛「当前视频暂不支持AI视频总结」", async () => {
    stubFetch([
      ["/x/web-interface/nav", NAV_WBI],
      ["/x/web-interface/view/conclusion/get", { code: 0, data: { code: 2 } }],
    ]);
    const bili = await freshBili();
    await expect(bili.biliAiConclusion("BV1xx411c7mD", "123456")).rejects.toThrow(
      "当前视频暂不支持AI视频总结",
    );
  });
});
