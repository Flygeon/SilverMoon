/**
 * 任务栏锚定几何的回归测试。
 *
 * 这些数字直接决定桌面歌词窗口「贴不贴得住」任务栏：四条边、正负偏移、
 * 无任务栏退化、窗口比屏幕还大 —— 全都是实测过的真实分支，
 * 一旦几何口径被改动，这里必须跟着红。
 */
import { describe, expect, it } from "vitest";
import {
  computeAnchoredPosition,
  resolveTaskbarEdge,
  resolveTaskbarRect,
  type AnchorRequest,
  type DisplayLike,
  type LyricsAnchorH,
} from "@/utils/taskbarAnchor";

/** 1920x1080 主屏，任务栏 40px 停靠指定边 */
function makeDisplay(edge: "bottom" | "top" | "left" | "right" | "none"): DisplayLike {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const workArea = { ...bounds };
  if (edge === "bottom") workArea.height -= 40;
  if (edge === "top") {
    workArea.y += 40;
    workArea.height -= 40;
  }
  if (edge === "left") {
    workArea.x += 40;
    workArea.width -= 40;
  }
  if (edge === "right") workArea.width -= 40;
  return { bounds, workArea, scaleFactor: 1 };
}

function request(
  display: DisplayLike,
  anchor: LyricsAnchorH,
  offsetX = 0,
  offsetY = 0,
  windowSize = { width: 400, height: 100 },
  margin?: number,
): AnchorRequest {
  return {
    display,
    windowSize,
    anchor,
    offsetX,
    offsetY,
    ...(margin === undefined ? {} : { margin }),
  };
}

describe("resolveTaskbarEdge", () => {
  it("四边停靠各自识别正确", () => {
    expect(resolveTaskbarEdge(makeDisplay("bottom"))).toBe("bottom");
    expect(resolveTaskbarEdge(makeDisplay("top"))).toBe("top");
    expect(resolveTaskbarEdge(makeDisplay("left"))).toBe("left");
    expect(resolveTaskbarEdge(makeDisplay("right"))).toBe("right");
  });

  it("取差值最大的那条边（顺带压了别的边时仍认主边）", () => {
    // 底边 40px，左边另有 8px 的边距：底边差值更大
    const display: DisplayLike = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 8, y: 0, width: 1912, height: 1040 },
    };
    expect(resolveTaskbarEdge(display)).toBe("bottom");
  });

  it("无任务栏（workArea 等于 bounds）退化为 bottom", () => {
    expect(resolveTaskbarEdge(makeDisplay("none"))).toBe("bottom");
  });
});

describe("resolveTaskbarRect", () => {
  it("下边：一条贯穿屏幕的 40px 条", () => {
    expect(resolveTaskbarRect(makeDisplay("bottom"))).toEqual({
      x: 0,
      y: 1040,
      width: 1920,
      height: 40,
    });
  });

  it("上边", () => {
    expect(resolveTaskbarRect(makeDisplay("top"))).toEqual({ x: 0, y: 0, width: 1920, height: 40 });
  });

  it("左边", () => {
    expect(resolveTaskbarRect(makeDisplay("left"))).toEqual({
      x: 0,
      y: 0,
      width: 40,
      height: 1080,
    });
  });

  it("右边", () => {
    expect(resolveTaskbarRect(makeDisplay("right"))).toEqual({
      x: 1880,
      y: 0,
      width: 40,
      height: 1080,
    });
  });

  it("无任务栏返回零矩形（自动隐藏时不至于贴到幻影边上）", () => {
    expect(resolveTaskbarRect(makeDisplay("none"))).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("副屏负坐标下依然落在该屏内", () => {
    const display: DisplayLike = {
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
    };
    expect(resolveTaskbarRect(display)).toEqual({ x: -1920, y: 1040, width: 1920, height: 40 });
  });
});

describe("computeAnchoredPosition 四条边", () => {
  it("下边：窗口贴在任务栏上方", () => {
    const display = makeDisplay("bottom");
    expect(computeAnchoredPosition(request(display, "left"))).toEqual({ x: 0, y: 940 });
    expect(computeAnchoredPosition(request(display, "center"))).toEqual({ x: 760, y: 940 });
    expect(computeAnchoredPosition(request(display, "right"))).toEqual({ x: 1520, y: 940 });
  });

  it("上边：窗口贴在任务栏下方", () => {
    const display = makeDisplay("top");
    expect(computeAnchoredPosition(request(display, "left"))).toEqual({ x: 0, y: 40 });
    expect(computeAnchoredPosition(request(display, "center"))).toEqual({ x: 760, y: 40 });
    expect(computeAnchoredPosition(request(display, "right"))).toEqual({ x: 1520, y: 40 });
  });

  it("左边：anchor 改沿 Y 轴作用于任务栏长边，窗口贴其右侧", () => {
    const display = makeDisplay("left");
    expect(computeAnchoredPosition(request(display, "left"))).toEqual({ x: 40, y: 0 });
    expect(computeAnchoredPosition(request(display, "center"))).toEqual({ x: 40, y: 490 });
    expect(computeAnchoredPosition(request(display, "right"))).toEqual({ x: 40, y: 980 });
  });

  it("右边：窗口贴其左侧", () => {
    const display = makeDisplay("right");
    expect(computeAnchoredPosition(request(display, "left"))).toEqual({ x: 1480, y: 0 });
    expect(computeAnchoredPosition(request(display, "center"))).toEqual({ x: 1480, y: 490 });
    expect(computeAnchoredPosition(request(display, "right"))).toEqual({ x: 1480, y: 980 });
  });
});

describe("computeAnchoredPosition 偏移与留白", () => {
  it("正负偏移叠加在锚点结果上", () => {
    const display = makeDisplay("bottom");
    expect(computeAnchoredPosition(request(display, "left", 30, -12))).toEqual({ x: 30, y: 928 });
    // 负偏移用居中对齐：left 锚点本就贴 0，再往左推会被 clamp 吃掉，验不出负偏移本身
    expect(computeAnchoredPosition(request(display, "center", -30, 12))).toEqual({
      x: 730,
      y: 952,
    });
  });

  it("margin 是窗口与任务栏之间的留白，只作用于垂直于任务栏的那条轴", () => {
    const display = makeDisplay("bottom");
    expect(computeAnchoredPosition(request(display, "center", 0, 0, undefined, 8))).toEqual({
      x: 760,
      y: 932,
    });
    const left = makeDisplay("left");
    expect(computeAnchoredPosition(request(left, "center", 0, 0, undefined, 8))).toEqual({
      x: 48,
      y: 490,
    });
  });

  it("偏移把窗口推出屏幕时被夹回 bounds 内", () => {
    const display = makeDisplay("bottom");
    // 夹取边界是 display.bounds（按签名约定）而不是 workArea，所以右下角允许压住任务栏
    expect(computeAnchoredPosition(request(display, "left", 9999, 9999))).toEqual({
      x: 1520,
      y: 980,
    });
    expect(computeAnchoredPosition(request(display, "right", -9999, -9999))).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("computeAnchoredPosition 退化与 clamp", () => {
  it("无任务栏退化为贴 bounds 底部居中", () => {
    const display = makeDisplay("none");
    expect(computeAnchoredPosition(request(display, "left"))).toEqual({ x: 760, y: 980 });
    expect(computeAnchoredPosition(request(display, "center"))).toEqual({ x: 760, y: 980 });
    expect(computeAnchoredPosition(request(display, "right"))).toEqual({ x: 760, y: 980 });
  });

  it("无任务栏时偏移仍然生效且被夹回 bounds", () => {
    const display = makeDisplay("none");
    expect(computeAnchoredPosition(request(display, "center", 100, -20))).toEqual({
      x: 860,
      y: 960,
    });
    expect(computeAnchoredPosition(request(display, "center", 9999, 9999))).toEqual({
      x: 1520,
      y: 980,
    });
  });

  it("窗口比屏幕还大时钉在左上角，不产生负坐标", () => {
    const display = makeDisplay("bottom");
    const huge = { width: 2400, height: 1400 };
    expect(computeAnchoredPosition(request(display, "center", 0, 0, huge))).toEqual({ x: 0, y: 0 });
    expect(computeAnchoredPosition(request(display, "right", 50, 50, huge))).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("窗口比任务栏还高时不会穿到屏幕外（下边）", () => {
    const display = makeDisplay("bottom");
    const tall = { width: 400, height: 1200 };
    // 贴任务栏会算到 y = -160，clamp 后回到 0
    expect(computeAnchoredPosition(request(display, "left", 0, 0, tall))).toEqual({ x: 0, y: 0 });
  });
});
