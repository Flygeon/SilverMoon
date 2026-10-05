import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { krcDecrypt, krcLinesToLyricLines, krcToRawLines } from "@/utils/krc";

/**
 * KRC（酷狗逐字歌词）单测。
 *
 * 两类覆盖：
 * 1. **解密链路**：用 **Node 内置 zlib** 独立构造密文，而不是用被测代码自己的
 *    压缩实现反向生成 —— 这样 pako → fflate 之类的替换一旦行为不同就会暴露。
 *    （这也是本次替换 pako 的前置条件：先把行为钉住，再换实现。）
 * 2. **解析链路**：纯函数，直接喂真实形态的 KRC 明文。
 */

/** KRC 异或密钥，与 krc.ts 保持一致。 */
const KRC_KEY = new Uint8Array([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

/**
 * 按 KRC 真实格式构造密文：zlib 压缩 → 逐字节异或 → 前置 4 字节头 → base64。
 *
 * 顺序很关键：异或作用在**压缩后**的字节上（krcDecrypt 是先异或、再解压）。
 */
function encryptKrc(plaintext: string, headerBytes = 4): string {
  const compressed = deflateSync(Buffer.from(plaintext, "utf8"));
  const xored = new Uint8Array(compressed.length);
  for (let i = 0; i < compressed.length; i++) {
    xored[i] = compressed[i] ^ KRC_KEY[i % KRC_KEY.length];
  }
  const all = new Uint8Array(headerBytes + xored.length);
  all.fill(0xa5, 0, headerBytes);
  all.set(xored, headerBytes);
  return Buffer.from(all).toString("base64");
}

const SAMPLE_KRC = [
  "[ti:测试歌曲]",
  "[ar:测试歌手]",
  "[0,1000]<0,500,0>Hello <500,500,0>world",
  "[2000,1500]<0,700,0>第二行 <700,800,0>文本",
].join("\n");

describe("krcDecrypt", () => {
  it("解开 Node zlib 独立构造的密文（4 字节头 + 异或 + zlib）", async () => {
    expect(await krcDecrypt(encryptKrc(SAMPLE_KRC))).toBe(SAMPLE_KRC);
  });

  it("容忍 base64 前后的空白", async () => {
    const b64 = encryptKrc(SAMPLE_KRC);
    expect(await krcDecrypt(`  ${b64}  \n`)).toBe(SAMPLE_KRC);
  });

  it("多字节 UTF-8 不被拆坏", async () => {
    const text = "[0,1000]<0,1000,0>日本語のテスト・中文·emoji 🎵";
    expect(await krcDecrypt(encryptKrc(text))).toBe(text);
  });

  it("空输入与非 zlib 输入都 reject（不返回半个字符串）", async () => {
    await expect(krcDecrypt("")).rejects.toBeTruthy();
    await expect(
      krcDecrypt(Buffer.from("not-a-zlib-stream-at-all").toString("base64")),
    ).rejects.toBeTruthy();
  });
});

describe("krcToRawLines", () => {
  it("非 KRC 文本返回 null", () => {
    expect(krcToRawLines("这不是歌词")).toBeNull();
    expect(krcToRawLines("[00:01.00]普通 LRC 行")).toBeNull();
  });

  it("解析标签行与逐字行，字时间轴按「行首 + 字偏移」累加", () => {
    const parsed = krcToRawLines(SAMPLE_KRC);
    expect(parsed).not.toBeNull();
    const { lines, tags } = parsed!;

    expect(tags.ti).toBe("测试歌曲");
    expect(tags.ar).toBe("测试歌手");
    expect(lines).toHaveLength(2);

    expect(lines[0]).toMatchObject({ start: 0, end: 1000 });
    expect(lines[0].words).toEqual([
      { text: "Hello ", start: 0, end: 500 },
      { text: "world", start: 500, end: 1000 },
    ]);

    expect(lines[1]).toMatchObject({ start: 2000, end: 3500 });
    expect(lines[1].words).toEqual([
      { text: "第二行 ", start: 2000, end: 2700 },
      { text: "文本", start: 2700, end: 3500 },
    ]);
  });

  it("只有标签、没有歌词行时返回 null", () => {
    expect(krcToRawLines("[ti:空]")).toBeNull();
  });

  it("没有逐字标记的行回退成「整行一个词」", () => {
    const parsed = krcToRawLines("[500,400]没有标记的整行");
    expect(parsed!.lines[0].words).toEqual([{ text: "没有标记的整行", start: 500, end: 900 }]);
  });

  it("language 标签（base64 JSON）解析出逐行翻译与逐行罗马音", () => {
    // 真实语义：type 1 = 逐行翻译，type 0 = 罗马音；每个数组元素对应**一行**，
    // 行内再按词分段。两行歌词 → 两行翻译、两行罗马音。
    const lang = {
      content: [
        { type: 1, lyricContent: [["译文一"], ["译文二"]] },
        {
          type: 0,
          lyricContent: [
            ["He", "llo ", "world"],
            ["ka", "na"],
          ],
        },
      ],
    };
    const langTag = Buffer.from(JSON.stringify(lang), "utf8").toString("base64");
    const text = [
      `[language:${langTag}]`,
      "[0,1000]<0,500,0>Hello <500,500,0>world",
      "[1000,1000]<0,1000,0>kana",
    ].join("\n");

    const parsed = krcToRawLines(text)!;
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.translations).toEqual(["译文一", "译文二"]);
    // 行内分段拼接
    expect(parsed.romaji[0]).toBe("Hello world");
    expect(parsed.romaji[1]).toBe("kana");
  });

  it("空文本行会让罗马音下标错位，解析时需按 offset 跳过", () => {
    const lang = {
      content: [{ type: 0, lyricContent: [["on", "ly"], ["skip"]] }],
    };
    const langTag = Buffer.from(JSON.stringify(lang), "utf8").toString("base64");
    const text = [
      `[language:${langTag}]`,
      "[0,1000]<0,1000,0>only",
      "[1000,1000]   ",
      "[2000,1000]<0,1000,0>tail",
    ].join("\n");

    const parsed = krcToRawLines(text)!;
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.romaji[0]).toBe("only");
    // 中间空行没有对应罗马音行，不做偏移的话这里会串行
    expect(parsed.romaji[2]).toBe("skip");
  });

  it("language 标签是坏 JSON 时不影响原文解析", () => {
    const text = "[language:bm90LWpzb24=]\n[0,1000]<0,1000,0>原文";
    const parsed = krcToRawLines(text)!;
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].words[0].text).toBe("原文");
    expect(parsed.translations[0]).toBeNull();
    expect(parsed.romaji[0]).toBeNull();
  });
});

describe("krcLinesToLyricLines", () => {
  it("毫秒转秒、丢弃空文本行、按索引合并翻译", () => {
    const parsed = krcToRawLines(
      ["[0,1000]<0,500,0>Hello <500,500,0>world", "[1000,500]   ", "[1500,500]<0,500,0>尾巴"].join(
        "\n",
      ),
    )!;
    parsed.translations[0] = "译文";
    const out = krcLinesToLyricLines(parsed);

    expect(out).toHaveLength(2);
    expect(out[0].time).toBe(0);
    expect(out[0].text).toBe("Hello world");
    expect(out[0].translation).toBe("译文");
    expect(out[0].units).toEqual([
      { text: "Hello ", start: 0, end: 0.5 },
      { text: "world", start: 0.5, end: 1 },
    ]);
    expect(out[1].text).toBe("尾巴");
    expect(out[1].time).toBe(1.5);
    // 空行没有翻译 → undefined 而不是空串
    expect(out[1].translation).toBeUndefined();
  });
});
