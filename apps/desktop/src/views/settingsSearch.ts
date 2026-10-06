import type { SettingsIndexEntry } from "@/views/settingsIndex.generated";

/** 一条搜索结果。 */
export interface SettingsHit {
  /** i18n 键，同时是 DOM 锚点（data-setting） */
  key: string;
  /** 所属分类 id */
  section: string;
  /** 该项在当前语言下的文案 */
  label: string;
  /** 所属分类的文案，用于显示「项名 / 分类」 */
  where: string;
}

/**
 * 设置搜索的匹配逻辑。
 *
 * 抽成**纯函数**是为了可测：真正的 UI 是 computed + 模板，跑不了单测；
 * 而"输入什么能搜到什么"恰恰是最该被钉住的行为（搜不到 = 功能不存在）。
 *
 * 匹配范围刻意包含三部分：
 * - 当前语言的文案（用户看到的字）
 * - 英文文案（中文界面下也可能习惯敲英文关键词）
 * - i18n 键本身（方便按 `settings.lyricsFont` 这类路径精确搜）
 */
export function matchSettings(
  index: readonly SettingsIndexEntry[],
  query: string,
  textOf: (key: string) => string,
  sectionLabelOf: (sectionId: string) => string,
  limit = 30,
): SettingsHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SettingsHit[] = [];
  for (const entry of index) {
    const hay = (textOf(entry.key) + " " + entry.key).toLowerCase();
    if (!hay.includes(q)) continue;
    hits.push({
      key: entry.key,
      section: entry.section,
      label: textOf(entry.key),
      where: sectionLabelOf(entry.section),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
