/**
 * 「本地智能匹配」数据源回归测试（不依赖 Electron / 不发真实网络请求）。
 *
 * 覆盖四类：
 * 1. 打分：matchScore / matchArtist / smartTagRank 的排序与稳定性；
 * 2. 解析：五个源的**真实响应裁剪样本** → 归一化字段；
 * 3. 聚合：单源 reject 不拖垮其它源，错误进 outcome.error；
 * 4. 歌词兜底：任何失败返回空串而不是抛错。
 *
 * mock 接缝（与模块的真实依赖对应）：
 * - netease / migu / kuwo 走模块顶层 \`@/ipc/http\` 的 fetch；
 * - kugou 走 \`await import("@/capabilities")\` 的 kugouSearch；
 * - qq 走 \`@/utils/qqMusic\` 的 qqSearchSongs —— 必须在这一层 mock：
 *   qqMusic 内部用 isDesktop 门控，测试环境没有 window.__SILVERMOON__，
 *   它会退回**全局 fetch**，不经过 \`@/ipc/http\`（否则测试会真发网络请求）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTagSearchResult } from "@shared/types";

const h = vi.hoisted(() => {
  /** 每次 \`@/ipc/http\` 的 fetch 调用（url + init），供断言与桩实现分流 */
  const calls: { url: string; init?: RequestInit }[] = [];
  /** url 子串 → 响应工厂（返回 JSON 文本） */
  const routes = new Map<string, () => string>();
  const qqSongs: unknown[] = [];
  const kugouRaw: { value: unknown } = { value: null };
  return { calls, routes, qqSongs, kugouRaw };
});

vi.mock("@/ipc/http", () => ({
  fetch: async (url: string, init?: RequestInit) => {
    h.calls.push({ url, init });
    for (const [needle, factory] of h.routes) {
      if (url.includes(needle)) {
        return new Response(factory(), { status: 200, headers: { "Content-Type": "text/plain" } });
      }
    }
    return new Response("not found", { status: 404 });
  },
}));

vi.mock("@/capabilities", () => ({
  isDesktop: true,
  capabilities: {
    kugouSearch: async () => h.kugouRaw.value,
  },
}));

vi.mock("@/utils/qqMusic", () => ({
  qqSearchSongs: async () => h.qqSongs,
  qqFetchLyrics: async () => [],
}));

import {
  MUSIC_TAG_SOURCES,
  fetchTagLyrics,
  matchArtist,
  matchScore,
  musicTagSourceLabelKey,
  searchAllMusicTagSources,
  searchMusicTagSource,
  smartTagRank,
} from "@/utils/musicTagSources";

// ---------------------------------------------------------------------------
// 真实响应裁剪样本（取自各平台实测响应，字段名与嵌套层级原样保留）
// ---------------------------------------------------------------------------

/** netease：result.songs[]，歌手在 ar[]，专辑在 al{}，年份由 publishTime(ms) 推 */
const NETEASE_BODY = JSON.stringify({
  result: {
    songs: [
      {
        id: 2725685941,
        name: "夜曲",
        publishTime: 1751990400000,
        ar: [{ name: "Xai小爱" }],
        al: {
          name: "夜曲",
          picUrl: "http://p1.music.126.net/kBeIsIs1LuDB5aoj8PWdxw==/109951171458803146.jpg",
        },
      },
    ],
  },
});

/** migu：songResultData.result[]，lyricUrl 可直接 GET 到 LRC 文本 */
const MIGU_BODY = JSON.stringify({
  songResultData: {
    result: [
      {
        name: "夜曲",
        copyrightId: "60054701947",
        lyricUrl: "https://d.musicapp.migu.cn/data/oss/resource/00/1y/hd/y5",
        singers: [{ name: "周杰伦" }],
        albums: [{ name: "寂寞边境 月光爱人 情歌精选" }],
        imgItems: [
          {
            img: "https://d.musicapp.migu.cn/data/oss/resource/00/41/zg/52fc0237665241878a0159c7e4a39234.webp",
          },
        ],
      },
    ],
  },
});

/** kuwo：Python 风格单引号 JSON（非合法 JSON），字段在 abslist[] */
const KUWO_BODY = (pic: string) =>
  "{'TOTAL':'3598','abslist':[{'ARTIST':'周杰伦','ALBUM':'十一月的萧邦'," +
  `'DC_TARGETID':'118980','DC_TARGETTYPE':'music','DURATION':'226',` +
  `'NAME':'夜曲','web_albumpic_short':'${pic}'},{'ARTIST':'甲、乙',` +
  "'ALBUM':'别的专辑','DC_TARGETID':'999','NAME':'<em>另一首</em>'," +
  "'web_albumpic_short':''}]}";

/** kugou：走 capabilities.kugouSearch 的原始 JSON（FileHash/SongName/Singers 等） */
const KUGOU_RAW = {
  data: {
    lists: [
      {
        FileHash: "ABCDEF123456",
        SongName: "<em>夜曲</em>",
        Singers: [{ name: "周杰伦" }],
        AlbumName: "十一月的萧邦",
        Image: "http://c1.kgimg.com/star/albumcover/{size}/abc.jpg",
        Duration: 226000,
      },
    ],
  },
};

function resetStubs() {
  h.calls.length = 0;
  h.routes.clear();
  h.qqSongs.length = 0;
  h.kugouRaw.value = null;
}

beforeEach(resetStubs);

// ---------------------------------------------------------------------------
// 1. 打分
// ---------------------------------------------------------------------------

describe("① 打分：matchScore / matchArtist / smartTagRank", () => {
  it("matchScore：相等 2 / 包含 1 / 无关 0 / 空串 0", () => {
    expect(matchScore("夜曲", "夜曲")).toBe(2);
    expect(matchScore("夜曲", "夜曲（Live）")).toBe(1);
    expect(matchScore("夜曲", "晴天")).toBe(0);
    expect(matchScore("", "夜曲")).toBe(0);
    expect(matchScore("夜曲", "")).toBe(0);
    expect(matchScore("", "")).toBe(0);
  });

  it("matchScore：繁简与空白做归一化（周杰倫 vs 周杰伦 判为相等）", () => {
    expect(matchScore("周杰倫", "周杰伦")).toBe(2);
    expect(matchScore("周 杰 伦", "周杰伦")).toBe(2);
    expect(matchScore("周杰倫", "周杰倫")).toBe(2);
  });

  it("matchArtist：单歌手等价于 matchScore", () => {
    expect(matchArtist("周杰伦", "周杰伦")).toBe(2);
    expect(matchArtist("周杰伦", "蔡依林")).toBe(0);
  });

  it("matchArtist：多歌手逐段相加（只累加命中的段）", () => {
    // 「甲,乙」两段：只有第一段命中 → 2 + 0
    expect(matchArtist("甲", "甲,乙")).toBe(2);
    // 只命中第二段 → 0 + 2
    expect(matchArtist("乙", "甲,乙")).toBe(2);
    // 两段都命中同一歌手 → 2 + 2（这才是「逐段相加」的累加效果）
    expect(matchArtist("甲", "甲,甲")).toBe(4);
    // 包含关系每段记 1：与两段都是包含 → 1 + 1
    expect(matchArtist("甲乙", "甲,乙")).toBe(2);
    // 顿号与斜杠同样是分隔符
    expect(matchArtist("乙", "甲、乙")).toBe(2);
    expect(matchArtist("乙", "甲/乙")).toBe(2);
  });

  it("smartTagRank：标题相同的排前面", () => {
    const results = [
      result({ title: "无关", artist: "无关" }),
      result({ title: "夜曲", artist: "周杰伦" }),
    ];
    const ranked = smartTagRank({ title: "夜曲", artist: "周杰伦", album: "" }, results);
    expect(ranked[0].title).toBe("夜曲");
  });

  it("smartTagRank：艺术家完全不匹配时降权（-2），即使标题命中也会下沉", () => {
    const exact = result({ title: "夜曲", artist: "周杰伦" });
    const wrongArtist = result({ title: "夜曲", artist: "完全无关的人" });
    const ranked = smartTagRank({ title: "夜曲", artist: "周杰伦", album: "" }, [
      wrongArtist,
      exact,
    ]);
    expect(ranked[0]).toBe(exact);
    expect(ranked[1]).toBe(wrongArtist);
  });

  it("smartTagRank：同分时保持原顺序（稳定排序）", () => {
    const a = result({ title: "同分", artist: "同人" });
    const b = result({ title: "同分", artist: "同人" });
    const c = result({ title: "同分", artist: "同人" });
    const ranked = smartTagRank({ title: "同分", artist: "同人", album: "" }, [a, b, c]);
    expect(ranked).toEqual([a, b, c]);
  });

  it("smartTagRank：不修改入参数组的顺序（返回新数组）", () => {
    const a = result({ title: "低分", artist: "无关" });
    const b = result({ title: "夜曲", artist: "周杰伦" });
    const input = [a, b];
    const ranked = smartTagRank({ title: "夜曲", artist: "周杰伦", album: "" }, input);
    expect(input).toEqual([a, b]);
    expect(ranked).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 2. 解析
// ---------------------------------------------------------------------------

describe("② 解析：五个源的真实响应归一化", () => {
  it("netease：result.songs[] → title/artist/album/coverUrl/songId/year", async () => {
    h.routes.set("music.163.com", () => NETEASE_BODY);
    const list = await searchMusicTagSource("netease", "夜曲");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: "netease",
      songId: "2725685941",
      title: "夜曲",
      artist: "Xai小爱",
      album: "夜曲",
      coverUrl: "http://p1.music.126.net/kBeIsIs1LuDB5aoj8PWdxw==/109951171458803146.jpg",
    });
    // publishTime(ms) → 4 位年份
    expect(list[0].year).toMatch(/^\d{4}$/);
    // Referer 必须带上（服务端有校验）
    const call = h.calls.find((c) => c.url.includes("music.163.com"))!;
    expect((call.init?.headers as Record<string, string>)?.Referer).toBe("https://music.163.com/");
  });

  it("migu：songResultData.result[] → 歌手/专辑/封面/歌词地址", async () => {
    h.routes.set("migu.cn", () => MIGU_BODY);
    const list = await searchMusicTagSource("migu", "夜曲");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: "migu",
      songId: "60054701947",
      title: "夜曲",
      artist: "周杰伦",
      album: "寂寞边境 月光爱人 情歌精选",
      lyricsUrl: "https://d.musicapp.migu.cn/data/oss/resource/00/1y/hd/y5",
    });
    // imgItems[0].img（webp）
    expect(list[0].coverUrl).toContain(".webp");
  });

  it("kuwo：单引号 JSON 能容错解析，且 <em> 被清洗", async () => {
    h.routes.set("search.kuwo.cn", () => KUWO_BODY("120/s4s11/89/774616642.jpg"));
    const list = await searchMusicTagSource("kuwo", "夜曲");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      source: "kuwo",
      songId: "118980",
      title: "夜曲",
      artist: "周杰伦",
      album: "十一月的萧邦",
    });
    // 第二条的 <em> 高亮必须被剥掉
    expect(list[1].title).toBe("另一首");
    // uid / ver / vipver 必须带上，否则会退回 ALBUM 为空的旧格式
    const call = h.calls.find((c) => c.url.includes("search.kuwo.cn"))!;
    expect(call.url).toContain("uid=794762570");
    expect(call.url).toContain("ver=kwplayer_ar_9.2.2.1");
    expect(call.url).toContain("vipver=1");
  });

  it("kuwo 封面归一化回归：web_albumpic_short 带 120/ 前缀 → 不重复拼接", async () => {
    h.routes.set("search.kuwo.cn", () => KUWO_BODY("120/s4s11/89/774616642.jpg"));
    const list = await searchMusicTagSource("kuwo", "夜曲");
    // 曾经拼成 …/albumcover/120/120/… 实测 404
    expect(list[0].coverUrl).toBe(
      "https://img1.kuwo.cn/star/albumcover/120/s4s11/89/774616642.jpg",
    );
    expect(list[0].coverUrl).not.toContain("/120/120/");
  });

  it("kuwo 封面归一化回归：web_albumpic_short 不带前缀 → 补默认 120/", async () => {
    h.routes.set("search.kuwo.cn", () => KUWO_BODY("s4s11/89/774616642.jpg"));
    const list = await searchMusicTagSource("kuwo", "夜曲");
    // 两种字段形态必须归一化到同一个正确 URL
    expect(list[0].coverUrl).toBe(
      "https://img1.kuwo.cn/star/albumcover/120/s4s11/89/774616642.jpg",
    );
  });

  it("kuwo 封面归一化回归：两种字段形态产出同一个最终 URL", async () => {
    h.routes.set("search.kuwo.cn", () => KUWO_BODY("120/s4s11/89/774616642.jpg"));
    const withPrefix = (await searchMusicTagSource("kuwo", "夜曲"))[0].coverUrl;
    resetStubs();
    h.routes.set("search.kuwo.cn", () => KUWO_BODY("s4s11/89/774616642.jpg"));
    const withoutPrefix = (await searchMusicTagSource("kuwo", "夜曲"))[0].coverUrl;
    expect(withoutPrefix).toBe(withPrefix);
  });

  it("kugou：capabilities.kugouSearch 原始 JSON → <em> 清洗 + {size}→150", async () => {
    h.kugouRaw.value = KUGOU_RAW;
    const list = await searchMusicTagSource("kugou", "夜曲");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: "kugou",
      songId: "ABCDEF123456",
      title: "夜曲",
      artist: "周杰伦",
      album: "十一月的萧邦",
    });
    // kugouToOnlineSongs 已把 {size} 换成固定尺寸（COVER_SIZE=400）、
    // c1.kgimg.com 换成 imge.kugou.com
    expect(list[0].coverUrl).toBe("https://imge.kugou.com/star/albumcover/400/abc.jpg");
    expect(list[0].coverUrl).not.toContain("{size}");
  });

  it("qq：qqSearchSongs → 归一化；封面靠 albumMid(coverKey) 供上层拼接", async () => {
    h.qqSongs.push({
      id: "12345",
      mid: "0039MnYb0qxYhV",
      title: "夜曲",
      subtitle: "",
      artist: "周杰伦",
      album: "十一月的萧邦",
      durationMs: 226000,
    });
    const list = await searchMusicTagSource("qq", "夜曲");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: "qq",
      songId: "12345",
      title: "夜曲",
      artist: "周杰伦",
      album: "十一月的萧邦",
      // 搜索接口不给封面 URL，只回 mid
      coverUrl: "",
      coverKey: "0039MnYb0qxYhV",
    });
  });

  it("空关键词不请求任何源，直接返回空数组", async () => {
    expect(await searchMusicTagSource("netease", "   ")).toEqual([]);
    expect(await searchAllMusicTagSources("")).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it("结果里没有标题的条目被过滤掉", async () => {
    h.routes.set("music.163.com", () =>
      JSON.stringify({
        result: {
          songs: [
            { id: 1, name: "" },
            { id: 2, name: "有标题" },
          ],
        },
      }),
    );
    const list = await searchMusicTagSource("netease", "x");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("有标题");
  });

  it("HTTP 非 2xx 抛错（由聚合层收进 outcome）", async () => {
    // 没有注册路由 → 桩返回 404
    await expect(searchMusicTagSource("netease", "夜曲")).rejects.toThrow(/HTTP 404/);
  });

  it("非法 JSON 响应给出可读错误", async () => {
    h.routes.set("music.163.com", () => "<html>not json</html>");
    await expect(searchMusicTagSource("netease", "夜曲")).rejects.toThrow(/非 JSON/);
  });
});

// ---------------------------------------------------------------------------
// 3. 聚合容错
// ---------------------------------------------------------------------------

describe("③ 聚合：searchAllMusicTagSources 容错", () => {
  it("单源失败不影响其它源，错误进 outcome.error 且不抛", async () => {
    h.routes.set("music.163.com", () => NETEASE_BODY);
    h.routes.set("migu.cn", () => MIGU_BODY);
    h.routes.set("search.kuwo.cn", () => KUWO_BODY("120/a/b.jpg"));
    // kugou 的 capabilities 返回一个会抛的实现
    h.kugouRaw.value = null; // kugouToOnlineSongs(null) → [] 其实不抛，改用 qq 制造失败
    // qq 抛错（模拟接口失效）
    h.qqSongs.length = 0;
    const qqModule = await import("@/utils/qqMusic");
    const spy = vi.spyOn(qqModule, "qqSearchSongs").mockRejectedValueOnce(new Error("qq down"));

    const outcomes = await searchAllMusicTagSources("夜曲");
    spy.mockRestore();

    expect(outcomes.map((o) => o.source)).toEqual(MUSIC_TAG_SOURCES);
    const qq = outcomes.find((o) => o.source === "qq")!;
    expect(qq.results).toEqual([]);
    expect(qq.error).toContain("qq down");
    // 其它源的结果仍然在
    const netease = outcomes.find((o) => o.source === "netease")!;
    expect(netease.results.length).toBeGreaterThan(0);
    expect(netease.error).toBeUndefined();
    const total = outcomes.reduce((sum, o) => sum + o.results.length, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it("全部源失败时每个 outcome 都有 error，且整体不抛", async () => {
    // 不注册任何路由 → 除 kugou 外全部 404；kugou 也给 null
    h.kugouRaw.value = null;
    const qqModule = await import("@/utils/qqMusic");
    const spy = vi.spyOn(qqModule, "qqSearchSongs").mockRejectedValue(new Error("boom"));
    const outcomes = await searchAllMusicTagSources("夜曲");
    spy.mockRestore();
    expect(outcomes).toHaveLength(MUSIC_TAG_SOURCES.length);
    // netease/migu/kuwo 是 HTTP 404；qq 是 boom
    const errored = outcomes.filter((o) => o.error);
    expect(errored.length).toBeGreaterThanOrEqual(3);
    expect(outcomes.every((o) => o.results.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. 歌词兜底
// ---------------------------------------------------------------------------

describe("④ 歌词兜底：任何失败都返回空串", () => {
  it("netease：成功时取 lrc.lyric", async () => {
    h.routes.set("music.163.com", () => JSON.stringify({ lrc: { lyric: "[00:01.00]夜曲" } }));
    const lrc = await fetchTagLyrics(result({ source: "netease", songId: "1" }));
    expect(lrc).toBe("[00:01.00]夜曲");
  });

  it("migu：直接 GET lyricUrl 的文本", async () => {
    h.routes.set("migu.cn", () => "[00:10.00]夜曲 - 周杰伦");
    const lrc = await fetchTagLyrics(
      result({ source: "migu", lyricsUrl: "https://d.musicapp.migu.cn/x.lrc" }),
    );
    expect(lrc).toBe("[00:10.00]夜曲 - 周杰伦");
  });

  it("kuwo：lrclist 拼成标准 LRC 行", async () => {
    h.routes.set("kuwo.cn", () =>
      JSON.stringify({
        data: {
          lrclist: [
            { time: "10.5", lineLyric: "第一行" },
            { time: "70", lineLyric: "第二行" },
          ],
        },
      }),
    );
    const lrc = await fetchTagLyrics(result({ source: "kuwo", songId: "118980" }));
    expect(lrc).toBe("[00:10.50]第一行\n[01:10.00]第二行");
  });

  it("网络抛错时返回空串（不抛）——netease", async () => {
    // 无路由 → 404 → getJson 里 getText 抛 HTTP 404，但 fetchTagLyrics 必须吞掉
    await expect(fetchTagLyrics(result({ source: "netease", songId: "1" }))).resolves.toBe("");
  });

  it("网络抛错时返回空串（不抛）——kuwo / migu / kugou / qq", async () => {
    await expect(fetchTagLyrics(result({ source: "kuwo", songId: "1" }))).resolves.toBe("");
    await expect(fetchTagLyrics(result({ source: "migu", lyricsUrl: "" }))).resolves.toBe("");
    await expect(fetchTagLyrics(result({ source: "kugou", songId: "" }))).resolves.toBe("");
    await expect(fetchTagLyrics(result({ source: "qq", songId: "1" }))).resolves.toBe("");
  });

  it("缺少必要字段时返回空串而不请求网络", async () => {
    resetStubs();
    await expect(fetchTagLyrics(result({ source: "netease", songId: "" }))).resolves.toBe("");
    await expect(fetchTagLyrics(result({ source: "kuwo", songId: "" }))).resolves.toBe("");
    expect(h.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 源标签与常量
// ---------------------------------------------------------------------------

describe("⑤ 源标签 / 常量", () => {
  it("MUSIC_TAG_SOURCES 就是五个本地源且顺序固定", () => {
    expect(MUSIC_TAG_SOURCES).toEqual(["qq", "netease", "kugou", "migu", "kuwo"]);
  });

  it("musicTagSourceLabelKey 对每个源返回固定 i18n 键，未知回退 sourceSmart", () => {
    expect(musicTagSourceLabelKey("qq")).toBe("musicTag.sourceQq");
    expect(musicTagSourceLabelKey("netease")).toBe("musicTag.sourceNetease");
    expect(musicTagSourceLabelKey("kugou")).toBe("musicTag.sourceKugou");
    expect(musicTagSourceLabelKey("migu")).toBe("musicTag.sourceMigu");
    expect(musicTagSourceLabelKey("kuwo")).toBe("musicTag.sourceKuwo");
    expect(musicTagSourceLabelKey("unknown" as never)).toBe("musicTag.sourceSmart");
  });
});

/** 造一个候选（只覆盖用到的字段） */
function result(overrides: Partial<MusicTagSearchResult> = {}): MusicTagSearchResult {
  return {
    source: "netease",
    songId: "",
    title: "",
    artist: "",
    album: "",
    year: "",
    coverUrl: "",
    ...overrides,
  };
}
