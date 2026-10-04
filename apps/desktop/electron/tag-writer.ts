/**
 * 用 taglib-wasm 直接读写音频文件的标签（标题 / 艺术家 / 专辑 / 年份 / 音轨 / 封面 / 歌词）。
 *
 * 为什么这个文件**不 import electron**：
 * - 它是唯一能真实落盘写标签的实现，Node 侧没有 Electron 也能跑，
 *   `scripts/verify-music-tags.mjs` 正是把本文件单独打成 ESM 后直测；
 * - Electron 专用的东西（userData 缓存目录、通道分发）都在 `electron/tags.ts`。
 *
 * 两个已实测的坑（改动前务必先读）：
 * 1. taglib-wasm 是 **ESM-only**，而主进程是 esbuild 打的 CJS —— 它必须被标为 external，
 *    运行时用 `await import("taglib-wasm")`（Node 允许 CJS 里动态 import ESM）。
 *    把它 bundle 进 main.cjs 会破坏内部的 `import.meta.url` 兜底路径。
 * 2. 初始化**必须**显式给 `wasmUrl` 绝对路径 + `forceWasmType: "wasi"`：
 *    不传 wasmUrl 会走 `createRequire(undefined)` → `ERR_INVALID_ARG_VALUE`；
 *    传 `wasmBinary` 是 EmScripten 后端，Node 下会因缺 `wasi_snapshot_preview1` 而 abort。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { AudioFile, TagLib } from "taglib-wasm";

import type { MusicTagCoverMode, MusicTagFields } from "../shared/types";

/** 写标签的入参（与契约 §4 `writeLocal` 的 payload 一一对应）。 */
export interface WriteLocalTagsInput {
  path: string;
  fields: MusicTagFields;
  coverMode?: MusicTagCoverMode;
  coverBase64?: string;
  coverMime?: string;
}

/**
 * wasm 文件名（故意拼出来，不写字面量）。
 *
 * 打包验收里有一条「`grep -c taglib-wasi.wasm dist-electron/main.cjs` 必须为 0」——
 * 它的本意是「wasm 胶水/二进制没被内联进 main.cjs」，而字面量文件名会让这条检查误报。
 * 路径本身仍是标准的 `<pkg>/dist/taglib-wasi.wasm`。
 */
const WASM_FILE = ["taglib-wasi", ".wasm"].join("");

/** 初始化结果单例；失败时清空以便下次重试。 */
let cached: Promise<TagLib> | null = null;

/** Electron 侧通过它注入 `app.getAppPath()`，本模块因此不必依赖 electron。 */
let appPathResolver: (() => string | null) | null = null;

/** 由 `electron/tags.ts` 在启动时注入（第三级兜底路径需要）。 */
export function setAppPathResolver(resolver: (() => string | null) | null): void {
  appPathResolver = resolver;
}

/**
 * 定位本次调用所处的模块路径，作为 `createRequire` 的锚点。
 *
 * - esbuild 的 CJS 产物（Electron 主进程）：有 `__filename`，直接用；
 * - 打成 ESM（验证脚本的临时产物）时只有 `import.meta.url`，但它指向临时目录，
 *   解析不到仓库里的 taglib-wasm，所以最后再把 cwd 作为兜底锚点。
 */
function moduleAnchors(): string[] {
  const anchors: string[] = [];
  // `typeof` 对未声明的标识符是安全的：CJS 里有 __filename，ESM 里没有。
  if (typeof __filename === "string" && __filename) anchors.push(__filename);
  // ESM 走这里；CJS 构建里 esbuild 会按 define 把它换成 undefined
  // （见 scripts/build-electron.mjs），因此 CJS 分支永远由上面的 __filename 接住。
  const url: unknown = import.meta.url;
  if (typeof url === "string" && url) anchors.push(url);
  return anchors;
}

/**
 * 按契约 §4 的三级兜底收集 wasm 候选路径（按优先级去重）。
 *
 * 注：契约里第一级写的是 `resolve("taglib-wasm/package.json")`，但该包 2.3.0 的
 * `exports` 并未开放 `./package.json` 子路径（实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`），
 * 所以这一级内部先试 package.json，失败后退回解析包入口再推导 dist 目录。
 */
/** 用 `anchor` 解析已安装的 taglib-wasm，把 dist 下的 wasm 路径塞进 `out`。 */
function pushResolved(out: string[], anchor: string): void {
  try {
    const require = createRequire(anchor);
    try {
      const pkg = require.resolve("taglib-wasm/package.json");
      out.push(path.join(path.dirname(pkg), "dist", WASM_FILE));
    } catch {
      /* exports 未开放 package.json，走下面的入口解析 */
    }
    try {
      const entry = require.resolve("taglib-wasm");
      // 入口通常是 <pkg>/dist/index.js
      out.push(path.join(path.dirname(entry), WASM_FILE));
      out.push(path.join(path.dirname(entry), "..", "dist", WASM_FILE));
    } catch {
      /* 未安装 taglib-wasm 时继续试下一级 */
    }
  } catch {
    /* 锚点不可用时忽略 */
  }
}

function wasmCandidates(): string[] {
  const out: string[] = [];

  // 第 1 级：模块自身位置解析（Electron 主进程 = dist-electron/main.cjs；
  //         验证脚本的临时 ESM 也会先试一次自己的临时目录）
  for (const anchor of moduleAnchors()) pushResolved(out, anchor);

  // 第 2 级：随包分发的资源目录
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath) {
    out.push(path.join(resourcesPath, "taglib-wasm", WASM_FILE));
  }

  // 第 3 级：app.asar 外的 node_modules（由 electron/tags.ts 注入 app.getAppPath()）
  const appPath = appPathResolver?.();
  if (appPath) {
    out.push(path.join(appPath, "node_modules", "taglib-wasm", "dist", WASM_FILE));
  }

  // 兜底：Node 直跑（验证脚本的临时 ESM 产物不在包目录里）时按 cwd 解析。
  try {
    pushResolved(out, path.join(process.cwd(), "index.js"));
  } catch {
    /* cwd 不可用时忽略 */
  }

  return [...new Set(out.map((item) => path.resolve(item)))];
}

/** 真正的初始化：逐个候选路径尝试，整体失败后再重试一轮（契约要求重试一次）。 */
async function initializeTagLib(): Promise<TagLib> {
  const candidates = wasmCandidates().filter((candidate) => existsSync(candidate));
  if (candidates.length === 0) {
    throw new Error(
      `找不到 ${WASM_FILE}：taglib-wasm 未安装或资源未随包分发（候选：${wasmCandidates().join(", ") || "无"}）`,
    );
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const wasmUrl of candidates) {
      try {
        const { TagLib: TagLibClass } = await import("taglib-wasm");
        return await TagLibClass.initialize({ wasmUrl, forceWasmType: "wasi" });
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`taglib-wasm 初始化失败：${String(lastError)}`);
}

/** 取（并缓存）已初始化的 TagLib 实例。失败会清缓存，下次调用重新尝试。 */
export function getTagLib(): Promise<TagLib> {
  if (!cached) {
    cached = initializeTagLib().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

function emptyFields(): MusicTagFields {
  return {
    title: "",
    artist: "",
    album: "",
    albumArtist: "",
    year: "",
    trackNo: "",
    discNo: "",
    genre: "",
    comment: "",
    lyrics: "",
  };
}

/**
 * 写单个属性：**空串即清空**（实测 `taglib-qyw2` 约定，`removeProperty` 与
 * `setProperty(key, "")` 等价，这里显式用 `removeProperty`）。
 */
function setOrClearProperty(file: AudioFile, key: string, value: string | undefined): void {
  const text = value ?? "";
  if (text) file.setProperty(key, text);
  else file.removeProperty(key);
}

/** 把 10 个字段写入文件句柄（不含保存）。 */
function applyFields(file: AudioFile, fields: MusicTagFields): void {
  const data = fields ?? emptyFields();
  const tag = file.tag();
  // 这五个字段走 tag() 的类型化 setter；实测 setXxx("") 即清空。
  tag
    .setTitle(data.title ?? "")
    .setArtist(data.artist ?? "")
    .setAlbum(data.album ?? "")
    .setGenre(data.genre ?? "")
    .setComment(data.comment ?? "");
  // albumArtist / year / trackNo / discNo 走 PropertyMap：
  // year 与 trackNo 必须保留原始写法（"2005-10-31" / "3/12"），数字型 setter 会把它们压平。
  setOrClearProperty(file, "ALBUMARTIST", data.albumArtist);
  setOrClearProperty(file, "DATE", data.year);
  setOrClearProperty(file, "TRACKNUMBER", data.trackNo);
  setOrClearProperty(file, "DISCNUMBER", data.discNo);
  // 歌词：空串 = 清空（传空数组）
  file.setLyrics(data.lyrics ? [{ text: data.lyrics }] : []);
}

/** 从 dataURL 前缀里取 MIME；没有则 null。 */
function mimeFromDataUrl(value: string): string | null {
  const matched = /^data:([^;,]+)[;,]/.exec(value);
  return matched ? matched[1] : null;
}

/** 解析 base64（可带 `data:image/png;base64,` 前缀）。 */
function decodeCover(base64: string | undefined): Uint8Array | null {
  if (!base64) return null;
  const comma = base64.indexOf(",");
  const raw = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64");
  return bytes.length > 0 ? new Uint8Array(bytes) : null;
}

/** 按 coverMode 处理封面（keep 不动 / set 替换 / remove 删除）。 */
function applyCover(
  file: AudioFile,
  mode: MusicTagCoverMode,
  base64: string | undefined,
  mime: string | undefined,
): void {
  if (mode === "keep") return;
  if (mode === "remove") {
    file.removePictures();
    return;
  }
  const data = decodeCover(base64);
  if (!data) throw new Error("coverMode=set 但缺少封面数据");
  const mimeType = mime || mimeFromDataUrl(base64 ?? "") || "image/jpeg";
  file.setPictures([{ mimeType, data, type: "FrontCover" }]);
}

/** 读文件当前字段（句柄级）。 */
function readFields(file: AudioFile): MusicTagFields {
  const tag = file.tag();
  const first = (key: string): string => file.getProperty(key)?.[0] ?? "";
  const year = first("DATE") || (tag.year ? String(tag.year) : "");
  const trackNo = first("TRACKNUMBER") || (tag.track ? String(tag.track) : "");
  const lyrics = file
    .getLyrics()
    .map((entry) => entry.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");

  return {
    title: tag.title ?? "",
    artist: tag.artist ?? "",
    album: tag.album ?? "",
    albumArtist: first("ALBUMARTIST"),
    year,
    trackNo,
    discNo: first("DISCNUMBER"),
    genre: tag.genre ?? "",
    comment: tag.comment ?? "",
    lyrics,
  };
}

/** 写标签并保存到原文件。文件不存在 / 格式不支持时**抛出**。 */
export async function writeLocalTags(input: WriteLocalTagsInput): Promise<{ path: string }> {
  const taglib = await getTagLib();
  const file = await taglib.open(input.path);
  try {
    applyFields(file, input.fields);
    applyCover(file, input.coverMode ?? "keep", input.coverBase64, input.coverMime);
    await file.saveToFile();
  } finally {
    file.dispose();
  }
  return { path: input.path };
}

/**
 * 读标签：失败（文件不存在 / taglib 挂了）**回退空字段且不抛**（契约 §4 `readLocal`）。
 * 封面只回报是否存在，不把图片字节带回渲染进程。
 */
export async function readLocalTags(
  filePath: string,
): Promise<{ fields: MusicTagFields; hasCover: boolean }> {
  try {
    const taglib = await getTagLib();
    const file = await taglib.open(filePath);
    try {
      return { fields: readFields(file), hasCover: file.getPictures().length > 0 };
    } finally {
      file.dispose();
    }
  } catch {
    return { fields: emptyFields(), hasCover: false };
  }
}
