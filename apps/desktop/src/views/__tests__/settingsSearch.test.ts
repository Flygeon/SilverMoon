import { describe, expect, it } from "vitest";
import { messages } from "@shared/i18n";
import { SETTINGS_INDEX } from "../settingsIndex.generated";
import { matchSettings } from "../settingsSearch";

/**
 * 设置搜索的匹配行为。
 *
 * 「搜不到」等于「功能不存在」—— 所以这里钉住的是**实际能搜到什么**，
 * 而不只是"函数不报错"。UI 那层是 computed + 模板跑不了单测，
 * 因此匹配逻辑被抽成了 settingsSearch.ts 里的纯函数。
 */

function lookup(lang: "zh" | "en", key: string): unknown {
  let cur: unknown = (messages as Record<string, unknown>)[lang];
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 与 SettingsView 里的用法一致：中英文案 + 键名都参与匹配 */
const textOf = (key: string) =>
  String(lookup("zh", key) ?? "") + " " + String(lookup("en", key) ?? "");
const sectionLabel = (id: string) => id;

describe("设置搜索匹配", () => {
  it("空查询不返回结果（导航保持原样）", () => {
    expect(matchSettings(SETTINGS_INDEX, "", textOf, sectionLabel)).toEqual([]);
    expect(matchSettings(SETTINGS_INDEX, "   ", textOf, sectionLabel)).toEqual([]);
  });

  it("中文关键词能定位到设置项", () => {
    const keys = matchSettings(SETTINGS_INDEX, "逐字歌词", textOf, sectionLabel).map((h) => h.key);
    expect(keys).toContain("settings.preciseLyrics");
  });

  it("英文关键词也能搜到（中文界面下的习惯用法）", () => {
    const keys = matchSettings(SETTINGS_INDEX, "loudness", textOf, sectionLabel).map((h) => h.key);
    expect(keys).toContain("settings.loudnessNormalize");
  });

  it("可以按 i18n 键路径搜", () => {
    const hits = matchSettings(SETTINGS_INDEX, "settings.danmakuOpacity", textOf, sectionLabel);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].key).toBe("settings.danmakuOpacity");
  });

  it("每条结果都带可用的跳转目标（键 + 分类）", () => {
    const hits = matchSettings(SETTINGS_INDEX, "歌词", textOf, sectionLabel);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.key).toMatch(/^settings\./);
      expect(h.section).toMatch(/^settings-[a-z0-9-]+$/);
      expect(h.label.length).toBeGreaterThan(0);
    }
  });

  it("无匹配时返回空数组（UI 显示「没有匹配的设置项」）", () => {
    expect(matchSettings(SETTINGS_INDEX, "zzz-绝不存在的设置项-zzz", textOf, sectionLabel)).toEqual(
      [],
    );
  });

  it("结果有上限（搜索框下面放不下几十条）", () => {
    const hits = matchSettings(SETTINGS_INDEX, "e", textOf, sectionLabel, 5);
    expect(hits.length).toBeLessThanOrEqual(5);
  });
});
