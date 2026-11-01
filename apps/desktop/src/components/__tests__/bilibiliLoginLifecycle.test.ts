// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import BilibiliOnlineView from "../BilibiliOnlineView.vue";

const bili = reactive({
  feed: [],
  feedStatus: "ready",
  accountLoaded: true,
  account: { isLogin: false },
  searchHistory: [],
  notice: "",
  qrContent: null as string | null,
  qrStatusText: "waiting",
  startingQr: false,
  loginError: "",
  current: null,
  userMid: null,
  resetQr: vi.fn(() => {
    bili.qrContent = null;
  }),
  startQr: vi.fn(async (_protocol: "tv" | "web") => {
    bili.qrContent = "https://example.test/qr";
  }),
  pollQr: vi.fn(async () => false),
  loadSearchHistory: vi.fn(),
  loadFeed: vi.fn(),
  loadAccount: vi.fn(),
});
vi.mock("@/stores/bilibili", () => ({ useBiliStore: () => bili }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AA==" } }));
vi.mock("../SegmentedTabs.vue", () => ({
  default: defineComponent({
    emits: ["update:modelValue"],
    setup(_, { emit, slots }) {
      return () =>
        h("div", [
          h("button", { id: "mine-tab", onClick: () => emit("update:modelValue", "mine") }, "mine"),
          slots.default?.(),
        ]);
    },
  }),
}));
vi.mock("../BilibiliMinePanel.vue", () => ({
  default: defineComponent({
    emits: ["login"],
    setup(_, { emit }) {
      return () => h("button", { id: "login", onClick: () => emit("login") }, "login");
    },
  }),
}));
vi.mock("../BilibiliVideoView.vue", () => ({ default: { render: () => null } }));
vi.mock("../BilibiliUserView.vue", () => ({ default: { render: () => null } }));
vi.mock("../BilibiliDynamics.vue", () => ({ default: { render: () => null } }));
vi.mock("../BilibiliCard.vue", () => ({ default: { render: () => null } }));

let app: App;
let host: HTMLElement;
let hide: ReturnType<typeof vi.fn>;

async function settle() {
  await vi.dynamicImportSettled();
  await nextTick();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}
function click(selector: string) {
  host.querySelector<HTMLElement>(selector)!.click();
}
async function openLogin() {
  click("#mine-tab");
  await nextTick();
  click("#login");
  await settle();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  bili.account.isLogin = false;
  bili.qrContent = null;
  bili.pollQr.mockImplementation(async () => false);
  bili.startQr.mockImplementation(async () => {
    bili.qrContent = "https://example.test/qr";
  });
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(BilibiliOnlineView);
  app.mount(host);
  const dialog = host.querySelector("m3e-dialog")!;
  Object.assign(dialog, { show: vi.fn(async () => {}), hide: (hide = vi.fn(async () => {})) });
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.useRealTimers();
});

it("restarts polling after an expired QR code is refreshed", async () => {
  bili.pollQr.mockResolvedValueOnce(true);
  await openLogin();
  expect(bili.pollQr).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4000);
  expect(bili.pollQr).toHaveBeenCalledTimes(1);
  click(".login-dialog [slot=actions] m3e-button");
  await settle();
  expect(bili.startQr).toHaveBeenCalledTimes(2);
  expect(bili.pollQr).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(bili.pollQr).toHaveBeenCalledTimes(3);
});

it("closes the dialog only after the account is verified", async () => {
  bili.pollQr.mockImplementationOnce(async () => {
    bili.account.isLogin = true;
    return true;
  });
  await openLogin();
  expect(hide).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4000);
  expect(bili.pollQr).toHaveBeenCalledTimes(1);
});

it("defaults to TV, refreshes the selected fallback, and resets on reopening", async () => {
  await openLogin();
  expect(bili.startQr).toHaveBeenLastCalledWith("tv");
  click(".login-dialog m3e-button[variant=tonal]");
  await settle();
  expect(bili.startQr).toHaveBeenLastCalledWith("web");
  click(".login-dialog [slot=actions] m3e-button");
  await settle();
  expect(bili.startQr).toHaveBeenLastCalledWith("web");
  click(".login-dialog [slot=actions] m3e-button:last-child");
  await openLogin();
  expect(bili.startQr).toHaveBeenLastCalledWith("tv");
});

it("does not restart polling if closed during QR generation", async () => {
  let finish!: () => void;
  bili.startQr.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await openLogin();
  click(".login-dialog [slot=actions] m3e-button:last-child");
  bili.qrContent = "https://example.test/stale";
  finish();
  await settle();
  await vi.advanceTimersByTimeAsync(4000);
  expect(bili.pollQr).not.toHaveBeenCalled();
});
