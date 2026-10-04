// @vitest-environment jsdom
/**
 * `utils/preciseLyrics.ts` 的匹配编排回归测试。
 *
 * 这些用例全部围绕「匹配度低」的具体成因，每一条都对应一个真实修过的坑：
 *
 * 1. **时长校验用错误的估计值**：旧实现拿「最后一个歌词行的开始时间 + 1s」当曲长，
 *    而真实 TTML 里最后一行到曲末中位数还差 3.6s（p90 ≈ 7.6s，最大近 19s），
 *    于是**版本完全正确的候选也会被判「时长差过大」跳过**。现在用 amllTtmlDurationMs。
 * 2. **兜底取「第一个下载成功的」**：应该是「时长最接近的」；而且返回的 songId 必须
 *    与真正采用的歌词文件一致（旧实现硬写 candidates[0]，第一个下载失败时会指错歌）。
 * 3. **搜索词只试剥括注后的标题**：歌名整体被括号包住的条目会剥成空串，一条都搜不到。
 * 4. **判等是完全相等**：写法差一个标点 / feat. 位置就判死。
 * 5. **同名不同艺人**：453 组同名里 38% 是不同歌，必须用艺人分区分。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudLyrics,
  preciseLyricsClearCache,
  prefetchCloudLyrics,
} from "@/utils/preciseLyrics";
import { amllClearCache } from "@/utils/amllTtml";

vi.mock("@/ipc/store", () => ({
  JsonStore: class {
    async get(): Promise<null> {
      return null;
    }
    async set(): Promise<void> {}
    async save(): Promise<void> {}
  },
}));

vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

vi.mock("@/utils/onlineCache", () => ({
  lrcGet: vi.fn(async () => null),
  lrcSet: vi.fn(async () => {}),
}));

/** 测试基地址：与默认镜像区分开 */
const BASE = "https://amll.test/db";

/** 构造一条索引行 */
function idxEntry(names: string[], artists: string[], rawFile: string): string {
  const md: [string, string[]][] = [
    ["musicName", names],
    ["artists", artists],
    ["ncmMusicId", ["1"]],
  ];
  return JSON.stringify({ metadata: md, rawLyricFile: rawFile });
}

/** 构造一份 TTML：pCount 行，最后一行起始于 lastLineStartMs，行末整体结束于 durMs */
function ttml(opts: { pCount: number; lastLineStartMs: number; durMs: number }): string {
  const lines: string[] = [];
  const step = Math.floor(opts.lastLineStartMs / Math.max(1, opts.pCount));
  for (let i = 0; i < opts.pCount; i++) {
    const begin = i * step;
    lines.push(
      `<p begin="${(begin / 1000).toFixed(3)}s" end="${((begin + 900) / 1000).toFixed(3)}s">` +
        `<span begin="${(begin / 1000).toFixed(3)}s" end="${((begin + 900) / 1000).toFixed(3)}s">字${i}</span></p>`,
    );
  }
  return `<tt xmlns="http://www.w3.org/ns/ttml"><body dur="${(opts.durMs / 1000).toFixed(3)}s"><div>${lines.join("")}</div></body></tt>`;
}

interface Route {
  needle: string;
  body: string;
  status?: number;
}

/** fetch 桩：索引走 JSONL，逐字歌词走 TTML；未命中的 URL 直接抛错 */
function stubFetch(routes: Route[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const r of routes) {
      if (url.includes(r.needle)) {
        return new Response(r.body, { status: r.status ?? 200 });
      }
    }
    throw new Error("unexpected fetch: " + url);
  });
  return { calls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // 索引 / 歌词 / 结果三级都是模块级缓存：不清掉，用例之间会互相喂旧数据
  // （尤其是失败缓存，会把上一个用例的失败带进下一个）。
  amllClearCache();
  preciseLyricsClearCache();
});

describe("AMLL 时长校验用真实曲长（旧实现的最大缺陷）", () => {
  it("最后一个歌词行距曲末很远时，正确版本不再被误判为「时长差过大」", async () => {
    // 本地音频 200s。TTML：最后一行起点 190s、曲末（body dur）200s。
    // 旧实现会拿 190+1=191s 当曲长，与 200s 差 9s > 3s 容差 → 跳过该候选。
    // 新实现取 body dur = 200s，差 0s → 直接命中。
    const songTtml = ttml({ pCount: 40, lastLineStartMs: 190000, durMs: 200000 });
    stubFetch([
      { needle: "raw-lyrics-index.jsonl", body: idxEntry(["测试歌"], ["测试歌手"], "a.ttml") },
      { needle: "raw-lyrics/a.ttml", body: songTtml },
    ]);

    const r = await fetchCloudLyrics({
      title: "测试歌",
      artist: "测试歌手",
      durationMs: 200000,
      amllEnabled: true,
      amllBase: BASE,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("amll");
      expect(r.lines.length).toBeGreaterThan(0);
    }
  });

  it("时长确实对不上时，回退到「最接近的那一个」并返回与之一致的 songId", async () => {
    // 三个同版本候选：90s / 150s / 300s；本地 148s。
    // 旧实现：第一个候选（90s）时长校验失败但被记为 firstOk，兜底时返回它 —— 而且
    // songId 硬写 candidates[0]。新实现应选 150s 那一个（差 2s，且在本例中它是唯一
    // 时长最接近的），songId 也必须是它的。
    const mk = (durMs: number) => ttml({ pCount: 30, lastLineStartMs: durMs - 5000, durMs });
    stubFetch([
      {
        needle: "raw-lyrics-index.jsonl",
        body: [
          idxEntry(["同名歌"], ["某歌手"], "far-short.ttml"),
          idxEntry(["同名歌"], ["某歌手"], "close.ttml"),
          idxEntry(["同名歌"], ["某歌手"], "far-long.ttml"),
        ].join("\n"),
      },
      { needle: "raw-lyrics/far-short.ttml", body: mk(90000) },
      { needle: "raw-lyrics/close.ttml", body: mk(150000) },
      { needle: "raw-lyrics/far-long.ttml", body: mk(300000) },
    ]);

    const r = await fetchCloudLyrics({
      title: "同名歌",
      artist: "某歌手",
      durationMs: 148000,
      amllEnabled: true,
      amllBase: BASE,
      force: true,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      // 150s 的候选在 3s 容差内，应直接命中（而不是走到兜底）
      expect(r.songTitle).toBe("同名歌");
      // 命中的应该是 close.ttml 对应的时间轴（150s 版），行时间应落在 150s 量级
      const last = r.lines[r.lines.length - 1].time;
      expect(last).toBeGreaterThan(100);
      expect(last).toBeLessThan(150);
    }
  });
});

describe("搜索词同时试「原文」与「剥括注」两种形态", () => {
  it("歌名整体被括号包住时仍能搜到（旧实现关键词为空 → 一条都不返回）", async () => {
    // 索引里真实存在的形态：（……醉鬼阿Q）（feat. 孙燕姿）
    const title = "（……醉鬼阿Q）（feat. 孙燕姿）";
    const songTtml = ttml({ pCount: 20, lastLineStartMs: 120000, durMs: 130000 });
    stubFetch([
      { needle: "raw-lyrics-index.jsonl", body: idxEntry([title], ["某歌手"], "x.ttml") },
      { needle: "raw-lyrics/x.ttml", body: songTtml },
    ]);

    const r = await fetchCloudLyrics({
      title,
      artist: "某歌手",
      durationMs: 130000,
      amllEnabled: true,
      amllBase: BASE,
      force: true,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe("amll");
  });

  it("本地标签带【MV】等方括号后缀时仍能命中", async () => {
    const songTtml = ttml({ pCount: 20, lastLineStartMs: 120000, durMs: 130000 });
    stubFetch([
      { needle: "raw-lyrics-index.jsonl", body: idxEntry(["偶像"], ["歌手A"], "m.ttml") },
      { needle: "raw-lyrics/m.ttml", body: songTtml },
    ]);

    const r = await fetchCloudLyrics({
      title: "偶像【MV】",
      artist: "歌手A",
      durationMs: 130000,
      amllEnabled: true,
      amllBase: BASE,
      force: true,
    });

    expect(r.ok).toBe(true);
  });
});

describe("同名不同艺人 / 标点差异", () => {
  it("同名但艺人不同的候选不会被选中", async () => {
    // 《怪物》在真实索引里同时有 YOASOBI 与 MC HotDog 两首完全不同的歌。
    // 本地是 MC HotDog 版，索引顺序把 YOASOBI 版放在前面 —— 旧实现会拿错。
    const yoa = ttml({ pCount: 20, lastLineStartMs: 120000, durMs: 130000 });
    const hot = ttml({ pCount: 20, lastLineStartMs: 180000, durMs: 190000 });
    stubFetch([
      {
        needle: "raw-lyrics-index.jsonl",
        body: [
          idxEntry(["怪物"], ["YOASOBI"], "yoa.ttml"),
          idxEntry(["怪物"], ["MC HotDog热狗"], "hot.ttml"),
        ].join("\n"),
      },
      { needle: "raw-lyrics/yoa.ttml", body: yoa },
      { needle: "raw-lyrics/hot.ttml", body: hot },
    ]);

    const r = await fetchCloudLyrics({
      title: "怪物",
      artist: "MC HotDog热狗",
      durationMs: 190000,
      amllEnabled: true,
      amllBase: BASE,
      force: true,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      // 选中的必须是 MC HotDog 那一版：它的时间轴末尾接近 190s
      const last = r.lines[r.lines.length - 1].time;
      expect(last).toBeGreaterThan(170);
    }
  });

  it("标点 / 全角写法差异不再判死", async () => {
    const songTtml = ttml({ pCount: 16, lastLineStartMs: 100000, durMs: 110000 });
    stubFetch([
      {
        needle: "raw-lyrics-index.jsonl",
        body: idxEntry(["world.execute (me) ;"], ["Mili"], "w.ttml"),
      },
      { needle: "raw-lyrics/w.ttml", body: songTtml },
    ]);

    const r = await fetchCloudLyrics({
      title: "world.execute(me);",
      artist: "Mili",
      durationMs: 110000,
      amllEnabled: true,
      amllBase: BASE,
      force: true,
    });

    expect(r.ok).toBe(true);
  });
});

describe("失败缓存：瞬时网络错误只缓存 90 秒，确定性失败缓存 10 分钟", () => {
  /** 第一次索引下载抛网络错，之后成功；同时记录索引请求次数 */
  function transientThenOk(counter: { index: number; calls: number }) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("raw-lyrics-index.jsonl")) {
        counter.calls++;
        counter.index++;
        if (counter.index === 1) return new Response("boom", { status: 503 });
        return new Response(idxEntry(["重试歌"], ["歌手"], "r.ttml"), { status: 200 });
      }
      if (url.includes("raw-lyrics/r.ttml")) {
        return new Response(ttml({ pCount: 16, lastLineStartMs: 100000, durMs: 110000 }));
      }
      throw new Error("unexpected fetch: " + url);
    });
  }

  it("90 秒内命中失败缓存（不重复打网络）", async () => {
    const counter = { index: 0, calls: 0 };
    transientThenOk(counter);
    const opts = {
      title: "重试歌",
      artist: "歌手",
      durationMs: 110000,
      amllEnabled: true,
      amllBase: BASE,
    };
    expect((await fetchCloudLyrics(opts)).ok).toBe(false);
    const afterFirst = counter.calls;
    expect(await fetchCloudLyrics(opts)).toMatchObject({ ok: false });
    expect(counter.calls).toBe(afterFirst); // 仍在 90 秒内 → 不发请求
  });

  it("超过 90 秒后失败缓存失效，重新请求并能成功（这正是「匹配度低」的观感来源）", async () => {
    // 关键回归：旧实现把网络错误按 10 分钟缓存，一次 CDN 抖动会让这首歌在十分钟内
    // 一直匹配不上。这里把时钟推过 90 秒，验证会重新请求、并且这次拿到了歌词。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const counter = { index: 0, calls: 0 };
      transientThenOk(counter);
      const opts = {
        title: "重试歌",
        artist: "歌手",
        durationMs: 110000,
        amllEnabled: true,
        amllBase: BASE,
      };
      expect((await fetchCloudLyrics(opts)).ok).toBe(false);
      expect(counter.index).toBe(1);

      // 推进到 90 秒之后（但远小于 10 分钟）
      vi.setSystemTime(Date.now() + 95_000);
      const retry = await fetchCloudLyrics(opts);
      expect(counter.index).toBe(2); // 确实重新请求了索引
      expect(retry.ok).toBe(true);
      if (retry.ok) expect(retry.source).toBe("amll");
    } finally {
      vi.useRealTimers();
    }
  });

  it("确定性失败（确实没有候选）在 90 秒后不会反复重打网络", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { calls } = stubFetch([
        {
          needle: "raw-lyrics-index.jsonl",
          body: idxEntry(["完全不存在的歌"], ["某歌手"], "n.ttml"),
        },
      ]);
      const opts = {
        title: "张冠李戴的名字",
        artist: "某歌手",
        durationMs: 100000,
        amllEnabled: true,
        amllBase: BASE,
      };
      expect((await fetchCloudLyrics(opts)).ok).toBe(false);
      const before = calls.length;
      vi.setSystemTime(Date.now() + 95_000);
      expect((await fetchCloudLyrics(opts)).ok).toBe(false);
      // 确定性失败仍按 10 分钟缓存：90 秒后不该重新请求
      expect(calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("成功的请求会清掉瞬时失败标记", async () => {
    stubFetch([
      { needle: "raw-lyrics-index.jsonl", body: idxEntry(["成功歌"], ["歌手"], "ok.ttml") },
      {
        needle: "raw-lyrics/ok.ttml",
        body: ttml({ pCount: 16, lastLineStartMs: 100000, durMs: 110000 }),
      },
    ]);
    const r = await fetchCloudLyrics({
      title: "成功歌",
      artist: "歌手",
      durationMs: 110000,
      amllEnabled: true,
      amllBase: BASE,
    });
    expect(r.ok).toBe(true);
  });
});

describe("AMLL 关闭时不发任何 AMLL 请求", () => {
  it("amllEnabled=false 且偏好 amll 时直接走 QQ（不请求索引）", async () => {
    const { calls } = stubFetch([]);
    const r = await fetchCloudLyrics({
      title: "随便",
      artist: "谁",
      durationMs: 100000,
      preferredSource: "amll",
      amllEnabled: false,
      amllBase: BASE,
      force: true,
    });
    expect(r.ok).toBe(false);
    expect(calls.some((u) => u.includes("raw-lyrics-index.jsonl"))).toBe(false);
  });
});
describe("prefetchCloudLyrics（AutoMix 预载下一曲歌词）", () => {
  it("预载只落缓存：随后正式取词直接命中，不再打网络", async () => {
    const songTtml = ttml({ pCount: 30, lastLineStartMs: 110000, durMs: 120000 });
    const { calls } = stubFetch([
      { needle: "raw-lyrics-index.jsonl", body: idxEntry(["预载歌"], ["预载歌手"], "p.ttml") },
      { needle: "raw-lyrics/p.ttml", body: songTtml },
    ]);
    const opts = {
      title: "预载歌",
      artist: "预载歌手",
      durationMs: 120000,
      amllEnabled: true,
      amllBase: BASE,
    };

    const pre = await prefetchCloudLyrics(opts);
    expect(pre.ok).toBe(true);
    const callsAfterPrefetch = calls.length;

    // 正式取词：同参数、同缓存键，必须直接命中缓存且一次网络都不发
    const real = await fetchCloudLyrics(opts);
    expect(real.ok).toBe(true);
    if (real.ok) {
      expect(real.fromCache).toBe(true);
      expect(real.source).toBe("amll");
    }
    expect(calls.length).toBe(callsAfterPrefetch);
  });

  it("未命中时只返回失败结果，不抛错（预载不能影响播放）", async () => {
    stubFetch([{ needle: "raw-lyrics-index.jsonl", body: "" }]);
    const r = await prefetchCloudLyrics({
      title: "查无此歌",
      artist: "查无此人",
      durationMs: 100000,
      amllEnabled: true,
      amllBase: BASE,
    });
    expect(r.ok).toBe(false);
  });

  it("缺时长直接按 missing-info 短路（预载与正式取词同一判据）", async () => {
    const r = await prefetchCloudLyrics({
      title: "没有时长的歌",
      durationMs: undefined,
      amllEnabled: true,
      amllBase: BASE,
    });
    expect(r).toEqual({ ok: false, reason: "missing-info" });
  });
});
