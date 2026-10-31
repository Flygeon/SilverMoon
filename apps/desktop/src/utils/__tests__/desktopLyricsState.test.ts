import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/capabilities", () => ({ isDesktop: true }));
vi.mock("@/ipc/window", () => ({}));
vi.mock("@/ipc/events", () => ({ emitTo: vi.fn().mockResolvedValue(undefined) }));

import { emitTo } from "@/ipc/events";
import {
  DL_STATE_EVENT,
  emitDesktopLyricsState,
  mergeDesktopLyricsState,
  type DesktopLyricsState,
  type DesktopLyricsUpdate,
} from "../desktopLyrics";

const full: DesktopLyricsState = {
  lines: [{ time: 0, text: "line", units: [{ start: 0, end: 1 }] }],
  currentTime: 0,
  playing: true,
  title: "song",
  artist: "artist",
};
const progress: DesktopLyricsUpdate = {
  currentTime: 1,
  playing: true,
  title: "song",
  artist: "artist",
};

beforeEach(() => vi.clearAllMocks());

it("sends progress without copying the lyric timeline into IPC", async () => {
  await emitDesktopLyricsState(full);
  await emitDesktopLyricsState(progress);
  expect(emitTo).toHaveBeenNthCalledWith(1, "desktop-lyrics", DL_STATE_EVENT, full);
  expect(emitTo).toHaveBeenNthCalledWith(2, "desktop-lyrics", DL_STATE_EVENT, progress);
  expect(vi.mocked(emitTo).mock.calls[1][2]).not.toHaveProperty("lines");
});

it("reuses the received timeline through repeated progress updates", () => {
  let state = mergeDesktopLyricsState(null, full);
  for (let i = 1; i <= 1000; i++) {
    state = mergeDesktopLyricsState(state, { ...progress, currentTime: i / 5 });
    expect(state?.lines).toBe(full.lines);
  }
  expect(state?.currentTime).toBe(200);
});

it("waits for the ready snapshot before applying progress", () => {
  expect(mergeDesktopLyricsState(null, progress)).toBeNull();
  expect(mergeDesktopLyricsState(null, full)).toEqual(full);
});

it("replaces old lyrics on a song change and clears them for instrumental tracks", () => {
  const next = { ...full, title: "next", lines: [{ time: 0, text: "new line" }] };
  const state = mergeDesktopLyricsState(full, next);
  expect(state?.lines).toBe(next.lines);
  expect(state?.title).toBe("next");
  expect(mergeDesktopLyricsState(state, { ...next, lines: [] })?.lines).toEqual([]);
});
