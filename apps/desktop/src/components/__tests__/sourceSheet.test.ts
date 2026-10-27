// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import SourceSheet from "../SourceSheet.vue";
import type { BangumiSubject } from "@shared/types";

const anime = {
  sourceSearch: [
    { pluginName: "测试源", status: "success", items: [{ name: "示例番剧", url: "show/1" }] },
  ],
  sourceSearching: false,
  sourceSearchError: "",
  rules: [],
  requerySingleSource: vi.fn(),
  requeryAllSources: vi.fn(),
};
vi.mock("@/stores/anime", () => ({ useAnimeStore: () => anime }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));
vi.mock("@/capabilities", () => ({ capabilities: { openUrl: vi.fn() } }));

let app: App;
let host: HTMLElement;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SourceSheet, {
        keyword: "示例",
        subject: { alias: ["别名"] } as BangumiSubject,
      }),
  });
  app.mount(host);
  await nextTick();
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.unstubAllGlobals();
});

it("有结果的源默认展开，第一次点击可收起，再点击恢复", async () => {
  const head = document.querySelector<HTMLButtonElement>(".card-head")!;
  const row = document.querySelector<HTMLElement>(".result-row")!;
  expect(head.getAttribute("aria-expanded")).toBe("true");
  head.click();
  await nextTick();
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(row.style.display).toBe("none");
  head.click();
  await nextTick();
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(row.style.display).not.toBe("none");
});

it("更多操作有名称，别名使用官方可聚焦 Chip 且只检索一次", async () => {
  const more = document.querySelector<HTMLElement>("m3e-icon-button.more-toggle")!;
  expect(more.getAttribute("aria-label")).toBe("更多");
  more.click();
  await nextTick();
  document.querySelector<HTMLElement>(".alias-row m3e-assist-chip")!.click();
  expect(anime.requerySingleSource).toHaveBeenCalledExactlyOnceWith("测试源", "别名");
});
