import { describe, expect, it } from "vitest";

/**
 * 氛围光（ambient light）参数换算的测试。
 *
 * 参考实现：WesselKroos/youtube-ambilight。核心是「把视频帧降采样到小画布 →
 * CSS blur 抹开 → 拉伸到比播放器更大 + 调色」。这里测的是最后一环：
 * 外扩与不透明度的换算，它们直接决定光晕铺多远、多亮。
 */

/** 画布尺寸 = 播放器尺寸 + 两侧各外扩 spread%。 */
function glowSizePercent(spread: number): number {
  return 100 + Math.max(0, spread) * 2;
}

/** 不透明度：设置是 0-100 的整数百分比，CSS 要 0-1。 */
function glowOpacity(value: number): number {
  return Math.max(0, Math.min(100, value)) / 100;
}

/** 降采样画布高度（按视频纵横比，最小 1 行）。 */
function sampleHeight(videoWidth: number, videoHeight: number, sampleWidth = 48): number {
  if (!videoWidth || !videoHeight) return 1;
  return Math.max(1, Math.round(sampleWidth * (videoHeight / videoWidth)));
}

describe("氛围光参数换算", () => {
  it("外扩 0 时画布与播放器等大", () => {
    expect(glowSizePercent(0)).toBe(100);
  });

  it("外扩是「两侧各扩」，所以尺寸是 100 + 2×spread", () => {
    expect(glowSizePercent(22)).toBe(144);
    expect(glowSizePercent(50)).toBe(200);
  });

  it("负外扩按 0 处理，不会把画布缩到比播放器还小", () => {
    expect(glowSizePercent(-10)).toBe(100);
  });

  it("不透明度换算并夹取到合理范围", () => {
    expect(glowOpacity(70)).toBeCloseTo(0.7);
    expect(glowOpacity(100)).toBe(1);
    expect(glowOpacity(0)).toBe(0);
    expect(glowOpacity(-5)).toBe(0);
    expect(glowOpacity(999)).toBe(1);
  });

  it("降采样画布保持视频纵横比（关键是成本与分辨率解耦）", () => {
    expect(sampleHeight(1920, 1080)).toBe(27); // 16:9
    expect(sampleHeight(3840, 2160)).toBe(27); // 4K 同样只用 48×27
    expect(sampleHeight(1080, 1920)).toBe(85); // 竖屏
  });

  it("视频元数据未就绪时给最小画布，避免 0 尺寸异常", () => {
    expect(sampleHeight(0, 0)).toBe(1);
  });

  it("4K 与 480P 的采样画布一样大 —— 这是该方案省 GPU 的根本原因", () => {
    expect(sampleHeight(3840, 2160)).toBe(sampleHeight(854, 480));
  });
});
