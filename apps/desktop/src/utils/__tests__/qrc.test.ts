import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { unzlibSync } from "fflate";
import { hasWordLevel, mergeQqLyrics, qrcToRawLines, rawLinesToLyricLines } from "@/utils/qrc";
import type { LyricLine } from "@shared/types";

/**
 * QRC（QQ 音乐逐字歌词）单测。
 *
 * 关于解密链路：QRC 密文是「zlib 压缩 → 补齐到 8 字节整数倍 → 3DES-EDE-ECB → hex」。
 * 本文件**没有**用 Node crypto 反向构造密文去测 qrcDecrypt —— 该模块的 DES 按
 * 「4 字节字内字节反转」的布局处理输入（见 qrc.ts 的 bitnum），我未能确定一个
 * 与 OpenSSL 对齐的等价改写，与其写一条自己都证不了的用例，不如不写。
 * 好在这段 3DES 是**既有代码**、本次改动不涉及；本次要换的只有解压那一步，
 * 所以下面用「解压实现选型守门人」把真正的风险钉住。
 *
 * 解析链路是纯函数，覆盖在这里。
 */

const QRC_SRC = readFileSync(fileURLToPath(new URL("../qrc.ts", import.meta.url)), "utf8");

const SAMPLE_QRC = [
  "[ti:测试]",
  "[0,1000]Hello (0,500)world (500,500)",
  "[1000,2000]第二行 (1000,1000)文本 (2000,1000)",
].join("\n");

const xml = (content: string): string => `<Lyric_1 LyricType="1" LyricContent="${content}"/>`;

describe("解压实现选型守门人", () => {
  it("qrc.ts 当前用的解压库，与本测试验证的是同一个", () => {
    // 换库时必须同步改本文件的 import 与这一行，否则下面的性质测试就失去意义了。
    // （本仓库已有同类「静态守卫」先例，见 chipClick.test.ts / splashContract.test.ts。）
    expect(QRC_SRC).toMatch(/from "fflate"/);
  });

  it("必须忽略 zlib 流结束之后的填充字节", () => {
    // QRC 明文长度几乎不会是 8 的整数倍，密文按 8 字节块解密后必然拖着填充字节。
    // 这是 qrc.ts 顶部注释里明确写下的选型理由，也是任何解压库替换的第一道门槛。
    const z = deflateSync(Buffer.from(SAMPLE_QRC, "utf8"));
    const withJunk = Buffer.concat([z, Buffer.alloc(7, 0x00)]);
    expect(new TextDecoder().decode(unzlibSync(new Uint8Array(withJunk)))).toBe(SAMPLE_QRC);
  });

  it("原生 DecompressionStream 会拒绝尾部填充 —— 这就是当初不用它的原因", async () => {
    const z = deflateSync(Buffer.from(SAMPLE_QRC, "utf8"));
    const withJunk = Buffer.concat([z, Buffer.alloc(7, 0x00)]);
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();

    // 流在尾部填充处报错后，write / close / closed 三侧的 Promise 都会 reject。
    // 必须逐个接管，否则就是 unhandled rejection —— vitest 会因此把整轮标记为出错。
    const swallow = (p: unknown): Promise<unknown> => Promise.resolve(p).catch(() => undefined);
    const pending = [
      swallow(writer.write(new Uint8Array(withJunk))),
      swallow(writer.close()),
      swallow(writer.closed),
    ];

    // 谁要是把解压「现代化」成 DecompressionStream，这条用例会立刻变红
    await expect(new Response(stream.readable).arrayBuffer()).rejects.toThrow(/trailing junk/i);
    await Promise.allSettled(pending);
  });
});

describe("qrcToRawLines", () => {
  it("非 QRC 文本返回 null", () => {
    expect(qrcToRawLines("not-qrc")).toBeNull();
    expect(qrcToRawLines('<Lyric_1 LyricType="1" LyricContent=""/>')).toBeNull();
  });

  it("解析 LyricContent 里的逐字行（时间戳为绝对毫秒）", () => {
    const lines = qrcToRawLines(xml(SAMPLE_QRC));
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);

    expect(lines![0]).toMatchObject({ start: 0, end: 1000 });
    expect(lines![0].words).toEqual([
      { text: "Hello ", start: 0, end: 500 },
      { text: "world ", start: 500, end: 1000 },
    ]);
    expect(lines![1]).toMatchObject({ start: 1000, end: 3000 });
    expect(lines![1].words).toEqual([
      { text: "第二行 ", start: 1000, end: 2000 },
      { text: "文本 ", start: 2000, end: 3000 },
    ]);
  });

  it("纯时间戳行（只有 (start,dur)、无文本）产出空 words", () => {
    const lines = qrcToRawLines(xml("[0,1000](0,1000)\n[1000,500]正文 (1000,500)"))!;
    expect(lines).toHaveLength(2);
    expect(lines[0].words).toEqual([]);
    expect(lines[1].words).toEqual([{ text: "正文 ", start: 1000, end: 1500 }]);
  });

  it("没有逐字标记的行回退成「整行一个词」", () => {
    const lines = qrcToRawLines(xml("[0,1000]整行无标记"))!;
    expect(lines[0].words).toEqual([{ text: "整行无标记", start: 0, end: 1000 }]);
  });

  it("标签行不产生歌词行", () => {
    const lines = qrcToRawLines(xml("[ti:标题]\n[0,1000]正文 (0,1000)"))!;
    expect(lines).toHaveLength(1);
    expect(lines[0].words[0].text).toBe("正文 ");
  });
});

describe("rawLinesToLyricLines", () => {
  it("毫秒转秒、构造 units", () => {
    const out = rawLinesToLyricLines(qrcToRawLines(xml(SAMPLE_QRC))!);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ time: 0, text: "Hello world " });
    expect(out[0].units).toEqual([
      { text: "Hello ", start: 0, end: 0.5 },
      { text: "world ", start: 0.5, end: 1 },
    ]);
    expect(out[1].time).toBe(1);
  });

  it("纯时间戳行（空文本）被跳过", () => {
    const out = rawLinesToLyricLines(
      qrcToRawLines(xml("[0,1000](0,1000)\n[1000,500]正文 (1000,500)"))!,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "正文 ", time: 1 });
  });
});

describe("hasWordLevel", () => {
  it("任一行字单元数 > 1 才算逐字", () => {
    const one = (units: number): LyricLine => ({
      time: 0,
      text: "x",
      units: Array.from({ length: units }, (_, i) => ({ text: "x", start: i, end: i + 1 })),
    });
    expect(hasWordLevel([])).toBe(false);
    expect(hasWordLevel([one(1)])).toBe(false);
    expect(hasWordLevel([{ time: 0, text: "no units" }])).toBe(false);
    expect(hasWordLevel([one(1), one(2)])).toBe(true);
  });
});

describe("mergeQqLyrics", () => {
  const orig: LyricLine[] = [
    { time: 0, text: "a" },
    { time: 1, text: "b" },
  ];

  it("两条轨都没有时原样返回", () => {
    expect(mergeQqLyrics(orig, null, null)).toBe(orig);
    expect(mergeQqLyrics(orig, [], [])).toBe(orig);
  });

  it("行数一致时按索引配对", () => {
    const trans: LyricLine[] = [
      { time: 0, text: "译A" },
      { time: 1, text: "译B" },
    ];
    expect(mergeQqLyrics(orig, trans, null).map((l) => l.translation)).toEqual(["译A", "译B"]);
  });

  it("行数不一致时按起始时间就近配对", () => {
    const trans: LyricLine[] = [{ time: 1.05, text: "只有一行" }];
    const out = mergeQqLyrics(orig, trans, null);
    expect(out[0].translation).toBeUndefined();
    expect(out[1].translation).toBe("只有一行");
  });

  it("翻译与罗马音同时合并，且不修改原对象", () => {
    const trans: LyricLine[] = [
      { time: 0, text: "译A" },
      { time: 1, text: "译B" },
    ];
    const roma: LyricLine[] = [
      { time: 0, text: "ra" },
      { time: 1, text: "rb" },
    ];
    const out = mergeQqLyrics(orig, trans, roma);
    expect(out[0]).toMatchObject({ translation: "译A", romaji: "ra" });
    expect(out[1]).toMatchObject({ translation: "译B", romaji: "rb" });
    expect(orig[0].translation).toBeUndefined();
  });
});
