import { describe, expect, it } from "vitest";

/**
 * 氛围光覆盖区域的回归测试。
 *
 * 目标：一片光晕同时覆盖「顶部导航栏 + 播放器 + 右侧相关推荐」。
 * 三者分属不同父级（顶栏在 .content 之外、侧栏是 .main 的兄弟），没法用 DOM 祖先
 * 框起来，所以在视图根下放绝对定位画布，按测量出的并集矩形对齐。
 *
 * 重点防两类回归：
 * 1. 漏掉顶栏右边界 → 光晕到侧栏右沿就断，顶栏右边露白；
 * 2. 漏掉侧栏高度 → 相关推荐比播放器长时，下半截没有光晕。
 */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 三块区域的并集（相对视图根），与 BilibiliVideoView.measureGlow 一致。 */
function glowUnion(
  view: { left: number; top: number },
  head: Rect,
  player: Rect,
  side: Rect | null,
): Rect {
  const left = Math.min(head.left, player.left) - view.left;
  const top = Math.min(head.top, player.top) - view.top;
  const right = Math.max(head.right, player.right, side ? side.right : player.right) - view.left;
  const bottom =
    Math.max(head.bottom, player.bottom, side ? side.bottom : player.bottom) - view.top;
  return { left, top, right, bottom };
}

const view = { left: 0, top: 0 };
const head: Rect = { left: 0, top: 0, right: 1280, bottom: 48 };
const player: Rect = { left: 22, top: 66, right: 622, bottom: 404 };
const side: Rect = { left: 644, top: 66, right: 980, bottom: 586 };

describe("氛围光覆盖区域", () => {
  it("上边贴顶栏上沿（顶栏也在光里）", () => {
    expect(glowUnion(view, head, player, side).top).toBe(0);
  });

  it("右边覆盖顶栏右沿，不会在侧栏处断掉", () => {
    expect(glowUnion(view, head, player, side).right).toBe(1280);
  });

  it("下边取侧栏底（相关推荐比播放器长时也要有光）", () => {
    // 侧栏底 586 > 播放器底 404
    expect(glowUnion(view, head, player, side).bottom).toBe(586);
  });

  it("窄窗口折成一栏（无侧栏）时光晕只覆盖顶栏+播放器", () => {
    const narrow = glowUnion(view, { ...head, right: 800 }, player, null);
    expect(narrow.right).toBe(800);
    expect(narrow.bottom).toBe(404);
  });

  it("播放器比侧栏高时，下边取播放器底", () => {
    const tallPlayer = { ...player, bottom: 700 };
    expect(glowUnion(view, head, tallPlayer, side).bottom).toBe(700);
  });
});

/** 外扩换算：按区域短边取百分比，扩一圈。 */
function spreadPad(width: number, height: number, pct: number): number {
  return Math.round(Math.min(width, height) * (Math.max(0, pct) / 100));
}

describe("氛围光外扩", () => {
  it("0% 不外扩（区域与并集等大）", () => {
    expect(spreadPad(1280, 586, 0)).toBe(0);
  });

  it("按短边换算，避免宽扁区域横向扩过头", () => {
    // 短边 586，22% → 129px
    expect(spreadPad(1280, 586, 22)).toBe(129);
  });

  it("负值按 0 处理", () => {
    expect(spreadPad(1280, 586, -10)).toBe(0);
  });
});
