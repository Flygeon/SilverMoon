/**
 * 应用元信息与路径解析。
 *
 * 单一真源是 `backend/silvermoon.config.json`：Rust 侧的 `generate_context!`
 * 在**编译期**读它，这里在**运行期**读它（构建时被 esbuild 内联进包）。
 * 两侧必须一致，否则窗口标题、identifier、数据目录都会对不上。
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import configJson from "../backend/silvermoon.config.json";

export interface WindowConfig {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  decorations: boolean;
  center: boolean;
  resizable: boolean;
}

export interface AppConfig {
  /** 面向用户展示的应用名，同时也是打包与数据目录的技术标识。 */
  productName: string;
  identifier: string;
  version: string;
  window: WindowConfig;
  sidecar: { binary: string; devBinary: string };
  migration: { legacyIdentifier: string };
}

export const config = configJson as unknown as AppConfig;

/**
 * 是否处于开发模式。
 *
 * 用 `app.isPackaged` 而不是环境变量：打包产物由 electron-builder 生成，
 * 没有任何地方能可靠地设置 env，而 `isPackaged` 由 Electron 自己判定。
 */
export const isDev = !app.isPackaged;

/** 前端 dev server 地址（与 vite.config.ts 的 server.port 保持一致）。 */
export const DEV_SERVER_URL = "http://localhost:1420";

/** 生产环境承载前端的自定义协议。 */
export const APP_SCHEME = "app";
export const APP_ORIGIN = `${APP_SCHEME}://silvermoon`;

/** 本地文件代理协议：把磁盘文件暴露成页面可直接消费的 URL。 */
export const ASSET_SCHEME = "asset";

/**
 * 在线封面代理协议：`app-cover://img/<encodeURIComponent(原始URL)>`。
 * 主进程接管取图（Referer/UA 按域伪装、磁盘缓存、并发去重、负缓存），
 * 渲染层 `<img>` 直接消费，绕开 CORS 与防盗链双杀。
 */
export const COVER_SCHEME = "app-cover";

/** 工程根目录。 */
export const projectRoot = path.resolve(__dirname, "..");

/**
 * 应用数据目录 —— 必须是**绝对**路径，且与 Rust 侧 `app_data_dir()` 完全一致。
 *
 * 用 `<appData>/<identifier>` 而不是 Electron 默认的
 * `<appData>/<productName>`，这样目录名与 identifier 同名、语义明确。
 */
export function dataDir(appDataRoot: string): string {
  return path.join(appDataRoot, config.identifier);
}

/** 缓存目录（缩略图缓存落在其下的 `thumbs/`）。 */
export function cacheDir(localAppDataRoot: string): string {
  return path.join(localAppDataRoot, config.identifier, "cache");
}

/** 面向用户展示的日志目录。 */
export function logDir(appDataRoot: string): string {
  return path.join(dataDir(appDataRoot), "logs");
}

/** 确保目录存在。 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 一次性数据迁移：把旧项目 LumiLuna 的数据目录整份复制过来。
 *
 * 只在「新目录还不存在」且「旧目录存在」时执行一次，**只读旧目录、绝不删改**。
 * 迁移内容包含 library.db、设置、皮肤、扩展、登录态等。
 */
export function migrateLegacyData(appDataRoot: string): { migrated: boolean; from?: string } {
  const target = dataDir(appDataRoot);
  const legacy = path.join(appDataRoot, config.migration.legacyIdentifier);

  if (existsSync(target) || !existsSync(legacy)) {
    return { migrated: false };
  }

  try {
    copyTree(legacy, target);
    return { migrated: true, from: legacy };
  } catch (error) {
    // 迁移失败不阻断启动：新目录照样会被创建，用户只是需要重新扫描库
    console.error("[silvermoon] 旧数据迁移失败：", error);
    return { migrated: false };
  }
}

/** 递归复制目录（保留子目录结构；不跟随符号链接）。 */
function copyTree(from: string, to: string): void {
  ensureDir(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
    }
  }
}

/**
 * 应用图标路径（托盘 / 窗口图标 / 托盘降级图标）。
 *
 * 开发期直接取仓库里的 icons；打包后 `backend/` 不在 app.asar 内，
 * 因此改从 `extraResources` 放进去的 `resources/icon.png` 取。
 */
export function iconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icon.png")]
    : [
        path.join(projectRoot, "backend", "icons", "128x128.png"),
        path.join(projectRoot, "app-icon.png"),
      ];
  return candidates.find((p) => existsSync(p) && statSync(p).isFile());
}

/** 渲染进程入口 URL。 */
export function rendererUrl(hash = ""): string {
  const base = isDev ? `${DEV_SERVER_URL}/` : `${APP_ORIGIN}/index.html`;
  return `${base}${hash}`;
}
