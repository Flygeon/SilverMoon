/**
 * 锚定编排层测试。
 *
 * 编排层本身不做几何（那是 taskbarAnchor 的职责），它做的是「取显示器信息 →
 * 调纯函数 → 移动窗口」以及**失败时的降级**。这里重点覆盖降级路径：
 * 拿不到显示器信息、屏幕没有任务栏时，绝不能把窗口挪到一个奇怪的位置。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const displayInfo = vi.fn();
const setPosition = vi.fn();
const setSize = vi.fn();
const outerSize = vi.fn();

vi.mock("@/ipc/window", () => ({
  getCurrentWindow: () => ({ displayInfo, setPosition, setSize, outerSize }),
}));

vi.mock("@/ipc/dpi", () => ({
  LogicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));

vi.mock("@/ipc/events", () => ({
  listen: async () => () => {},
}));

import { applyAnchorSize, applyTaskbarAnchor } from "../desktopLyricsAnchor";

/** 1920x1080 的屏幕，底部任务栏 48px */
const withBottomTaskbar = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
  scaleFactor: 1,
};

/** 无任务栏（自动隐藏 / 全屏独占）：workArea 与 bounds 相同 */
const noTaskbar = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  outerSize.mockResolvedValue({ width: 420, height: 120 });
});

describe("applyTaskbarAnchor", () => {
  it("贴到底部任务栏上方，并沿用对齐方式", async () => {
    displayInfo.mockResolvedValue(withBottomTaskbar);
    const ok = await applyTaskbarAnchor({ align: "center", offsetX: 0, offsetY: 0 });
    expect(ok).toBe(true);
    expect(setPosition).toHaveBeenCalledTimes(1);
    const pos = setPosition.mock.calls[0][0];
    // 居中：x = (1920-420)/2 = 750；y = 1032-120 = 912
    expect(pos.x).toBe(750);
    expect(pos.y).toBe(912);
  });

  it("靠右对齐时贴到任务栏右端", async () => {
    displayInfo.mockResolvedValue(withBottomTaskbar);
    await applyTaskbarAnchor({ align: "right", offsetX: 0, offsetY: 0 });
    const pos = setPosition.mock.calls[0][0];
    expect(pos.x).toBe(1920 - 420);
  });

  it("没有任务栏时**不移动窗口**并返回 false", async () => {
    displayInfo.mockResolvedValue(noTaskbar);
    const ok = await applyTaskbarAnchor({ align: "center", offsetX: 0, offsetY: 0 });
    expect(ok).toBe(false);
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("拿不到显示器信息时不抛错、不移动窗口", async () => {
    displayInfo.mockRejectedValue(new Error("no display"));
    const ok = await applyTaskbarAnchor({ align: "center", offsetX: 0, offsetY: 0 });
    expect(ok).toBe(false);
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("按显示器缩放把物理尺寸换算成逻辑尺寸再定位", async () => {
    // 200% 缩放：窗口物理 840x240 → 逻辑 420x120
    displayInfo.mockResolvedValue({ ...withBottomTaskbar, scaleFactor: 2 });
    outerSize.mockResolvedValue({ width: 840, height: 240 });
    await applyTaskbarAnchor({ align: "center", offsetX: 0, offsetY: 0 });
    const pos = setPosition.mock.calls[0][0];
    expect(pos.x).toBe(750);
    expect(pos.y).toBe(912);
  });
});

describe("applyAnchorSize", () => {
  it("不放大用户设定的尺寸", async () => {
    displayInfo.mockResolvedValue(withBottomTaskbar);
    await applyAnchorSize(420, 120);
    const size = setSize.mock.calls[0][0];
    expect(size.width).toBe(420);
    expect(size.height).toBe(120);
  });

  it("宽度超过任务栏长度时收窄到 90%", async () => {
    displayInfo.mockResolvedValue(withBottomTaskbar);
    await applyAnchorSize(3000, 120);
    const size = setSize.mock.calls[0][0];
    expect(size.width).toBe(Math.round(1920 * 0.9));
  });

  it("有最小尺寸下限，不会被压成 0", async () => {
    displayInfo.mockResolvedValue(withBottomTaskbar);
    await applyAnchorSize(10, 5);
    const size = setSize.mock.calls[0][0];
    expect(size.width).toBeGreaterThanOrEqual(160);
    expect(size.height).toBeGreaterThanOrEqual(48);
  });
});
