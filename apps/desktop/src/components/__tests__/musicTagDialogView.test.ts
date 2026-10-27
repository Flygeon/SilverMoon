// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import MusicTagDialog from "../MusicTagDialog.vue";
import { emptyMusicTagFields } from "@/utils/musicTagDraft";

const actions = vi.hoisted(() => ({
  close: vi.fn(),
  search: vi.fn(async () => null),
  pick: vi.fn(),
}));
const dialog = reactive({
  visible: false,
  target: null,
  fields: emptyMusicTagFields(),
  original: emptyMusicTagFields(),
  hasLocalBackup: false,
  mode: "smart",
  keyword: "",
  results: [],
  searching: false,
  applying: false,
  fetchingLyrics: false,
  fetchingWordLyrics: false,
  partialError: "",
  error: "",
  coverPreview: null,
  coverMode: "keep",
  lyricsFromApi: true,
  lyricsWordLevel: true,
});
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "en" }) }));
vi.mock("@/components/AppToast.vue", () => ({ useAppToast: () => ({ show: vi.fn() }) }));
vi.mock("@/composables/useMusicTagDialog", () => ({
  useMusicTagDialog: () => dialog,
  MUSIC_TAG_MODE_OPTIONS: [{ value: "smart", labelKey: "musicTag.smart" }],
  closeMusicTagDialog: () => {
    actions.close();
    dialog.visible = false;
  },
  searchTagCandidates: actions.search,
  pickSearchResult: actions.pick,
  applyTagDialog: vi.fn(),
  chooseCoverFile: vi.fn(),
  fetchLyricsForResult: vi.fn(),
  fetchWordLyrics: vi.fn(),
  keepCover: vi.fn(),
  removeCover: vi.fn(),
  resetTagDialog: vi.fn(),
}));

let app: App;
let host: HTMLElement;
let trigger: HTMLButtonElement;
beforeEach(() => {
  vi.clearAllMocks();
  dialog.visible = false;
  dialog.searching = false;
  dialog.fields = emptyMusicTagFields();
  dialog.original = emptyMusicTagFields();
  dialog.keyword = "";
  dialog.lyricsFromApi = true;
  dialog.lyricsWordLevel = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  host.id = "app";
  trigger = document.createElement("button");
  document.body.append(trigger, host);
  trigger.focus();
  app = createApp({ render: () => h(MusicTagDialog) });
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  trigger.remove();
  host.remove();
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
});
async function open() {
  dialog.visible = true;
  await nextTick();
  return document.querySelector<HTMLElement>(".music-tag-dialog")!;
}

it("官方字段保留草稿绑定，手改歌词清掉来源标记", async () => {
  const surface = await open();
  const input = surface.querySelector<HTMLInputElement>(".field-grid m3e-form-field input")!;
  input.value = "新的标题";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(dialog.fields.title).toBe("新的标题");
  const lyrics = surface.querySelector<HTMLTextAreaElement>("textarea")!;
  lyrics.value = "手动歌词";
  lyrics.dispatchEvent(new Event("input", { bubbles: true }));
  expect(dialog.fields.lyrics).toBe("手动歌词");
  expect(dialog.lyricsFromApi).toBe(false);
  expect(dialog.lyricsWordLevel).toBe(false);
});

it("共享搜索忽略输入法确认与忙碌提交，正常 Enter 查询一次", async () => {
  const surface = await open();
  const input = surface.querySelector<HTMLInputElement>(".mtd-search input")!;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
  expect(actions.search).not.toHaveBeenCalled();
  dialog.searching = true;
  await nextTick();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(actions.search).not.toHaveBeenCalled();
  dialog.searching = false;
  await nextTick();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(actions.search).toHaveBeenCalledTimes(1);
});

it("只在打开时锁背景，Escape 关闭恢复滚动与触发器", async () => {
  document.body.style.overflow = "clip";
  const surface = await open();
  expect(host.inert).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await nextTick();
  expect(actions.close).toHaveBeenCalledTimes(1);
  expect(host.inert).toBe(false);
  expect(document.body.style.overflow).toBe("clip");
  expect(document.activeElement).toBe(trigger);
});
