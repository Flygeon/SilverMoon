// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import BilibiliSearchHistory from "../BilibiliSearchHistory.vue";

const actions = vi.hoisted(() => ({
  clearSearchHistory: vi.fn(),
  removeSearchHistory: vi.fn(),
}));
const bili = reactive({ ...actions, searchHistory: ["first search", "第二条"] });
vi.mock("@/stores/bilibili", () => ({ useBiliStore: () => bili }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "en" }) }));

let app: App;
let host: HTMLElement;
const pick = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  bili.searchHistory = ["first search", "第二条"];
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(BilibiliSearchHistory, { onPick: pick }) });
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
});

it("搜索与删除是独立官方控件，删除不会重新搜索", () => {
  const item = host.querySelector<HTMLElement>(".history-item")!;
  item.querySelector<HTMLElement>("m3e-assist-chip")!.click();
  expect(pick).toHaveBeenCalledExactlyOnceWith("first search");
  pick.mockClear();
  const remove = item.querySelector<HTMLElement>("m3e-icon-button")!;
  expect(remove.getAttribute("aria-label")).toContain("first search");
  remove.click();
  expect(actions.removeSearchHistory).toHaveBeenCalledExactlyOnceWith("first search");
  expect(pick).not.toHaveBeenCalled();
  expect(host.querySelector("button")).toBeNull();
});

it("清空保留确认与取消，确认后才调用持久化动作", async () => {
  host.querySelector<HTMLElement>(".head m3e-button")!.click();
  await nextTick();
  expect(actions.clearSearchHistory).not.toHaveBeenCalled();
  host.querySelectorAll<HTMLElement>(".clear-confirm m3e-button")[1].click();
  await nextTick();
  expect(host.querySelector(".clear-confirm")).toBeNull();
  expect(actions.clearSearchHistory).not.toHaveBeenCalled();
  host.querySelector<HTMLElement>(".head m3e-button")!.click();
  await nextTick();
  host.querySelector<HTMLElement>(".clear-confirm m3e-button")!.click();
  await nextTick();
  expect(actions.clearSearchHistory).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".clear-confirm")).toBeNull();
});

it("没有历史时不留下空面板", async () => {
  bili.searchHistory = [];
  await nextTick();
  expect(host.querySelector(".search-history")).toBeNull();
});
