// @vitest-environment jsdom
/**
 * AMLL TTML DB 歌词源（`utils/amllTtml.ts`）的回归测试。
 *
 * 这条链路是「上游 JSONL 索引 + TTML 文本 → 本地 LyricLine」，纯数据搬运，但有几处
 * 最容易悄悄坏掉、且坏了以后只在真机上表现为「歌词错位 / 少一行」：
 *
 * 1. **逐字时间轴的单位**。TTML 用 `00:01.500` / `1.5s` 这类毫秒级写法，而
 *    `LyricLine.time` / `WordUnit.start` 是**秒**；差 1000 倍不会报错，只会让
 *    每行歌词都挤在第 0 秒 —— 所以这里把毫秒→秒的换算钉死。
 * 2. **翻译 / 音译的落点**。`ttm:role="x-translation"` 与 `x-roman` 必须分别进
 *    `translation` / `romaji`，且**不能**混进正文与 units（否则逐字高亮会多出几个
 *    不该唱的字）。真实库里另有一小部分把翻译写在 `<head>` 里按 `itunes:key` 关联。
 * 3. **空格规则**。AMLL 规范第 6 节：span 内**自带**的空白才保留，标签之间的换行 /
 *    缩进只是排版。判错会让英文歌词粘成 `HelloWorld` 或让中文歌词被塞满空格。
 *
 * 索引文件有 1.6MB，测试一律走 fetch 桩，绝不真联网。
 * 桩写法对齐同目录的 `bilibiliQrLogin.test.ts`：`@/ipc/store` / `@/capabilities`
 * 打掉；文件首行声明 jsdom 环境（`parseAmllTtml` 需要 DOMParser）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMLL_DEFAULT_BASE,
  amllClearCache,
  amllFetchLyrics,
  amllSearchSongs,
  amllTtmlDurationMs,
  parseAmllTime,
  parseAmllTtml,
  type AmllTtmlSong,
} from "@/utils/amllTtml";

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

/** 测试专用基地址：与默认镜像区分开，便于断言 URL 拼接。 */
const TEST_BASE = "https://amll.test/db";

/** 一次 fetch 调用（url）的桩记录。 */
interface FetchCall {
  url: string;
}

/**
 * 按 URL 片段路由的 fetch 桩。
 * 未命中的 URL 直接抛错：实现如果偷偷多打了一次接口，测试要立刻炸出来，
 * 而不是拿到一个静默失败的空响应。
 */
function stubFetch(routes: [needle: string, body: string, status?: number][]) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    for (const [needle, body, status] of routes) {
      if (url.includes(needle)) {
        return new Response(body, {
          status: status ?? 200,
          headers: { "content-type": "text/plain" },
        });
      }
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

/**
 * 极小的索引桩：一条「夜曲」（含别名 + ncm / qq 双平台 id）+ 一条「晴天」
 * + 一条只有 qq id + 一条没有 id + 一条 rawLyricFile 为空 + 一条坏行（JSON 未闭合）。
 */
const INDEX_JSONL = [
  '{"metadata":[["musicName",["夜曲"]],["artists",["周杰伦"]],["ncmMusicId",["185809"]],["qqMusicId",["108340"]]],"rawLyricFile":"1-a.ttml"}',
  '{"metadata":[["musicName",["夜曲 (Live)","夜曲 Live"]],["artists",["周杰伦"]],["ncmMusicId",["999"]],["qqMusicId",["888"]]],"rawLyricFile":"2-b.ttml"}',
  '{"metadata":[["musicName",["晴天"]],["artists",["周杰伦"]],["ncmMusicId",["186016"]],["qqMusicId",["108341"]]],"rawLyricFile":"3-c.ttml"}',
  '{"metadata":[["musicName",["只有 qq id"]],["qqMusicId",["777"]]],"rawLyricFile":"4-d.ttml"}',
  '{"metadata":[["musicName",["没有 id"]],["artists",["无名"]]],"rawLyricFile":"5-e.ttml"}',
  '{"metadata":[["musicName",["无文件"]],["ncmMusicId",["1"]]],"rawLyricFile":""}',
  '{"metadata":[["musicName",["坏行-未闭合"]],["ncmMusicId",["2"]]],"rawLyricFile":"6-f.ttml"',
  "",
].join("\n");

/** 最小可解析的 TTML：逐字行 + 翻译 + 音译 + 背景和声。 */
const TTML_WORD_LEVEL = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="ja">',
  '  <body dur="00:12.000">',
  "    <div>",
  '      <p begin="00:01.500" end="00:02.400">',
  '        <span begin="00:01.500" end="00:02.000">Hel</span>',
  '        <span begin="00:02.000" end="00:02.400">lo </span>',
  "      </p>",
  '      <p begin="00:04.000" end="00:05.500">',
  '        <span begin="00:04.000" end="00:04.500">唱</span>',
  '        <span begin="00:04.500" end="00:05.000">吧</span>',
  '        <span ttm:role="x-bg"><span begin="00:05.000" end="00:05.500">和声</span></span>',
  '        <span ttm:role="x-roman">chang ba</span>',
  '        <span ttm:role="x-translation" xml:lang="zh-CN">唱吧</span>',
  "      </p>",
  "    </div>",
  "  </body>",
  "</tt>",
].join("\n");

beforeEach(() => {
  vi.unstubAllGlobals();
  // 索引 / 歌词都是模块级 TTL 缓存：不清掉，用例之间会互相喂旧数据。
  amllClearCache();
});

/** AMLL 官方仓库（packages/ttml/tests/fixtures）里的两个真实夹具，覆盖本项目要处理的特殊标记。 */
// vitest 的 root 是 apps/desktop（见 vite.config.ts），用 cwd 定位即可；
// 不能用 import.meta.url —— jsdom 环境下它不是 file: 协议。
const FIXTURE_DIR = resolve(process.cwd(), "src/utils/__fixtures__");
const readFixture = (name: string): string => readFileSync(resolve(FIXTURE_DIR, name), "utf8");

describe("parseAmllTtml 特殊标记（对齐 AMLL packages/ttml 的行为）", () => {
  it("tts:ruby 注音：取基文本，注音不进正文；音节时间取注音片段的 min/max", () => {
    // 真实夹具（ruby-test-song.ttml）：<span tts:ruby="container"> 包 base + textContainer
    const lines = parseAmllTtml(readFixture("ruby-test-song.ttml"));

    expect(lines).toHaveLength(1);
    // 「これは」+「所詮」的 base —— 注音（しょ / せ / ん）不混进正文
    expect(lines[0].text).toBe("これは所詮");
    expect(lines[0].text).not.toContain("しょ");
    expect(lines[0].text).not.toContain("せん");
    expect(lines[0].units?.map((u) => u.text)).toEqual(["これは", "所", "詮"]);
    // ruby 容器自身没有 begin/end，但注音片段有：取 min(begin)/max(end)。
    // 「所」的注音是 27.690~27.820；若退回行时间就会变成 27~28（一个字亮一整行）。
    expect(lines[0].units?.[1]).toEqual({ text: "所", start: 27.69, end: 27.82 });
    // 「詮」有两段注音（せ + ん），取整体区间 27.820~27.950
    expect(lines[0].units?.[2]).toEqual({ text: "詮", start: 27.82, end: 27.95 });
  });

  it("amll:obscene / amll:empty-beat 不会污染歌词文本；obscene 记到词级", () => {
    // AMLL 官方夹具：<span amll:obscene="true">これ</span> 与 <span amll:empty-beat="5">テスト</span>
    const lines = parseAmllTtml(readFixture("complex-test-song.ttml"));
    const first = lines.find((l) => l.text.includes("これ"));

    expect(first?.text).toBe("これは テスト");
    // empty-beat 只是打轴辅助，不影响文本与时间；obscene 只记标志、不改文本
    expect(first?.text).not.toContain("obscene");
    expect(first?.text).not.toContain("empty-beat");
    expect(first?.units?.every((u) => Number.isFinite(u.start) && Number.isFinite(u.end))).toBe(
      true,
    );
    // amll:obscene="true" 落在「これ」这个词上，由渲染前统一遮蔽
    expect(first?.units?.[0]).toMatchObject({ text: "これ", obscene: true });
    // 其余词不带标志
    expect(first?.units?.[1]?.obscene).toBeUndefined();
  });

  it("x-bg 落成独立子行，主行不再内嵌括号正文", () => {
    // 夹具写法：<span ttm:role="x-bg"><span>(背景)</span>
    //   <span ttm:role="x-translation">Background</span><span ttm:role="x-roman">haikei</span></span>
    const lines = parseAmllTtml(readFixture("complex-test-song.ttml"));
    const bgLine = lines.find((l) => l.text.includes("コーラス"));

    expect(bgLine).toBeDefined();
    // 主行正文不含和声（AMLL 里和声是 backgroundVocal 子行，不是主行的一部分）
    expect(bgLine?.text).toBe("コーラス です");
    expect(bgLine?.text).not.toContain("背景");
    // 和声落在 line.bg 上：正文剥掉书写用的括号。
    // 该夹具的和声只有一个 span，按与主行相同的规则不给 units（一个词 = 整段点亮）
    expect(bgLine?.bg?.text).toBe("背景");
    expect(bgLine?.bg?.units).toBeUndefined();
    // 和声自己的翻译 / 音译归和声子行，不占主行的副行
    expect(bgLine?.bg?.translation).toBe("Background");
    expect(bgLine?.bg?.romaji).toBe("haikei");
    // 该夹具的主行翻译只写在 <head> 的 sidecar 里（按 L3 关联）：不能被和声那句顶掉
    expect(bgLine?.translation).toContain("合唱");
  });

  it("和声的翻译不会顶掉主行的翻译", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        '<body><div><p begin="1s" end="4s">',
        '<span begin="1s" end="2s">主</span><span begin="2s" end="3s">词</span>',
        '<span ttm:role="x-translation">主行翻译</span>',
        '<span ttm:role="x-bg" begin="3s" end="4s"><span begin="3s" end="4s">(和声)</span>',
        '<span ttm:role="x-translation">backing</span></span>',
        "</p></div></body></tt>",
      ].join(""),
    );

    expect(lines[0].text).toBe("主词");
    expect(lines[0].translation).toBe("主行翻译");
    expect(lines[0].bg?.text).toBe("和声");
    expect(lines[0].bg?.translation).toBe("backing");
  });

  it("和声整段与逐词两种括号写法都能剥掉", () => {
    // 写法 a：括号在整段首尾；写法 b：括号被拆到相邻 span 上
    const whole = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        '<body><div><p begin="1s" end="4s">',
        '<span begin="1s" end="2s">主</span><span begin="2s" end="3s">词</span>',
        '<span ttm:role="x-bg" begin="3s" end="4s"><span begin="3s" end="4s">（和声）</span></span>',
        "</p></div></body></tt>",
      ].join(""),
    );
    expect(whole[0].bg?.text).toBe("和声");

    const split = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        '<body><div><p begin="1s" end="5s">',
        '<span begin="1s" end="2s">主</span><span begin="2s" end="3s">词</span>',
        '<span ttm:role="x-bg" begin="3s" end="5s"><span begin="3s" end="4s">(oh </span>',
        '<span begin="4s" end="5s">yeah)</span></span>',
        "</p></div></body></tt>",
      ].join(""),
    );
    expect(split[0].bg?.text).toBe("oh yeah");
    expect(split[0].text).toBe("主词");
  });

  it("ttm:agent 推导对唱：交替翻转，group 恒非对唱且不打断交替", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        '<head><metadata><ttm:agent type="person" xml:id="v1"/>',
        '<ttm:agent type="person" xml:id="v2"/>',
        '<ttm:agent type="group" xml:id="v1000"/></metadata></head>',
        "<body><div>",
        '<p begin="1s" end="3s" ttm:agent="v1"><span begin="1s" end="2s">君</span><span begin="2s" end="3s">の</span></p>',
        '<p begin="3s" end="5s" ttm:agent="v2"><span begin="3s" end="4s">僕</span><span begin="4s" end="5s">の</span></p>',
        '<p begin="5s" end="7s" ttm:agent="v1"><span begin="5s" end="6s">また</span><span begin="6s" end="7s">ね</span></p>',
        '<p begin="7s" end="9s" ttm:agent="v1000"><span begin="7s" end="8s">みんな</span><span begin="8s" end="9s">で</span></p>',
        '<p begin="9s" end="11s" ttm:agent="v2"><span begin="9s" end="10s">さよ</span><span begin="10s" end="11s">なら</span></p>',
        "</div></body></tt>",
      ].join(""),
    );

    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.text)).toEqual(["君の", "僕の", "またね", "みんなで", "さよなら"]);
    // v1 首发非对唱；v2 换人翻转 → 对唱；v1 再换回 → 翻转回非对唱；
    // group 恒非对唱且不参与交替；v2 与上一个非 group 演唱者（v1）不同 → 翻转 → 对唱
    expect(lines.map((l) => l.duet)).toEqual([false, true, false, false, true]);
    // 逐字时间轴不受影响
    expect(lines[1].units?.[0]).toEqual({ text: "僕", start: 3, end: 4 });
  });

  it("agent 没有 <ttm:agent> 声明时，v2 仍按 AMLL 约定判为对唱", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        "<body><div>",
        '<p begin="1s" end="3s" ttm:agent="v1"><span begin="1s" end="2s">A</span><span begin="2s" end="3s">B</span></p>',
        '<p begin="3s" end="5s" ttm:agent="v2"><span begin="3s" end="4s">C</span><span begin="4s" end="5s">D</span></p>',
        "</div></body></tt>",
      ].join(""),
    );

    expect(lines.map((l) => l.duet)).toEqual([false, true]);
  });

  it("没有 ttm:agent 的行不写 duet（避免给纯独唱歌词加右对齐）", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        "<body><div>",
        '<p begin="1s" end="3s"><span begin="1s" end="2s">A</span><span begin="2s" end="3s">B</span></p>',
        "</div></body></tt>",
      ].join(""),
    );

    expect(lines[0].duet).toBeUndefined();
  });
});
describe("parseAmllTime TTML 时间写法 → 毫秒", () => {
  it("00:01.500 / 1.5s / 01:02.25 / 裸秒数 都换算正确", () => {
    expect(parseAmllTime("00:01.500")).toBe(1500);
    expect(parseAmllTime("1.5s")).toBe(1500);
    expect(parseAmllTime("01:02.25")).toBe(62250);
    expect(parseAmllTime("12")).toBe(12000);
    expect(parseAmllTime("01:02:03.5")).toBe(3723500);
    // 空值 / 非法值一律 0（不能让 NaN 流进渲染层）
    expect(parseAmllTime("")).toBe(0);
    expect(parseAmllTime(undefined)).toBe(0);
    expect(parseAmllTime("01:xx.5")).toBe(0);
  });

  it("三种写法在真实 <p>/<span> 上同样成立（行时间与逐字时间都是秒）", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        "<body><div>",
        '<p begin="1.5s" end="01:02.25"><span begin="1.5s" end="2.5s">a</span><span begin="3s" end="01:02.25">b</span></p>',
        "</div></body></tt>",
      ].join("\n"),
    );

    expect(lines).toHaveLength(1);
    // 1.5s → 1.5 秒；不是 1.5 毫秒，也不是 1500 秒
    expect(lines[0].time).toBe(1.5);
    expect(lines[0].units).toEqual([
      { text: "a", start: 1.5, end: 2.5 },
      { text: "b", start: 3, end: 62.25 },
    ]);
  });
});

describe("parseAmllTtml 逐字行 / 翻译 / 音译 / 背景和声", () => {
  it("行时间取 <p begin>，文本按 span 拼接，units 毫秒→秒且翻译音译不进正文", () => {
    const lines = parseAmllTtml(TTML_WORD_LEVEL);

    expect(lines).toHaveLength(2);

    // 第一行：词自带尾空格，join + 折叠后是 "Hello"，行时间取 <p begin>
    expect(lines[0].time).toBe(1.5);
    expect(lines[0].text).toBe("Hello");
    expect(lines[0].units).toEqual([
      { text: "Hel", start: 1.5, end: 2 },
      { text: "lo ", start: 2, end: 2.4 },
    ]);
    expect(lines[0].translation).toBeUndefined();
    expect(lines[0].romaji).toBeUndefined();

    // 第二行：翻译 / 音译各归各位；背景和声是**独立子行**（line.bg），不再内嵌进正文
    expect(lines[1].time).toBe(4);
    expect(lines[1].text).toBe("唱吧");
    expect(lines[1].translation).toBe("唱吧");
    expect(lines[1].romaji).toBe("chang ba");
    expect(lines[1].units).toEqual([
      { text: "唱", start: 4, end: 4.5 },
      { text: "吧", start: 4.5, end: 5 },
    ]);
    // 和声落在子行：正文已剥掉书写用的括号
    expect(lines[1].bg?.text).toBe("和声");
    // 正文里不该混进翻译 / 音译 / 和声文本
    expect(lines[1].text).not.toContain("chang ba");
    expect(lines[1].text).not.toContain("和声");
  });

  it("作者已带括号的和声不会出现双层括号（正文与子行都只留一层语义）", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
        '<body><div><p begin="1s" end="3s">',
        '<span begin="1s" end="2s">主</span><span begin="2s" end="3s">词</span>',
        '<span ttm:role="x-bg"><span begin="2.2s" end="2.8s">(oh)</span></span>',
        "</p></div></body></tt>",
      ].join(""),
    );

    expect(lines[0].text).toBe("主词");
    // 括号是 TTML 的书写惯例，渲染时由子行的视觉层级承担，不该出现在文本里
    expect(lines[0].bg?.text).toBe("oh");
  });

  it("纯排版空白不产生空格：标签之间的换行 / 缩进不算歌词内容", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        "<body><div>",
        '<p begin="1s" end="2s">',
        '  <span begin="1s" end="1.5s">Hello</span>',
        '  <span begin="1.5s" end="2s">World</span>',
        "</p>",
        "</div></body></tt>",
      ].join("\n"),
    );

    // span 内没有自带空白 → 拼接后就是 "HelloWorld"（规范语义：不替作者加空格）
    expect(lines[0].text).toBe("HelloWorld");
  });

  it("词间空格是标签之间的纯文本节点时，也要挂到前一个词（真实库最常见的英文写法）", () => {
    // 真实样本（That's When）：<span>You</span> <span>said</span> —— 空格既不在词内，
    // 也不是排版空白，丢给行文本会让逐字渲染拼成 "Yousaid"。
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        "<body><div>",
        '<p begin="11.46s" end="13.77s">',
        '<span begin="11.46s" end="11.82s">You</span> <span begin="11.82s" end="12.51s">said</span> <span begin="12.57s" end="13.08s">"I</span> <span begin="13.08s" end="13.77s">know"</span>',
        "</p>",
        "</div></body></tt>",
      ].join(""),
    );

    expect(lines[0].text).toBe('You said "I know"');
    // 逐字单元必须带着分隔空白，否则 .word 是 white-space:pre，渲染出来会粘成一片
    expect(lines[0].units?.map((u) => u.text)).toEqual(["You ", "said ", '"I ', 'know"']);
    expect(lines[0].units?.map((u) => u.text).join("")).toBe(lines[0].text);
    // 时间轴不受影响
    expect(lines[0].units?.[0]).toEqual({ text: "You ", start: 11.46, end: 11.82 });
  });

  it("词内自带空格与标签间空白混用：两种写法都保住分隔，且不叠加成双空格", () => {
    // 词尾自带空白 + 紧随其后的标签间空白：不应再追加一个空格
    const withTrailing = parseAmllTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="4s"><span begin="1s" end="2s">Can</span><span begin="2s" end="3s"> you </span> <span begin="3s" end="4s">feel</span></p></div></body></tt>',
    );
    expect(withTrailing[0].text).toBe("Can you feel");
    expect(withTrailing[0].units?.map((u) => u.text)).toEqual(["Can", " you ", "feel"]);
    expect(withTrailing[0].units?.map((u) => u.text).join("")).toBe(withTrailing[0].text);

    // 词自带**前置**空白（Geronimo 的写法）：分隔在词首，标签间空白另算
    const withLeading = parseAmllTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="4s"><span begin="1s" end="2s">Can</span><span begin="2s" end="3s"> you</span> <span begin="3s" end="4s">feel</span></p></div></body></tt>',
    );
    expect(withLeading[0].text).toBe("Can you feel");
    expect(withLeading[0].units?.map((u) => u.text).join("")).toBe(withLeading[0].text);
    // 逐字单元里不出现连续两个空格（否则 .word 是 pre，屏幕上会看到空档）
    for (const u of withLeading[0].units ?? []) expect(u.text).not.toMatch(/ {2}/);
  });

  it("行首 / 行尾的标签间空白不产生多余空格", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        "<body><div>",
        '<p begin="1s" end="2s">',
        ' <span begin="1s" end="1.5s">Solo</span> ',
        "</p>",
        "</div></body></tt>",
      ].join(""),
    );

    // 行首空格没有前词可挂 → 不能变成一个空词；行尾空格 join 后被 trim
    expect(lines[0].text).toBe("Solo");
  });
  it("无 span 的整行歌词（逐行 TTML）也能出一行，且不生成退化的 units", () => {
    const lines = parseAmllTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body dur="00:10.000"><div><p begin="00:07.000" end="00:09.000">Just a plain line</p></div></body></tt>',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].time).toBe(7);
    expect(lines[0].text).toBe("Just a plain line");
    // 只有一个词时给 units 会让逐字填充退化成整行高亮，所以必须没有
    expect(lines[0].units).toBeUndefined();
  });

  it("单个 span 的行也不写 units（同上：一个词不等于逐字）", () => {
    const lines = parseAmllTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s"><span begin="1s" end="2s">独唱</span></p></div></body></tt>',
    );

    expect(lines[0].text).toBe("独唱");
    expect(lines[0].units).toBeUndefined();
  });

  it("没有 begin/end 的 span（连接词）挂在行首与行尾，不产生 0 秒时间轴", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        '<body><div><p begin="2s" end="4s"><span begin="2s" end="3s">甲</span><span>·</span></p></div></body></tt>',
      ].join(""),
    );

    expect(lines[0].text).toBe("甲·");
    expect(lines[0].units).toEqual([
      { text: "甲", start: 2, end: 3 },
      // 无时间词的 start 退回行首、end 退回行尾
      { text: "·", start: 2, end: 4 },
    ]);
  });

  it("空行 / 全空白 <p> 被跳过；一行都不剩时抛错", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        "<body><div>",
        '<p begin="1s" end="2s">\n   </p>',
        '<p begin="3s" end="4s"></p>',
        '<p begin="5s" end="6s">真正的一行</p>',
        "</div></body></tt>",
      ].join("\n"),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("真正的一行");

    expect(() =>
      parseAmllTtml(
        '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s"></p></div></body></tt>',
      ),
    ).toThrow("AMLL TTML 没有任何歌词行");
  });

  it("<head> 里 Apple Music 风格的翻译 / 音译按 itunes:key 关联到行", () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="ja">',
        "  <head>",
        '    <translation xml:lang="zh-Hans"><text for="L1">第一行翻译</text></translation>',
        '    <transliteration><text for="L1">dai ichi</text></transliteration>',
        "  </head>",
        '  <body dur="00:10.000"><div>',
        '    <p begin="00:01.000" end="00:03.000" itunes:key="L1">',
        '      <span begin="00:01.000" end="00:02.000">a</span>',
        '      <span begin="00:02.000" end="00:03.000">b</span>',
        "    </p>",
        '    <p begin="00:03.000" end="00:05.000" itunes:key="L2">',
        '      <span begin="00:03.000" end="00:05.000">c</span>',
        "    </p>",
        "  </div></body>",
        "</tt>",
      ].join("\n"),
    );

    expect(lines[0].translation).toBe("第一行翻译");
    expect(lines[0].romaji).toBe("dai ichi");
    // 没有对应 <text for> 的行不能被误配
    expect(lines[1].translation).toBeUndefined();
    expect(lines[1].romaji).toBeUndefined();
  });

  it('role 只写了本地名（role="x-translation"，无 ttm: 前缀）也能识别', () => {
    const lines = parseAmllTtml(
      [
        '<tt xmlns="http://www.w3.org/ns/ttml">',
        '<body><div><p begin="1s" end="3s">',
        '<span begin="1s" end="2s">本</span><span begin="2s" end="3s">文</span>',
        '<span role="x-translation">正文翻译</span>',
        '<span role="x-roman">hon bun</span>',
        "</p></div></body></tt>",
      ].join(""),
    );

    expect(lines[0].text).toBe("本文");
    expect(lines[0].translation).toBe("正文翻译");
    expect(lines[0].romaji).toBe("hon bun");
  });

  it("非法 TTML / 缺 <body> / 空字符串都抛出可读错误", () => {
    expect(() => parseAmllTtml("")).toThrow("AMLL 歌词内容为空");
    expect(() => parseAmllTtml("   ")).toThrow("AMLL 歌词内容为空");
    expect(() => parseAmllTtml("<tt><body><p>unclosed")).toThrow("AMLL TTML 解析失败");
    expect(() =>
      parseAmllTtml('<tt xmlns="http://www.w3.org/ns/ttml"><div><p begin="1s">x</p></div></tt>'),
    ).toThrow("AMLL TTML 缺少 <body>");
  });
});

describe("amllSearchSongs 索引筛选", () => {
  it("URL 拼接正确：默认走 AMLL_DEFAULT_BASE，自定义 base 去尾斜杠", async () => {
    const first = stubFetch([["raw-lyrics-index.jsonl", INDEX_JSONL]]);
    await amllSearchSongs("晴天");

    expect(first.calls[0].url).toBe(`${AMLL_DEFAULT_BASE}/metadata/raw-lyrics-index.jsonl`);

    amllClearCache();
    const second = stubFetch([["raw-lyrics-index.jsonl", INDEX_JSONL]]);
    await amllSearchSongs("晴天", TEST_BASE + "///");
    expect(second.calls[0].url).toBe(`${TEST_BASE}/metadata/raw-lyrics-index.jsonl`);
  });

  it("按歌名粗筛（大小写不敏感 / 别名也算命中），并归一化各平台 id", async () => {
    const { calls } = stubFetch([["raw-lyrics-index.jsonl", INDEX_JSONL]]);

    const hits = await amllSearchSongs("夜曲", TEST_BASE);
    expect(hits.map((s) => s.rawFile)).toEqual(["1-a.ttml", "2-b.ttml"]);

    const first = hits[0];
    expect(first.title).toBe("夜曲");
    expect(first.titles).toEqual(["夜曲"]);
    expect(first.artists).toEqual(["周杰伦"]);
    expect(first.ncmIds).toEqual(["185809"]);
    expect(first.qqIds).toEqual(["108340"]);
    // 主 id 优先取 ncm，没有再退 qq，最后退文件名
    expect(first.id).toBe("185809");

    const onlyQq = (await amllSearchSongs("只有 qq id", TEST_BASE))[0];
    expect(onlyQq.ncmIds).toEqual([]);
    expect(onlyQq.qqIds).toEqual(["777"]);
    expect(onlyQq.id).toBe("777");

    const noId = (await amllSearchSongs("没有 id", TEST_BASE))[0];
    expect(noId.id).toBe("5-e.ttml");

    // rawLyricFile 为空 / JSON 坏行都被跳过，不能让整份索引不可用
    expect(await amllSearchSongs("无文件", TEST_BASE)).toEqual([]);
    expect(await amllSearchSongs("坏行-未闭合", TEST_BASE)).toEqual([]);
    // 「夜曲 live」：别名里写了 Live 的那条（2-b）排最前并精确命中；1-a 只是被
    // 「本地标签多带了后缀、索引名是其子串」这一档收录为**低分候选**（相关度 90 vs 240）。
    // 粗筛放宽是有意的：调用方还要过 titleSimilarity + 艺人分做最终判等，
    // 多收一个低分候选不影响正确性，但能救回「本地带后缀」的整类命名。
    expect((await amllSearchSongs("夜曲 live", TEST_BASE)).map((s) => s.rawFile)).toEqual([
      "2-b.ttml",
      "1-a.ttml",
    ]);

    // 空关键词不返回任何候选
    expect(await amllSearchSongs("   ", TEST_BASE)).toEqual([]);

    // 索引只下载一次（模块级缓存）
    expect(calls.filter((c) => c.url.endsWith("raw-lyrics-index.jsonl"))).toHaveLength(1);
  });

  it("索引 HTTP 失败 / 空索引都抛出可读错误", async () => {
    stubFetch([["raw-lyrics-index.jsonl", "not found", 404]]);
    await expect(amllSearchSongs("夜曲", TEST_BASE)).rejects.toThrow(
      "AMLL 歌词索引下载失败：HTTP 404",
    );

    amllClearCache();
    stubFetch([["raw-lyrics-index.jsonl", ""]]);
    await expect(amllSearchSongs("夜曲", TEST_BASE)).rejects.toThrow("AMLL 歌词索引为空或格式异常");
  });
});

describe("amllFetchLyrics 下载并解析", () => {
  const song: AmllTtmlSong = {
    id: "185809",
    ncmIds: ["185809"],
    qqIds: ["108340"],
    title: "夜曲",
    titles: ["夜曲"],
    artists: ["周杰伦"],
    appleMusicIds: [],
    spotifyIds: [],
    isrcs: [],
    rawFile: "1-a.ttml",
    uploadedAt: 0,
  };

  it("按 base + /raw-lyrics/<rawFile> 下载并解析成 LyricLine[]", async () => {
    const { calls } = stubFetch([["/raw-lyrics/1-a.ttml", TTML_WORD_LEVEL]]);

    const lines = await amllFetchLyrics(song, TEST_BASE);

    expect(calls[calls.length - 1].url).toBe(`${TEST_BASE}/raw-lyrics/1-a.ttml`);
    expect(lines.map((l) => [l.time, l.text])).toEqual([
      [1.5, "Hello"],
      [4, "唱吧"],
    ]);
    expect(lines[1].translation).toBe("唱吧");
    expect(lines[1].bg?.text).toBe("和声");
  });

  it("404 抛出可读错误（而不是返回空歌词）", async () => {
    stubFetch([["/raw-lyrics/1-a.ttml", "gone", 404]]);

    await expect(amllFetchLyrics(song, TEST_BASE)).rejects.toThrow("AMLL 歌词下载失败：HTTP 404");
  });

  it("同一首歌第二次取走缓存，不再打网络", async () => {
    const { fn, calls } = stubFetch([["/raw-lyrics/1-a.ttml", TTML_WORD_LEVEL]]);

    const first = await amllFetchLyrics(song, TEST_BASE);
    const second = await amllFetchLyrics(song, TEST_BASE);

    expect(second).toBe(first);
    expect(calls.filter((c) => c.url.includes("/raw-lyrics/"))).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("amllTtmlDurationMs 时长估算", () => {
  it("取 <body dur> 与所有 <p end> 的较大值，缺一个就用另一个", () => {
    expect(
      amllTtmlDurationMs(
        '<tt><body dur="00:10.000"><div><p begin="1s" end="00:20.000">x</p></div></body></tt>',
      ),
    ).toBe(20000);
    expect(
      amllTtmlDurationMs(
        '<tt><body dur="00:30.000"><div><p begin="1s" end="2s">x</p></div></body></tt>',
      ),
    ).toBe(30000);
    expect(
      amllTtmlDurationMs('<tt><body><div><p begin="1s" end="2.5s">x</p></div></body></tt>'),
    ).toBe(2500);
    // 两者都没有 → 0，调用方据此跳过时长校验
    expect(amllTtmlDurationMs('<tt><body><div><p begin="1s">x</p></div></body></tt>')).toBe(0);
  });
});
