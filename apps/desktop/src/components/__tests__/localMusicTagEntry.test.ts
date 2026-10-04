/**
 * 本地音乐「写音乐标签」入口的回归测试。
 *
 * 背景：写标签功能（commit e4bb1d1）只接了**列表视图**（TrackList）与**在线歌曲**，
 * 网格视图（MediaGrid，默认视图）的右键菜单里只有「在资源管理器中显示」——
 * 用户右键本地歌曲根本找不到「写音乐标签」。这里把「哪些入口必须出现该菜单项」
 * 固定下来，避免以后调整菜单时又把它丢了。
 *
 * 测试方式是纯规则复刻 + 源码断言：
 * - 规则复刻保证菜单决策本身是显式的（音频才给写标签、其它类型不给）；
 * - 源码断言保证两个渲染入口真的接上了同一条链路（regression 的真正防线）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MediaEntry } from "@shared/types";

/** 与 MediaGrid.onContextMenu 一致的菜单决策（在位的音频多一项写标签） */
function gridMenuIds(type: MediaEntry["type"], deleted = 0): string[] {
  const items = ["reveal"];
  if (type === "audio" && !deleted) items.push("write-tags");
  return items;
}

/** 与 TrackList.menuOf 一致的菜单项（该列表只服务音频） */
const TRACK_LIST_MENU_IDS = ["play", "play-next", "add-queue", "favorite", "reveal", "write-tags"];

function source(relative: string): string {
  // __dirname = <app>/src/components/__tests__ → 退三级到 <app>，再拼相对路径
  return readFileSync(path.resolve(__dirname, "..", "..", "..", relative), "utf8");
}

describe("本地音乐右键「写音乐标签」入口", () => {
  it("网格视图：音频卡片给出写标签项", () => {
    expect(gridMenuIds("audio")).toContain("write-tags");
  });

  it("网格视图：非音频卡片不给写标签项（图片/视频/书籍写了也没意义）", () => {
    for (const type of ["image", "video", "book"] as const) {
      expect(gridMenuIds(type)).not.toContain("write-tags");
    }
  });

  it("网格视图：回收站里的音频不给写标签项（文件可能已删，写了必然失败）", () => {
    expect(gridMenuIds("audio", 1)).not.toContain("write-tags");
    // 「在资源管理器中显示」仍在，方便用户定位残留文件
    expect(gridMenuIds("audio", 1)).toContain("reveal");
  });

  it("列表视图：音频行一直有写标签项", () => {
    expect(TRACK_LIST_MENU_IDS).toContain("write-tags");
  });

  it("MediaGrid 源码：确实接上了写标签（菜单项 + 打开对话框）", () => {
    const src = source("src/components/MediaGrid.vue");
    expect(src).toContain('t("musicTag.menu")');
    expect(src).toMatch(/openMusicTagDialog\(localTagTarget\(/);
    // 只对音频开放
    expect(src).toMatch(/item\.type === "audio" && !item\.deleted/);
  });

  it("TrackList 源码：确实接上了写标签，且与网格共用同一目标构造函数", () => {
    const src = source("src/components/TrackList.vue");
    expect(src).toContain('t("musicTag.menu")');
    expect(src).toMatch(/openMusicTagDialog\(localTagTarget\(/);
  });

  it("两个入口都走 localTagTarget，保证带上时长/艺人供逐字歌词匹配", () => {
    const dialog = source("src/composables/useMusicTagDialog.ts");
    expect(dialog).toMatch(/export function localTagTarget/);
    // 关键字段：时长参与 ±1s 匹配，缺了逐字歌词只能纯标题搜索
    expect(dialog).toMatch(/durationMs: item\.durationMs/);
    expect(dialog).toMatch(/artist: item\.artist/);
  });
});
