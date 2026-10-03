import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 歌词行明暗过渡的回归测试。
 *
 * 背景：行位移改成弹簧逐帧积分时，顺手把 \`.lyric-item\` 上那条
 * \`transition: all 0.7s\` 整个删了。位移确实不再需要 CSS 过渡，但那条规则同时还
 * 顺带平滑了 opacity 与 filter —— 而这两个是**离散档位**（按与当前行的距离取值），
 * activeLine 每前进一行，所有可见行同时跳一档。过渡一没，整屏一帧硬切，
 * 表现就是「一句唱完切下一句很生硬」。
 *
 * 这里用源码断言把契约钉住：transform 不能有 CSS 过渡（交给弹簧），
 * opacity / filter 必须有（AMLL 的 .lyricLineWrapper 就是这么分的）。
 * 组件跑起来的行为没法在 jsdom 里量，但「这两条规则在不在」是可以断言的。
 */

const SRC = readFileSync(resolve(process.cwd(), "src/components/LyricsView.vue"), "utf8");

/** 取出某个选择器的规则块（第一个匹配到的） */
function ruleBlock(selector: string): string {
  const idx = SRC.indexOf(selector);
  expect(idx, `找不到选择器 ${selector}`).toBeGreaterThan(-1);
  const open = SRC.indexOf("{", idx);
  const close = SRC.indexOf("}", open);
  return SRC.slice(open + 1, close);
}

describe("LyricsView 的行明暗过渡契约", () => {
  it("行有 opacity / filter 的过渡（否则切行会整屏硬切）", () => {
    const item = ruleBlock(".lyric-item {");
    expect(item).toContain("transition");
    expect(item).toMatch(/opacity\s+[\d.]+s/);
    expect(item).toMatch(/filter\s+[\d.]+s/);
  });

  it("行的过渡**不含** transform（位移由弹簧逐帧积分，两套缓动叠加会互相拖后腿）", () => {
    const item = ruleBlock(".lyric-item {");
    // 只断言 transition 声明里不出现 transform，避免误伤 will-change: transform
    const transitionDecl = /transition\s*:[^;]+;/s.exec(item)?.[0] ?? "";
    expect(transitionDecl).not.toMatch(/transform/);
    expect(transitionDecl).not.toContain("all");
  });

  it("换歌时用 .no-transition 压掉过渡（重新就位不该有渐变）", () => {
    // 规则存在
    expect(SRC).toMatch(/\.lyric-item\.no-transition\s*\{[^}]*transition:\s*none/s);
    // 且确实被用上：换歌的 watch 里加了类，并在下一帧移除
    expect(SRC).toContain('classList.add("no-transition")');
    expect(SRC).toContain('classList.remove("no-transition")');
  });

  it("词的上浮由 CSS 变量驱动，且词上不挂 transition（位移是连续量）", () => {
    const word = ruleBlock(".word,\n.bg-word {");
    expect(word).toContain("--word-float");
    expect(word).not.toContain("transition:");
  });
});
