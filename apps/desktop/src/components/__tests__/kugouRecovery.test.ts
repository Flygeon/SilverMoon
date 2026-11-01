// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, reactive, type App } from "vue";
import KugouFeed from "../KugouFeed.vue";

const calls = vi.hoisted(() => ({ daily: vi.fn(), open: vi.fn() }));
const store = reactive({
  loggedIn: true,
  reauthRequired: false,
  playlistsStatus: "error",
  playlistsError: "[KUGOU_LOGIN_REQUIRED] code=20017",
  playlists: [],
  signedDays: [],
  loadPlaylists: vi.fn(),
  openQr: calls.open,
});
vi.mock("@/stores/kugou", () => ({ useKugouStore: () => store }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));
vi.mock("@/capabilities", () => ({ capabilities: { kugouRecommendSongs: calls.daily } }));
vi.mock("@/components/CachedCover.vue", () => ({ default: { render: () => null } }));

let app: App;
let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  store.reauthRequired = false;
  calls.daily.mockResolvedValue({ data: { info: [] } });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
});

it.each(["daily", "playlist"])("%s 账号错误提供官方重新登录按钮", async (source) => {
  if (source === "daily") calls.daily.mockRejectedValueOnce("[KUGOU_LOGIN_REQUIRED] code=20018");
  else store.reauthRequired = true;
  app = createApp(KugouFeed);
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain("重新登录"));
  const button = [...host.querySelectorAll<HTMLElement>("m3e-button")].find((node) =>
    node.textContent?.includes("重新登录"),
  )!;
  button.click();
  expect(calls.open).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("actions.retry");
});
