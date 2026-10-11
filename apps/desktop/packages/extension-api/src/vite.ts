/**
 * Vite 插件：把扩展前端构建到扩展包约定的 `<扩展根>/web/dist`，并把扩展 id 注入为编译期常量。
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { silvermoonExtension } from "@silvermoon/extension-api/vite";
 *
 * export default defineConfig({ plugins: [silvermoonExtension()] });
 * ```
 *
 * 插件做的事（都是「约定大于配置」的部分）：
 * - 读 `manifest.json`，推断扩展 id 与产物目录（`web.dist`，缺省 `web/dist`）；
 * - `build.outDir` 指到扩展包内的那个目录（而不是默认的 `dist`）；
 * - `base: "./"` —— 产物由宿主经自定义协议按文件加载，绝对路径 `/assets/…` 会 404；
 * - `define` 注入 `__EXT_ID__` / `__EXT_API_VERSION__`；
 * - 往 `index.html` 塞一个 `<meta name="silvermoon-ext-id">`，方便在宿主里排查是哪个扩展。
 *
 * 前提：`manifest.json` 与 `vite.config.ts` 同级（都在扩展包根目录）。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, UserConfig } from "vite";
import { EXT_API_VERSION, type ExtManifest } from "./manifest";

/** `manifest.web.dist` 的缺省值，与宿主 Rust 侧保持一致。 */
export const DEFAULT_WEB_DIST = "web/dist";

/** Vite 插件选项。 */
export interface ExtVitePluginOptions {
  /**
   * 扩展 id。缺省从 `manifest.json` 的 `id` 读取。
   * 显式传入时**以它为准**（manifest 缺失时也能构建，便于脚手架先跑起来）。
   */
  extId?: string;
  /** `manifest.json` 路径；缺省 `<扩展根>/manifest.json`。 */
  manifestPath?: string;
  /** 前端产物目录，相对扩展根目录。缺省 = `manifest.web.dist ?? "web/dist"`。 */
  outDir?: string;
  /** 构建前是否清空产物目录，缺省 `true`。 */
  emptyOutDir?: boolean;
  /** 是否注入 `__EXT_ID__` / `__EXT_API_VERSION__` 常量，缺省 `true`。 */
  define?: boolean;
  /** 额外的 `define` 常量（值需自行 `JSON.stringify`）。 */
  extraDefine?: Record<string, string>;
  /** 是否覆盖 `base` 为 `"./"`，缺省 `true`（扩展产物必须用相对路径）。 */
  relativeBase?: boolean;
}

/** 读到的清单与其来源路径。 */
export interface LoadedExtManifest {
  manifest: ExtManifest;
  /** `manifest.json` 的绝对路径；仅由 `extId` 选项兜底时可能为 null。 */
  path: string | null;
  /** 生效的扩展 id（`options.extId` 优先）。 */
  id: string;
}

/** 去掉开头的 "./" 与前导 "/"（契约里路径一律用 POSIX 分隔符）。 */
function normalizeRel(p: string): string {
  let s = p.trim();
  while (s.startsWith("./") || s.startsWith("/")) {
    s = s.startsWith("./") ? s.slice(2) : s.slice(1);
  }
  return s;
}

/**
 * 读扩展清单。
 *
 * - 找不到文件且**没有**显式给 `extId`：抛错（扩展包必须有 manifest.json）；
 * - 找不到文件但给了 `extId`：返回一个只有 id 的最小清单（脚手架首次构建可用）；
 * - 文件存在但 JSON 非法 / 缺 `id`：抛错（早失败比装到用户机器上再失败好）。
 */
export function loadExtManifest(
  root: string,
  options: ExtVitePluginOptions = {},
): LoadedExtManifest {
  const file = options.manifestPath
    ? path.resolve(root, options.manifestPath)
    : path.resolve(root, "manifest.json");

  if (!existsSync(file)) {
    if (options.extId) {
      return {
        manifest: { id: options.extId, name: options.extId },
        path: null,
        id: options.extId,
      };
    }
    throw new Error(
      `[silvermoon] 未找到扩展清单：${file}\n` +
        "扩展包根目录必须有 manifest.json；若只想先跑通构建，可在插件选项里传 extId。",
    );
  }

  let parsed: ExtManifest;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as ExtManifest;
  } catch (e) {
    throw new Error(`[silvermoon] 解析 ${file} 失败：${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[silvermoon] ${file} 不是合法的 JSON 对象`);
  }
  const id = options.extId || parsed.id;
  if (!id || typeof id !== "string") {
    throw new Error(`[silvermoon] ${file} 缺少 id，或在插件选项里传 extId`);
  }
  return { manifest: parsed, path: file, id };
}

/** 计算前端产物目录（相对扩展根目录）。 */
export function resolveWebDist(
  manifest: ExtManifest | null | undefined,
  override?: string,
): string {
  if (override && override.trim()) return normalizeRel(override);
  const fromManifest = manifest?.web?.dist;
  if (fromManifest && fromManifest.trim()) return normalizeRel(fromManifest);
  return DEFAULT_WEB_DIST;
}

/**
 * 银月扩展 Vite 插件。
 *
 * 用法见文件头。`vite dev` 也能直接跑 —— `outDir` 只在 `build` 时生效，
 * 开发服务器照常在 :5173 起，方便先把 UI 调好再接宿主。
 */
export function silvermoonExtension(options: ExtVitePluginOptions = {}): Plugin {
  let root = process.cwd();
  let resolved: LoadedExtManifest | null = null;
  let outDir = DEFAULT_WEB_DIST;

  const ensure = (): LoadedExtManifest => {
    if (!resolved) resolved = loadExtManifest(root, options);
    return resolved;
  };

  return {
    name: "silvermoon:extension-api",

    config(userConfig: UserConfig): UserConfig {
      root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      const loaded = ensure();
      outDir = resolveWebDist(loaded.manifest, options.outDir);

      const patch: UserConfig = {
        build: {
          outDir,
          emptyOutDir: options.emptyOutDir ?? true,
        },
      };
      if (options.relativeBase ?? true) patch.base = "./";
      if (options.define ?? true) {
        patch.define = {
          __EXT_ID__: JSON.stringify(loaded.id),
          __EXT_API_VERSION__: JSON.stringify(EXT_API_VERSION),
          ...(options.extraDefine ?? {}),
        };
      }
      return patch;
    },

    configResolved() {
      // 清单缺失之类的问题在 config 阶段就该抛；这里再确保一次，并把落点告诉作者。
      const loaded = ensure();
      console.log(
        `[silvermoon] 扩展 ${loaded.id} · API ${EXT_API_VERSION} · 前端产物 → ${path.resolve(root, outDir)}`,
      );
    },

    transformIndexHtml(html: string) {
      const loaded = ensure();
      const meta = `<meta name="silvermoon-ext-id" content="${loaded.id}">`;
      if (html.includes("silvermoon-ext-id")) return html;
      return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${meta}`);
    },
  };
}

/** 默认导出，便于 `import ext from "@silvermoon/extension-api/vite"`。 */
export default silvermoonExtension;
