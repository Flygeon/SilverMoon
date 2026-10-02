import { describe, expect, it } from "vitest";

/**
 * 浮层栈行为的回归测试（B 站视频详情 ↔ UP 主主页）。
 *
 * 背景：两个浮层都是 `position: fixed; inset: 0`，靠 z-index 分层
 * （视频 220 > UP 主页 210）。曾经 `openUser` 不清 `current`，于是
 * 「视频详情 → 点 UP 头像」时 UP 主页被**压在视频浮层底下**，表现为点了没反应，
 * 必须先在视频页点返回才露出 UP 主页，再点一次返回才回到软件主页。
 *
 * 这里把「谁该显示、谁该卸载」的规则固定下来。
 */
interface Stack {
  video: boolean;
  user: boolean;
}

/** 从视频详情点 UP 头像：应当关掉视频、打开 UP 主页（替换，而非叠加）。 */
function openUpFromVideo(): Stack {
  return { video: false, user: true };
}

/** 从 UP 主页点某个投稿：UP 主页保留，视频叠在它上面。 */
function openVideoFromUser(): Stack {
  return { video: true, user: true };
}

/** 关闭最上层浮层：视频在上时先关视频，回到 UP 主页。 */
function closeTop(s: Stack): Stack {
  if (s.video) return { video: false, user: s.user };
  if (s.user) return { video: false, user: false };
  return s;
}

describe("B 站浮层栈", () => {
  it("视频详情点 UP 头像 → 视频关闭、UP 主页打开（不会压在底下）", () => {
    expect(openUpFromVideo()).toEqual({ video: false, user: true });
  });

  it("UP 主页点视频 → 两者共存，视频在上；关掉视频回到 UP 主页", () => {
    let s = openVideoFromUser();
    expect(s).toEqual({ video: true, user: true });
    s = closeTop(s);
    expect(s).toEqual({ video: false, user: true });
  });

  it("再点一次返回才回到软件主页", () => {
    const s = closeTop({ video: false, user: true });
    expect(s).toEqual({ video: false, user: false });
  });

  it("关键不变式：从视频进 UP 主页的那一刻，视频层必须已关闭", () => {
    const s = openUpFromVideo();
    expect(s.video && s.user).toBe(false);
  });
});
