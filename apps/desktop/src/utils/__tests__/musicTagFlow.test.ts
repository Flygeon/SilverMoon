// @vitest-environment jsdom
/**
 * 「写音乐标签」端到端流程回归（纯渲染层逻辑，不依赖 Electron / taglib-wasm）。
 *
 * 为什么要独立于实现者的自测：T1/T2/T3/T4 各自的单测只覆盖自己那一层，
 * 真正容易出事的是**跨层调用顺序**与**「还原默认」的最终落盘值**。这里用一套
 * 记录调用的假 capabilities，把「打开 → 改 → 应用 → 还原默认」整条链走完，
 * 断言调用序列与最终 fields，而不是断言中间实现细节。
 *
 * 覆盖：
 * 1. 搜索候选 → fieldsFromSearchResult → 手动编辑 → fieldsDirty；
 * 2. 在线：apply → playbackOverride 拿到覆盖 → clear → 回退平台原值；
 * 3. 本地：readLocal → backupLocal → writeLocal → reset(有备份) → 最终 = 备份；
 * 4. 本地无备份：reset 只回滚表单、绝不写盘；
 * 5. T5 回归：本地写盘后 patchEntry 收到新字段 + 触发后台重扫（顺序 refresh → patch → scan）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppliedOnlineTags, MusicTagFields, OnlineSong } from "@shared/types";

/** 用 hoisted 状态承载 mock 与被测代码共享的可观测记录（vi.mock 会被提升到顶部）。 */
const h = vi.hoisted(() => {
  const calls: { op: string; payload: Record<string, unknown> }[] = [];
  const localTags = new Map<string, MusicTagFields>();
  const localBackups = new Map<string, MusicTagFields>();
  const onlineTags = new Map<string, AppliedOnlineTags>();
  const onlineLyrics = new Map<string, string>();
  /** 库 store 的调用顺序与内容（断言 T5 的 refresh → patchEntry → startScan） */
  const libraryEvents: string[] = [];
  const patched: { fileId: string; patch: Record<string, unknown> }[] = [];
  const refreshed: string[] = [];
  let scans = 0;
  const playerRefreshes: number[] = [];
  /** 候选样本：字段与 musicTagSources 归一化后的形状一致 */
  const candidate = {
    source: "kugou" as const,
    songId: "123456",
    title: "夜曲",
    artist: "周杰伦",
    album: "十一月的萧邦",
    year: "2005",
    coverUrl: "",
  };
  return {
    calls,
    candidate,
    localTags,
    localBackups,
    onlineTags,
    onlineLyrics,
    libraryEvents,
    patched,
    refreshed,
    scans: {
      get value() {
        return scans;
      },
    },
    bumpScan() {
      scans += 1;
    },
    playerRefreshes,
  };
});

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

vi.mock("@/utils/musicTagSources", () => ({
  MUSIC_TAG_SOURCES: ["qq", "netease", "kugou", "migu", "kuwo"],
  musicTagSourceLabelKey: (source: string) => `musicTag.source${source}`,
  // 单源：返回候选样本
  searchMusicTagSource: vi.fn(async () => [h.candidate]),
  // 智能匹配：只有一个源有结果，另一个源报错（覆盖「部分失败」路径）
  searchAllMusicTagSources: vi.fn(async () => [
    { source: "kugou", results: [h.candidate] },
    { source: "kuwo", results: [], error: "HTTP 503" },
  ]),
  // 排序：真实实现是按分数排序，这里样本只有一条，等价于原样返回
  smartTagRank: vi.fn((_seed: unknown, results: unknown[]) => results),
  fetchTagLyrics: vi.fn(async () => "[00:01.00]一群嗜血的蚂蚁"),
  fetchCoverAsBase64: vi.fn(async () => null),
}));

vi.mock("@/stores/library", () => ({
  useLibraryStore: () => ({
    refresh: async (type: string) => {
      h.libraryEvents.push("refresh");
      h.refreshed.push(type);
    },
    patchEntry: (fileId: string, patch: Record<string, unknown>) => {
      h.libraryEvents.push("patchEntry");
      h.patched.push({ fileId, patch });
    },
    startScan: () => {
      h.libraryEvents.push("startScan");
      h.bumpScan();
    },
  }),
}));

vi.mock("@/stores/player", () => ({
  usePlayerStore: () => ({
    refreshTagOverrides: async () => {
      h.playerRefreshes.push(1);
    },
  }),
}));

vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ lang: "zh" }),
}));

vi.mock("@/ipc/dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@/ipc/fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));
vi.mock("@/ipc/http", () => ({ fetch: vi.fn() }));
vi.mock("@/ipc/invoke", () => ({
  toAssetUrl: (p: string) => `asset://localhost/${p.replace(/^\//, "")}`,
}));

vi.mock("@/capabilities", () => ({
  isDesktop: true,
  capabilities: {
    // ---- 本地 ----
    readLocalMusicTags: async (p: string) => {
      h.calls.push({ op: "readLocal", payload: { path: p } });
      const v = h.localTags.get(p);
      return { fields: v ? { ...v } : emptyFields(), hasCover: !!v };
    },
    backupLocalMusicTags: async (p: string, fields: MusicTagFields) => {
      h.calls.push({ op: "backupLocal", payload: { path: p, fields: { ...fields } } });
      if (h.localBackups.has(p)) return false;
      h.localBackups.set(p, { ...fields });
      return true;
    },
    readLocalMusicTagsBackup: async (p: string) => {
      h.calls.push({ op: "readLocalBackup", payload: { path: p } });
      const v = h.localBackups.get(p);
      return v ? { ...v } : null;
    },
    writeLocalMusicTags: async (p: string, fields: MusicTagFields) => {
      h.calls.push({ op: "writeLocal", payload: { path: p, fields: { ...fields } } });
      h.localTags.set(p, { ...fields });
    },
    musicTagFileId: async (p: string) => {
      h.calls.push({ op: "musicTagFileId", payload: { path: p } });
      return "file-1";
    },
    getMetadata: async (fileId: string) => {
      h.calls.push({ op: "getMetadata", payload: { fileId } });
      return {};
    },
    // ---- 在线 ----
    cacheOnlineMusicTags: async (
      key: string,
      fields: MusicTagFields,
      cover?: { mode: string; image?: { base64: string; mimeType: string } },
    ) => {
      const prev = h.onlineTags.get(key);
      const entry: AppliedOnlineTags = {
        key,
        fields: { ...fields },
        // 与主进程一致：只保留首次覆盖前的平台快照
        original: prev?.original ?? { ...emptyFields(), title: "平台原曲", artist: "平台歌手" },
        coverPath: cover?.mode === "set" && cover.image ? `/cache/covers/cover-${key}.jpg` : null,
        cachedAt: 1,
      };
      h.onlineTags.set(key, entry);
      return { ...entry };
    },
    readOnlineMusicTags: async (key: string) => h.onlineTags.get(key) ?? null,
    removeOnlineMusicTags: async (key: string) => {
      h.calls.push({ op: "removeOnline", payload: { key } });
      // 延后一个宏任务再删：调用方若忘了 `await`，断言时缓存还在（真实主进程是 IPC + 磁盘写，
      // 同样不是同步完成的）。这样这条用例才能真正校验 clear() 的等待语义。
      await new Promise((resolve) => setTimeout(resolve, 0));
      return h.onlineTags.delete(key);
    },
    listOnlineMusicTags: async () => [...h.onlineTags.values()],
    writeOnlineMusicTagLyrics: async (key: string, lyrics: string) => {
      h.calls.push({ op: "writeLyrics", payload: { key, lyrics } });
      if (lyrics) h.onlineLyrics.set(key, lyrics);
      else h.onlineLyrics.delete(key);
    },
    readOnlineMusicTagLyrics: async (key: string) => h.onlineLyrics.get(key) ?? null,
    readOnlineMusicTagOriginal: async (key: string) => h.onlineTags.get(key)?.original ?? null,
    cacheOnlineMusicTagOriginal: async () => {},
    listFiles: async () => [],
  },
}));

import {
  applyTagDialog,
  openMusicTagDialog,
  pickSearchResult,
  resetTagDialog,
  searchTagCandidates,
  useMusicTagDialog,
} from "@/composables/useMusicTagDialog";
import { useMusicTagsStore } from "@/stores/musicTags";
import { emptyMusicTagFields, fieldsDirty, fieldsFromSearchResult } from "@/utils/musicTagDraft";
import { translate } from "@shared/i18n";

/** 等若干轮微任务 + 一个宏任务，让 open 内部的异步装载跑完 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function ops(): string[] {
  return h.calls.map((c) => c.op);
}

const ONLINE_SONG: OnlineSong = {
  id: "9",
  server: "netease",
  name: "平台原曲",
  artist: "平台歌手",
  url: "",
  pic: "",
  lrc: "",
};

beforeEach(() => {
  setActivePinia(createPinia());
  h.calls.length = 0;
  h.localTags.clear();
  h.localBackups.clear();
  h.onlineTags.clear();
  h.onlineLyrics.clear();
  h.libraryEvents.length = 0;
  h.patched.length = 0;
  h.refreshed.length = 0;
  h.playerRefreshes.length = 0;
  // scans 通过 bumpScan 累加，跨用例断言只看增量，这里用一个新 pinia 无法重置，
  // 因此断言时不比较绝对值，只比较「本用例内是否发生」。
});

describe("① 搜索 → 草稿 → 手动编辑 → dirty", () => {
  it("候选填充四项、手动补充其余字段，dirty 判定随之翻转", async () => {
    openMusicTagDialog({ kind: "online", song: ONLINE_SONG, label: ONLINE_SONG.name });
    await settle();
    const state = useMusicTagDialog();
    const original = { ...state.original };

    // 打开后未改动 → 不 dirty
    expect(fieldsDirty(state.fields, original)).toBe(false);

    state.keyword = "夜曲";
    expect(await searchTagCandidates()).toBeNull();
    expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({ songId: "123456", title: "夜曲", year: "2005" });

    pickSearchResult(state.results[0]);
    expect(state.fields).toMatchObject({
      title: "夜曲",
      artist: "周杰伦",
      album: "十一月的萧邦",
      year: "2005",
    });

    // 候选 → fieldsFromSearchResult 的纯函数结果应与手动 pick 一致（同源）
    expect(fieldsFromSearchResult(state.results[0])).toMatchObject({
      title: "夜曲",
      artist: "周杰伦",
      album: "十一月的萧邦",
      year: "2005",
    });

    // 候选不覆盖用户手工字段：先手填音轨号，再换一个候选
    state.fields.trackNo = "3/12";
    pickSearchResult({ ...state.results[0], title: "夜曲（Live）" });
    expect(state.fields.trackNo).toBe("3/12");

    expect(fieldsDirty(state.fields, original)).toBe(true);
    // 空值兜底：emptyMusicTagFields 的 10 个键齐全
    expect(Object.keys(emptyMusicTagFields())).toHaveLength(10);
  });
});

describe("② 在线：apply → playbackOverride → clear", () => {
  it("应用后内存覆盖生效，playbackOverride 返回覆盖值；clear 后回到平台原值", async () => {
    openMusicTagDialog({ kind: "online", song: ONLINE_SONG, label: ONLINE_SONG.name });
    await settle();
    const state = useMusicTagDialog();
    const tags = useMusicTagsStore();

    state.fields.title = "我的标题";
    state.fields.artist = "我的歌手";
    state.fields.album = "我的专辑";
    state.fields.lyrics = "[00:01.00]我的词";

    const applied = await applyTagDialog();
    expect(applied.ok).toBe(true);
    expect(h.onlineTags.get("netease:9")?.fields.title).toBe("我的标题");
    expect(h.onlineLyrics.get("netease:9")).toBe("[00:01.00]我的词");

    // 播放器读到的覆盖
    expect(tags.playbackOverride(ONLINE_SONG)).toMatchObject({
      title: "我的标题",
      artist: "我的歌手",
      album: "我的专辑",
    });
    // 首次覆盖前的平台快照被保留（还原默认要用）
    expect(h.onlineTags.get("netease:9")?.original?.title).toBe("平台原曲");
    expect(h.playerRefreshes.length).toBeGreaterThan(0);

    h.calls.length = 0;
    const reset = await resetTagDialog();
    expect(reset).toEqual({ ok: true, mode: "online" });
    expect(h.onlineTags.has("netease:9")).toBe(false);
    expect(h.onlineLyrics.has("netease:9")).toBe(false);
    // 内存与磁盘都清掉，覆盖链回退到平台原值
    expect(tags.get(ONLINE_SONG)).toBeUndefined();
    expect(tags.playbackOverride(ONLINE_SONG)).toBeUndefined();
    expect(ops()).toEqual(["removeOnline", "writeLyrics"]);
    // 旁路歌词被清空
    expect(h.calls.find((c) => c.op === "writeLyrics")?.payload.lyrics).toBe("");
  });

  it("coverPath 存在时 playbackOverride 拼出 asset:// 封面", async () => {
    const tags = useMusicTagsStore();
    h.onlineTags.set("netease:9", {
      key: "netease:9",
      fields: { ...emptyFields(), title: "带封面" },
      original: null,
      coverPath: "/cache/covers/cover-9.jpg",
      cachedAt: 1,
    });
    const hit = await tags.resolve(ONLINE_SONG);
    expect(hit?.coverPath).toBe("/cache/covers/cover-9.jpg");
    expect(tags.playbackOverride(ONLINE_SONG)?.coverUrl).toBe(
      "asset://localhost/cache/covers/cover-9.jpg",
    );
  });

  it("apply 后广播 silvermoon:music-tag-updated（在线 kind=online）", async () => {
    const seen: { kind: string; id: string }[] = [];
    const onEvt = (e: Event) => {
      const d = (e as CustomEvent<{ kind: string; id: string }>).detail;
      seen.push(d);
    };
    window.addEventListener("silvermoon:music-tag-updated", onEvt);
    try {
      openMusicTagDialog({ kind: "online", song: ONLINE_SONG, label: ONLINE_SONG.name });
      await settle();
      await applyTagDialog();
      expect(seen).toContainEqual({ kind: "online", id: "9" });
    } finally {
      window.removeEventListener("silvermoon:music-tag-updated", onEvt);
    }
  });
});

describe("③ 本地：打开 → 改 → 应用 → 还原默认（有备份）", () => {
  it("写盘序列正确，且「还原默认」最终 fields 等于写入前备份", async () => {
    const filePath = "/m/夜曲.flac";
    const ORIGINAL: MusicTagFields = {
      ...emptyFields(),
      title: "写入前标题",
      artist: "写入前歌手",
      lyrics: "写入前歌词",
    };
    h.localTags.set(filePath, { ...ORIGINAL });

    openMusicTagDialog({ kind: "local", fileId: "f1", path: filePath, label: "夜曲" });
    await settle();
    const state = useMusicTagDialog();
    // 打开时读文件真实标签（非空的文件标签覆盖库内列表项）
    expect(state.fields.title).toBe("写入前标题");

    state.fields.title = "新标题";
    state.fields.artist = "新歌手";
    state.fields.album = "新专辑";

    h.calls.length = 0;
    h.libraryEvents.length = 0;
    const applied = await applyTagDialog();
    expect(applied.ok).toBe(true);
    expect(state.error).toBe("");

    // 关键序列：先备份（用打开时的原始值）→ 再写盘
    const seq = ops();
    expect(seq.indexOf("backupLocal")).toBeGreaterThan(-1);
    expect(seq.indexOf("writeLocal")).toBeGreaterThan(-1);
    expect(seq.indexOf("backupLocal")).toBeLessThan(seq.indexOf("writeLocal"));
    const backupCall = h.calls.find((c) => c.op === "backupLocal")!;
    expect((backupCall.payload.fields as MusicTagFields).title).toBe("写入前标题");
    expect(h.localBackups.get(filePath)?.title).toBe("写入前标题");

    // 文件已写入新值
    expect(h.localTags.get(filePath)?.title).toBe("新标题");
    expect(h.localTags.get(filePath)?.album).toBe("新专辑");

    // T5 回归：乐观更新 + 后台重扫，顺序必须是 refresh → patchEntry → startScan
    expect(h.libraryEvents).toEqual(["refresh", "patchEntry", "startScan"]);
    expect(h.refreshed).toContain("audio");
    expect(h.patched[0]?.fileId).toBe("file-1");
    expect(h.patched[0]?.patch).toMatchObject({
      title: "新标题",
      artist: "新歌手",
      album: "新专辑",
    });
    // hasCover 在 coverMode=keep 时不应被写成 undefined 之外的显式值
    expect("hasCover" in h.patched[0]!.patch).toBe(false);

    // ---- 还原默认（有备份）----
    h.calls.length = 0;
    h.libraryEvents.length = 0;
    h.patched.length = 0;
    const reset = await resetTagDialog();
    expect(reset).toEqual({ ok: true, mode: "backup" });

    // 备份被写回文件：最终 fields 必须等于写入前备份
    const finalWritten = h.localTags.get(filePath)!;
    expect(finalWritten).toEqual(ORIGINAL);
    expect(state.fields).toEqual(ORIGINAL);
    // 还原也要走乐观更新 + 重扫
    expect(h.libraryEvents).toEqual(["refresh", "patchEntry", "startScan"]);
    expect(h.patched[0]?.patch).toMatchObject({ title: "写入前标题", artist: "写入前歌手" });
    // 「还原默认」不应新建备份（备份只在首次写入时创建）
    expect(ops().some((op) => op === "backupLocal")).toBe(false);
  });
});

describe("④ 本地无备份：还原默认只回滚表单", () => {
  it("不写盘、不刷新库，仅把 fields 退回打开时快照", async () => {
    const filePath = "/m/无备份.mp3";
    h.localTags.set(filePath, { ...emptyFields(), title: "文件里的标题" });

    openMusicTagDialog({ kind: "local", fileId: "f2", path: filePath, label: "无备份" });
    await settle();
    const state = useMusicTagDialog();
    state.fields.title = "乱改的标题";
    state.fields.artist = "乱改的歌手";

    h.calls.length = 0;
    h.libraryEvents.length = 0;
    const reset = await resetTagDialog();

    // 这组断言是「本地无备份」分支的**直接**判据：一条失败即可定位，
    // 不依赖 worker 超时（把该分支置为死代码会让 reset 无限递归 → 挂起，
    // 那是被测代码的病态行为，任何调用它的用例都拦不住）。
    expect(reset).toEqual({ ok: true, mode: "original" });
    // 表单回到打开时快照（不是编辑值，也不是空值）
    expect(state.fields).toEqual(state.original);
    expect(state.fields.title).toBe("文件里的标题");
    expect(state.fields.artist).toBe("");
    // 设置 store 的 lang mock 为 zh；文案取自冻结的 i18n 键
    expect(state.notice).toBe(translate("zh", "musicTag.resetLocalOriginal"));
    // 全程零 capabilities 调用（读/写/备份/刷新都不该发生）
    expect(ops()).toEqual([]);
    expect(h.localBackups.has(filePath)).toBe(false);
    expect(h.libraryEvents).toEqual([]);
    // 文件内容原样未动
    expect(h.localTags.get(filePath)?.title).toBe("文件里的标题");
    // 无备份语义下不关窗（用户可能接着改）
    expect(state.visible).toBe(true);
  });
});

describe("⑤ player.ts 集成顺序（只读源码断言）", () => {
  const playerSrc = readFileSync(path.join(process.cwd(), "src/stores/player.ts"), "utf8");

  it("loadOnlineSong 必须在 song.value 赋值前调用 applyTagOverride", () => {
    const start = playerSrc.indexOf("async function loadOnlineSong(");
    expect(start).toBeGreaterThan(-1);
    const body = playerSrc.slice(start, start + 4000);
    const overrideAt = body.indexOf("await applyTagOverride(item)");
    const assignAt = body.indexOf("song.value = {");
    expect(overrideAt).toBeGreaterThan(-1);
    expect(assignAt).toBeGreaterThan(-1);
    // 顺序错了覆盖就不生效（赋值后再算出来的 overridden 已经用不上）
    expect(overrideAt).toBeLessThan(assignAt);
  });

  it("导出了 refreshTagOverrides，并监听 music-tag-updated 事件", () => {
    expect(playerSrc).toMatch(/async function refreshTagOverrides\(/);
    expect(playerSrc).toMatch(/refreshTagOverrides,\s*$/m);
    expect(playerSrc).toContain("silvermoon:music-tag-updated");
    expect(playerSrc).toMatch(/addEventListener\(\s*\n?\s*"silvermoon:music-tag-updated"/);
  });
});
