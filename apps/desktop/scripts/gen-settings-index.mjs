/**
 * 生成「设置项 → 所属分类」索引。
 *
 * ## 为什么是生成而不是手写
 *
 * 设置搜索要把用户跳到**具体某一项**，就必须知道每个设置项属于哪个分类。
 * 手写一份映射表一定会漂移（加了设置项忘了登记 → 搜不到；删了项没清理 → 搜出来点进去空白）。
 * 所以索引直接从 `SettingsView.vue` 的模板结构推导，并配一条守卫测试：
 * 生成结果与磁盘文件不一致就 CI 失败 —— 索引永远不可能过期。
 *
 * ## 推导规则
 *
 * 模板里每张卡片的可见性由 `v-if="activeSection === 'xxx'"` 决定，
 * 卡片内所有 `t("settings.*")` 文案就是属于该分类的设置项。
 *
 * 用法：
 *   node scripts/gen-settings-index.mjs          # 写入 src/views/settingsIndex.generated.ts
 *   node scripts/gen-settings-index.mjs --check  # 只校验是否一致（CI / 单测用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.join(HERE, "..", "src", "views", "SettingsView.vue");
const OUT = path.join(HERE, "..", "src", "views", "settingsIndex.generated.ts");

/** 从模板推导索引：返回 [{ key, section }]，按出现顺序、按 key 去重。 */
export function buildIndex(source) {
  const src = source ?? readFileSync(VIEW, "utf8");
  const entries = [];
  const seen = new Set();

  // 逐张卡片处理：<m3e-card ...> 之后紧跟（或隔几行）就是 activeSection 判定
  const cardRe = /<m3e-card\b/g;
  const cardStarts = [];
  let m;
  while ((m = cardRe.exec(src)) !== null) cardStarts.push(m.index);

  for (let i = 0; i < cardStarts.length; i++) {
    const start = cardStarts[i];
    const end = i + 1 < cardStarts.length ? cardStarts[i + 1] : src.length;
    const chunk = src.slice(start, end);
    const sec = /activeSection === '([a-z0-9-]+)'/.exec(chunk);
    if (!sec) continue;
    const section = sec[1];
    /*
     * 两个来源都要收，缺一会漏项：
     *  1. `t("settings.x")` / `t('settings.x')` —— 模板里的文案调用。
     *     **引号两种都要匹配**：SettingRow 的属性位置习惯写单引号，
     *     只匹配双引号会让所有走 SettingRow 的行（目前 40 个开关项）从索引里消失。
     *  2. `setting-key="settings.x"` —— SettingRow 的搜索锚点属性。
     */
    const patterns = [
      /t\(["'](settings\.[A-Za-z0-9_]+)["']\)/g,
      /setting-key="(settings\.[A-Za-z0-9_]+)"/g,
    ];
    for (const re of patterns) {
      let k;
      while ((k = re.exec(chunk)) !== null) {
        const key = k[1];
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ key, section });
      }
    }
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}

/** 渲染成 TS 源码。 */
export function render(entries) {
  const rows = entries
    .map((e) => '  { key: "' + e.key + '", section: "' + e.section + '" },')
    .join("\n");
  return `/**
 * 设置项索引：i18n 键 → 所属分类 id。
 *
 * ⚠️ **本文件由 \`scripts/gen-settings-index.mjs\` 生成，请勿手改。**
 * 改了 \`SettingsView.vue\` 的模板后运行 \`npm run gen:settings-index\` 重新生成；
 * 忘记重新生成会被 \`src/views/__tests__/settingsIndex.test.ts\` 挡下。
 *
 * 用途：设置搜索把用户直接跳到**具体某一项**（而不只是某个分类）。
 */
export interface SettingsIndexEntry {
  /** i18n 键，如 \`settings.preciseLyrics\` */
  key: string;
  /** 所属分类 id，如 \`settings-lyrics\` */
  section: string;
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
${rows}
];
`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const entries = buildIndex();
  const next = render(entries);
  const check = process.argv.includes("--check");
  let prev = "";
  try {
    prev = readFileSync(OUT, "utf8");
  } catch {
    /* 首次生成 */
  }
  if (check) {
    if (prev !== next) {
      console.error("设置索引已过期：请运行 npm run gen:settings-index 重新生成。");
      process.exit(1);
    }
    console.log("设置索引是最新的（" + entries.length + " 项）");
  } else {
    writeFileSync(OUT, next, "utf8");
    console.log("已写入 " + entries.length + " 项 → src/views/settingsIndex.generated.ts");
  }
}
