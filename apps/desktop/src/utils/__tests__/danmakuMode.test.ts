import { describe, expect, it, vi } from "vitest";
import { mapDanmakuMode } from "@/utils/danmaku";

vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

/**
 * 弹幕模式映射的回归测试。
 *
 * 权威定义来自 artplayer-plugin-danmuku 的 types：0=滚动 / 1=顶部 / 2=底部。
 * 源端（B 站与 DanDanPlay 同构）：1/2/3=滚动、4=底部、5=顶部。
 *
 * 曾经的实现写成 4→1、5→2，正好把顶部与底部对调，表现为顶部弹幕从底部飘出来。
 * 插件自己的 XML 解析用的是 `case 4: return 2; case 5: return 1`，可对照。
 */
describe("弹幕模式映射", () => {
  it("4 是底部弹幕 → 2", () => {
    expect(mapDanmakuMode(4)).toBe(2);
  });

  it("5 是顶部弹幕 → 1", () => {
    expect(mapDanmakuMode(5)).toBe(1);
  });

  it("1/2/3 都是滚动 → 0", () => {
    expect(mapDanmakuMode(1)).toBe(0);
    expect(mapDanmakuMode(2)).toBe(0);
    expect(mapDanmakuMode(3)).toBe(0);
  });

  it("未知模式一律回落滚动，不抛错", () => {
    expect(mapDanmakuMode(0)).toBe(0);
    expect(mapDanmakuMode(6)).toBe(0);
    expect(mapDanmakuMode(7)).toBe(0);
    expect(mapDanmakuMode(8)).toBe(0);
    expect(mapDanmakuMode(-1)).toBe(0);
  });

  it("与插件自身的 XML 解析保持一致（防止再次写反）", () => {
    // 复刻插件 dist 里的 function t(t){switch(t){...case 4:return 2;case 5:return 1}}
    const pluginMapping = (m: number): number => {
      switch (m) {
        case 4:
          return 2;
        case 5:
          return 1;
        default:
          return 0;
      }
    };
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(mapDanmakuMode(m)).toBe(pluginMapping(m));
    }
  });
});
