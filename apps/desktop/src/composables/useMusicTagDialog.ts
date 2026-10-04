/**
 * 「写音乐标签」对话框的状态与业务逻辑（全局单例）。
 *
 * 状态在这里，`MusicTagDialog.vue` 只做绑定与渲染；所有能力调用都收在这几个
 * 可导出函数里（open / apply / reset / search），便于脱离组件直接驱动与断言。
 */
import { reactive } from "vue";
import { translate } from "@shared/i18n";
import { capabilities } from "@/capabilities";
import { useLibraryStore } from "@/stores/library";
import { open as dialogOpen } from "@/ipc/dialog";
import { readFile } from "@/ipc/fs";
import { useMusicTagsStore } from "@/stores/musicTags";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
import {
  emptyMusicTagFields,
  fieldsDirty,
  fieldsFromMediaEntry,
  fieldsFromOnlineSong,
  fieldsFromSearchResult,
} from "@/utils/musicTagDraft";
import {
  MUSIC_TAG_SOURCES,
  fetchCoverAsBase64,
  fetchTagLyrics,
  musicTagSourceLabelKey,
  searchAllMusicTagSources,
  searchMusicTagSource,
  smartTagRank,
  type MusicTagSearchMode,
} from "@/utils/musicTagSources";
import {
  fetchWordLyricsByMeta,
  fetchWordLyricsForCandidate,
  toTagLyricsText,
} from "@/utils/musicTagWordLyrics";
import type {
  MediaEntry,
  MusicTagCover,
  MusicTagCoverMode,
  MusicTagFields,
  MusicTagSearchResult,
  MusicTagTarget,
} from "@shared/types";

/** 「标签已更新」事件名：播放器监听它刷新在线覆盖 */
export const MUSIC_TAG_UPDATED_EVENT = "silvermoon:music-tag-updated";

/**
 * 本地曲目 → 写标签目标的公共转换。
 *
 * 到处手抄 `{kind:"local", fileId, path, label}` 会漏字段：列表视图、网格视图、
 * 收藏页都要带时长/艺人供逐字歌词匹配用，收在这里保证各入口一致。
 */
export function localTagTarget(item: MediaEntry): Extract<MusicTagTarget, { kind: "local" }> {
  return {
    kind: "local",
    fileId: item.id,
    path: item.path,
    label: item.title || item.name,
    artist: item.artist ?? null,
    album: item.album ?? null,
    durationMs: item.durationMs ?? null,
  };
}

export type MusicTagResetMode = "online" | "backup" | "original";

interface MusicTagDialogState {
  visible: boolean;
  target: MusicTagTarget | null;
  /** 当前表单值 */
  fields: MusicTagFields;
  /** 打开时的快照（「还原默认」无备份时回滚到它） */
  original: MusicTagFields;
  /** 「写入前」磁盘备份内容（本地目标才有；打开时探测一次） */
  backup: MusicTagFields | null;
  /** 磁盘上是否**存在**备份（内容可能还没读出来；决定「还原默认」走哪条语义） */
  hasLocalBackup: boolean;
  /** 搜索模式：智能匹配（聚合五源打分）或指定单源 */
  mode: MusicTagSearchMode;
  /** 部分数据源失败的弱提示（全部失败走 searchTagCandidates 的返回值） */
  partialError: string;
  keyword: string;
  results: MusicTagSearchResult[];
  searching: boolean;
  applying: boolean;
  fetchingLyrics: boolean;
  error: string;
  notice: string;
  /** 新选封面的 dataURL（null = 未改动，沿用 coverMode） */
  coverPreview: string | null;
  coverMode: MusicTagCoverMode;
  /** 从候选拉到的歌词是否已填进表单（UI 上给个标记） */
  lyricsFromApi: boolean;
  /** 正在取逐字歌词（与 fetchingLyrics 分开：两个按钮各自转圈） */
  fetchingWordLyrics: boolean;
  /** 拉到的歌词是否含**真**逐字时间轴（UI 标记「逐字」而非「LRC」） */
  lyricsWordLevel: boolean;
}

const state = reactive<MusicTagDialogState>({
  visible: false,
  target: null,
  fields: emptyMusicTagFields(),
  original: emptyMusicTagFields(),
  backup: null,
  hasLocalBackup: false,
  mode: "smart",
  partialError: "",
  keyword: "",
  results: [],
  searching: false,
  applying: false,
  fetchingLyrics: false,
  error: "",
  notice: "",
  coverPreview: null,
  coverMode: "keep",
  lyricsFromApi: false,
  fetchingWordLyrics: false,
  lyricsWordLevel: false,
});

/** 封面图片大小上限（base64 前的原始字节），与 i18n 的 coverTooLarge 文案一致 */
const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** 数据源下拉选项：智能匹配排第一（默认），随后是五个单源 */
export const MUSIC_TAG_MODE_OPTIONS: { value: MusicTagSearchMode; labelKey: string }[] = [
  { value: "smart", labelKey: "musicTag.sourceSmart" },
  ...MUSIC_TAG_SOURCES.map((source) => ({
    value: source as MusicTagSearchMode,
    labelKey: musicTagSourceLabelKey(source),
  })),
];

function t(key: string): string {
  try {
    // 延迟取 settings：模块加载时 Pinia 可能还没 install
    return translate(useSettingsStore().lang, key);
  } catch {
    return key;
  }
}

function friendly(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

/** 广播「标签已更新」，播放器据此刷新在线覆盖 */
export function broadcastMusicTagUpdated(kind: "local" | "online", id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MUSIC_TAG_UPDATED_EVENT, { detail: { kind, id } }));
}

/**
 * 打开对话框：按目标类型装载初始草稿。
 *
 * - 在线：优先用已应用的覆盖，否则用平台字段；打开时同步探测磁盘缓存，不阻塞 UI；
 * - 本地：优先读文件里的真实标签（失败就退回库内列表项），并查是否有「写入前备份」。
 */
export function openMusicTagDialog(target: MusicTagTarget): void {
  state.target = target;
  state.error = "";
  state.notice = "";
  state.results = [];
  state.coverPreview = null;
  state.coverMode = "keep";
  state.lyricsFromApi = false;
  state.lyricsWordLevel = false;
  state.visible = true;

  if (target.kind === "local") {
    const entry: MediaEntry = {
      id: target.fileId,
      path: target.path,
      parent: "",
      name: target.label,
      ext: "",
      type: "audio",
      size: 0,
      mtime: 0,
      scannedAt: 0,
      deleted: 0,
      hasCover: false,
      favorite: false,
      // 列表项带来的艺人/专辑/时长：逐字歌词的时长匹配要用（缺了只能纯标题搜索）
      artist: target.artist ?? null,
      album: target.album ?? null,
      durationMs: target.durationMs ?? null,
    };
    state.fields = fieldsFromMediaEntry(entry);
    state.original = { ...state.fields };
    state.keyword = state.fields.title;
    state.backup = null;
    state.hasLocalBackup = false;
    void loadLocalInitial(target.path);
  } else {
    const tags = useMusicTagsStore();
    const existing = tags.get(target.song);
    state.fields = existing ? { ...existing.fields } : fieldsFromOnlineSong(target.song);
    state.original = { ...state.fields };
    state.keyword = state.fields.title || target.song.name;
    state.backup = null;
    state.hasLocalBackup = false;
    void loadOnlineInitial(tags, target);
  }
}

/** 本地：读文件当前标签 + 写入前备份（失败保留列表项草稿） */
async function loadLocalInitial(path: string): Promise<void> {
  try {
    const [read, backup] = await Promise.all([
      capabilities.readLocalMusicTags(path),
      capabilities.readLocalMusicTagsBackup(path),
    ]);
    if (!isCurrentTarget("local", path)) return;
    // 合并策略：**非空**的文件标签覆盖库内列表项。
    // 不能整份替换——后端元数据缺失或读不到标签时会返回空字段，整份替换会把
    // 列表里本来可用的标题/艺人擦成空白，用户一打开就看到空表单。
    const merged = { ...state.fields };
    for (const key of Object.keys(read.fields) as (keyof MusicTagFields)[]) {
      const value = read.fields[key];
      if (value && String(value).trim()) merged[key] = value;
    }
    state.fields = merged;
    state.original = { ...state.fields };
    if (!state.keyword) state.keyword = state.fields.title;
    state.backup = backup;
    // 备份内容读不出来（损坏 / 空文件）时按「无备份」处理，避免还原成空标签
    state.hasLocalBackup = !!backup;
  } catch {
    /* 读失败不阻塞手动填写 */
  }
}

/** 在线：读磁盘覆盖 + 平台原始快照（用于「还原默认」提示） */
async function loadOnlineInitial(
  tags: ReturnType<typeof useMusicTagsStore>,
  target: Extract<MusicTagTarget, { kind: "online" }>,
): Promise<void> {
  try {
    const entry = await tags.resolve(target.song);
    if (!isCurrentTarget("online", tags.keyOf(target.song))) return;
    if (entry) {
      state.fields = { ...entry.fields };
      state.original = { ...state.fields };
      state.backup = entry.original ?? null;
      state.hasLocalBackup = !!entry.original;
    }
  } catch {
    /* 无缓存即平台值 */
  }
}

function isCurrentTarget(kind: "local" | "online", id: string): boolean {
  const target = state.target;
  if (!target || target.kind !== kind || !state.visible) return false;
  const current = target.kind === "local" ? target.path : useMusicTagsStore().keyOf(target.song);
  return current === id;
}

/** 智能匹配最多展示多少条候选 */
const SMART_RESULT_LIMIT = 15;

/**
 * 搜索候选并写入 results。
 *
 * - `mode === "smart"`：并发搜五个源，汇总后按标题/艺术家/专辑相似度打分取前 15；
 * - 指定单源：只搜那一个源，失败直接抛给调用方。
 *
 * 单源失败不阻塞智能匹配：失败原因拼进 `state.partialError` 弱提示，**只有全部源都失败**
 * 才返回错误文案。
 *
 * @returns 错误文案（null = 成功）
 */
export async function searchTagCandidates(): Promise<string | null> {
  const target = state.target;
  if (!target) return t("musicTag.searchFailed");
  const keyword = state.keyword.trim() || state.fields.title.trim();
  state.searching = true;
  state.error = "";
  state.partialError = "";

  try {
    if (state.mode === "smart") {
      const outcomes = await searchAllMusicTagSources(keyword);
      const merged = outcomes.flatMap((outcome) => outcome.results);
      const failed = outcomes.filter((outcome) => outcome.error);
      if (!merged.length) {
        state.results = [];
        // 全部源都失败 → 返回错误文案（并把明细留在 partialError 里）；
        // 只是没搜到（没有源报错）→ 空结果，由 UI 提示「没有找到候选」。
        if (failed.length && failed.length === outcomes.length) {
          state.partialError = `${t("musicTag.partialFailed")}：${failed
            .map((outcome) => outcome.source)
            .join(" / ")}`;
          return t("musicTag.smartEmpty");
        }
        return null;
      }
      const seed = {
        title: state.fields.title || keyword,
        artist: state.fields.artist,
        album: state.fields.album,
      };
      state.results = smartTagRank(seed, merged).slice(0, SMART_RESULT_LIMIT);
      if (failed.length) {
        state.partialError = `${t("musicTag.partialFailed")}：${failed
          .map((outcome) => outcome.source)
          .join(" / ")}`;
      }
      return null;
    }

    state.results = await searchMusicTagSource(state.mode, keyword);
    return null;
  } catch (e) {
    state.results = [];
    return friendly(e) || t("musicTag.searchFailed");
  } finally {
    state.searching = false;
  }
}

/**
 * 点击候选：填充 title / artist / album / year 四项。
 *
 * 只覆盖这四项——用户在候选列表里换来换去时，不该把已经手动填好的
 * 音轨号 / 流派 / 备注 / 歌词冲掉（歌词另有「拉歌词」按钮单独写）。
 */
export function pickSearchResult(result: MusicTagSearchResult): void {
  const patch = fieldsFromSearchResult(result);
  state.fields = {
    ...state.fields,
    title: patch.title || state.fields.title,
    artist: patch.artist || state.fields.artist,
    album: patch.album || state.fields.album,
    year: patch.year || state.fields.year,
  };
  state.notice = "";
  // 候选封面：立即下载预览；失败则保留原封面
  const coverUrl = coverUrlOf(result);
  if (coverUrl) {
    state.coverMode = "keep";
    void fetchCoverAsBase64(coverUrl).then((cover) => {
      if (!cover) return;
      state.coverPreview = toDataUrl(cover);
      state.coverMode = "set";
    });
  }
}

/**
 * 候选的封面 URL。
 *
 * QQ 的搜索接口不直接给封面，只回 album mid（存在 `coverKey`），
 * 按平台的图床规则拼一张 300×300 的专辑图；其余源直接用 `coverUrl`。
 */
export function coverUrlOf(result: MusicTagSearchResult): string {
  if (result.coverUrl) return result.coverUrl;
  if (result.source === "qq" && result.coverKey) {
    return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${result.coverKey}.jpg`;
  }
  return "";
}

/** 拉取选中候选的歌词（逐行 LRC，最省事的接口） */
export async function fetchLyricsForResult(result: MusicTagSearchResult): Promise<string | null> {
  state.fetchingLyrics = true;
  state.error = "";
  try {
    const lrc = await fetchTagLyrics(result);
    if (!lrc) return t("musicTag.noResults");
    state.fields.lyrics = lrc;
    state.lyricsFromApi = true;
    // 普通接口给的是逐行 LRC，清掉上一次的逐字标记
    state.lyricsWordLevel = false;
    return null;
  } catch (e) {
    return friendly(e) || t("musicTag.searchFailed");
  } finally {
    state.fetchingLyrics = false;
  }
}

/** 当前目标用于逐字匹配的标题/艺人/时长（在线取曲目自带的，本地取列表项带的） */
function wordLyricsMeta(): { title: string; artist?: string; durationMs?: number } {
  const target = state.target;
  const title = state.fields.title.trim() || target?.label?.trim() || "";
  if (target?.kind === "online") {
    return {
      title,
      artist: state.fields.artist || target.song.artist || undefined,
      durationMs: target.song.durationMs || undefined,
    };
  }
  if (target?.kind === "local") {
    return {
      title,
      artist: state.fields.artist || target.artist || undefined,
      durationMs: target.durationMs ?? undefined,
    };
  }
  return { title };
}

/**
 * 取**逐字**歌词并填进表单（对话框顶部的「逐字歌词」按钮）。
 *
 * 与「拉歌词」的区别：这条走**逐字**链路（按候选取 QRC/KRC/yrc，或按歌名+时长走
 * AMLL → QQ → 酷狗 回退链），取到的文本是增强型 LRC（带 `<mm:ss.xx>` 词级标记）。
 *
 * @param result 可选：用户点的是某条候选的「逐字」按钮；缺省按歌名+时长走回退链
 */
export async function fetchWordLyrics(result?: MusicTagSearchResult): Promise<string | null> {
  state.fetchingWordLyrics = true;
  state.error = "";
  try {
    // 1) 按候选取（用户明确选了某一条）
    if (result) {
      const byCandidate = await fetchWordLyricsForCandidate(result);
      if (byCandidate?.lines.length) {
        state.fields.lyrics = toTagLyricsText(byCandidate.lines, byCandidate.wordLevel);
        state.lyricsFromApi = true;
        state.lyricsWordLevel = byCandidate.wordLevel;
        return null;
      }
      // 候选没有富歌词（咪咕/酷我）：退普通接口，别让用户白点
      const plain = await fetchTagLyrics(result);
      if (!plain) return t("musicTag.noResults");
      state.fields.lyrics = plain;
      state.lyricsFromApi = true;
      state.lyricsWordLevel = false;
      return null;
    }

    // 2) 按歌名 + 时长走 preciseLyrics 回退链（AMLL → QQ → 酷狗）
    const auto = await fetchWordLyricsByMeta(wordLyricsMeta());
    if (auto?.hit.lines.length) {
      state.fields.lyrics = toTagLyricsText(auto.hit.lines, auto.wordLevel);
      state.lyricsFromApi = true;
      state.lyricsWordLevel = auto.wordLevel;
      return null;
    }

    // 3) 回退链没命中：若当前搜索已有候选，用首条候选再试一次
    const first = state.results[0];
    if (first) return fetchWordLyrics(first);
    return t("musicTag.wordLyricsEmpty");
  } catch (e) {
    return friendly(e) || t("musicTag.searchFailed");
  } finally {
    state.fetchingWordLyrics = false;
  }
}

function toDataUrl(cover: MusicTagCover): string {
  if (cover.base64.startsWith("data:")) return cover.base64;
  return `data:${cover.mimeType || "image/jpeg"};base64,${cover.base64}`;
}

/**
 * 打开文件选择器挑封面并读成 dataURL（`>5MB` 用 coverTooLarge 拒绝）。
 * @returns 错误文案（null = 成功或用户取消）
 */
export async function chooseCoverFile(): Promise<string | null> {
  const picked = await dialogOpen({
    multiple: false,
    filters: [{ name: t("musicTag.cover"), extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
  });
  const path = typeof picked === "string" ? picked : null;
  if (!path) return null;
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;
  if (bytes.byteLength > COVER_MAX_BYTES) return t("musicTag.coverTooLarge");
  const mimeType = mimeOfPath(path);
  state.coverPreview = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  state.coverMode = "set";
  return null;
}

export function removeCover(): void {
  state.coverPreview = null;
  state.coverMode = "remove";
}

export function keepCover(): void {
  state.coverPreview = null;
  state.coverMode = "keep";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === "function" ? btoa(binary) : "";
}

function mimeOfPath(path: string): string {
  const ext = path.toLowerCase().replace(/^.*\./, "");
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/** 当前封面处理方式（有预览图即为 set） */
function effectiveCoverMode(): MusicTagCoverMode {
  if (state.coverPreview) return "set";
  return state.coverMode;
}

/** 组装封面参数（给 capabilities） */
function coverPayload(): { mode: MusicTagCoverMode; image?: MusicTagCover } | undefined {
  const mode = effectiveCoverMode();
  if (mode !== "set" || !state.coverPreview) return { mode };
  const comma = state.coverPreview.indexOf(",");
  const header = comma >= 0 ? state.coverPreview.slice(0, comma) : "";
  const base64 = comma >= 0 ? state.coverPreview.slice(comma + 1) : state.coverPreview;
  const mimeType = /:(.*?);/.exec(header)?.[1] ?? "image/jpeg";
  return { mode: "set", image: { base64, mimeType } };
}

/**
 * 应用当前表单。
 * - 本地：首次备份写入前标签 → 写文件 → 刷新库元数据；
 * - 在线：写内存 + 磁盘缓存 + 广播刷新播放器。
 */
export async function applyTagDialog(): Promise<{ ok: boolean; error?: string }> {
  const target = state.target;
  if (!target) return { ok: false, error: t("musicTag.applyFailed") };
  state.applying = true;
  state.error = "";
  try {
    if (target.kind === "local") {
      // 备份只建一次：保留最原始的「写入前」快照，之后的覆盖不冲掉它
      await capabilities.backupLocalMusicTags(target.path, state.original);
      await capabilities.writeLocalMusicTags(target.path, { ...state.fields }, coverPayload());
      await syncLocalEntry(target, state.fields, effectiveCoverMode());
      state.notice = t("musicTag.applied");
      // 已经写过一次，磁盘上必然有备份；后续「还原默认」按备份语义走
      state.hasLocalBackup = true;
    } else {
      const tags = useMusicTagsStore();
      await tags.apply(target.song, { ...state.fields }, coverPayload());
      // 旁路歌词：player 读它覆盖平台歌词；空串 = 清空
      await capabilities.writeOnlineMusicTagLyrics(tags.keyOf(target.song), state.fields.lyrics);
      broadcastMusicTagUpdated("online", target.song.id);
      await refreshPlayer();
      state.notice = t("musicTag.onlineCached");
    }
    state.original = { ...state.fields };
    return { ok: true };
  } catch (e) {
    const message = friendly(e) || t("musicTag.applyFailed");
    state.error = message;
    return { ok: false, error: message };
  } finally {
    state.applying = false;
  }
}

/**
 * 还原默认，三种语义：
 * - `online`：删在线缓存 + 清旁路歌词，回到平台原始数据；
 * - `backup`：本地存在「写入前备份」→ 立即把备份写回文件；
 * - `original`：本地无备份 → 表单回滚到打开时的快照，不写盘。
 */
export async function resetTagDialog(): Promise<{
  ok: boolean;
  mode: MusicTagResetMode;
  error?: string;
}> {
  const target = state.target;
  if (!target) return { ok: false, mode: "original", error: t("musicTag.resetFailed") };

  if (target.kind === "online") {
    state.applying = true;
    state.error = "";
    try {
      const tags = useMusicTagsStore();
      await tags.clear(target.song);
      await capabilities.writeOnlineMusicTagLyrics(tags.keyOf(target.song), "");
      broadcastMusicTagUpdated("online", target.song.id);
      await refreshPlayer();
      state.visible = false;
      return { ok: true, mode: "online" };
    } catch (e) {
      const message = friendly(e) || t("musicTag.resetFailed");
      state.error = message;
      return { ok: false, mode: "online", error: message };
    } finally {
      state.applying = false;
    }
  }

  // 本地：有备份 → 回滚文件；无备份 → 只回滚表单
  if (!state.hasLocalBackup) {
    state.fields = { ...state.original };
    state.coverPreview = null;
    state.coverMode = "keep";
    state.notice = t("musicTag.resetLocalOriginal");
    return { ok: true, mode: "original" };
  }

  state.applying = true;
  state.error = "";
  try {
    // 打开时只探测到「备份存在」但内容还没读出来（例如只加载了元信息）时，
    // 这里补读一次，避免把空标签写回文件。
    const backup =
      state.backup ?? (await capabilities.readLocalMusicTagsBackup(target.path)) ?? null;
    if (!backup) {
      state.applying = false;
      state.hasLocalBackup = false;
      return resetTagDialog();
    }
    await capabilities.writeLocalMusicTags(target.path, { ...backup });
    await syncLocalEntry(target, backup, "keep");
    state.fields = { ...backup };
    state.original = { ...backup };
    state.coverPreview = null;
    state.coverMode = "keep";
    state.visible = false;
    return { ok: true, mode: "backup" };
  } catch (e) {
    const message = friendly(e) || t("musicTag.resetFailed");
    state.error = message;
    return { ok: false, mode: "backup", error: message };
  } finally {
    state.applying = false;
  }
}

/**
 * 本地写盘后把「文件里的新标签」同步到 UI 与后端缓存。
 *
 * 顺序**不能颠倒**（踩过的坑）：
 * 1. `refresh("audio")` 先从 DB 拉一次列表——后端 `get_metadata` 优先读 SQLite
 *    的 media_metadata 缓存，这次拉到的**仍是旧标签**；
 * 2. `patchEntry` 再把这一条覆盖成刚写入的字段，用户立刻看到新值；
 * 3. `getMetadata` 顺带让「缓存缺失」的条目真正解析一次文件；
 * 4. `startScan()` 后台整库重扫，把 SQLite 补正成与新文件一致（否则下次启动
 *    或播放器 `getSong` 又是旧标签）。扫描是异步的，期间列表保持乐观值。
 */
async function syncLocalEntry(
  target: Extract<MusicTagTarget, { kind: "local" }>,
  fields: MusicTagFields,
  coverMode: MusicTagCoverMode,
): Promise<void> {
  const library = useLibraryStore();
  const fileId = (await capabilities.musicTagFileId(target.path)) ?? target.fileId;

  await library.refresh("audio");

  // 只放明确要改的键：封面 mode 为 keep 时不带 hasCover，保持列表原值
  const patch: Partial<MediaEntry> = {
    title: fields.title || null,
    artist: fields.artist || null,
    album: fields.album || null,
  };
  if (coverMode === "remove") patch.hasCover = false;
  else if (coverMode === "set") patch.hasCover = true;
  library.patchEntry(fileId, patch);

  await capabilities.getMetadata(fileId).catch(() => undefined);
  broadcastMusicTagUpdated("local", fileId);
  void library.startScan();
}

/** 通知播放器刷新（player 只读不改；导入失败静默） */
async function refreshPlayer(): Promise<void> {
  try {
    const player = usePlayerStore();
    if (typeof player.refreshTagOverrides === "function") await player.refreshTagOverrides();
  } catch {
    /* 播放器未就绪时靠事件兜底 */
  }
}

/**
 * 关闭对话框。
 *
 * 这里**不**清 `target`：面板还有 200ms 的收起动画，过早清空会让标题在动画里
 * 先消失。下次 `openMusicTagDialog` 会整体覆写它，留着没有副作用。
 */
export function closeMusicTagDialog(): void {
  state.visible = false;
  state.results = [];
  state.error = "";
}

/** 当前草稿与打开时快照是否有差异（UI 用来置灰「应用」） */
export function isTagDialogDirty(): boolean {
  return fieldsDirty(state.fields, state.original);
}

export function useMusicTagDialog(): MusicTagDialogState {
  return state;
}
