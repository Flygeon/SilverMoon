// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import StatsView from "../StatsView.vue";

const capabilities = vi.hoisted(() => ({
  getListenStats: vi.fn(async () => null),
  listListenStats: vi.fn(async () => []),
  listTopTracks: vi.fn(async () => []),
  listenSourceBreakdown: vi.fn(async () => []),
}));
vi.mock("@/capabilities", () => ({ capabilities, isDesktop: true }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "en" }) }));
vi.mock("@/stores/player", () => ({ usePlayerStore: () => ({}) }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

let app: App;
let host: HTMLElement;
async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
beforeEach(async () => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(StatsView) });
  app.mount(host);
  await settle();
});
afterEach(() => {
  app.unmount();
  host.remove();
});

async function chooseCustom() {
  const button = [...host.querySelectorAll<HTMLElement>(".online-tabs m3e-button")].find(
    (element) => element.textContent?.trim() === "Custom",
  )!;
  button.click();
  await settle();
  return button;
}

it("官方连通分段切换自定义日期，重复点击不重复加载", async () => {
  const button = await chooseCustom();
  expect(host.querySelectorAll("m3e-form-field input[type=date]")).toHaveLength(2);
  expect(button.classList.contains("active")).toBe(true);
  vi.clearAllMocks();
  button.click();
  await settle();
  expect(capabilities.getListenStats).not.toHaveBeenCalled();
});

it("日期有双语名称且一次更改只执行一次加载", async () => {
  await chooseCustom();
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Start date"]')!;
  expect(host.querySelector('input[aria-label="End date"]')).not.toBeNull();
  vi.clearAllMocks();
  input.value = "2026-09-01";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(capabilities.getListenStats).toHaveBeenCalledTimes(1);
  expect(capabilities.listTopTracks).toHaveBeenCalledWith(
    100,
    null,
    "2026-09-01",
    expect.any(String),
  );
});
