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

  it("位移只按行高 + 行距累加，不含「已读行额外上移」（那会导致切行时整摞被顶一跳）", () => {
    // AMLL 的布局层只有 viewportStartY + 行高前缀和这一个纵坐标来源
    expect(SRC).toContain("lineOffset(");
    expect(SRC).not.toContain("PASSED_LINE_RISE_RATIO");
    expect(SRC).not.toMatch(/heights\[i[^\]]*\]\s*\*\s*0\.\d/);
  });

  it("级联延迟用收敛的级数，而不是「超过 N 行直接置 0」（那会让远端行反而先动）", () => {
    expect(SRC).toContain("cascadeDelaySec(");
    expect(SRC).not.toMatch(/if \(n > 10\) n = 0/);
  });

  it("弹簧参数整帧只算一次并推给所有行（逐行各算会让同一摞歌词被拉出形变）", () => {
    // AMLL 的 updateSpringParams 按当前行的间隔取一次 policy，再推给所有 group
    expect(SRC).toContain("posYPolicy");
    expect(SRC).toMatch(/const posYPolicy = seeking/);
    // 循环体里必须复用这一份，而不是按第 i 行自己的 interval 重算
    expect(SRC).toContain("row.spring.updateParams(posYPolicy)");
    expect(SRC).not.toMatch(/row\.spring\.updateParams\(getPosYSpringPolicy/);
  });

  it("视口判定留出与 AMLL 同量级的缓冲（否则离散档位在可见区域内切换）", () => {
    // AMLL 的 motionBuffer = containerHeight * .4
    expect(SRC).toMatch(/containerH \* 0\.4/);
  });

  it("已读行比同距离的未读行更糊（模糊由 lyricLineBlur 统一推导）", () => {
    expect(SRC).toContain("lyricLineBlur(");
    // 旧的实现是 min(5, distance)，已读行与未读行档位相同，丢掉了一档层次
    expect(SRC).not.toMatch(/Math\.min\(MAX_BLUR, distance\)/);
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

describe("双换行动效方案（设置里的「换行动效」）", () => {
  const SETTINGS = readFileSync(resolve(process.cwd(), "src/stores/settings.ts"), "utf8");

  it("默认走新版：类型、默认值与注册表都在", () => {
    expect(SETTINGS).toContain('export type LyricLineMotion = "spring" | "legacy"');
    expect(SETTINGS).toContain('lyricLineMotion: "spring" as LyricLineMotion');
    // load/save 的单一注册表里必须带上它，否则重启后被丢弃 / 不落盘
    const fieldsAt = SETTINGS.indexOf("const fields = {");
    const keyAt = SETTINGS.indexOf("lyricLineMotion,");
    expect(fieldsAt).toBeGreaterThan(-1);
    expect(keyAt).toBeGreaterThan(fieldsAt);
  });

  it("旧版位移由 CSS transition 补间（AMLL 之前那条参考曲线）", () => {
    expect(SRC).toContain("all 0.7s cubic-bezier(0.19, 0.11, 0, 1)");
    expect(ruleBlock(".lyric-item.legacy-motion {")).toContain("transition");
  });

  it("新版坐标不含 transform 过渡（位移与缩放都归弹簧逐帧积分）", () => {
    const item = ruleBlock(".lyric-item {");
    const start = item.indexOf("transition");
    const decl = item.slice(start, item.indexOf(";", start));
    expect(decl).not.toContain("transform");
    expect(decl).not.toContain("all");
  });

  it("换歌时旧版也要压掉位移过渡（否则新歌会从上一首滑过来）", () => {
    expect(SRC).toContain(".lyric-item.legacy-no-transition");
    expect(SRC).toContain('classList.add("legacy-no-transition")');
    expect(SRC).toContain('classList.remove("legacy-no-transition")');
  });

  it("旧版级联 / 模糊走 legacy* 纯函数，新版两条通路都还在", () => {
    // 旧版的 (n*70 - n*10) 与 blur(距离) 抽成了可测纯函数
    expect(SRC).toContain("legacyCascadeDelayMs(");
    expect(SRC).toContain("legacyLineBlur(");
    expect(SRC).toContain("applyLegacyLayout");
    // 新版未被改动
    expect(SRC).toContain("cascadeDelaySec(");
    expect(SRC).toContain("lyricLineBlur(");
    expect(SRC).toContain("getPosYSpringPolicy");
  });

  it("旧版由 CSS transition 承担位移，因此不再走弹簧那段循环", () => {
    // legacy 分支在 syncRows 之前就返回，避免两条补间通路同时写 transform
    const branchAt = SRC.indexOf('settings.lyricLineMotion === "legacy"');
    const returnAt = SRC.indexOf("return;", branchAt);
    const syncRowsAt = SRC.indexOf("  syncRows();", 0);
    expect(branchAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(branchAt);
    expect(returnAt).toBeLessThan(syncRowsAt);
    // 但逐字填充必须还在这一分支里（填充与上浮是两套方案共用的表现）
    expect(SRC.slice(branchAt, returnAt)).toContain("updateWordFill()");
  });

  it("切换方案 / 换行都会触发旧版重新布局（新版靠 rAF 追目标值，不需要）", () => {
    expect(SRC).toContain("settings.lyricLineMotion,");
    expect(SRC).toContain("legacyAnimateNext = true");
    expect(SRC).toContain("() => player.activeLine");
  });

  it("旧版没有「失去焦点缩放」：规则里用 none 压掉，JS 也会清残留内联 scale", () => {
    expect(SRC).toContain(".lyric-item.legacy-motion .lyric-main,");
    expect(SRC).toContain("transform: none;");
    expect(SRC).toContain("textEl.style.transform = ");
  });
});
