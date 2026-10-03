/**
 * 标题 / 艺人匹配打分的回归测试（`utils/lyricMatch.ts`）。
 *
 * 这里钉住的是「匹配度低」这件事的两个根因：
 * 1. 判等不能是「归一化后完全相等」——真实曲库里的写法差异（标点、译名、feat. 位置、
 *    全角数字）远比本地 tag 的写法多，完全相等会把大量正确的候选判死；
 * 2. 但也不能放太宽——AMLL 索引里 453 组同名条目中 38% 是**不同艺人的不同歌**
 *    （《怪物》= YOASOBI 与 MC HotDog），所以需要艺人分把关。
 *
 * 阈值两侧都要有样例：太严会漏、太松会错拿别人的歌词。
 */
import { describe, expect, it } from "vitest";
import {
  artistSimilarity,
  foldTitle,
  isSameSong,
  normalizeTitle,
  stripBrackets,
  titleSimilarity,
  TITLE_STRONG,
  TITLE_WEAK,
} from "@/utils/lyricMatch";

describe("stripBrackets / normalizeTitle", () => {
  it("剥掉半角与全角的圆括号内容", () => {
    expect(stripBrackets("夜曲 (Live)")).toBe("夜曲");
    expect(stripBrackets("夜曲（现场版）")).toBe("夜曲");
    expect(stripBrackets("Cupid (Twin Ver.)")).toBe("Cupid");
    // 方括号不剥：索引里真有 world.execute (me) ; / All Too Well [Taylor's Version]
    expect(stripBrackets("All Too Well [Taylor's Version]")).toBe(
      "All Too Well [Taylor's Version]",
    );
  });

  it("归一化：全角转半角 + 小写 + 折叠空白", () => {
    expect(normalizeTitle("Ｉｄｏｌ")).toBe("idol");
    expect(normalizeTitle("  Hello   WORLD ")).toBe("hello world");
    // 歌名整体被括号包住时会被剥成空串 —— 调用方因此必须同时用「原文」搜索
    expect(normalizeTitle("（……醉鬼阿Q）（feat. 孙燕姿）")).toBe("");
  });
});

describe("foldTitle 折叠标点与符号", () => {
  it("忽略空白 / 标点 / 符号差异", () => {
    expect(foldTitle("world.execute (me) ;")).toBe("worldexecuteme");
    expect(foldTitle("world.execute(me);")).toBe("worldexecuteme");
    expect(foldTitle("ME!")).toBe("me");
    expect(foldTitle("夜曲 -Instrumental-")).toBe("夜曲instrumental");
  });
});

describe("titleSimilarity 标题相似度", () => {
  it("归一化相等 → 1（(Live) 之类的括注差异不影响）", () => {
    expect(titleSimilarity("夜曲", "夜曲 (Live)")).toBe(1);
    expect(titleSimilarity("晴天", "晴天")).toBe(1);
  });

  it("折叠相等 → 接近 1（标点 / 全角差异）", () => {
    expect(titleSimilarity("world.execute (me) ;", "world.execute(me);")).toBeGreaterThan(0.9);
    expect(titleSimilarity("Ｉｄｏｌ", "Idol")).toBeGreaterThan(0.9);
  });

  it("包含关系 → 长度比例越高分越高，短名不会误命中", () => {
    // 「Only My Railgun」被「only my railgun -Instrumental-」完整包含（长度比 0.5）：
    // 分数落在「可能同一首」区间，需要艺人佐证才接受——不同录音（Instrumental）不能自动当同一首
    const contained = titleSimilarity("Only My Railgun", "only my railgun -Instrumental-");
    expect(contained).toBeGreaterThan(TITLE_WEAK);
    expect(contained).toBeLessThan(TITLE_STRONG);
    // 名字更长、被包含比例更高 → 分数更高
    const tighter = titleSimilarity("Hello World", "Hello World (Radio Edit)");
    expect(tighter).toBeGreaterThan(contained);
    // 单字标题不参与「包含」判断
    expect(titleSimilarity("晴", "晴天")).toBeLessThan(TITLE_WEAK);
  });

  it("完全不相干 → 低于接受阈值", () => {
    expect(titleSimilarity("晴天", "七里香")).toBeLessThan(TITLE_WEAK);
    expect(titleSimilarity("Idol", "Cruel Summer")).toBeLessThan(TITLE_WEAK);
  });

  it("短标题不会因为 bigram 稀疏而误判成高相似", () => {
    // 「怪物」与「怪物先生」共享 bigram「怪物」，但长度差明显，不该给到 strong
    expect(titleSimilarity("怪物", "怪物先生")).toBeLessThan(TITLE_STRONG);
  });
});

describe("artistSimilarity 艺人相似度", () => {
  it("分隔符 / feat. 写法不同也能对上", () => {
    expect(artistSimilarity("周杰伦", ["周杰伦"])).toBe(1);
    expect(artistSimilarity("A/B", ["A", "B"])).toBe(1);
    expect(artistSimilarity("A & B", ["A", "B"])).toBe(1);
    expect(artistSimilarity("米津玄師 feat. Daoko", ["Daoko"])).toBe(1);
  });

  it("繁体 / 别名包含算匹配", () => {
    expect(artistSimilarity("周杰倫", ["周杰伦"])).toBe(1);
    expect(artistSimilarity("G.E.M.邓紫棋", ["邓紫棋"])).toBe(1);
  });

  it("完全不同的艺人 → 0", () => {
    expect(artistSimilarity("YOASOBI", ["MC HotDog"])).toBe(0);
    expect(artistSimilarity("周杰伦", ["Taylor Swift"])).toBe(0);
  });

  it("一侧为空 → 0（「不知道」不等于「匹配」）", () => {
    expect(artistSimilarity(undefined, ["周杰伦"])).toBe(0);
    expect(artistSimilarity("周杰伦", [])).toBe(0);
  });
});

describe("isSameSong 阈值分档", () => {
  it("标题归一化完全相等 → 直接接受（不要求艺人）", () => {
    expect(isSameSong(1, 0, { exactTitle: true })).toEqual({ accept: true, strong: true });
  });

  it("标题弱但艺人能对上 → 接受（非 strong）", () => {
    const r = isSameSong(0.7, 1);
    expect(r.accept).toBe(true);
    expect(r.strong).toBe(false);
  });

  it("标题高度相似但艺人完全对不上 → 拒绝（拦住折叠带来的同名误报）", () => {
    // Heartbeat(Cloudier) vs HEART BEAT(YOASOBI)、ME!(Taylor Swift) vs ≠ME：
    // 折叠后完全相同，但艺人毫无关系 —— 不能当同一首
    expect(isSameSong(1, 0).accept).toBe(false);
    expect(isSameSong(1, 0).strong).toBe(false);
    // 双方都有艺人且能对上才接受
    expect(isSameSong(1, 1).accept).toBe(true);
  });

  it("某一侧缺艺人信息时不能拿艺人否定标题（缺信息 != 不匹配）", () => {
    expect(isSameSong(1, 0, { artistUnknown: true }).accept).toBe(true);
  });

  it("标题弱且艺人对不上 → 拒绝", () => {
    expect(isSameSong(0.7, 0, { artistUnknown: true }).accept).toBe(false);
  });
});
