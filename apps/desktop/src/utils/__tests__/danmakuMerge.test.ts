import { describe, expect, it, vi } from "vitest";
import { mapDanmakuMode, mergeDuplicates, type ArtDanmu } from "@/utils/danmaku";

// utils/danmaku 经 danmakuLog 间接引 capabilities，纯 node 环境下会在导入期读 location
vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

const d = (text: string, time: number, mode: 0 | 1 | 2 = 0): ArtDanmu => ({
  text,
  time,
  mode,
  color: "#ffffff",
});

/**
 * mergeDuplicates 的回归测试。
 *
 * 原实现有三个坑，都会在真实弹幕流里出问题：
 * 1. 合并时不校验 mode —— 顶部弹幕与滚动弹幕内容相同就并成一条，
 *    连模式带颜色被前一条覆盖（顶部弹幕「跑进」滚动里）；
 * 2. 用「上一条」的文本反查计数，正文本身以 x2 结尾的正常弹幕会被误算；
 * 3. 计数直接写进 text，参与下一轮归一化比对，越滚越乱。
 */
describe("弹幕去重合并", () => {
  it("同文本同模式且在窗口内 → 合并计数", () => {
    const out = mergeDuplicates([d("哈哈哈", 1), d("哈哈哈", 2), d("哈哈哈", 3)], 5);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("哈哈哈 x3");
  });

  it("同文本但模式不同 → 不合并（否则顶/底弹幕会串模式）", () => {
    const out = mergeDuplicates([d("666", 1, 0), d("666", 2, 1)], 5);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.mode)).toEqual([0, 1]);
    expect(out[1].text).toBe("666");
  });

  it("超出时间窗 → 不合并", () => {
    const out = mergeDuplicates([d("awsl", 1), d("awsl", 30)], 5);
    expect(out).toHaveLength(2);
  });

  it("正文本身以 x2 结尾时不被继承计数污染", () => {
    const out = mergeDuplicates([d("好的 x2", 1), d("好的 x2", 2)], 5);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("好的 x2 x2");
  });

  it("归一化：标点与全角差异视为同一条", () => {
    const out = mergeDuplicates([d("前方高能！！！", 1), d("前方高能", 2)], 5);
    expect(out).toHaveLength(1);
  });

  it("空数组与单条原样返回", () => {
    expect(mergeDuplicates([], 5)).toEqual([]);
    expect(mergeDuplicates([d("x", 1)], 5)).toHaveLength(1);
  });
});

/**
 * 评论点赞态解析：上游顶层 action（0 未赞 / 1 已赞）才是权威，
 * reply_control.action 实测常为 undefined，不能用它判断。
 */
function likedFromJson(raw: { action?: unknown }): boolean {
  return Number(raw.action) === 1;
}

describe("评论点赞态解析", () => {
  it("action=1 → 已点赞", () => {
    expect(likedFromJson({ action: 1 })).toBe(true);
    expect(likedFromJson({ action: "1" })).toBe(true);
  });

  it("action=0 / 缺失 → 未点赞", () => {
    expect(likedFromJson({ action: 0 })).toBe(false);
    expect(likedFromJson({})).toBe(false);
  });
});

/**
 * 模式映射与插件保持一致（防止再次把顶/底写反）。
 */
describe("模式映射（防回归）", () => {
  it("4=底部→2，5=顶部→1", () => {
    expect(mapDanmakuMode(4)).toBe(2);
    expect(mapDanmakuMode(5)).toBe(1);
    expect(mapDanmakuMode(1)).toBe(0);
  });
});
