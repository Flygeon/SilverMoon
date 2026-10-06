/**
 * `gen-settings-index.mjs` 的类型声明。
 *
 * 生成器本身是 .mjs（CI 与本地都用 `node` 直接跑，不需要编译），
 * 但单测 `src/views/__tests__/settingsIndex.test.ts` 会 import 它来比对
 * 「生成结果 vs 磁盘文件」。没有这份声明，`vue-tsc` 会报 TS7016。
 */
export interface SettingsIndexEntry {
  /** i18n 键，如 settings.preciseLyrics */
  key: string;
  /** 所属分类 id，如 settings-lyrics */
  section: string;
}

/** 从 SettingsView.vue 源码推导索引（不传 source 时读磁盘上的模板）。 */
export function buildIndex(source?: string): SettingsIndexEntry[];

/** 把索引渲染成 settingsIndex.generated.ts 的源码。 */
export function render(entries: SettingsIndexEntry[]): string;
