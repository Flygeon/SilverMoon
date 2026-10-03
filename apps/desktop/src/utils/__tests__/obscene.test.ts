/**
 * 不雅用语遮蔽的回归测试（对齐 AMLL 的 full-mask / partial-mask 语义）。
 */
import { describe, expect, it } from "vitest";
import { maskObsceneUnits, maskWordText } from "@/utils/obscene";
import type { LyricLine } from "@shared/types";

describe("maskWordText", () => {
  it("off 原样返回", () => {
    expect(maskWordText("fuck", "off")).toBe("fuck");
  });

  it("full：每个非空白字符都替换，空格保留", () => {
    expect(maskWordText("fu ck", "full")).toBe("** **");
  });

  it("partial：保留首尾字符，只遮蔽中间", () => {
    expect(maskWordText("fucking", "partial")).toBe("f*****g");
  });

  it("partial：trim 后长度 <= 2 退化为全遮蔽", () => {
    expect(maskWordText("ab", "partial")).toBe("**");
    expect(maskWordText("a", "partial")).toBe("*");
  });

  it("partial：保留首尾空白（英文词间空格不能被吃掉）", () => {
    expect(maskWordText("fuck ", "partial")).toBe("f**k ");
    expect(maskWordText(" fuck", "partial")).toBe(" f**k");
  });

  it("支持自定义遮蔽字符", () => {
    expect(maskWordText("fuck", "full", "×")).toBe("××××");
  });
});

describe("maskObsceneUnits", () => {
  const line = (): LyricLine => ({
    time: 0,
    text: "fuck this",
    units: [
      { text: "fuck ", start: 0, end: 1, obscene: true },
      { text: "this", start: 1, end: 2 },
    ],
  });

  it("只遮蔽带标记的词，其它词原样保留", () => {
    const out = maskObsceneUnits([line()], "full");
    expect(out[0].units?.map((u) => u.text)).toEqual(["**** ", "this"]);
  });

  it("行文本与 units 同步更新（两条渲染路径不能出现不同文本）", () => {
    const out = maskObsceneUnits([line()], "full");
    expect(out[0].units?.map((u) => u.text).join("")).toBe(out[0].text);
    expect(out[0].text).toBe("**** this");
  });

  it("不改动入参", () => {
    const input = [line()];
    const snapshot = JSON.parse(JSON.stringify(input)) as LyricLine[];
    maskObsceneUnits(input, "full");
    expect(input).toEqual(snapshot);
  });

  it("没有标记的行原样返回（引用不变）", () => {
    const plain: LyricLine = {
      time: 0,
      text: "hello",
      units: [{ text: "hello", start: 0, end: 1 }],
    };
    const out = maskObsceneUnits([plain], "full");
    expect(out[0]).toBe(plain);
  });

  it("off 模式下整份歌词引用不变", () => {
    const input = [line()];
    const out = maskObsceneUnits(input, "off");
    expect(out).toBe(input);
  });
});
