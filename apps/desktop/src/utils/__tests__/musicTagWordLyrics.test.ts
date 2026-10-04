/**
 * 「逐字歌词」取词编排的回归测试（不依赖 Electron / 不发真实网络请求）。
 *
 * 覆盖四块：
 * 1. 网易云 `yrc` 解析（它与 KRC/QRC 的时间语义不同：**绝对毫秒**，不是相对行首）；
 * 2. 按候选取词：QQ/KG 富接口命中逐字、咪咕/酷我如实降级、失败返回 null 不抛；
 * 3. 按歌名+时长走 preciseLyrics 回退链，以及无时长时的标题兜底；
 * 4. 落盘文本：逐行歌词**绝不能**被写成伪逐字（见文末「逐行 vs 逐字」）。
 *
 * mock 接缝与 musicTagSources.test.ts 保持一致：
 * - netease 走模块顶层 `@/ipc/http`；
 * - qq / kg 的词接口走各自的 utils 模块（内部有自己的网络栈）；
 * - preciseLyrics 整体 mock（它自己已有完整测试，这里只验证接线）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricLine, MusicTagSearchResult } from "@shared/types";

const h = vi.hoisted(() => {
  const calls: { url: string }[] = [];
  const routes = new Map<string, () => string>();
  const qqLines: { value: LyricLine[] | null } = { value: null };
  const kgLines: { value: LyricLine[] | null } = { value: null };
  const qqSearch: { value: unknown[] } = { value: [] };
  const qqWordLevel: { value: boolean } = { value: true };
  const cloud: { value: unknown } = { value: null };
  return { calls, routes, qqLines, kgLines, qqSearch, qqWordLevel, cloud };
});

vi.mock("@/ipc/http", () => ({
  fetch: async (url: string) => {
    h.calls.push({ url });
    for (const [needle, factory] of h.routes) {
      if (url.includes(needle)) {
        return new Response(factory(), { status: 200, headers: { "Content-Type": "text/plain" } });
      }
    }
    return new Response("not found", { status: 404 });
  },
}));

vi.mock("@/utils/qqMusic", () => ({
  qqSearchSongs: async () => h.qqSearch.value,
  qqFetchLyrics: async () => h.qqLines.value,
  // detailed 版多回一个 wordLevel：由 QQ 侧显式给出，调用方不再用 units 反推
  qqFetchLyricsDetailed: async () =>
    h.qqLines.value ? { lines: h.qqLines.value, wordLevel: h.qqWordLevel.value } : null,
}));

vi.mock("@/utils/kgMusic", () => ({
  kgSearchSongs: async () => [],
  kgFetchLyrics: async () => h.kgLines.value,
}));

vi.mock("@/utils/preciseLyrics", () => ({
  fetchCloudLyrics: async () => h.cloud.value,
}));

import {
  fetchWordLyricsByMeta,
  fetchWordLyricsForCandidate,
  parseNeteaseYrc,
  toTagLyricsText,
} from "@/utils/musicTagWordLyrics";
import { parseLrc } from "@/utils/lyricTimeline";

function result(partial: Partial<MusicTagSearchResult>): MusicTagSearchResult {
  return {
    source: "netease",
    songId: "1",
    title: "夜曲",
    artist: "周杰伦",
    album: "",
    year: "",
    coverUrl: "",
    ...partial,
  };
}

/** 网易云 yrc 实测样本：行首 [行起点ms,行时长ms]，随后 (词起点ms,词时长ms,0)词 */
const YRC_SAMPLE =
  "[40450,4620](40450,280,0)原(40730,260,0)谅(40990,320,0)我(41310,150,0)不(41460,350,0)再(41810,380,0)送(42190,450,0)花\n" +
  "[45070,4530](45070,400,0)花(45470,360,0)瓣(45830,300,0)铺(46130,200,0)满";

beforeEach(() => {
  h.calls.length = 0;
  h.routes.clear();
  h.qqLines.value = null;
  h.kgLines.value = null;
  h.qqSearch.value = [];
  h.qqWordLevel.value = true;
  h.cloud.value = null;
});

// ---------------------------------------------------------------------------
// 1. 网易云 yrc 解析
// ---------------------------------------------------------------------------

describe("① parseNeteaseYrc", () => {
  it("解析出绝对毫秒词级时间轴（不是相对行首）", () => {
    const lines = parseNeteaseYrc(YRC_SAMPLE);
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toBeCloseTo(40.45, 3);
    expect(lines[0].text).toBe("原谅我不再送花");
    expect(lines[0].units?.map((u) => u.text)).toEqual(["原", "谅", "我", "不", "再", "送", "花"]);
    // 首词绝对起点 = 40450ms，末词 = 42190ms（若是 KRC 那样相对行首就会是 0 / 1740）
    expect(lines[0].units?.[0].start).toBeCloseTo(40.45, 3);
    expect(lines[0].units?.[6].start).toBeCloseTo(42.19, 3);
    expect(lines[0].units?.[6].end).toBeCloseTo(42.64, 3);
  });

  it("空文本行 / 非 yrc 行被跳过，不产生空歌词行", () => {
    expect(parseNeteaseYrc("")).toEqual([]);
    expect(parseNeteaseYrc("[00:01.00]普通LRC")).toEqual([]);
    expect(parseNeteaseYrc("[40450,4620]")).toEqual([]);
  });

  it("单字样行不写 units（逐字无意义，交给渲染端整行高亮）", () => {
    const lines = parseNeteaseYrc("[1000,500](1000,500,0)啊");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("啊");
    expect(lines[0].units).toBeUndefined();
  });

  it("词元带括号等坏数据时保文本、弃时间轴（不丢字也不串行）", () => {
    // 行文本独立于词元提取：只剥掉 `(数字,数字,数字)` 标记，其余字符原样保留
    const lines = parseNeteaseYrc("[1000,1000](1000,100,0)AB(CD(1100,100,0)EF");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("AB(CDEF");
    // 不变量：要么没有逐字时间轴，要么词元拼起来**恰好等于**行文本。
    // 绝不能出现「时间轴与文本对不上」却仍然逐字点亮的情况。
    const units = lines[0].units;
    expect(units === undefined || units.map((u) => u.text).join("") === lines[0].text).toBe(true);
  });

  it("正文里的普通括号（无时间标记）不会破坏词元一致性", () => {
    const lines = parseNeteaseYrc("[1000,1000](1000,300,0)Alive(2000,300,0) (Live)");
    expect(lines[0].text).toBe("Alive (Live)");
    expect(lines[0].units?.map((u) => u.text)).toEqual(["Alive", " (Live)"]);
  });
});

// ---------------------------------------------------------------------------
// 2. 按候选取词
// ---------------------------------------------------------------------------

describe("② fetchWordLyricsForCandidate", () => {
  it("qq：富接口命中逐字，wordLevel=true", async () => {
    h.qqLines.value = [
      {
        time: 1,
        text: "原谅我",
        units: [
          { text: "原", start: 1, end: 1.2 },
          { text: "谅", start: 1.2, end: 1.4 },
        ],
      },
    ];
    const hit = await fetchWordLyricsForCandidate(
      result({ source: "qq", songId: "1", raw: { mid: "M", durationMs: 200000 } }),
    );
    expect(hit?.wordLevel).toBe(true);
    expect(hit?.source).toBe("qq");
    expect(hit?.lines[0].text).toBe("原谅我");
  });

  it("qq：QRC 轨标 wordLevel=true，LRC 兜底轨标 false（不靠 units 反推）", async () => {
    // 行上带着粗排 units（≥2 个词元），但 QQ 侧说这是 LRC 兜底轨
    h.qqLines.value = [
      {
        time: 1,
        text: "逐行歌词",
        units: [
          { text: "逐", start: 1, end: 1.2 },
          { text: "行", start: 1.2, end: 1.4 },
        ],
      },
    ];
    h.qqWordLevel.value = false;
    const hit = await fetchWordLyricsForCandidate(
      result({ source: "qq", songId: "1", raw: { mid: "M", durationMs: 200000 } }),
    );
    expect(hit?.wordLevel).toBe(false);
    // 行本身仍带 units（渲染逐字填充要好看），只是写标签时会被剥掉
    expect(hit?.lines[0].units?.length).toBe(2);
  });

  it("kugou：无 hash 直接返回 null（不空发请求）", async () => {
    expect(
      await fetchWordLyricsForCandidate(result({ source: "kugou", songId: "1", raw: {} })),
    ).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it("kugou：有 hash 时按 KRC 取词", async () => {
    h.kgLines.value = [
      {
        time: 2,
        text: "花瓣",
        units: [
          { text: "花", start: 2, end: 2.3 },
          { text: "瓣", start: 2.3, end: 2.6 },
        ],
      },
    ];
    const hit = await fetchWordLyricsForCandidate(
      result({ source: "kugou", songId: "7", raw: { hash: "ABC", albumAudioId: "7" } }),
    );
    expect(hit?.source).toBe("kg");
    expect(hit?.wordLevel).toBe(true);
  });

  it("netease：命中 yrc 逐字轨", async () => {
    h.routes.set("music.163.com", () => JSON.stringify({ yrc: { lyric: YRC_SAMPLE } }));
    const hit = await fetchWordLyricsForCandidate(result({ source: "netease", songId: "65766" }));
    expect(hit?.source).toBe("netease-ylrc");
    expect(hit?.wordLevel).toBe(true);
    expect(hit?.lines[0].units?.length).toBe(7);
    // yv/kv 参数必须在（否则服务端不返回 yrc）
    expect(h.calls[0].url).toContain("yv=0");
  });

  it("netease：无 yrc 时退回普通 LRC（wordLevel=false，不空手而归）", async () => {
    h.routes.set("music.163.com", () =>
      JSON.stringify({ lrc: { lyric: "[00:01.00]第一行\n[00:03.00]第二行" } }),
    );
    const hit = await fetchWordLyricsForCandidate(result({ source: "netease", songId: "1" }));
    expect(hit?.wordLevel).toBe(false);
    // 首行在 1s 之后，parseLrc 会补一条前奏三点行（与全应用一致）；歌词本身原样带回
    const texts = hit?.lines.filter((l) => !l.instrumental).map((l) => l.text);
    expect(texts).toEqual(["第一行", "第二行"]);
    // 逐行结果不带粗排 units，避免被误当成逐字写进文件
    expect(hit?.lines.every((l) => l.units === undefined)).toBe(true);
  });

  it("netease：接口出错时返回 null（不抛）", async () => {
    // 无路由 → 404
    await expect(
      fetchWordLyricsForCandidate(result({ source: "netease", songId: "1" })),
    ).resolves.toBeNull();
  });

  it("migu / kuwo：公开接口没有逐字，返回 null 交由调用方走逐行链路", async () => {
    await expect(
      fetchWordLyricsForCandidate(result({ source: "migu", songId: "1" })),
    ).resolves.toBeNull();
    await expect(
      fetchWordLyricsForCandidate(result({ source: "kuwo", songId: "1" })),
    ).resolves.toBeNull();
    expect(h.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 按歌名 + 时长走回退链
// ---------------------------------------------------------------------------

describe("③ fetchWordLyricsByMeta", () => {
  it("命中回退链时带上来源与逐字标记", async () => {
    h.cloud.value = {
      ok: true,
      source: "qq",
      lines: [
        {
          time: 1,
          text: "原谅我",
          units: [
            { text: "原", start: 1, end: 1.2 },
            { text: "谅", start: 1.2, end: 1.4 },
          ],
        },
      ],
      songId: "1",
      songTitle: "夜曲",
      wordLevel: true,
      fromCache: false,
    };
    const hit = await fetchWordLyricsByMeta({
      title: "夜曲",
      artist: "周杰伦",
      durationMs: 226000,
    });
    expect(hit?.wordLevel).toBe(true);
    expect(hit?.hit.source).toBe("qq");
    expect(hit?.hit.songTitle).toBe("夜曲");
  });

  it("回退链未命中返回 null", async () => {
    h.cloud.value = { ok: false, reason: "no-match" };
    expect(await fetchWordLyricsByMeta({ title: "夜曲", durationMs: 1 })).toBeNull();
  });

  it("标题为空直接返回 null（不发请求）", async () => {
    expect(await fetchWordLyricsByMeta({ title: "   ", durationMs: 1000 })).toBeNull();
  });

  it("缺时长时走标题兜底（QQ 搜索取标题命中项）", async () => {
    h.qqSearch.value = [
      {
        id: "1",
        mid: "M",
        title: "夜曲",
        subtitle: "",
        artist: "周杰伦",
        album: "",
        durationMs: 0,
      },
    ];
    h.qqLines.value = [{ time: 1, text: "啊", units: [{ text: "啊", start: 1, end: 1.4 }] }];
    // 标题兜底走 QQ：逐字性由 QQ 侧给出（此处置 false，模拟 LRC 兜底轨）
    h.qqWordLevel.value = false;
    const hit = await fetchWordLyricsByMeta({ title: "夜曲", artist: "周杰伦" });
    expect(hit?.hit.source).toBe("qq");
    expect(hit?.wordLevel).toBe(false);
  });

  it("缺时长且搜不到候选时返回 null", async () => {
    expect(await fetchWordLyricsByMeta({ title: "查无此歌" })).toBeNull();
  });

  it("纯音乐占位文案被过滤后视为未命中", async () => {
    h.cloud.value = {
      ok: true,
      source: "qq",
      lines: [{ time: 0, text: "此歌曲为没有填词的纯音乐，请您欣赏" }],
      songId: "1",
      songTitle: "x",
      wordLevel: false,
      fromCache: false,
    };
    expect(await fetchWordLyricsByMeta({ title: "x", durationMs: 1000 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. 落盘文本：走增强型 LRC
// ---------------------------------------------------------------------------

describe("④ toTagLyricsText", () => {
  it("逐字行写成增强型 LRC，且能被 parseLrc 原样读回", () => {
    const lines: LyricLine[] = [
      {
        time: 12.34,
        text: "原谅我",
        units: [
          { text: "原", start: 12.34, end: 12.61 },
          { text: "谅", start: 12.61, end: 12.88 },
          { text: "我", start: 12.88, end: 13.2 },
        ],
      },
    ];
    const text = toTagLyricsText(lines, true);
    expect(text).toContain("<00:12.34>原");
    const round = parseLrc(text, false);
    expect(round[0].text).toBe("原谅我");
    expect(round[0].units?.map((u) => u.text)).toEqual(["原", "谅", "我"]);
  });

  it("逐行歌词写成普通 LRC，不掺伪逐字标记", () => {
    const text = toTagLyricsText(
      [
        { time: 1, text: "第一行" },
        { time: 3, text: "第二行" },
      ],
      false,
    );
    expect(text).toBe("[00:01.00]第一行\n[00:03.00]第二行");
    expect(text).not.toContain("<");
  });

  // ---- 逐行 vs 逐字：踩过的坑（wordLevel 必须由调用方显式担保）----

  it("wordLevel=false 时，即使行上带粗排 units（Meting 回退链），也只写普通 LRC", () => {
    // 模拟 preciseLyrics 的 Meting 分支：返回逐行歌词，但 parseLrc 默认附了粗排 units
    const lines = parseLrc("[00:10.00]第一句歌词\n[00:14.00]第二句歌词", true);
    expect(lines.some((l) => (l.units?.length ?? 0) > 1)).toBe(true);

    const text = toTagLyricsText(lines, false);
    expect(text).not.toContain("<00:");
    expect(text).toBe("[00:10.00]第一句歌词\n[00:14.00]第二句歌词");
  });

  it("wordLevel=false 不修改入参（剥 units 走拷贝）", () => {
    const lines = parseLrc("[00:10.00]第一句歌词", true);
    const before = lines[0].units;
    toTagLyricsText(lines, false);
    expect(lines[0].units).toBe(before);
  });

  it("wordLevel=true 但行上没有 units 时，该行仍写普通 LRC", () => {
    expect(toTagLyricsText([{ time: 1, text: "纯文本行" }], true)).toBe("[00:01.00]纯文本行");
  });
});
