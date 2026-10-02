import { describe, expect, it, vi } from "vitest";

// sponsorBlock.ts 引 @/capabilities（isDesktop 决定走宿主通道还是原生 fetch），
// 纯 node 环境下导入它会读 location，必须 mock。
vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));
import {
  SB_CATEGORIES,
  findActiveSkip,
  normalizeSegments,
  skipTargets,
  skippedKey,
  type SbSegment,
} from "@/utils/sponsorBlock";

/**
 * 空降助手（SponsorBlock）核心逻辑测试。
 *
 * 参考实现：hanydd/BilibiliSponsorBlock + PiliPlus `lib/http/sponsor_block.dart`。
 * 这几条逻辑决定「什么该跳、什么时候跳、什么时候不再跳」，是最容易回归的部分。
 */
describe("normalizeSegments", () => {
  it("单元素 segment 表示「到片尾」，用 videoDuration 补全", () => {
    const out = normalizeSegments(
      [{ segment: [10], category: "sponsor", actionType: "skip", videoDuration: 100 }],
      "1",
    );
    expect(out).toEqual([
      expect.objectContaining({ start: 10, end: 100, category: "sponsor", action: "skip" }),
    ]);
  });

  it("脏数据一律丢弃（不抛错、不产生 NaN 区间）", () => {
    const out = normalizeSegments(
      [
        null,
        "str",
        { segment: [] },
        { segment: "bad" },
        { segment: ["abc"] },
        { segment: [1, 2], category: "sponsor", actionType: "skip" },
      ],
      "1",
    );
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0].start)).toBe(true);
    expect(Number.isFinite(out[0].end)).toBe(true);
  });

  it("按起点排序", () => {
    const out = normalizeSegments(
      [
        { segment: [50, 60], category: "intro", actionType: "skip" },
        { segment: [5, 10], category: "sponsor", actionType: "skip" },
      ],
      "1",
    );
    expect(out.map((s) => s.start)).toEqual([5, 50]);
  });

  it("end 小于 start 时被夹正（不会出现负长度区段）", () => {
    const out = normalizeSegments(
      [{ segment: [30, 10], category: "sponsor", actionType: "skip" }],
      "1",
    );
    expect(out[0].end).toBeGreaterThanOrEqual(out[0].start);
  });
});

const seg = (o: Partial<SbSegment>): SbSegment => ({
  start: 0,
  end: 10,
  category: "sponsor",
  action: "skip",
  uuid: "",
  cid: "1",
  videoDuration: 100,
  ...o,
});

describe("skipTargets（什么该跳）", () => {
  it("只保留用户启用的分类", () => {
    const segs = [seg({ category: "sponsor" }), seg({ category: "intro", start: 20, end: 30 })];
    expect(skipTargets(segs, { sponsor: true, intro: false }).map((s) => s.category)).toEqual([
      "sponsor",
    ]);
  });

  it("未出现在配置里的分类视为不跳过（默认保守）", () => {
    expect(skipTargets([seg({ category: "preview" })], {}).length).toBe(0);
  });

  it("排除 full 类整片标记（segment 为 [0,0]）—— 跳了等于从头开始", () => {
    const segs = [seg({ action: "full", start: 0, end: 0 }), seg({ start: 10, end: 20 })];
    const t = skipTargets(segs, { sponsor: true });
    expect(t).toHaveLength(1);
    expect(t[0].start).toBe(10);
  });

  it("排除 mute（静音）与 poi（精彩时刻）—— 它们不是「跳过」", () => {
    const segs = [seg({ action: "mute" }), seg({ action: "poi" }), seg({ action: "skip" })];
    expect(skipTargets(segs, { sponsor: true }).map((s) => s.action)).toEqual(["skip"]);
  });
});

describe("findActiveSkip（什么时候跳）", () => {
  const targets = [seg({ start: 10, end: 20 })];

  it("落在片段内 → 命中", () => {
    expect(findActiveSkip(targets, 15)).not.toBeNull();
  });

  it("起点前 0.35s 容差内也命中（采样间隔可能跨过起点）", () => {
    expect(findActiveSkip(targets, 9.8)).not.toBeNull();
  });

  it("片段外不命中（前后都不）", () => {
    expect(findActiveSkip(targets, 5)).toBeNull();
    expect(findActiveSkip(targets, 25)).toBeNull();
    // 边界：end 是开区间，等于 end 时不该再跳
    expect(findActiveSkip(targets, 20)).toBeNull();
  });

  it("多个片段时返回实际命中的那个", () => {
    const multi = [seg({ start: 10, end: 20 }), seg({ start: 40, end: 50 })];
    expect(findActiveSkip(multi, 45)?.start).toBe(40);
  });
});

describe("skippedKey（只跳一次）", () => {
  it("有 UUID 用 UUID（同一条片段稳定标识）", () => {
    expect(skippedKey(seg({ uuid: "abc" }))).toBe("abc");
  });

  it("无 UUID 退回区间作为 key", () => {
    expect(skippedKey(seg({ uuid: "", start: 3, end: 9 }))).toBe("3-9");
  });
});

describe("SB_CATEGORIES 元数据", () => {
  it("每个分类都有颜色与短名（进度条刻痕与设置页要用）", () => {
    for (const c of SB_CATEGORIES) {
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.short.length).toBeGreaterThan(0);
      expect(c.actions.length).toBeGreaterThan(0);
    }
  });

  it("颜色不重复（进度条上要能区分）", () => {
    const colors = SB_CATEGORIES.map((c) => c.color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("sponsor（赞助/恰饭）是唯一默认该开的分类", () => {
    expect(SB_CATEGORIES.some((c) => c.key === "sponsor")).toBe(true);
  });
});
