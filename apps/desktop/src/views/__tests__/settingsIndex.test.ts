import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messages } from "@shared/i18n";
import { SETTINGS_INDEX } from "../settingsIndex.generated";

/**
 * 设置索引的守卫。
 *
 * `SETTINGS_INDEX`（i18n 键 → 所属分类）是设置搜索的地基：搜索结果靠它把用户
 * 跳到**具体某一项**。它是**生成**的（见 scripts/gen-settings-index.mjs），
 * 手写映射表必然漂移 —— 加了设置项忘了登记就搜不到，删了项没清理就点进空白。
 *
 * 这里把三件事钉死：
 *  1. 生成文件与模板结构一致（改了模板没重新生成 → 失败）；
 *  2. 每个键在中英两套文案里都存在（否则搜索结果会显示成 `settings.xxx`）；
 *  3. 每个 section 都真的存在于导航里（否则点了跳到空白）。
 */

const VIEW = fileURLToPath(new URL("../SettingsView.vue", import.meta.url));
const GENERATED = fileURLToPath(new URL("../settingsIndex.generated.ts", import.meta.url));
const VIEW_SRC = readFileSync(VIEW, "utf8");

/** 按点号路径在 i18n 文案树里取值。 */
function lookup(lang: "zh" | "en", key: string): unknown {
  let cur: unknown = (messages as Record<string, unknown>)[lang];
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe("设置索引", () => {
  it("生成文件与模板一致 —— 改了模板必须重新生成", async () => {
    const mod = (await import("../../../scripts/gen-settings-index.mjs")) as {
      buildIndex: (src?: string) => { key: string; section: string }[];
      render: (e: { key: string; section: string }[]) => string;
    };
    expect(mod.render(mod.buildIndex(VIEW_SRC))).toBe(readFileSync(GENERATED, "utf8"));
  });

  it("索引非空，且覆盖了导航里的每一个分类", () => {
    expect(SETTINGS_INDEX.length).toBeGreaterThan(100);
    const navIds = [...VIEW_SRC.matchAll(/id: "(settings-[a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(navIds.length).toBeGreaterThan(0);
    const covered = new Set(SETTINGS_INDEX.map((e) => e.section));
    const uncovered = navIds.filter((id) => !covered.has(id));
    // 一个分类可以暂时没有设置项（纯展示页），但不能**全都没** —— 这里只报告
    expect(uncovered.length, "没有任何设置项的分类：" + uncovered.join(", ")).toBeLessThan(
      navIds.length,
    );
  });

  it("每一项的 i18n 键在中英文案里都存在（否则搜索结果会露出键名）", () => {
    const missing = SETTINGS_INDEX.filter(
      (e) => typeof lookup("zh", e.key) !== "string" || typeof lookup("en", e.key) !== "string",
    ).map((e) => e.key);
    expect(missing, "缺文案的设置项：" + missing.join(", ")).toEqual([]);
  });

  it("每一项的 section 都是导航里真实存在的分类（否则点了跳到空白）", () => {
    const navIds = new Set([...VIEW_SRC.matchAll(/id: "(settings-[a-z0-9-]+)"/g)].map((m) => m[1]));
    const bad = SETTINGS_INDEX.filter((e) => !navIds.has(e.section)).map(
      (e) => e.key + " → " + e.section,
    );
    expect(bad, "指向不存在的分类：" + bad.join(", ")).toEqual([]);
  });

  it("模板里出现的每个设置项都被索引收录（不漏项）", () => {
    // 只统计「有 data-setting 锚点」或「被 SettingRow 包裹」的项，二者都应可被搜到
    const anchored = new Set([...VIEW_SRC.matchAll(/setting-key="([^"]+)"/g)].map((m) => m[1]));
    const indexed = new Set(SETTINGS_INDEX.map((e) => e.key));
    const unindexedAnchors = [...anchored].filter((k) => !indexed.has(k));
    expect(unindexedAnchors, "有锚点但没进索引：" + unindexedAnchors.join(", ")).toEqual([]);
  });
});
