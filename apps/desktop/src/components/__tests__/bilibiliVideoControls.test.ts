// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref, type App } from "vue";
import BilibiliVideoView from "../BilibiliVideoView.vue";

const actions = vi.hoisted(() => ({
  closeVideo: vi.fn(),
  toggleLike: vi.fn(),
  toggleFavorite: vi.fn(),
  addCoin: vi.fn(),
  shareVideo: vi.fn(),
  reportProgress: vi.fn(),
  stopHeartbeat: vi.fn(),
  selectQuality: vi.fn(),
  selectPart: vi.fn(),
  openCurrentUp: vi.fn(),
}));
const bili = reactive({
  ...actions,
  detail: {
    title: "Video preview",
    desc: "Description",
    pubdate: 0,
    stat: { view: 0, danmaku: 0, like: 12, coin: 3, favorite: 8 },
    owner: { mid: "up", name: "Author", face: "" },
    parts: [
      { cid: "one", part: "First", duration: 60 },
      { cid: "two", part: "Second", duration: 90 },
    ],
  },
  play: { durl: [], dashVideo: [], qualities: [64], formats: [] },
  playStatus: "ready",
  playError: "",
  activeQn: 64,
  activeCid: "one",
  detailStatus: "ready",
  relation: { liked: true, favored: false, coin: 1, followed: false },
  acting: {} as Record<string, boolean>,
  related: [],
  relatedStatus: "ready",
  aiSummary: null,
  aiStatus: "idle",
  aiError: "",
  aiActionVisible: false,
});
vi.mock("@/stores/bilibili", () => ({ useBiliStore: () => bili }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ lang: "en", ambilightEnabled: false }),
}));
vi.mock("@/composables/useAmbilight", () => ({
  useAmbilight: () => ({ attach: vi.fn() }),
}));
vi.mock("@/composables/useSponsorSkip", () => ({
  useSponsorSkip: () => ({ highlights: ref([]), attach: vi.fn(), detach: vi.fn() }),
}));
vi.mock("@/components/BilibiliComments.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/BilibiliRelatedList.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/BilibiliAiSummary.vue", () => ({ default: { render: () => null } }));

let app: App;
let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  bili.acting = {};
  bili.playStatus = "ready";
  bili.playError = "";
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(BilibiliVideoView) });
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
});

it("官方互动按钮保留点赞收藏状态、忙碌态和分享动作", async () => {
  const controls = host.querySelectorAll<HTMLElement>(".actions > m3e-button");
  expect(controls[0].getAttribute("aria-pressed")).toBe("true");
  expect(controls[0].getAttribute("variant")).toBe("tonal");
  expect(controls[1].getAttribute("aria-pressed")).toBe("false");
  controls[0].click();
  controls[1].click();
  controls[2].click();
  expect(actions.toggleLike).toHaveBeenCalledTimes(1);
  expect(actions.toggleFavorite).toHaveBeenCalledTimes(1);
  expect(actions.shareVideo).toHaveBeenCalledTimes(1);
  bili.acting = { like: true, fav: true, coin: true };
  await nextTick();
  expect(controls[0].hasAttribute("disabled")).toBe(true);
  expect(controls[1].hasAttribute("disabled")).toBe(true);
  expect(host.querySelector(".act-wrap > m3e-button")!.hasAttribute("disabled")).toBe(true);
});

it("投币选项传递原数量，收起气泡并支持外部点击关闭", async () => {
  const toggle = host.querySelector<HTMLElement>(".act-wrap > m3e-button")!;
  toggle.click();
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  host.querySelectorAll<HTMLElement>(".coin-pop m3e-button")[1].click();
  expect(actions.addCoin).toHaveBeenCalledExactlyOnceWith(2);
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await vi.waitFor(() => expect(host.querySelector(".coin-pop")).toBeNull());
  toggle.click();
  await nextTick();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

it("返回、UP 主、分 P、受控清晰度和失败重试仍使用原入口", async () => {
  host.querySelector<HTMLElement>(".head m3e-icon-button")!.click();
  expect(actions.closeVideo).toHaveBeenCalledExactlyOnceWith(0);
  host.querySelector<HTMLElement>(".owner-link")!.click();
  expect(actions.openCurrentUp).toHaveBeenCalledExactlyOnceWith(0);
  host.querySelectorAll<HTMLElement>(".part")[1].click();
  expect(actions.selectPart).toHaveBeenCalledExactlyOnceWith("two", 0);
  const quality = host.querySelector<HTMLElement>(".chips m3e-filter-chip")!;
  quality.click();
  quality.click();
  expect(actions.selectQuality).toHaveBeenNthCalledWith(1, 64);
  expect(actions.selectQuality).toHaveBeenNthCalledWith(2, 64);
  expect(quality.getAttribute("selected")).toBe("true");
  bili.playStatus = "error";
  bili.playError = "Temporary failure";
  await nextTick();
  host.querySelector<HTMLElement>(".player-overlay m3e-button")!.click();
  expect(actions.selectQuality).toHaveBeenLastCalledWith(64);
});
