import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 阅读器与媒体浮层的排版契约（2026-11 修复）。
 *
 * 这里断言的是源码里的样式契约而不是渲染结果，原因：
 * - `-webkit-app-region` 是 Electron 专属属性，jsdom 不认识，挂载组件测不出来；
 * - 排版单位（px/em）、字号基准、版心留白同理，必须在源码层面锁死。
 * 项目里已有的 `lyricsTransition.test.ts` / `amllLyricsContract.test.ts` 也走这条路。
 */

const READ_ROOT = process.cwd();
const readerSrc = readFileSync(resolve(READ_ROOT, "src/components/BookReader.vue"), "utf8");
const viewerSrc = readFileSync(resolve(READ_ROOT, "src/components/MediaViewer.vue"), "utf8");

/** 取出 <style scoped> 段落，避免模板/脚本里的同名文本误伤断言 */
function styleOf(src: string): string {
  const start = src.indexOf("<style scoped>");
  const end = src.indexOf("</style>", start);
  return start >= 0 && end > start ? src.slice(start, end) : "";
}

describe("阅读器拖拽区", () => {
  it("顶栏本身可拖窗口，工具区与各层浮层显式 no-drag 才不会吞掉点击", () => {
    const style = styleOf(readerSrc);
    // 顶栏留白处要能拖窗口，所以 .bar 自身是 drag
    expect(style).toMatch(/\.bar\s*\{[^}]*-webkit-app-region:\s*drag/);
    // 但可点区域必须减出去：否则按钮落在拖拽带里，click 不派发（表现为点了没反应）
    for (const selector of [".bar .tools", ".toc-backdrop", ".toc-panel"]) {
      const escaped = selector.replace(/\./g, "\\.");
      expect(style).toMatch(new RegExp(`${escaped}[^{]*\\{[^}]*-webkit-app-region:\\s*no-drag`));
    }
  });
});

describe("媒体浮层拖拽区", () => {
  it("顶栏条保持可拖窗口，按钮显式排除", () => {
    const style = styleOf(viewerSrc);
    expect(style).toMatch(/\.bar\s*\{[^}]*-webkit-app-region:\s*drag/);
    expect(style).toMatch(/\.vbtn\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  });
});

describe("正文与 EPUB 的排版基准一致", () => {
  it("段间距在设置面板、正文模板与 EPUB 主题里统一用 px", () => {
    // 设置面板显示的文案是 px，两处实现必须同单位，否则同一个「段间距 2」差一个数量级
    expect(readerSrc).toContain("settings.readerParaSpacing + 'px'");
    expect(readerSrc).toContain('const paraMB = settings.readerParaSpacing + "px";');
    expect(readerSrc).not.toContain("settings.readerParaSpacing + 'em'");
    expect(readerSrc).not.toContain('settings.readerParaSpacing + "em"');
  });

  it("EPUB 的字号基准对齐应用根字号 14px", () => {
    // epub.js iframe 默认 16px，正文模式继承应用根字号 14px；不锁基准同一个 156% 是两个字号
    expect(readerSrc).toContain("html { font-size: 14px; }");
  });

  it("EPUB 的字距与正文模式继承的 0.25px 对齐", () => {
    // body 全局带 letter-spacing（theme.css:162），正文模式继承、iframe 不继承
    expect(readerSrc).toContain("letter-spacing: 0.25px !important;");
  });

  it("EPUB 与正文模式的版心留白一致", () => {
    expect(readerSrc).toMatch(/\.epub-host\s*\{[^}]*padding:\s*32px 48px/);
    expect(readerSrc).toMatch(/\.text-page\s*\{[^}]*padding:\s*32px 48px/);
  });

  it("首行缩进只有 .text-para 一处来源，与探针保持一致", () => {
    expect(readerSrc).toMatch(/\.text-para\s*\{[^}]*text-indent:\s*2em/);
    // 探针必须复刻同一缩进，否则测量宽度与真实渲染不符
    expect(readerSrc).toContain("text-indent:2em;");
  });
});
