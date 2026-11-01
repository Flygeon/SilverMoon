import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useBiliStore } from "../bilibili";
import type { BiliQrProtocol, BiliQrStatus } from "@/utils/bilibili";

const mocks = vi.hoisted(() => ({
  generate: vi.fn<(protocol: BiliQrProtocol) => Promise<{ key: string; url: string }>>(),
  poll: vi.fn<
    (key: string, protocol: BiliQrProtocol, isCurrent: () => boolean) => Promise<BiliQrStatus>
  >(),
  nav: vi.fn(),
  openWebsite: vi.fn(),
  cancelWebsite: vi.fn(async () => {}),
  applyWebsite: vi.fn(async () => {}),
  log: vi.fn(async () => {}),
}));
vi.mock("@/utils/bilibili", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/bilibili")>()),
  biliQrGenerate: mocks.generate,
  biliQrPoll: mocks.poll,
  biliNav: mocks.nav,
  biliApplyWebsiteCookies: mocks.applyWebsite,
}));
vi.mock("@/capabilities", () => ({ isDesktop: true, capabilities: { appLog: mocks.log } }));
vi.mock("@/ipc/bilibili", () => ({
  openBilibiliLogin: mocks.openWebsite,
  cancelBilibiliLogin: mocks.cancelWebsite,
}));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue({ key: "test-key", url: "https://example.test/qr" });
  mocks.poll.mockResolvedValue({ code: 86039, message: "二维码尚未确认" });
  mocks.openWebsite.mockResolvedValue({ SESSDATA: "fixture", bili_jct: "csrf", DedeUserID: "42" });
});

it("TV waiting code keeps polling without an error", async () => {
  const store = useBiliStore();
  await store.startQr();
  expect(mocks.generate).toHaveBeenCalledWith("tv");
  expect(await store.pollQr()).toBe(false);
  expect(mocks.poll).toHaveBeenCalledWith("test-key", "tv", expect.any(Function));
  expect(store.loginError).toBe("");
  expect(store.qrStatusText).toBe("二维码尚未确认");
});

it("binds the selected protocol to the generated QR key", async () => {
  const store = useBiliStore();
  await store.startQr("web");
  await store.pollQr();
  expect(mocks.generate).toHaveBeenCalledWith("web");
  expect(mocks.poll).toHaveBeenCalledWith("test-key", "web", expect.any(Function));
});

it.each(["tv", "web"] as const)(
  "%s authorization error stops without blaming the account",
  async (protocol) => {
    const store = useBiliStore();
    await store.startQr(protocol);
    mocks.poll.mockResolvedValueOnce({ code: 48007, message: "当前账号暂不支持在本APP登录" });
    expect(await store.pollQr()).toBe(true);
    expect(store.loginError).toContain("48007");
    expect(store.loginError).not.toContain("网络异常");
    expect(store.loginError).not.toContain("手机确认不代表登录成功");
    expect(store.loginError).not.toContain("检查账号状态");
    expect(store.loginError).toContain("若手机已确认成功");
    expect(store.qrStatusText).not.toContain("手机上确认");
    expect(mocks.nav).not.toHaveBeenCalled();
  },
);

it("invalidates an outstanding poll when the QR session is reset", async () => {
  const store = useBiliStore();
  await store.startQr();
  let finish!: (status: BiliQrStatus) => void;
  mocks.poll.mockImplementationOnce(
    () => new Promise<BiliQrStatus>((resolve) => (finish = resolve)),
  );
  const pending = store.pollQr();
  const isCurrent = mocks.poll.mock.calls[0][2];
  expect(isCurrent()).toBe(true);
  store.resetQr();
  expect(isCurrent()).toBe(false);
  finish({ code: 0, message: "authorized" });
  expect(await pending).toBe(false);
  expect(mocks.nav).not.toHaveBeenCalled();
  expect(store.qrStatus).toBeNull();
});

it("verifies the account before finishing a successful TV authorization", async () => {
  const store = useBiliStore();
  await store.startQr();
  mocks.poll.mockResolvedValueOnce({ code: 0, message: "success" });
  mocks.nav.mockResolvedValueOnce({ isLogin: true, mid: 42, name: "Test" });
  expect(await store.pollQr()).toBe(true);
  expect(store.account.isLogin).toBe(true);
  expect(store.notice).toContain("Test");
  expect(mocks.log.mock.calls.flat().join(" ")).not.toContain("test-key");
});

it("official website login completes only after business account verification", async () => {
  const store = useBiliStore();
  mocks.nav.mockResolvedValueOnce({ isLogin: true, mid: 42, name: "Test" });
  expect(await store.startWebsiteLogin()).toBe(true);
  expect(mocks.applyWebsite).toHaveBeenCalledWith(
    { SESSDATA: "fixture", bili_jct: "csrf", DedeUserID: "42" },
    expect.any(Function),
  );
  expect(store.account.isLogin).toBe(true);
  expect(store.websiteLoginBusy).toBe(false);
  expect(mocks.log.mock.calls.flat().join(" ")).not.toContain("fixture");
});

it("official website cancellation leaves credentials untouched", async () => {
  const store = useBiliStore();
  mocks.openWebsite.mockResolvedValueOnce(null);
  expect(await store.startWebsiteLogin()).toBe(false);
  expect(mocks.applyWebsite).not.toHaveBeenCalled();
  expect(store.loginError).toBe("");
  expect(store.websiteLoginBusy).toBe(false);
});

it("closing login discards a late official website response", async () => {
  const store = useBiliStore();
  let finish!: (value: Record<string, string>) => void;
  mocks.openWebsite.mockImplementationOnce(
    () => new Promise<Record<string, string>>((resolve) => (finish = resolve)),
  );
  const pending = store.startWebsiteLogin();
  expect(store.websiteLoginBusy).toBe(true);
  store.resetQr();
  finish({ SESSDATA: "stale", bili_jct: "csrf", DedeUserID: "42" });
  expect(await pending).toBe(false);
  expect(mocks.cancelWebsite).toHaveBeenCalledTimes(1);
  expect(mocks.applyWebsite).not.toHaveBeenCalled();
  expect(mocks.nav).not.toHaveBeenCalled();
});

it("official website credentials cannot report success for an anonymous account", async () => {
  const store = useBiliStore();
  mocks.nav.mockResolvedValueOnce({ isLogin: false });
  expect(await store.startWebsiteLogin()).toBe(false);
  expect(store.loginError).toContain("校验");
  expect(store.account.isLogin).toBe(false);
});
