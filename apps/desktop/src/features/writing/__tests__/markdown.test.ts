// @vitest-environment jsdom
/**
 * 渲染管线的安全性与 GFM 覆盖。
 *
 * 必须跑在 jsdom 下：DOMPurify 依赖真实 DOM，node 环境里它会退化成不做任何净化，
 * 那样测试会「通过」得毫无意义。
 */
import { describe, expect, it } from "vitest";
import { countChars, countLines, countWords, renderMarkdown } from "../markdown";

/** 围栏（避免在源码里直接写三反引号） */
const FENCE = "\u0060\u0060\u0060";

describe("renderMarkdown 安全性", () => {
  it("剥掉 script 标签", () => {
    const html = renderMarkdown("正常文本\n\n<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("剥掉事件属性", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  it("剥掉 style 属性（参考项目放行了 style，这里刻意收紧）", () => {
    const html = renderMarkdown('<p style="color:red">红</p>');
    expect(html).not.toContain("style=");
    expect(html).toContain("红");
  });

  it("剥掉 javascript: 协议链接", () => {
    const html = renderMarkdown("[点我](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("外链自动补 rel=noopener", () => {
    expect(renderMarkdown("[x](https://example.com)")).toContain("noopener");
  });
});

describe("renderMarkdown GFM 覆盖", () => {
  it("表格", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<td>1</td>");
  });

  it("任务列表渲染出复选框", () => {
    expect(renderMarkdown("- [x] 已做\n- [ ] 未做")).toContain('type="checkbox"');
  });

  it("删除线", () => {
    expect(renderMarkdown("~~删~~")).toContain("<del>");
  });

  it("围栏代码块保留语言 class", () => {
    const html = renderMarkdown(FENCE + "ts\nconst a = 1;\n" + FENCE);
    expect(html).toContain("language-ts");
    expect(html).toContain("const a = 1;");
  });
});

describe("标题锚点", () => {
  it("中文标题也能生成 id 且同页去重", () => {
    const html = renderMarkdown("# 第一章\n\n## 第一章");
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("GitHub 提示块", () => {
  it("识别 [!NOTE] 并保留正文", () => {
    const html = renderMarkdown("> [!NOTE]\n> 这是备注正文");
    expect(html).toContain("md-alert-note");
    expect(html).toContain("备注");
    expect(html).toContain("这是备注正文");
  });

  it("普通引用块不受影响", () => {
    const html = renderMarkdown("> 普通引用");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("md-alert");
  });

  it("五类标记都识别", () => {
    for (const type of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expect(renderMarkdown("> [!" + type + "]\n> x")).toContain("md-alert-" + type.toLowerCase());
    }
  });
});

describe("统计口径", () => {
  it("中文字按字计、英文按词计", () => {
    expect(countWords("你好世界 hello world")).toBe(6);
  });

  it("空白不计入字符数", () => {
    expect(countChars("a b\nc")).toBe(3);
  });

  it("行数", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb")).toBe(2);
  });
});
