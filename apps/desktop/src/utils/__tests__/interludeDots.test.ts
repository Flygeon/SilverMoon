/**
 * 云端歌词（AMLL / QQ / 酷狗）补间奏三点的回归测试。
 *
 * 这些官方时间轴只有真实歌词行：长前奏、长间奏、结尾器乐段都是空白。本地 LRC 链路
 * 一直由 buildLyricSequence 补三点，云端链路若漏了，同一首歌换来源就会出现「卡住不动」。
 */
import { describe, expect, it } from "vitest";
import { insertInterludeDots } from "@/utils/lyricTimeline";
import type { LyricLine } from "@shared/types";

const line = (time: number, text: string): LyricLine => ({ time, text });

describe("insertInterludeDots", () => {
  it("长间奏插三点，普通行距不插", () => {
    const lines = insertInterludeDots([
      line(0, "第一句"),
      // 行距 4s、演唱估算 ~1.5s → 停顿 ~2.5s，不到 3s 阈值，不插
      line(4, "紧接着的一句"),
      line(30, "很久之后的一句"),
    ]);

    expect(lines).toHaveLength(4);
    const dots = lines.filter((l) => l.instrumental);
    expect(dots).toHaveLength(1);
    expect(dots[0].text).toBe("•••");
    // 三点落在这两行之间的停顿区间里
    expect(dots[0].time).toBeGreaterThan(4);
    expect(dots[0].time).toBeLessThan(30);
    // 三个点各自有独立时间，逐字填充才动得起来
    expect(dots[0].units).toHaveLength(3);
  });

  it("已有 instrumental 行不重复插点，且不改动入参", () => {
    const input = [line(0, "A"), { ...line(10, "•••"), instrumental: true }, line(20, "B")];
    const snapshot = JSON.parse(JSON.stringify(input)) as LyricLine[];
    const lines = insertInterludeDots(input);

    expect(lines.filter((l) => l.instrumental)).toHaveLength(1);
    expect(input).toEqual(snapshot);
  });

  it("给 tailEnd 时结尾器乐段也补点", () => {
    const lines = insertInterludeDots([line(0, "最后一句")], { tailEnd: 40 });

    expect(lines).toHaveLength(2);
    expect(lines[1].instrumental).toBe(true);
    expect(lines[1].time).toBeGreaterThan(0);
    expect(lines[1].time).toBeLessThan(40);
  });

  it("行数不足 / 没有尾巴 / 空数组都原样返回", () => {
    expect(insertInterludeDots([line(0, "只有一行")])).toHaveLength(1);
    expect(insertInterludeDots([])).toHaveLength(0);
    expect(insertInterludeDots([line(0, "一行")], { tailEnd: 0 })).toHaveLength(1);
  });

  it("首行之前的长前奏也要补点（官方 TTML 常把第一句排在半分钟后）", () => {
    const lines = insertInterludeDots([line(25, "第一句"), line(28, "第二句")]);

    expect(lines).toHaveLength(3);
    // 三点排在首行**之前**，覆盖 [0, 25)
    expect(lines[0].instrumental).toBe(true);
    expect(lines[0].time).toBe(0);
    expect(lines[0].units?.[2].end).toBe(25);
    expect(lines[1].text).toBe("第一句");
  });

  it("首行之前的短停顿不插点（阈值是 1s，不是间奏的 3s）", () => {
    // 0.5s 前奏：太短，不值得画三点
    expect(insertInterludeDots([line(0.5, "A"), line(20, "B")])[0].instrumental).toBeUndefined();
    // 1.5s 前奏：够长
    expect(insertInterludeDots([line(1.5, "A"), line(20, "B")])[0].instrumental).toBe(true);
  });

  it("对唱/和声造成的重叠行不会让长间奏被漏判", () => {
    // 第二行的 units 结束在 9s（晚于第三行起点 8s）——典型的主行+和声重叠。
    // 按相邻间距算会得到负 gap；按「前缀最大 end」才能算出 8→30 这段长间奏。
    const overlapping: LyricLine[] = [
      line(0, "主行"),
      {
        time: 2,
        text: "带和声的主行",
        units: [
          { text: "带", start: 2, end: 3 },
          { text: "和声", start: 3, end: 9 },
        ],
      },
      line(8, "重叠的下一句"),
      line(30, "很久之后"),
    ];
    const lines = insertInterludeDots(overlapping);

    const dots = lines.filter((l) => l.instrumental);
    expect(dots).toHaveLength(1);
    // 间奏从「此前所有行最晚的结束时间」起算：9s（≥8s 的下一行起点）
    expect(dots[0].time).toBeGreaterThanOrEqual(9);
    expect(dots[0].time).toBeLessThan(30);
  });

  it("用官方逐字时间轴的末字结束时间，而不是字数估算", () => {
    // 行距 10s，但末字在 2s 就唱完 → 纯停顿 8s，远超阈值。
    // 若按 singingEstimate("短句")≈1.2s 算，会得到 8.8s 也超阈值；用长句才能分辨：
    const longLine: LyricLine = {
      time: 0,
      text: "这一句其实只有两个字唱得很短但字数很多很多很多很多很多很多",
      units: [
        { text: "这", start: 0, end: 1 },
        { text: "句", start: 1, end: 2 },
      ],
    };
    const lines = insertInterludeDots([longLine, line(10, "下一句")]);

    const dots = lines.filter((l) => l.instrumental);
    expect(dots).toHaveLength(1);
    // 从末字结束的 2s 起算，而不是从字数估算出来的更晚时间
    expect(dots[0].time).toBe(2);
  });
});
