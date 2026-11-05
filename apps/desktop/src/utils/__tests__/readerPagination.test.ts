import { describe, expect, it } from "vitest";
import { paginateParagraphs, splitReaderParagraphs } from "../readerPagination";

describe("splitReaderParagraphs", () => {
  it("把三个来源各自的换行密度归一化成同一套分段", () => {
    // 文库8：段间空行 + 段首 3 个半角空格
    const wenku8 = "   第一段正文。\n\n   第二段正文。";
    // 笔趣阁：normalize_text 之后是空行分隔，无缩进
    const bqg = "第一段正文。\n\n第二段正文。";
    // 番茄：paragraphs.join("\\n\\n")
    const fqapi = "第一段正文。\n\n第二段正文。";

    const expected = ["第一段正文。", "第二段正文。"];
    expect(splitReaderParagraphs(wenku8)).toEqual(expected);
    expect(splitReaderParagraphs(bqg)).toEqual(expected);
    expect(splitReaderParagraphs(fqapi)).toEqual(expected);
  });

  it("单换行也算分段，连续多个空行不会产生空段落", () => {
    expect(splitReaderParagraphs("甲\n乙\n\n\n丙")).toEqual(["甲", "乙", "丙"]);
  });

  it("兼容 CRLF", () => {
    expect(splitReaderParagraphs("甲\r\n\r\n乙")).toEqual(["甲", "乙"]);
  });

  it("空正文返回空数组", () => {
    expect(splitReaderParagraphs("")).toEqual([]);
    expect(splitReaderParagraphs("   \n\n  ")).toEqual([]);
  });
});

describe("paginateParagraphs", () => {
  /** 按「总字数上限」模拟一页的容量，余量留给标题 */
  const capacity =
    (max: number, titleCost = 0) =>
    (paras: string[], withTitle: boolean) =>
      paras.reduce((n, p) => n + p.length, 0) + (withTitle ? titleCost : 0) <= max;

  it("普通段落按容量顺序装页", () => {
    const pages = paginateParagraphs(["aaaa", "bbbb", "cccc"], capacity(8));
    expect(pages).toEqual([["aaaa", "bbbb"], ["cccc"]]);
  });

  it("首段要把章节标题也算进去", () => {
    const pages = paginateParagraphs(["aaaa", "bbbb"], capacity(8, 4));
    expect(pages).toEqual([["aaaa"], ["bbbb"]]);
  });

  it("单个超长段落按页二分切分，后续内容不会被吞掉", () => {
    const long = "x".repeat(25);
    const pages = paginateParagraphs([long], capacity(10));
    expect(pages.map((p) => p.join("").length)).toEqual([10, 10, 5]);
    // 拼回去必须和原文完全一致，一个字都不能丢
    expect(pages.flat().join("")).toBe(long);
  });

  it("超长段落之后仍可继续装后续段落", () => {
    const pages = paginateParagraphs(["x".repeat(12), "yy"], capacity(10));
    expect(pages.flat().join("")).toBe("x".repeat(12) + "yy");
    expect(pages.length).toBe(2);
  });

  it("容量装不下一个字符时不会死循环", () => {
    const pages = paginateParagraphs(["abc"], () => false);
    expect(pages).toEqual([["abc"]]);
  });

  it("空段落列表返回空页列表", () => {
    expect(paginateParagraphs([], capacity(100))).toEqual([]);
  });
});
