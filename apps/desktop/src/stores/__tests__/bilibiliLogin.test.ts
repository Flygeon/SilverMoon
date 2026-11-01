import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useBiliStore } from "../bilibili";
import { BILI_ANONYMOUS, type BiliQrProtocol, type BiliQrStatus } from "@/utils/bilibili";

const mocks = vi.hoisted(() => ({
  generate: vi.fn<(protocol: BiliQrProtocol) => Promise<{ key: string; url: string }>>(),
  poll: vi.fn<
    (key: string, protocol: BiliQrProtocol, isCurrent: () => boolean) => Promise<BiliQrStatus>
  >(),
  nav: vi.fn(),
  log: vi.fn(async () => {}),
}));
vi.mock("@/utils/bilibili", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/bilibili")>()),
  biliQrGenerate: mocks.generate,
  biliQrPoll: mocks.poll,
  biliNav: mocks.nav,
}));
vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: { appLog: mocks.log } }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.nav.mockReset();
  mocks.generate.mockResolvedValue({ key: "test-key", url: "https://example.test/qr" });
  mocks.poll.mockResolvedValue({ code: 86039, message: "二维码尚未确认" });
});

it("accepts a verified password/SMS account without a second nav overwriting it", async () => {
  const store = useBiliStore();
  let finish!: (account: typeof BILI_ANONYMOUS) => void;
  mocks.nav.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const loading = store.loadAccount();
  const next = { ...BILI_ANONYMOUS, isLogin: true, mid: 42, name: "fixture" };
  store.acceptCredentialLogin(next);
  finish({ ...BILI_ANONYMOUS });
  await loading;
  expect(store.account).toEqual(next);
  expect(store.accountLoaded).toBe(true);
  expect(store.accountLoading).toBe(false);
  expect(store.notice).toContain("fixture");
});

it("does not accept an anonymous account as a successful credential login", () => {
  const store = useBiliStore();
  store.acceptCredentialLogin({ ...BILI_ANONYMOUS });
  expect(store.account.isLogin).toBe(false);
  expect(store.notice).toBe("");
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
    expect(store.loginError).toContain("标准版");
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

it("does not show login success while account verification is pending", async () => {
  const store = useBiliStore();
  await store.startQr();
  mocks.poll.mockResolvedValueOnce({ code: 0, message: "success" });
  let finish!: (account: { isLogin: boolean; mid: number; name: string }) => void;
  mocks.nav.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = store.pollQr();
  await vi.waitFor(() => expect(mocks.nav).toHaveBeenCalledOnce());
  expect(store.qrStatusText).toBe("授权成功，正在验证账号");
  finish({ isLogin: true, mid: 42, name: "Test" });
  expect(await pending).toBe(true);
  expect(store.qrStatusText).toBe("登录成功");
});

it("does not show login success when account verification fails", async () => {
  const store = useBiliStore();
  await store.startQr();
  mocks.poll.mockResolvedValueOnce({ code: 0, message: "success" });
  mocks.nav.mockResolvedValue({ isLogin: false, mid: 0, name: "" });
  expect(await store.pollQr()).toBe(true);
  expect(mocks.nav).toHaveBeenCalledTimes(2);
  expect(store.qrStatusText).toBe("授权成功，账号验证失败");
  expect(store.loginError).toContain("账号信息获取失败");
});

it("verifies the account before finishing a successful TV authorization", async () => {
  const store = useBiliStore();
  await store.startQr();
  mocks.poll.mockResolvedValueOnce({ code: 0, message: "success" });
  mocks.nav.mockResolvedValueOnce({ isLogin: true, mid: 42, name: "Test" });
  expect(await store.pollQr()).toBe(true);
  expect(store.account.isLogin).toBe(true);
  expect(store.qrStatusText).toBe("登录成功");
  expect(store.notice).toContain("Test");
  expect(mocks.log.mock.calls.flat().join(" ")).not.toContain("test-key");
});
