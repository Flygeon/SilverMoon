/**
 * 跳转检测的回归测试（对齐 AMLL 的 SeekDetector 语义）。
 */
import { describe, expect, it } from "vitest";
import { SeekDetector } from "@/utils/seekDetector";

describe("SeekDetector", () => {
  it("首帧不算跳转", () => {
    const d = new SeekDetector();
    expect(d.detect(10, true, 1000)).toBe(false);
  });

  it("正常推进不算跳转", () => {
    const d = new SeekDetector();
    d.detect(0, true, 0);
    // 物理时钟走 200ms、媒体时间也走 200ms
    expect(d.detect(0.2, true, 200)).toBe(false);
    expect(d.detect(0.4, true, 400)).toBe(false);
  });

  it("前进跳转：媒体时间远超物理时钟", () => {
    const d = new SeekDetector();
    d.detect(0, true, 0);
    // 物理只走 100ms，媒体却跳到 60s
    expect(d.detect(60, true, 100)).toBe(true);
  });

  it("后退无条件判跳转", () => {
    const d = new SeekDetector();
    d.detect(60, true, 0);
    // 哪怕物理时钟只走了一点点，倒退也算
    expect(d.detect(59.99, true, 10)).toBe(true);
  });

  it("暂停时期望推进为 0：媒体时间自己走算跳转", () => {
    const d = new SeekDetector();
    d.detect(10, false, 0);
    expect(d.detect(10, false, 1000)).toBe(false);
    expect(d.detect(12, false, 1100)).toBe(true);
  });

  it("阈值边界：0.3s 以内不算", () => {
    const d = new SeekDetector();
    d.detect(0, true, 0);
    expect(d.detect(0.29, true, 0)).toBe(false);
    expect(d.detect(0.61, true, 0)).toBe(true);
  });

  it("reset 后基线归零（换歌不会把从 0 开始误判为倒退）", () => {
    const d = new SeekDetector();
    d.detect(100, true, 0);
    d.reset(0, 5);
    expect(d.detect(0.2, true, 205)).toBe(false);
  });
});
