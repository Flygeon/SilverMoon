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
});
