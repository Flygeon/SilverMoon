// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useKugouStore } from "../kugou";

const calls = vi.hoisted(() => ({ playlists: vi.fn(), login: vi.fn(), status: vi.fn() }));
vi.mock("@/capabilities", () => ({
  capabilities: {
    kugouUserPlaylists: calls.playlists,
    kugouLoginCellphone: calls.login,
    kugouLoginStatus: calls.status,
  },
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ kugouEnabled: true, kugouAutoSignIn: false }),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  calls.playlists.mockResolvedValue({ data: { info: [] } });
  calls.login.mockResolvedValue({ userid: 42, nickname: "fixture" });
  calls.status.mockResolvedValue({ loggedIn: true, profile: { userid: 42 }, signedDays: [] });
});

it("被拒绝的凭据显示重新登录操作，保留账号信息供用户决定", async () => {
  const store = useKugouStore();
  store.loggedIn = true;
  calls.playlists.mockRejectedValueOnce("[KUGOU_LOGIN_REQUIRED] code=20017");
  await store.loadPlaylists();
  expect(store.reauthRequired).toBe(true);
  expect(store.loggedIn).toBe(true);
  expect(store.playlistsStatus).toBe("error");
});

it("普通参数错误不会要求重新登录", async () => {
  const store = useKugouStore();
  store.loggedIn = true;
  calls.playlists.mockRejectedValueOnce(new Error("酷狗服务拒绝请求（code=20010）"));
  await store.loadPlaylists();
  expect(store.reauthRequired).toBe(false);
  expect(store.playlistsError).toContain("code=20010");
});

it("账号原本为已登录时，短信重新登录后仍强制刷新歌单", async () => {
  const store = useKugouStore();
  store.loggedIn = true;
  store.reauthRequired = true;
  store.playlistsStatus = "error";
  store.phone = "15500000000";
  store.smsCode = "123456";
  await store.phoneLogin();
  expect(calls.login).toHaveBeenCalledOnce();
  expect(calls.playlists).toHaveBeenCalledExactlyOnceWith(1, 50);
  expect(store.reauthRequired).toBe(false);
  expect(store.playlistsStatus).toBe("ready");
});
