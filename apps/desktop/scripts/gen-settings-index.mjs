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
 * ## 为什么还要看子组件（2026-10 起）
 *
 * 治理计划要把超大的 SettingsView 按分区拆成子组件。卡片一旦搬进子组件，
 * 只扫父组件就会**静默丢掉该分区的全部设置项** —— 搜索搜不到，而 `--check`
 * 因为磁盘文件被同步重写反而变绿（最坏的一种失败：看着绿、功能没了）。
 *
 * 所以卡片块里出现的 `<XxxPanel />` 会按父组件的 import 解析到真实 .vue 文件，
 * 把其中的 `t("settings.*")` / `setting-key` 归到**这张卡片**的 section。
 *
 * **解析失败必须硬报错**（非零退出），绝不允许「当成这张卡没有设置项」跳过：
 * 静默少项的后果与上面的「索引过期」一样严重，且更难发现。
 *
 * 用法：
 *   node scripts/gen-settings-index.mjs          # 写入 src/views/settingsIndex.generated.ts
 *   node scripts/gen-settings-index.mjs --check  # 只校验是否一致（CI / 单测用）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.join(HERE, "..", "src", "views", "SettingsView.vue");
const OUT = path.join(HERE, "..", "src", "views", "settingsIndex.generated.ts");

/**
 * 拆分前（Steam 分区拆分前）的索引条数，作为「只增不减」的护栏。
 *
 * 2026-10-25 拆 Steam 分区前实测 256 项。拆分同理只能把条目**搬走**、不能丢：
 * 任何一次重构若让这个数字变小，都意味着有设置项从搜索里消失了。
 */
const MIN_ENTRIES = 256;

/**
 * 收集「专属面板」组件标签：在整份父组件模板里**只出现一次**的 PascalCase 组件。
 *
 * 为什么要限定「只出现一次」：卡片块里出现的组件多数是共享原子
 * （`SettingRow` 用了 50 次、`PageHeader` / `SegmentedTabs` 是通用壳）。
 * 它们的文案来自 props，不是设置项；把它们当成面板去解析，只会把无关的
 * `settings.*` 误挂到当前卡片上。真正拆出来的分区面板，天然**一处只挂一次**。
 */
export function collectChildTags(chunk, parentSource) {
  const tags = new Set();
  for (const m of chunk.matchAll(/<([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g)) {
    const tag = m[1];
    if (tag.startsWith("m3e-")) continue;
    // 只认 PascalCase 组件（原生 HTML 标签是小写）
    if (!/^[A-Z]/.test(tag)) continue;
    tags.add(tag);
  }
  // 只保留「整份文件里仅此一处」的组件；共享原子一律跳过
  const once = new Set();
  for (const tag of tags) {
    const uses = [...parentSource.matchAll(new RegExp("<" + tag + "\\b", "g"))].length;
    if (uses === 1) once.add(tag);
  }
  return once;
}

/** 取 `<template>` 段：子组件只按模板收条目，与父组件侧的语义保持一致
 *  （父组件的卡片分块本来就落在模板里，脚本里的 `t(...)` 从不进索引）。 */
export function templateOf(source) {
  const start = source.indexOf("<template>");
  if (start === -1) return source;
  const end = source.lastIndexOf("</template>");
  return end > start ? source.slice(start, end) : source.slice(start);
}

/**
 * 从父组件源码里解析某个组件标签对应的 .vue 相对路径。
 *
 * 支持两种写法（覆盖本项目现有用法）：
 *   import SteamSettingsPanel from "@/components/settings/SteamSettingsPanel.vue";
 *   import SteamSettingsPanel from "./settings/SteamSettingsPanel.vue";
 * 返回绝对路径；**解析不出来就抛错** —— 由调用方决定是否致命。
 */
export function resolveImport(parentFile, parentSource, tag) {
  const re = new RegExp("import\\s+" + tag + "\\s+from\\s+[\"']([^\"']+\\.vue)[\"']", "m");
  const m = re.exec(parentSource);
  if (!m) return null;
  const spec = m[1];
  const parentDir = path.dirname(parentFile);
  if (spec.startsWith("@/")) return path.join(HERE, "..", "src", spec.slice(2));
  if (spec.startsWith(".")) return path.resolve(parentDir, spec);
  return null; // 裸包名（如 vue）不是本地 .vue
}

/** 读文件并抽条目；文件不存在直接抛错。 */
function readChildEntries(childPath, tag) {
  if (!existsSync(childPath)) {
    throw new Error(
      "设置索引生成失败：卡片里的子组件 <" +
        tag +
        "> 解析到 " +
        childPath +
        "，但该文件不存在。" +
        "（检查 import 路径是否写错 —— 静默跳过会让该分区的设置项从搜索里消失）",
    );
  }
  return templateOf(readFileSync(childPath, "utf8"));
}

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

  /** 把一段模板文本里的 key 收进索引（带 section 归属）。 */
  function harvest(chunk, section) {
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

  for (let i = 0; i < cardStarts.length; i++) {
    const start = cardStarts[i];
    const end = i + 1 < cardStarts.length ? cardStarts[i + 1] : src.length;
    const chunk = src.slice(start, end);
    const sec = /activeSection === '([a-z0-9-]+)'/.exec(chunk);
    if (!sec) continue;
    const section = sec[1];

    harvest(chunk, section);

    // 卡片里若拆出了子组件，它的设置项仍归属这张卡片的 section
    for (const tag of collectChildTags(chunk, src)) {
      const childPath = resolveImport(VIEW, src, tag);
      /*
       * 找不到 import：说明是全局注册的组件，不看。
       * 但**找到了 import 而文件不存在**必须硬报错 —— 那通常是路径写错，
       * 静默跳过就等于把该分区的设置项从搜索里删掉，且 --check 还会变绿。
       */
      if (!childPath) continue;
      harvest(readChildEntries(childPath, tag), section);
    }
  }

  /*
   * 只增不减护栏：拆分只能搬条目，不能丢条目。
   * 放在这里（而不是只在测试里）是为了让 `npm run gen:settings-index` 本身也挡一次 ——
   * 生成器是唯一会重写磁盘文件的地方，最坏情况必须在写之前被拦住。
   */
  if (entries.length < MIN_ENTRIES) {
    throw new Error(
      "设置索引条目减少了：当前 " +
        entries.length +
        " 项，基线 " +
        MIN_ENTRIES +
        " 项。拆分 / 重构只应搬动条目，不应让设置项从搜索里消失。" +
        "（若确实删了设置项，请同步下调 MIN_ENTRIES 并在 LOG 记录原因）",
    );
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
  let entries;
  try {
    entries = buildIndex();
  } catch (e) {
    // 解析子组件失败 / 条目减少：必须非零退出，不能静默写出更少的条目
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
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
