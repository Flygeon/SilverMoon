import { describe, expect, it } from "vitest";
import {
  emptyMusicTagFields,
  fieldsDirty,
  fieldsFromMediaEntry,
  fieldsFromOnlineSong,
  fieldsFromSearchResult,
} from "../musicTagDraft";
import type { MediaEntry, MusicTagSearchResult, OnlineSong } from "@shared/types";

function mediaEntry(extra: Partial<MediaEntry> = {}): MediaEntry {
  return {
    id: "a1",
    path: "D:/Music/夜曲.flac",
    parent: "D:/Music",
    name: "夜曲.flac",
    ext: "flac",
    type: "audio",
    size: 1024,
    mtime: 0,
    scannedAt: 0,
    deleted: 0,
    hasCover: false,
    favorite: false,
    ...extra,
  };
}

function onlineSong(extra: Partial<OnlineSong> = {}): OnlineSong {
  return {
    id: "123",
    name: "稻香",
    artist: "周杰伦",
    url: "",
    pic: "",
    lrc: "",
    ...extra,
  };
}

function searchResult(extra: Partial<MusicTagSearchResult> = {}): MusicTagSearchResult {
  return {
    source: "netease",
    songId: "42",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    year: "2003",
    coverUrl: "",
    ...extra,
  };
}

describe("musicTagDraft", () => {
  it("emptyMusicTagFields 十项全空且互不共享引用", () => {
    const a = emptyMusicTagFields();
    const b = emptyMusicTagFields();
    expect(Object.keys(a)).toHaveLength(10);
    expect(Object.values(a).every((v) => v === "")).toBe(true);
    a.title = "x";
    expect(b.title).toBe("");
  });

  it("fieldsFromMediaEntry：title 优先、缺字段兜底空串、歌词继承", () => {
    const fields = fieldsFromMediaEntry(
      mediaEntry({ title: "夜曲", artist: "周杰伦", album: null }),
      "[00:01.00]歌词",
    );
    expect(fields.title).toBe("夜曲");
    expect(fields.artist).toBe("周杰伦");
    // album 为 null → 空串，而不是 "null"
    expect(fields.album).toBe("");
    expect(fields.lyrics).toBe("[00:01.00]歌词");
    expect(fields.genre).toBe("");
  });

  it("fieldsFromMediaEntry：title 缺失回退文件名", () => {
    expect(fieldsFromMediaEntry(mediaEntry({ title: null })).title).toBe("夜曲.flac");
    expect(fieldsFromMediaEntry(mediaEntry({ title: "   " })).title).toBe("夜曲.flac");
  });

  it("fieldsFromOnlineSong：摊平四项并继承歌词", () => {
    const fields = fieldsFromOnlineSong(onlineSong({ album: undefined }), "lrc");
    expect(fields.title).toBe("稻香");
    expect(fields.artist).toBe("周杰伦");
    expect(fields.album).toBe("");
    expect(fields.lyrics).toBe("lrc");
    expect(fields.year).toBe("");
  });

  it("fieldsFromSearchResult：填 title/artist/album/year，歌词留空（另拉）", () => {
    const fields = fieldsFromSearchResult(searchResult());
    expect(fields).toMatchObject({
      title: "晴天",
      artist: "周杰伦",
      album: "叶惠美",
      year: "2003",
      lyrics: "",
      trackNo: "",
    });
  });

  it("fieldsFromSearchResult：null 字段兜底空串", () => {
    const r = searchResult({ artist: undefined as unknown as string, year: "" });
    expect(fieldsFromSearchResult(r).artist).toBe("");
    expect(fieldsFromSearchResult(r).year).toBe("");
  });

  it("fieldsDirty：完全相同为 false，任一字段变化为 true", () => {
    const base = emptyMusicTagFields();
    expect(fieldsDirty(base, { ...base })).toBe(false);

    const changed = { ...base, artist: "Queen" };
    expect(fieldsDirty(base, changed)).toBe(true);
    expect(fieldsDirty(changed, base)).toBe(true);

    const lyricsChanged = { ...base, lyrics: "lrc" };
    expect(fieldsDirty(base, lyricsChanged)).toBe(true);
  });

  it("fieldsDirty：忽略首尾空白差异（未编辑的空格不算改动）", () => {
    const base = emptyMusicTagFields();
    expect(fieldsDirty(base, { ...base, title: "  晴天  " })).toBe(true);
    expect(fieldsDirty({ ...base, title: "晴天" }, { ...base, title: " 晴天 " })).toBe(false);
  });
});
