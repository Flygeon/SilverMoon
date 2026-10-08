/**
 * `musicTags` 通道的 Electron 胶水层：本地文件写标签 + 在线歌曲标签的磁盘缓存。
 *
 * 分工：
 * - 真正读写音频文件的活儿在 `electron/tag-writer.ts`（纯 Node）；
 * - 缓存目录约定（sha1 / 原子写 / 备份 / 歌词旁路）在 `electron/tag-store.ts`（Lead 维护）；
 * - 这里只做「解析 payload → 调上面两个模块 → 组织返回值」。
 *
 * 目录布局（`<userData>/music-tags/`）：
 * - `index.json`                   在线标签索引（原子写）
 * - `covers/cover-<sha1(key)>.<ext>` 在线封面
 * - `lyrics/<sha1(key)>.txt`        在线歌词旁路
 * - `local-backup/<sha1(id)>.json`  写入前的原始字段快照（id = 本地路径或在线 key）
 */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import type { AppliedOnlineTags, MusicTagCoverMode, MusicTagFields } from "../shared/types";
import { readLocalTags, setAppPathResolver, writeLocalTags } from "./tag-writer";
import {
  COVER_DIR,
  INDEX_FILE,
  TAGS_DIR,
  createBackupIfAbsent,
  ensureDir,
  readBackup,
  readLyricsSidecar,
  readTextOrNull,
  removeQuietly,
  sha1,
  writeLyricsSidecar,
  writeTextAtomic,
} from "./tag-store";

/** 索引里的在线记录：内存返回给渲染进程时用 `toApplied` 去掉内部字段。 */
interface OnlineRecord {
  key: string;
  fields: MusicTagFields;
  /** 覆盖写入前平台自己的标签（还原默认 / 歌词回退用） */
  original: MusicTagFields | null;
  coverPath: string | null;
  cachedAt: number;
}

interface OnlineIndex {
  version: number;
  entries: Record<string, OnlineRecord>;
}

const INDEX_VERSION = 1;

/** 让 tag-writer 的第三级兜底（app.getAppPath()）可用，自身不必依赖 electron。 */
setAppPathResolver(() => {
  try {
    return app.getAppPath();
  } catch {
    return null;
  }
});

/** 标签缓存根目录。 */
function tagsRoot(): string {
  return path.join(app.getPath("userData"), TAGS_DIR);
}

function indexFile(): string {
  return path.join(tagsRoot(), INDEX_FILE);
}

function coverDir(): string {
  return path.join(tagsRoot(), COVER_DIR);
}

export function emptyMusicTagFields(): MusicTagFields {
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

/** 把外来的（可能缺字段的）对象补成完整 MusicTagFields。 */
function normalizeFields(input: unknown): MusicTagFields {
  const source = (input ?? {}) as Partial<MusicTagFields>;
  const base = emptyMusicTagFields();
  for (const key of Object.keys(base) as (keyof MusicTagFields)[]) {
    const value = source[key];
    base[key] = typeof value === "string" ? value : "";
  }
  return base;
}

function readIndex(): OnlineIndex {
  const text = readTextOrNull(indexFile());
  if (!text) return { version: INDEX_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(text) as Partial<OnlineIndex>;
    const entries = parsed?.entries;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
      return {
        version: typeof parsed.version === "number" ? parsed.version : INDEX_VERSION,
        entries: entries as Record<string, OnlineRecord>,
      };
    }
  } catch {
    /* 索引损坏时从空开始，不让应用起不来 */
  }
  return { version: INDEX_VERSION, entries: {} };
}

function writeIndex(index: OnlineIndex): void {
  writeTextAtomic(indexFile(), JSON.stringify(index, null, 2));
}

/** 内部记录 → 渲染进程可见的 `AppliedOnlineTags`（封面文件不存在时置 null）。 */
function toApplied(record: OnlineRecord): AppliedOnlineTags {
  const coverPath = record.coverPath && existsSync(record.coverPath) ? record.coverPath : null;
  return {
    key: record.key,
    fields: normalizeFields(record.fields),
    original: record.original ? normalizeFields(record.original) : null,
    coverPath,
    cachedAt: record.cachedAt,
  };
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 从 MIME（缺失时从 dataURL）推断封面扩展名。 */
function coverExt(mimeType: string | undefined, base64: string | undefined): string {
  const mime = (mimeType ?? "").toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const matched = /^data:([^;,]+)[;,]/.exec(base64 ?? "");
  const fromUrl = matched ? MIME_EXT[matched[1].toLowerCase()] : undefined;
  return fromUrl ?? "jpg";
}

/** base64（可带 dataURL 前缀）→ 字节。 */
function decodeBase64(base64: string): Buffer | null {
  const comma = base64.indexOf(",");
  const raw = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64");
  return bytes.length > 0 ? bytes : null;
}

/** 原子写二进制封面（.tmp + rename）。 */
function writeCoverAtomic(file: string, data: Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** 按 coverMode 落地在线封面，返回新的 coverPath（keep 保留 / remove 删除 / set 覆写）。 */
function updateCover(
  record: OnlineRecord,
  key: string,
  mode: MusicTagCoverMode,
  base64: string | undefined,
  mimeType: string | undefined,
): string | null {
  if (mode === "keep") {
    return record.coverPath && existsSync(record.coverPath) ? record.coverPath : null;
  }
  if (mode === "remove") {
    if (record.coverPath) removeQuietly(record.coverPath);
    return null;
  }

  const data = base64 ? decodeBase64(base64) : null;
  if (!data) throw new Error("coverMode=set 但缺少封面数据");

  const ext = coverExt(mimeType, base64);
  const next = path.join(coverDir(), `cover-${sha1(key)}.${ext}`);
  // 换过格式时删掉旧文件，避免 covers/ 里留垃圾
  if (record.coverPath && record.coverPath !== next) removeQuietly(record.coverPath);
  writeCoverAtomic(next, data);
  return next;
}

/** 在线记录的原始标签（索引优先，兼容旧的 local-backup 备份文件）。 */
function originalOf(record: OnlineRecord | undefined, key: string): MusicTagFields | null {
  if (record?.original) return normalizeFields(record.original);
  const backup = readBackup<MusicTagFields>(app.getPath("userData"), key);
  return backup ? normalizeFields(backup) : null;
}

/**
 * 处理 `musicTags` 通道的全部 op。
 *
 * 渲染进程侧一一对应 `src/capabilities/index.ts` 的同名方法，
 * payload 形状见契约 §4（op + 各自字段平铺在同一个对象里）。
 */
export async function handleMusicTags(payload: Record<string, unknown>): Promise<unknown> {
  const op = String(payload.op ?? "");
  const root = app.getPath("userData");

  switch (op) {
    // ---------------------------------------------------------------- 本地
    case "writeLocal": {
      const filePath = String(payload.path ?? "");
      if (!filePath) throw new Error("writeLocal 缺少 path");
      const coverMode = (payload.coverMode as MusicTagCoverMode | undefined) ?? "keep";
      return writeLocalTags({
        path: filePath,
        fields: normalizeFields(payload.fields),
        coverMode,
        coverBase64: typeof payload.coverBase64 === "string" ? payload.coverBase64 : undefined,
        coverMime: typeof payload.coverMime === "string" ? payload.coverMime : undefined,
      });
    }
    case "readLocal": {
      const filePath = String(payload.path ?? "");
      if (!filePath) throw new Error("readLocal 缺少 path");
      return readLocalTags(filePath);
    }
    case "backupLocal": {
      const filePath = String(payload.path ?? "");
      if (!filePath) throw new Error("backupLocal 缺少 path");
      const created = createBackupIfAbsent(root, filePath, normalizeFields(payload.fields));
      return { created };
    }
    case "readLocalBackup": {
      const filePath = String(payload.path ?? "");
      if (!filePath) throw new Error("readLocalBackup 缺少 path");
      const backup = readBackup<MusicTagFields>(root, filePath);
      return backup ? normalizeFields(backup) : null;
    }

    // ---------------------------------------------------------------- 在线
    case "cacheOnline": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("cacheOnline 缺少 key");
      const index = readIndex();
      const existing = index.entries[key];
      const record: OnlineRecord = existing ?? {
        key,
        fields: emptyMusicTagFields(),
        original: null,
        coverPath: null,
        cachedAt: 0,
      };
      record.fields = normalizeFields(payload.fields);
      record.coverPath = updateCover(
        record,
        key,
        (payload.coverMode as MusicTagCoverMode | undefined) ?? "keep",
        typeof payload.coverBase64 === "string" ? payload.coverBase64 : undefined,
        typeof payload.coverMime === "string" ? payload.coverMime : undefined,
      );
      record.cachedAt = Date.now();
      index.entries[key] = record;
      writeIndex(index);
      return toApplied(record);
    }
    case "readOnline": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("readOnline 缺少 key");
      const record = readIndex().entries[key];
      return record ? toApplied(record) : null;
    }
    case "removeOnline": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("removeOnline 缺少 key");
      const index = readIndex();
      const record = index.entries[key];
      if (!record) return { removed: false };
      if (record.coverPath) removeQuietly(record.coverPath);
      delete index.entries[key];
      writeIndex(index);
      return { removed: true };
    }
    case "listOnline": {
      return Object.values(readIndex().entries).map(toApplied);
    }

    // ------------------------------------------------- 在线：歌词 / 原始标签
    case "readLyrics": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("readLyrics 缺少 key");
      const kind = String(payload.kind ?? "tag");
      if (kind === "original") {
        const record = readIndex().entries[key];
        const original = originalOf(record, key);
        return original?.lyrics ? original.lyrics : null;
      }
      return readLyricsSidecar(root, key);
    }
    case "writeLyrics": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("writeLyrics 缺少 key");
      const lyrics = typeof payload.lyrics === "string" ? payload.lyrics : "";
      writeLyricsSidecar(root, key, lyrics);
      return { written: lyrics.length > 0 };
    }
    case "readOriginal": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("readOriginal 缺少 key");
      return originalOf(readIndex().entries[key], key);
    }
    case "writeOriginal": {
      const key = String(payload.key ?? "");
      if (!key) throw new Error("writeOriginal 缺少 key");
      const index = readIndex();
      const existing = index.entries[key];
      const record: OnlineRecord = existing ?? {
        key,
        fields: emptyMusicTagFields(),
        original: null,
        coverPath: null,
        cachedAt: 0,
      };
      // 只合并 original，绝不动 fields
      const merged: MusicTagFields = {
        ...emptyMusicTagFields(),
        ...(record.original ?? {}),
      };
      const patch = (payload.fields ?? {}) as Partial<MusicTagFields>;
      for (const field of Object.keys(patch) as (keyof MusicTagFields)[]) {
        const value = patch[field];
        if (typeof value === "string") merged[field] = value;
      }
      record.original = merged;
      if (!existing) record.cachedAt = Date.now();
      index.entries[key] = record;
      writeIndex(index);
      // 镜像到 local-backup：歌词回退链可以直接 readBackup（只在无备份时创建）
      createBackupIfAbsent(root, key, merged);
      return toApplied(record);
    }

    default:
      throw new Error(`未知的音乐标签操作：${op}`);
  }
}
