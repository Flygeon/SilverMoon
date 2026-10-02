import { describe, expect, it } from "vitest";

/**
 * 空格键归属的回归测试。
 *
 * 现象：在 B 站视频播放详情页按空格，**后台音乐和视频一起暂停**。
 *
 * 原因：全局热键（composables/useDesktopChrome.ts，挂在 App.vue 上、常驻）绑了
 * `Space → 音乐 togglePlay` 并 preventDefault；而 ArtPlayer 自己也绑了
 * `Space → art.toggle()`（视频播放暂停）。两者都会触发。
 *
 * 规则：前台存在可见的视频播放器时，空格归它，全局热键必须让位。
 */

interface MediaState {
  hasMusic: boolean;
  /** 可见的 ArtPlayer / <video> 数量 */
  foregroundPlayers: number;
}

/** 全局热键是否应当消费这次空格。 */
function globalSpaceHandles(s: MediaState): boolean {
  if (!s.hasMusic) return false;
  if (s.foregroundPlayers > 0) return false; // 让位给前台视频
  return true;
}

describe("空格键归属", () => {
  it("B 站视频页（有前台播放器 + 后台音乐）→ 只有视频响应", () => {
    expect(globalSpaceHandles({ hasMusic: true, foregroundPlayers: 1 })).toBe(false);
  });

  it("纯音乐页（无前台播放器）→ 全局热键照常控制音乐", () => {
    expect(globalSpaceHandles({ hasMusic: true, foregroundPlayers: 0 })).toBe(true);
  });

  it("没有音乐在播 → 全局热键本就不该处理", () => {
    expect(globalSpaceHandles({ hasMusic: false, foregroundPlayers: 0 })).toBe(false);
    expect(globalSpaceHandles({ hasMusic: false, foregroundPlayers: 1 })).toBe(false);
  });

  it("番剧播放器 / 媒体查看器同样让位", () => {
    expect(globalSpaceHandles({ hasMusic: true, foregroundPlayers: 2 })).toBe(false);
  });
});
