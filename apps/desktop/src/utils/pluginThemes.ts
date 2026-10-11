/**
 * 插件皮肤适配层：把扩展声明的皮肤接进既有的皮肤引擎。
 *
 * ## 定位
 *
 * 皮肤功能已改由扩展承载 —— 设置页不再有皮肤库，用户「装皮肤」就是装一个
 * 声明了 `contributes.themes` 的扩展。扩展只负责**声明与携带素材**，校验与应用
 * 一律复用既有链路（`skinSchema.ts` 校验器 + `skins.ts` 引擎），不另起一套。
 *
 * ## 路径口径（这里最容易错，写清楚）
 *
 * `ext_theme_load` 返回的路径**都以主题目录（skin.json 所在目录）为基准**，
 * 与内置皮肤的 `skin_load` 完全同口径，因此可以原样喂给既有校验器与引擎：
 *   - `absDir` —— 主题目录的绝对路径，作为 `prepareSkin` 的基准目录拼 asset://；
 *   - `files`  —— 主题目录内相对路径（`skin.json` / `assets/bg.png`），
 *     直接交给 `validateSkin(raw, { files })` 做资产存在性校验。
 *
 * ⚠️ 宿主侧起初曾以**扩展根目录**为 files 基准，得到 `themes/sakura/assets/bg.png`，
 * 与 skin.json 里的 `assets/bg.png` 字符串对不上，导致 v2 皮肤全部校验失败。
 * 前端**不要**在这里再做剥离/补前缀来「兜底」—— 基准只能有一处定义，
 * 两侧各修一次必然漂移（宿主侧已修正并留了注释）。
 */
import { capabilities } from "@/capabilities";
import { validateSkin, type SkinDocument } from "./skinSchema";
import type { PrepareContext } from "./skinLoader";

/** 扩展皮肤的持久化 id 前缀（`ext:<extId>:<themeId>`） */
export const EXT_SKIN_PREFIX = "ext:";

/**
 * 生成扩展皮肤在 `settings.activeSkin` 里的持久化 id。
 *
 * 内置皮肤的 id 受 `skinSchema.ts` 的 ID_RE 限制（小写字母/数字/连字符/点），
 * **不可能含冒号**，所以这个前缀与内置皮肤命名空间天然不冲突 —— 引擎靠它
 * 区分「走内置皮肤库」还是「走扩展解析」，不需要额外的状态位。
 */
export function extThemeKey(extId: string, themeId: string): string {
  return `${EXT_SKIN_PREFIX}${extId}:${themeId}`;
}

/** 拆解扩展皮肤 id；非扩展 id（无前缀 / 结构不完整）返回 null */
export function parseExtThemeKey(key: string): { extId: string; themeId: string } | null {
  if (!key.startsWith(EXT_SKIN_PREFIX)) return null;
  const rest = key.slice(EXT_SKIN_PREFIX.length);
  // extId 与 themeId 都不允许为空，且各自不含冒号（扩展 id 是点分命名空间）
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { extId: rest.slice(0, sep), themeId: rest.slice(sep + 1) };
}

/** 加载并校验一款扩展皮肤的产物 */
export interface ExtThemeSkin {
  ok: boolean;
  /** 校验通过的规范化皮肤文档（与内置皮肤同形，可直接喂给引擎） */
  skin?: SkinDocument;
  /** 引擎拼 asset:// 用的主题目录绝对路径（prepareSkin 的基准目录） */
  absDir?: string;
  /** 主题目录相对的文件清单（与 skin_load 同口径，直接喂校验器） */
  files?: string[];
  /** 失败原因，面向用户可直接展示 */
  errors: string[];
}

/**
 * 读取一款扩展皮肤并交给既有校验器，产出引擎可用的形态。
 *
 * 失败一律返回可读原因（不抛异常），调用方直接提示用户即可：
 *   - 扩展/皮肤不存在或磁盘读失败 → Rust 侧错误字符串；
 *   - skin.json 缺失 → 明确提示「皮肤文件缺失」；
 *   - 校验不过 → 复用校验器的首条错误（它与内置皮肤导入是同一套文案）。
 */
export async function loadExtThemeSkin(extId: string, themeId: string): Promise<ExtThemeSkin> {
  let payload;
  try {
    payload = await capabilities.extThemeLoad(extId, themeId);
  } catch (e) {
    return { ok: false, errors: [String(e)] };
  }

  if (!payload?.json) {
    return { ok: false, errors: [`皮肤文件缺失（${extId} / ${themeId}）`] };
  }

  // files 已是主题目录相对（与 skin_load 同口径），直接交给校验器
  const files = payload.files ?? [];
  const v = validateSkin(payload.json, { files });
  if (!v.ok || !v.skin) {
    return { ok: false, errors: v.errors.length ? v.errors : ["皮肤校验失败"] };
  }

  return { ok: true, skin: v.skin, absDir: payload.absDir ?? undefined, files, errors: [] };
}

/**
 * 由扩展皮肤构造 `prepareSkin` 的上下文。
 *
 * `prepareSkin` 的基准目录是「skinsDir + 皮肤 id」（为内置皮肤库「根目录 + 皮肤 id」
 * 的结构写的），而扩展皮肤拿到的是**已经拼好的绝对目录 absDir**。这里把 absDir
 * 拆成 `skinsDir = 父目录` + `id = 目录名`，让两条链路最终落到同一个基准字符串，
 * 从而完全复用同一个 prepareSkin —— 不必为扩展皮肤加第二条资产解析路径。
 */
export function extPrepareContext(load: ExtThemeSkin): PrepareContext | null {
  const abs = load.absDir;
  if (!abs) return null;
  const norm = abs.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  if (slash < 0) return null;
  const dir = norm.slice(0, slash);
  const name = norm.slice(slash + 1);
  if (!dir || !name) return null;
  return { id: name, skinsDir: dir, files: load.files ?? [] };
}
