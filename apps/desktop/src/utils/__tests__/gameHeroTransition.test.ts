// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  activeCoverAppId,
  activeCoverUrl,
  clearCover,
  clearCoverUrl,
  heroTransitionActive,
  rememberCover,
} from "../gameHeroTransition";

afterEach(() => {
  clearCover();
  clearCoverUrl();
});

describe("封面 URL 交接（无动画）", () => {
  it("记住封面 URL，供详情页首帧直接使用", () => {
    rememberCover(2704110, "https://cdn.example.com/header.jpg");
    expect(activeCoverAppId.value).toBe(2704110);
    expect(activeCoverUrl.value).toBe("https://cdn.example.com/header.jpg");
  });

  it("清空 appId 后 URL 仍保留（详情页数据未到时继续用它占位）", () => {
    rememberCover(1, "u");
    clearCover();
    expect(activeCoverAppId.value).toBeNull();
    expect(activeCoverUrl.value).toBe("u");
  });

  it("显式清空 URL", () => {
    rememberCover(1, "u");
    clearCoverUrl();
    expect(activeCoverUrl.value).toBeNull();
  });

  it("heroTransitionActive 恒为 false（动画已移除）", () => {
    expect(heroTransitionActive.value).toBe(false);
  });
});
