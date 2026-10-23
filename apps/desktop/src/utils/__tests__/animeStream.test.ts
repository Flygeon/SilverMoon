/**
 * 静态取流单测（方案书 §6）：覆盖规则正则、规则 JSONPath、通用 m3u8、
 * 通用 mp4/flv 四条快速路径的命中优先级与 URL 归一化，以及流挑选策略。
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractIframeUrls,
  extractStaticStream,
  extractStaticStreamDeep,
  pickStream,
} from "../animeStream";
import type { AnimeRule } from "@shared/types";

const BASE = "https://example.com/";

function rule(overrides?: Partial<AnimeRule>): AnimeRule {
  return {
    name: "测试源",
    baseURL: BASE,
    searchMode: "xpath",
    chapterMode: "xpath",
    searchURL: "",
    searchList: "",
    searchName: "",
    searchResult: "",
    chapterRoads: "",
    chapterResult: "",
    ...overrides,
  } as AnimeRule;
}

describe("extractStaticStream", () => {
  it("优先规则正则（取首个捕获组）", () => {
    const hit = extractStaticStream(
      `var url = "https://cdn.example/a/index.m3u8";`,
      rule({ streamRegex: `url = "([^"]+)"` }),
      BASE,
    );
    expect(hit?.method).toBe("regex");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8");
  });

  it("规则正则无捕获组时用全匹配", () => {
    const hit = extractStaticStream(
      `var u = https://cdn.example/a/1.mp4;`,
      rule({ streamRegex: "https://[^\"'\\\\s;]+" }),
      BASE,
    );
    expect(hit?.method).toBe("regex");
    expect(hit?.url).toBe("https://cdn.example/a/1.mp4");
  });

  it("规则正则非法时落到通用路径", () => {
    const hit = extractStaticStream(
      `https://cdn.example/a/index.m3u8`,
      rule({ streamRegex: "(" }),
      BASE,
    );
    expect(hit?.method).toBe("generic-m3u8");
  });

  it("规则 JSONPath 从内嵌 <script> JSON 提取", () => {
    const html = `<html><script>{"url":"/play/1/index.m3u8"}</script></html>`;
    const hit = extractStaticStream(html, rule({ streamJsonPath: "$.url" }), BASE);
    expect(hit?.method).toBe("jsonpath");
    expect(hit?.url).toBe("https://example.com/play/1/index.m3u8");
  });

  it("整页即为 JSON 时直接提取", () => {
    const html = JSON.stringify({ playUrl: "https://cdn.example/a.m3u8?token=1" });
    const hit = extractStaticStream(html, rule({ streamJsonPath: "$.playUrl" }), BASE);
    expect(hit?.method).toBe("jsonpath");
    expect(hit?.url).toBe("https://cdn.example/a.m3u8?token=1");
  });

  it("JSONPath 未命中时落到通用 m3u8", () => {
    const html = `<script>window.x = {"a":1}</script>https://cdn.example/a/index.m3u8`;
    const hit = extractStaticStream(html, rule({ streamJsonPath: "$.url" }), BASE);
    expect(hit?.method).toBe("generic-m3u8");
  });

  it("通用 m3u8 直链", () => {
    const hit = extractStaticStream(
      `src="https://cdn.example/a/index.m3u8?token=abc"`,
      rule(),
      BASE,
    );
    expect(hit?.method).toBe("generic-m3u8");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?token=abc");
  });

  it("通用 m3u8 支持协议相对", () => {
    const hit = extractStaticStream(`"//cdn.example/a/index.m3u8"`, rule(), BASE);
    expect(hit?.method).toBe("generic-m3u8");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8");
  });

  it("通用 mp4 直链（无 m3u8 时）", () => {
    const hit = extractStaticStream(
      `<video src="https://cdn.example/a/1.mp4"></video>`,
      rule(),
      BASE,
    );
    expect(hit?.method).toBe("generic-mp4");
    expect(hit?.url).toBe("https://cdn.example/a/1.mp4");
  });

  it("flv 同样命中", () => {
    const hit = extractStaticStream(`"https://cdn.example/live.flv?x=1"`, rule(), BASE);
    expect(hit?.method).toBe("generic-mp4");
    expect(hit?.url).toBe("https://cdn.example/live.flv?x=1");
  });

  it("页面无任何流返回 null", () => {
    expect(extractStaticStream("<html>没有视频</html>", rule(), BASE)).toBeNull();
  });

  // ---- JSON 转义的 URL（`/` 写成 `\/`）：苹果CMS 系站点普遍如此 ----
  // 事故背景：旧版正则的字符集排除了 `\` 且要求 `https:` 后紧跟 `//`，
  // 导致 akianime 等整类站点静态提取全部落空，只能掉进隐藏 webview（30s 超时而归）。

  it("player_aaaa 配置里 JSON 转义的 m3u8（真实页面片段）", () => {
    const html =
      `<script type="text/javascript">var player_aaaa={"flag":"play","encrypt":0,` +
      `"vod_data":{"vod_name":"\\u65e0\\u804c"},` +
      `"url":"https:\\/\\/fengbao12.com\\/video\\/abc\\/4b20eb12a14f\\/index.m3u8",` +
      `"url_next":"https:\\/\\/fengbao12.com\\/video\\/abc\\/c1ba25aebaba\\/index.m3u8",` +
      `"from":"bfzym3u8","id":"e3cDDE","sid":3,"nid":1}</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://fengbao12.com/video/abc/4b20eb12a14f/index.m3u8");
  });

  it("通用 m3u8 也能命中 JSON 转义写法", () => {
    const html = `<div>"url":"https:\\/\\/cdn.example\\/a\\/index.m3u8?token=1"</div>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("generic-m3u8");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?token=1");
  });

  it("通用 mp4 同样支持 JSON 转义写法", () => {
    const html = `{"url":"https:\\/\\/cdn.example\\/a\\/01.mp4"}`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("generic-mp4");
    expect(hit?.url).toBe("https://cdn.example/a/01.mp4");
  });

  it("未转义的 URL 行为不变（反转义不得误伤）", () => {
    const hit = extractStaticStream(`src="https://cdn.example/a/index.m3u8"`, rule(), BASE);
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8");
  });

  it("云解析 token 不当作地址（gugu3：url 是 vwnet-xxx，真址要跑 JS 换）", () => {
    const html =
      `<script>var player_aaaa={"flag":"play","encrypt":0,` +
      `"url":"vwnet-358921638633a60cf600b5cadde8a7a5","from":"yunjie","id":"5044"}</script>`;
    expect(extractStaticStream(html, rule(), BASE)).toBeNull();
  });

  it("配置里 url 为数组时取第一个有效项", () => {
    const html =
      `<script>var player_aaaa={"url":["https:\\/\\/cdn.example\\/a.m3u8",` +
      `"https:\\/\\/cdn.example\\/b.m3u8"]}</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/a.m3u8");
  });

  it("配置 JSON 非法时不崩，落到后续路径", () => {
    const html = `<script>var player_aaaa={"url":</script>https://cdn.example/a.m3u8`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("generic-m3u8");
  });

  // ---- 等号前后空白 / window 前缀：模板写法差异 ----
  it("player_aaaa 等号前有空格时仍能提取", () => {
    const html = `<script>var player_aaaa = {"url":"https:\\/\\/cdn.example\\/a\\/index.m3u8"}</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8");
  });

  it("window.player_aaaa 写法同样能提取", () => {
    const html = `<script>window.player_aaaa={"url":"https://cdn.example/a/1.mp4"}</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/a/1.mp4");
  });

  it("不误匹配同前缀的更长变量名", () => {
    const html =
      `<script>var player_aaaa2={"url":"https:\\/\\/bad.example\\/a.m3u8"};` +
      `var player_aaaa={"url":"https:\\/\\/cdn.example\\/b.m3u8"}</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/b.m3u8");
  });

  // ---- HTML 实体：属性/JSON 里的 &amp; 会让签名 URL 失效 ----
  it("通用匹配到的 URL 会还原 &amp;", () => {
    const hit = extractStaticStream(
      `<video src="https://cdn.example/a/index.m3u8?token=1&amp;expires=2"></video>`,
      rule(),
      BASE,
    );
    expect(hit?.method).toBe("generic-m3u8");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?token=1&expires=2");
  });

  it("player 配置里的 &amp; 同样还原", () => {
    const html =
      `<script>var player_aaaa={"url":` +
      `"https:\\/\\/cdn.example\\/a\\/index.m3u8?token=1&amp;expires=2"}</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?token=1&expires=2");
  });

  it("普通 & 参数不会被实体还原误伤", () => {
    const hit = extractStaticStream(`src="https://cdn.example/a/index.m3u8?a=1&b=2"`, rule(), BASE);
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?a=1&b=2");
  });

  // ---- base64 / URL 编码包裹的地址 ----
  it("player 配置里 base64 编码的地址会被解码", () => {
    const html =
      `<script>var player_aaaa={"url":"aHR0cHM6Ly9jZG4uZXhhbXBsZS9hL2luZGV4Lm0zdTg="}` +
      `</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8");
  });

  it("JS 里 atob('...') 包裹的地址会被解码", () => {
    const html = `<script>var u = atob("aHR0cHM6Ly9jZG4uZXhhbXBsZS9hL2luZGV4Lm0zdTg/dG9rZW49MQ==");</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("base64");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?token=1");
  });

  it("URL 编码包裹的地址会被解码", () => {
    const html = `<div>player?url=https%3A%2F%2Fcdn.example%2Fa%2Findex.m3u8%3Ftoken%3D1&t=2</div>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("urlencoded");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8?token=1");
  });

  // ---- JSON unicode 转义斜杠 ----
  it("支持 \\u002F 转义的斜杠", () => {
    const html = `<script>var u = "https:\\u002F\\u002Fcdn.example\\u002Fa.m3u8";</script>`;
    const hit = extractStaticStream(html, rule(), BASE);
    expect(hit?.method).toBe("generic-m3u8");
    expect(hit?.url).toBe("https://cdn.example/a.m3u8");
  });
});

describe("extractIframeUrls", () => {
  it("提取并归一化 iframe src（相对 / 协议相对）", () => {
    const html =
      `<iframe src="/player/1.html"></iframe>` +
      `<iframe src="//cdn.example/player/2.html"></iframe>`;
    expect(extractIframeUrls(html, BASE)).toEqual([
      "https://example.com/player/1.html",
      "https://cdn.example/player/2.html",
    ]);
  });

  it("支持懒加载 data-src，跳过 javascript: 与重复项", () => {
    const html =
      `<iframe data-src="https://player.example/1.html"></iframe>` +
      `<iframe src="javascript:void(0)"></iframe>` +
      `<iframe src="https://player.example/1.html"></iframe>`;
    expect(extractIframeUrls(html, BASE)).toEqual(["https://player.example/1.html"]);
  });

  it("无 iframe 时返回空数组", () => {
    expect(extractIframeUrls("<html><video src='https://x/a.m3u8'></video></html>", BASE)).toEqual(
      [],
    );
  });
});

describe("extractStaticStreamDeep", () => {
  const outer = `<html><iframe src="/player/ep1.html"></iframe></html>`;

  it("外层未命中时跟进 iframe 提取", async () => {
    const fetchPage = vi.fn(async (url: string) => {
      expect(url).toBe("https://example.com/player/ep1.html");
      return `<script>var player_aaaa = {"url":"https:\\/\\/cdn.example\\/a\\/index.m3u8"}</script>`;
    });
    const hit = await extractStaticStreamDeep(outer, rule(), BASE, fetchPage);
    expect(hit?.method).toBe("player-config");
    expect(hit?.url).toBe("https://cdn.example/a/index.m3u8");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("外层直接命中时不抓 iframe", async () => {
    const fetchPage = vi.fn(async () => null);
    const hit = await extractStaticStreamDeep(
      `https://cdn.example/a.m3u8`,
      rule(),
      BASE,
      fetchPage,
    );
    expect(hit?.method).toBe("generic-m3u8");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("iframe 抓取抛错 / 返回 null 时安全返回 null", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await extractStaticStreamDeep(outer, rule(), BASE, throwing)).toBeNull();
    const empty = vi.fn(async () => null);
    expect(await extractStaticStreamDeep(outer, rule(), BASE, empty)).toBeNull();
  });

  it("maxDepth=0 时不跟 iframe", async () => {
    const fetchPage = vi.fn(
      async () => `<script>var player_aaaa={"url":"https://x/a.m3u8"}</script>`,
    );
    expect(await extractStaticStreamDeep(outer, rule(), BASE, fetchPage, 0)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("总抓取数受 maxFetches 限制（防止广告 iframe 拖慢取流）", async () => {
    const html = `<iframe src="/a.html"></iframe><iframe src="/b.html"></iframe>`;
    const fetchPage = vi.fn(async () => `<iframe src="/c.html"></iframe>`);
    const hit = await extractStaticStreamDeep(html, rule(), BASE, fetchPage, 3, 2);
    expect(hit).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("支持两层嵌套 iframe，且相对地址基于内层页面解析", async () => {
    const pages: Record<string, string> = {
      "https://example.com/player/ep1.html": `<iframe src="/player/inner.html"></iframe>`,
      "https://example.com/player/inner.html": `<script>var player_aaaa={"url":"../media/a.m3u8"}</script>`,
    };
    const fetchPage = vi.fn(async (url: string) => pages[url] ?? null);
    const hit = await extractStaticStreamDeep(outer, rule(), BASE, fetchPage);
    expect(hit?.url).toBe("https://example.com/media/a.m3u8");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("播放器 iframe 优先于广告 iframe（避免把广告 mp4 当正片）", async () => {
    const html =
      `<iframe src="https://ad.doubleclick.net/banner.html"></iframe>` +
      `<iframe src="/player/ep2.html"></iframe>`;
    const fetched: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes("/player/")) {
        return `<script>var player_aaaa={"url":"https://cdn.example/a.m3u8"}</script>`;
      }
      return `<video src="https://ads.example/ad.mp4"></video>`;
    });
    const hit = await extractStaticStreamDeep(html, rule(), BASE, fetchPage);
    expect(hit?.url).toBe("https://cdn.example/a.m3u8");
    expect(fetched[0]).toBe("https://example.com/player/ep2.html");
  });

  it("只有明显广告 iframe 时不浪费抓取次数", async () => {
    const html = `<iframe src="https://ad.doubleclick.net/banner.html"></iframe>`;
    const fetchPage = vi.fn(async () => "<html></html>");
    expect(await extractStaticStreamDeep(html, rule(), BASE, fetchPage)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe("pickStream", () => {
  it("优先 m3u8", () => {
    expect(pickStream(["https://cdn.example/a.mp4", "https://cdn.example/a.m3u8"])).toBe(
      "https://cdn.example/a.m3u8",
    );
  });

  it("空数组返回 null", () => {
    expect(pickStream([])).toBeNull();
  });

  it("URL 去重（按 # 前片段）", () => {
    const urls = [
      "https://cdn.example/a.m3u8#1",
      "https://cdn.example/a.m3u8#2",
      "https://cdn.example/b.m3u8",
    ];
    expect(pickStream(urls)).toBe("https://cdn.example/a.m3u8#1");
  });
});
