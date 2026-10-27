// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import MusicView from "../MusicView.vue";

const search = vi.hoisted(() => vi.fn(async () => []));
const settings = reactive({
  lang: "en",
  enableOnlineMusic: true,
  enabledServers: [],
  neteaseEnabled: false,
  kugouEnabled: false,
  musicServer: "netease",
  musicViewMode: "grid",
  onlinePlaylists: [],
  playlistRenames: {},
  scanDirs: [],
});
function authState() {
  return reactive({
    init: vi.fn(),
    qrOpen: false,
    qrCode: "",
    qrState: "wait",
    qrError: "",
    authTab: "qr",
    loggedIn: false,
    phone: "",
    smsCode: "",
    smsSending: false,
    smsCooldown: 0,
    phoneLogging: false,
    phoneError: "",
    playlists: [],
    sendSms: vi.fn(),
    sendSmsCaptcha: vi.fn(),
    phoneLogin: vi.fn(),
    closeQr: vi.fn(),
  });
}
const netease = authState();
const kugou = authState();
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => settings }));
vi.mock("@/stores/netease", () => ({ useNeteaseStore: () => netease }));
vi.mock("@/stores/kugou", () => ({ useKugouStore: () => kugou }));
vi.mock("@/stores/library", () => ({
  useLibraryStore: () => ({ entries: () => [], refresh: vi.fn(), totalFor: () => 0 }),
}));
vi.mock("@/stores/player", () => ({ usePlayerStore: () => ({}) }));
vi.mock("@/stores/desktop", () => ({ useDesktopStore: () => ({}) }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/capabilities", () => ({ capabilities: {}, isDesktop: false }));
vi.mock("@/utils/meting", () => ({
  CURATED_PLAYLISTS: [],
  metingSearch: search,
  metingPlaylist: vi.fn(async () => []),
}));
vi.mock("@/components/NowPlayingFeed.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/KugouFeed.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/PlatformBar.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/LibraryToolbar.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/MediaGrid.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/TrackList.vue", () => ({ default: { render: () => null } }));

let app: App;
let host: HTMLElement;
async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const auth of [netease, kugou]) {
    auth.qrOpen = false;
    auth.authTab = "qr";
    auth.phone = "";
    auth.smsCode = "";
    auth.smsCooldown = 0;
    auth.closeQr.mockImplementation(() => {
      auth.qrOpen = false;
    });
  }
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  host.id = "app";
  document.body.append(host);
  app = createApp({ render: () => h(MusicView) });
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.unstubAllGlobals();
});

it("共享搜索只在输入法确认完成后查询，保留立即进入详情", async () => {
  const tab = [...host.querySelectorAll<HTMLElement>(".online-tabs m3e-button")].find((element) =>
    element.textContent?.includes("Search"),
  )!;
  tab.click();
  await settle();
  const input = host.querySelector<HTMLInputElement>(".search-field input")!;
  input.value = "  Moon  ";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  await settle();
  expect(search).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  expect(search).toHaveBeenCalledExactlyOnceWith("netease", "Moon");
  expect(host.querySelector(".detail-head h2")?.textContent).toBe("「Moon」");
});

it.each(["netease", "kugou"] as const)(
  "%s 登录使用官方字段并保留输入法、验证码与关闭恢复",
  async (provider) => {
    const auth = provider === "netease" ? netease : kugou;
    const send = provider === "netease" ? auth.sendSmsCaptcha : auth.sendSms;
    auth.qrOpen = true;
    auth.authTab = "phone";
    await settle();
    const dialog = document.querySelector<HTMLElement>(".qr-card")!;
    expect(host.contains(dialog)).toBe(false);
    expect(host.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    const input = dialog.querySelector<HTMLInputElement>('input[type="tel"]')!;
    input.value = "13800000000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(auth.phone).toBe("13800000000");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(send).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(send).toHaveBeenCalledTimes(1);
    auth.smsCooldown = 10;
    await settle();
    expect(dialog.querySelector(".sms-row m3e-button")?.hasAttribute("disabled")).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(auth.closeQr).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".qr-card")).toBeNull();
    expect(host.inert).toBe(false);
    expect(document.body.style.overflow).toBe("");
  },
);
