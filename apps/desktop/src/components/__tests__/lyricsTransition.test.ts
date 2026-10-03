import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 歌词行动效的回归测试（源码断言）。
 *
 * 背景：行位移改成弹簧逐帧积分时，顺手把 `.lyric-item` 上那条
 * `transition: all 0.7s` 整个删了。位移确实不再需要 CSS 过渡，但那条规则同时还
 * 顺带平滑了 opacity 与 filter —— 而这两个是**离散档位**（按与当前行的距离取值），
 * activeLine 每前进一行，所有可见行同时跳一档。过渡一没，整屏一帧硬切，
 * 表现就是「一句唱完切下一句很生硬」。
 *
 * 这里用源码断言把契约钉住：transform 不能有 CSS 过渡（位移与缩放都交给弹簧），
 * opacity / filter 必须有。组件跑起来的行为没法在 jsdom 里量，但「这些规则在不在」
 * 是可以断言的。
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

  it("行的过渡**不含** transform（位移与缩放都由弹簧逐帧积分）", () => {
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
});

describe("LyricsView 的上浮驱动方式", () => {
  it("上浮用 WAAPI 创建动画，而不是逐帧写 CSS 变量", () => {
    // 逐帧插值会走成台阶（播放位置推进粒度 ≠ 帧率）并每帧重算样式 → 顿感
    expect(SRC).toContain("floatAnimationSpec");
    expect(SRC).toContain(".animate(");
    // 旧的 --word-float 通道应已移除，避免两处位移叠加
    expect(SRC).not.toContain("--word-float");
  });

  it("词上不挂 CSS transition（位移由动画/弹簧驱动，叠加会互相拖后腿）", () => {
    const word = ruleBlock(".word,");
    expect(word).not.toContain("transition:");
  });

  it("切换当前行 / 换歌时取消旧动画（元素按 index 复用，残留会串到新行上）", () => {
    expect(SRC).toContain("cancelFloatAnims");
    expect(SRC).toContain("a.cancel()");
  });

  it("暂停时暂停上浮动画，恢复时只续播尚未结束的", () => {
    expect(SRC).toMatch(/a\.pause\(\)/);
    expect(SRC).toMatch(/a\.play\(\)/);
    // 已播完的不该被重新播一遍
    expect(SRC).toContain("finished");
  });
});

describe("LyricsView 的失去焦点过渡", () => {
  it("每行有独立的缩放弹簧（posY 与 scale 各一条，对齐 AMLL 的两个 Spring）", () => {
    // 缩放弹簧以满值为初值，并挂上 AMLL 的 scaleSpringParams
    expect(SRC).toContain("new Spring(LYRIC_SCALE_FOCUS)");
    expect(SRC).toContain("scale.updateParams(SCALE_SPRING_PARAMS)");
    expect(SRC).toContain("row.scale.update(dt)");
  });

  it("缩放目标由 lyricLineScale 推导，而不是一次性写死类名", () => {
    // AMLL 的做法：布局算目标值、弹簧补间；直接切 class 会跳变
    expect(SRC).toContain("lyricLineScale(");
    expect(SRC).toContain("row.scale.setTargetPosition(");
  });

  it("外层容器只管位移，缩放写在各行元素上（否则主行与和声行会互相影响）", () => {
    // 与 AMLL 的分工一致：LyricLineGroup 管 posY，LyricLineEl 各管自己的 scale
    expect(SRC).toMatch(/const transform = "translateY\(/);
    expect(SRC).not.toMatch(/const transform = "translateY\([^;]*scale\(/);
    // 主行元素 / 和声行元素各自写 scale
    expect(SRC).toContain('const textTransform = "scale("');
    expect(SRC).toContain('const bgTransform = "scale("');
  });

  it("已读完的行额外上移，参与位移累加（由 posY 弹簧补间，不跳变）", () => {
    expect(SRC).toContain("PASSED_LINE_RISE_RATIO");
  });

  it("缩放原点落在行元素上：默认左中，对唱行改到右中（否则缩放会横向漂移）", () => {
    // 原点必须跟着对齐方向走：对唱行是右对齐，用左原点缩放会整体横移
    expect(ruleBlock(".lyric-main {")).toContain("transform-origin: left center");
    expect(SRC).toMatch(
      /\.lyric-item\.duet \.lyric-main,\s*\n?\.lyric-item\.duet \.lyric-bg\s*\{[^}]*right center/s,
    );
  });

  it("缩放覆盖原文 + 副行整块（翻译行要跟着一起收）", () => {
    // 与 AMLL 一致：LyricLineEl 同时装着主行与翻译 / 音译，缩放时一起收
    expect(SRC).toContain('querySelector<HTMLElement>(".lyric-main")');
    expect(SRC).toMatch(/\.lyric-main[\s\S]*?class="lyric-translation"/);
  });
});
