/**
 * 「本地音乐写标签报 An object could not be cloned」的端到端回归。
 *
 * 复现用户路径：打开本地歌曲的写标签对话框 → 点「应用」→
 *   backupLocalMusicTags(path, state.original)  ← 这里把响应式 Proxy 传过桥
 *   writeLocalMusicTags(path, {...state.fields}, cover)
 *
 * 本测试用**真实**的 callBridge（只打桩 window.__SILVERMOON__，并在桥里执行
 * structuredClone 模拟 ipcRenderer.invoke 的克隆语义），断言不再抛 DataCloneError，
 * 且写盘收到的是正确的纯数据。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

/** 过桥记录：op → payload（已断言可被结构化克隆） */
const calls: { op: string; payload: Record<string, unknown> }[] = [];
const localTags = new Map<string, unknown>();
const localBackups = new Map<string, unknown>();

vi.mock("@/capabilities", async () => {
  // 用真实 callBridge（mock 掉宿主桥），从而覆盖「Proxy 过桥」这一层
  const { callBridge } = await import("@/ipc/bridge");
  function musicTagCall<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    return callBridge<T>("musicTags", { op, ...payload });
  }
  return {
    isDesktop: true,
    capabilities: {
      writeLocalMusicTags: (path: string, fields: unknown, cover?: unknown) =>
        musicTagCall("writeLocal", { path, fields, ...(cover as object) }),
      readLocalMusicTags: (path: string) =>
        musicTagCall("readLocal", { path }).then(() => ({
          fields: localTags.get(path) ?? null,
          hasCover: false,
        })),
      backupLocalMusicTags: (path: string, fields: unknown) =>
        musicTagCall<{ created: boolean }>("backupLocal", { path, fields }).then((r) => r.created),
      readLocalMusicTagsBackup: (path: string) =>
        musicTagCall("readLocalBackup", { path }).then(() => localBackups.get(path) ?? null),
      musicTagFileId: async () => "file-1",
      getMetadata: async () => ({}),
      // 在线相关（本用例不走，但模块加载需要）
      readOnlineMusicTags: async () => null,
      removeOnlineMusicTags: async () => false,
      listOnlineMusicTags: async () => [],
      cacheOnlineMusicTags: async () => ({}),
      writeOnlineMusicTagLyrics: async () => {},
      readOnlineMusicTagLyrics: async () => null,
      readOnlineMusicTagOriginal: async () => null,
      cacheOnlineMusicTagOriginal: async () => {},
      listFiles: async () => [],
    },
  };
});

vi.mock("@/stores/library", () => ({
  useLibraryStore: () => ({
    refresh: async () => {},
    patchEntry: () => {},
    startScan: async () => {},
  }),
}));
vi.mock("@/stores/player", () => ({
  usePlayerStore: () => ({ refreshTagOverrides: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));
vi.mock("@/ipc/dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@/ipc/fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));

import {
  applyTagDialog,
  openMusicTagDialog,
  resetTagDialog,
} from "@/composables/useMusicTagDialog";

const FIELDS = {
  title: "夜曲",
  artist: "周杰伦",
  album: "十一月的萧邦",
  albumArtist: "",
  year: "",
  trackNo: "",
  discNo: "",
  genre: "",
  comment: "",
  lyrics: "[00:01.00]一群嗜血的蚂蚁",
};

function stubHostBridge(): void {
  // 保留真实的 window（jsdom 提供 dispatchEvent 等），只挂上宿主桥
  (window as unknown as { __SILVERMOON__: unknown }).__SILVERMOON__ = {
    label: "main",
    platform: "win32",
    invoke: async () => ({ ok: true, data: null }),
    invokeBatch: async () => ({ ok: true, data: [] }),
    call: async (_channel: string, payload: Record<string, unknown>) => {
      // 真实 ipcRenderer.invoke 的语义：不可克隆就抛 DataCloneError
      structuredClone(payload);
      calls.push({ op: String(payload.op), payload });
      const op = payload.op;
      const path = String(payload.path ?? "");
      if (op === "backupLocal") {
        if (!localBackups.has(path)) localBackups.set(path, { ...(payload.fields as object) });
        return { ok: true, data: { created: true } };
      }
      if (op === "writeLocal") {
        localTags.set(path, { ...(payload.fields as object) });
        return { ok: true, data: null };
      }
      if (op === "readLocal") {
        return { ok: true, data: { fields: localTags.get(path) ?? null, hasCover: false } };
      }
      if (op === "readLocalBackup") {
        return { ok: true, data: localBackups.get(path) ?? null };
      }
      return { ok: true, data: null };
    },
    emitTo: async () => undefined,
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  setActivePinia(createPinia());
  calls.length = 0;
  localTags.clear();
  localBackups.clear();
  delete (window as unknown as { __SILVERMOON__?: unknown }).__SILVERMOON__;
  stubHostBridge();
});

describe("本地写标签不再报 An object could not be cloned", () => {
  it("应用：backupLocal + writeLocal 都能过桥（loadLocalInitial 的读取也先跑一遍）", async () => {
    openMusicTagDialog({ kind: "local", fileId: "f1", path: "D:/m/夜曲.flac", label: "夜曲" });
    await settle();

    // 填表（真实场景是用户手填或从候选选，这里直接改表单）
    const { useMusicTagDialog } = await import("@/composables/useMusicTagDialog");
    Object.assign(useMusicTagDialog().fields, FIELDS);

    const r = await applyTagDialog();
    expect(r.ok, `apply failed: ${r.error}`).toBe(true);
    expect(r.error).toBeUndefined();

    const ops = calls.map((c) => c.op);
    expect(ops).toContain("backupLocal");
    expect(ops).toContain("writeLocal");
    // 写盘收到的是纯数据（不是 Proxy）
    const written = localTags.get("D:/m/夜曲.flac") as typeof FIELDS;
    expect(written.title).toBe("夜曲");
    expect(written.lyrics).toBe("[00:01.00]一群嗜血的蚂蚁");
  });

  it("还原默认：写回备份同样过桥（此路径直接传 state.backup / 读回的备份）", async () => {
    openMusicTagDialog({ kind: "local", fileId: "f1", path: "D:/m/夜曲.flac", label: "夜曲" });
    await settle();
    const { useMusicTagDialog } = await import("@/composables/useMusicTagDialog");
    Object.assign(useMusicTagDialog().fields, FIELDS);
    await applyTagDialog();

    const reset = await resetTagDialog();
    expect(reset.ok).toBe(true);
    expect(reset.mode).toBe("backup");
  });

  it("打开对话框时读文件标签 + 探测备份都不报错（读路径同样过桥）", async () => {
    openMusicTagDialog({ kind: "local", fileId: "f2", path: "D:/m/稻香.mp3", label: "稻香" });
    await settle();
    expect(calls.map((c) => c.op)).toContain("readLocal");
    expect(calls.map((c) => c.op)).toContain("readLocalBackup");
  });
});
