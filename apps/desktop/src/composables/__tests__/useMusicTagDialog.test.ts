/**
 * 渲染层「写音乐标签」流程自测（不依赖 Electron / taglib）。
 *
 * 直接驱动 `useMusicTagDialog` 导出的业务函数，断言三种「还原默认」语义与
 * 「应用」的调用序列——这是组件模板之外唯一能回归这条链路的地方。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AppliedOnlineTags, MusicTagFields, MusicTagSearchResult } from "@shared/types";

const h = vi.hoisted(() => {
  const calls: { op: string; payload: Record<string, unknown> }[] = [];
  const localTags = new Map<string, MusicTagFields>();
  const localBackups = new Map<string, MusicTagFields>();
  const onlineTags = new Map<string, AppliedOnlineTags>();
  const onlineLyrics = new Map<string, string>();
  return { calls, localTags, localBackups, onlineTags, onlineLyrics };
});

// 本地聚合五源：单源结果与「全部源 outcome」都从这里来，
// 便于断言智能模式确实做了多源合并 + smartTagRank。
const SOURCE_FIXTURES: Record<string, MusicTagSearchResult> = {
  netease: {
    source: "netease",
    songId: "42",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    year: "2003",
    coverUrl: "",
  },
  qq: {
    source: "qq",
    songId: "qq-1",
    title: "晴天 (Live)",
    artist: "周杰伦",
    album: "演唱会",
    year: "",
    coverUrl: "",
    coverKey: "002albumMid",
  },
};

vi.mock("@/utils/musicTagSources", () => ({
  MUSIC_TAG_SOURCES: ["qq", "netease", "kugou", "migu", "kuwo"],
  searchMusicTagSource: vi.fn(async (source: string) => {
    h.calls.push({ op: "searchSource", payload: { source } });
    const hit = SOURCE_FIXTURES[source];
    return hit ? [hit] : [];
  }),
  searchAllMusicTagSources: vi.fn(async () => {
    h.calls.push({ op: "searchAll", payload: {} });
    return [
      { source: "netease", results: [SOURCE_FIXTURES.netease] },
      { source: "qq", results: [SOURCE_FIXTURES.qq] },
      { source: "kugou", results: [], error: "kugou 搜索超时" },
      { source: "migu", results: [] },
      { source: "kuwo", results: [] },
    ];
  }),
  // 真实实现会打分；测试里只记录被调用并原样返回（顺序无关，另有断言覆盖合并条数）
  smartTagRank: vi.fn((_seed: unknown, results: MusicTagSearchResult[]) => {
    h.calls.push({ op: "smartRank", payload: { count: results.length } });
    return results;
  }),
  fetchTagLyrics: vi.fn(async () => "[00:01.00]从前从前"),
  fetchCoverAsBase64: vi.fn(async () => null),
  musicTagSourceLabelKey: (source: string) => `musicTag.source${source}`,
}));

vi.mock("@/stores/library", () => ({
  useLibraryStore: () => ({
    refresh: async (type: string) => {
      h.calls.push({ op: "refresh", payload: { type } });
    },
    // 乐观更新：记录收到的 fileId / patch，验证「写盘后 UI 立刻变」这条链路
    patchEntry: (fileId: string, patch: Record<string, unknown>) => {
      h.calls.push({ op: "patchEntry", payload: { fileId, patch } });
    },
    startScan: async () => {
      h.calls.push({ op: "startScan", payload: {} });
    },
  }),
}));
vi.mock("@/stores/player", () => ({
  usePlayerStore: () => ({ refreshTagOverrides: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ lang: "zh" }),
}));
vi.mock("@/ipc/dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@/ipc/fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));

vi.mock("@/capabilities", () => ({
  isDesktop: true,
  capabilities: {
    readLocalMusicTags: async (path: string) => {
      h.calls.push({ op: "readLocal", payload: { path } });
      const v = h.localTags.get(path);
      return { fields: v ?? emptyFields(), hasCover: !!v };
    },
    backupLocalMusicTags: async (path: string, fields: MusicTagFields) => {
      h.calls.push({ op: "backupLocal", payload: { path, fields } });
      if (h.localBackups.has(path)) return false;
      h.localBackups.set(path, { ...fields });
      return true;
    },
    readLocalMusicTagsBackup: async (path: string) => {
      h.calls.push({ op: "readLocalBackup", payload: { path } });
      return h.localBackups.get(path) ?? null;
    },
    writeLocalMusicTags: async (path: string, fields: MusicTagFields) => {
      h.calls.push({ op: "writeLocal", payload: { path, fields } });
      h.localTags.set(path, { ...fields });
    },
    musicTagFileId: async (path: string) => {
      h.calls.push({ op: "musicTagFileId", payload: { path } });
      return "file-1";
    },
    getMetadata: async (fileId: string) => {
      h.calls.push({ op: "getMetadata", payload: { fileId } });
      return {};
    },
    cacheOnlineMusicTags: async (key: string, fields: MusicTagFields) => {
      const prev = h.onlineTags.get(key);
      const entry: AppliedOnlineTags = {
        key,
        fields: { ...fields },
        original: prev?.original ?? { ...emptyFields(), title: "平台原曲", artist: "平台歌手" },
        coverPath: null,
        cachedAt: 1,
      };
      h.onlineTags.set(key, entry);
      return { ...entry };
    },
    readOnlineMusicTags: async (key: string) => h.onlineTags.get(key) ?? null,
    removeOnlineMusicTags: async (key: string) => {
      h.calls.push({ op: "removeOnline", payload: { key } });
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

import {
  applyTagDialog,
  openMusicTagDialog,
  removeCover,
  resetTagDialog,
  coverUrlOf,
  searchTagCandidates,
  useMusicTagDialog,
} from "@/composables/useMusicTagDialog";

/** 等若干轮微任务，让 open 内部的异步装载跑完 */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("useMusicTagDialog 流程", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.calls.length = 0;
    h.localTags.clear();
    h.localBackups.clear();
    h.onlineTags.clear();
    h.onlineLyrics.clear();
  });

  it("本地：打开 → 应用（先备份再写盘）→ 还原默认回到备份", async () => {
    const path = "/m/夜曲.flac";
    h.localTags.set(path, {
      ...emptyFields(),
      title: "原始标题",
      artist: "原始歌手",
      lyrics: "原词",
    });

    openMusicTagDialog({ kind: "local", fileId: "f1", path, label: "夜曲" });
    await settle();
    const state = useMusicTagDialog();
    expect(state.fields.title).toBe("原始标题");

    state.fields.title = "新标题";
    state.fields.artist = "新歌手";
    const applied = await applyTagDialog();
    expect(applied.ok).toBe(true);

    const seq = h.calls.map((c) => c.op);
    expect(seq).toContain("backupLocal");
    expect(seq.indexOf("backupLocal")).toBeLessThan(seq.indexOf("writeLocal"));
    // 备份是「打开时」的原始值，不是应用后的值
    const backup = h.calls.find((c) => c.op === "backupLocal")!;
    expect((backup.payload.fields as MusicTagFields).title).toBe("原始标题");
    expect(h.localTags.get(path)?.title).toBe("新标题");

    // 乐观更新：写盘后立刻把新字段 patch 进列表，用户不必等整库重扫
    const patch = h.calls.find((c) => c.op === "patchEntry")!;
    expect(patch.payload.fileId).toBe("file-1");
    expect(patch.payload.patch).toMatchObject({
      title: "新标题",
      artist: "新歌手",
      album: null,
    });
    // 封面 mode 为 keep（默认）时不能把 hasCover 擦掉
    expect(patch.payload.patch).not.toHaveProperty("hasCover");
    // 顺序：refresh 先从 DB 拉旧列表，patchEntry 再覆盖成新值（反了会被旧值盖回去）
    expect(seq.indexOf("refresh")).toBeLessThan(seq.indexOf("patchEntry"));
    expect(seq).toContain("startScan");

    // 重开一次，让 hasLocalBackup 被探测到
    openMusicTagDialog({ kind: "local", fileId: "f1", path, label: "夜曲" });
    await settle();
    h.calls.length = 0;

    const reset = await resetTagDialog();
    expect(reset).toEqual({ ok: true, mode: "backup" });
    expect(h.localTags.get(path)).toMatchObject({ title: "原始标题", artist: "原始歌手" });
    // 还原同样走乐观更新 + 后台重扫
    const resetPatch = h.calls.find((c) => c.op === "patchEntry")!;
    expect(resetPatch.payload.patch).toMatchObject({ title: "原始标题", artist: "原始歌手" });
    expect(h.calls.map((c) => c.op)).toContain("startScan");
  });

  it("本地：移除封面时 patchEntry 把 hasCover 置为 false", async () => {
    const path = "/m/封面.mp3";
    h.localTags.set(path, { ...emptyFields(), title: "带封面" });

    openMusicTagDialog({ kind: "local", fileId: "f3", path, label: "封面" });
    await settle();
    const state = useMusicTagDialog();
    state.fields.title = "去掉封面";
    removeCover();
    expect(state.coverMode).toBe("remove");

    expect((await applyTagDialog()).ok).toBe(true);
    const patch = h.calls.find((c) => c.op === "patchEntry")!;
    expect(patch.payload.patch).toMatchObject({ title: "去掉封面", hasCover: false });
  });

  it("本地：无备份时「还原默认」只回滚表单，不写盘", async () => {
    const path = "/m/无备份.mp3";
    h.localTags.set(path, { ...emptyFields(), title: "文件里的标题" });

    openMusicTagDialog({ kind: "local", fileId: "f2", path, label: "无备份" });
    await settle();
    const state = useMusicTagDialog();
    state.fields.title = "乱改的标题";
    h.calls.length = 0;

    const reset = await resetTagDialog();
    expect(reset.mode).toBe("original");
    expect(h.calls.some((c) => c.op === "writeLocal")).toBe(false);
    expect(state.fields.title).toBe("文件里的标题");
  });

  it("在线：应用写缓存并落旁路歌词，还原默认清缓存并恢复平台原值", async () => {
    const song = {
      id: "9",
      server: "netease" as const,
      name: "平台原曲",
      artist: "平台歌手",
      url: "",
      pic: "",
      lrc: "",
    };
    const key = "netease:9";

    openMusicTagDialog({ kind: "online", song, label: song.name });
    await settle();
    const state = useMusicTagDialog();
    state.fields.title = "我的标题";
    state.fields.lyrics = "[00:01.00]我的词";

    const applied = await applyTagDialog();
    expect(applied.ok).toBe(true);
    expect(h.onlineTags.get(key)?.fields.title).toBe("我的标题");
    expect(h.onlineLyrics.get(key)).toBe("[00:01.00]我的词");
    // 首次覆盖前的平台标签被保留下来
    expect(h.onlineTags.get(key)?.original?.title).toBe("平台原曲");

    h.calls.length = 0;
    const reset = await resetTagDialog();
    expect(reset).toEqual({ ok: true, mode: "online" });
    expect(h.onlineTags.has(key)).toBe(false);
    expect(h.onlineLyrics.has(key)).toBe(false);
    expect(h.calls.map((c) => c.op)).toEqual(["removeOnline", "writeLyrics"]);
  });

  function openOnlineForSearch() {
    const song = {
      id: "9",
      server: "netease" as const,
      name: "平台原曲",
      artist: "",
      url: "",
      pic: "",
      lrc: "",
    };
    openMusicTagDialog({ kind: "online", song, label: song.name });
    const state = useMusicTagDialog();
    state.keyword = "晴天";
    return state;
  }

  it("智能模式：合并多源结果、走 smartTagRank，并提示失败源", async () => {
    const state = openOnlineForSearch();
    expect(state.mode).toBe("smart");

    expect(await searchTagCandidates()).toBeNull();

    // 五个源都搜了，合并后交给 smartTagRank（netease + qq 两条）
    const ops = h.calls.map((c) => c.op);
    expect(ops).toContain("searchAll");
    expect(ops).not.toContain("searchSource");
    const rank = h.calls.find((c) => c.op === "smartRank")!;
    expect(rank.payload.count).toBe(2);
    expect(state.results).toHaveLength(2);
    expect(state.results.map((r) => r.source).sort()).toEqual(["netease", "qq"]);

    // 酷狗失败但整体成功：只写弱提示，不报错
    expect(state.partialError).toContain("kugou");
  });

  it("单源模式：只搜指定源，不经过智能合并", async () => {
    const state = openOnlineForSearch();
    state.mode = "qq";

    expect(await searchTagCandidates()).toBeNull();
    const sourceCall = h.calls.find((c) => c.op === "searchSource")!;
    expect(sourceCall.payload.source).toBe("qq");
    expect(h.calls.some((c) => c.op === "searchAll")).toBe(false);
    expect(state.results).toHaveLength(1);
    expect(state.results[0].source).toBe("qq");
    expect(state.partialError).toBe("");
  });

  it("QQ 候选只有 albumMid 时补出封面 URL", () => {
    expect(coverUrlOf(SOURCE_FIXTURES.qq)).toBe(
      "https://y.gtimg.cn/music/photo_new/T002R300x300M000002albumMid.jpg",
    );
    // 已有 coverUrl 的源直接用原值
    expect(coverUrlOf(SOURCE_FIXTURES.netease)).toBe("");
  });
});
