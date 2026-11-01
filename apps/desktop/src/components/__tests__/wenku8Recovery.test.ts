// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, type App } from "vue";
import NovelOnlineView from "../NovelOnlineView.vue";
import { reloginRequested } from "@/novel/wenku8Auth";

const calls = vi.hoisted(() => ({
  rank: vi.fn(),
  recommend: vi.fn(),
  login: vi.fn(),
}));
const settings = reactive({ wenku8Node: "net", novelCharset: "gbk", lang: "zh" });
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => settings }));
vi.mock("@/utils/novelCache", () => ({
  novelRankCached: calls.rank,
  novelRecommendCached: calls.recommend,
}));
vi.mock("@/capabilities", () => ({
  capabilities: { wenku8LoginStatus: async () => ({ loggedIn: true }), appLog: async () => {} },
}));
vi.mock("@/novel/wenku8Login", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/novel/wenku8Login")>()),
  openWenku8Login: calls.login,
}));
vi.mock("@/components/NovelCard.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/NovelSearchBar.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/NovelDetailPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/BookReader.vue", () => ({ default: { render: () => null } }));

let app: App | undefined;
let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  settings.wenku8Node = "net";
  reloginRequested.value = false;
  calls.rank.mockResolvedValue([]);
  calls.recommend.mockResolvedValue([]);
  calls.login.mockResolvedValue({ loggedIn: true });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.restoreAllMocks();
});
async function mount() {
  app = createApp(NovelOnlineView);
  app.mount(host);
  await nextTick();
  await vi.waitFor(() => expect(calls.rank).toHaveBeenCalledTimes(1));
  await nextTick();
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLElement>("m3e-button")].find((item) =>
    item.textContent?.includes(label),
  )!;
}

it("Cloudflare 挑战提供明确的 .cc 恢复操作并重新请求备用节点", async () => {
  calls.rank.mockRejectedValueOnce(new Error("[WENKU8_SITE_CHALLENGE] 浏览器验证"));
  await mount();
  await vi.waitFor(() => expect(button("切换 .cc 节点")).toBeDefined());
  button("切换 .cc 节点").click();
  await vi.waitFor(() => expect(calls.rank).toHaveBeenCalledWith("cc", "gbk", "allvisit", 1));
  expect(settings.wenku8Node).toBe("cc");
  await vi.waitFor(() => expect(host.querySelector(".home-error")).toBeNull());
});

it("普通 403 不能被误报为 Cloudflare 验证", async () => {
  calls.rank.mockRejectedValueOnce(new Error("Wenku8 返回 HTTP 403"));
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain("HTTP 403"));
  expect(button("切换 .cc 节点")).toBeUndefined();
  expect(reloginRequested.value).toBe(false);
});

it("登录跳转显示重新登录，窗口跟随当前节点且成功后刷新内容", async () => {
  settings.wenku8Node = "cc";
  calls.rank.mockRejectedValueOnce(new Error("[WENKU8_LOGIN_REQUIRED] 请重新登录"));
  await mount();
  await vi.waitFor(() => expect(reloginRequested.value).toBe(true));
  button("重新登录").click();
  await vi.waitFor(() => expect(calls.login).toHaveBeenCalledWith("cc"));
  await vi.waitFor(() => expect(calls.rank).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(host.querySelector(".home-error")).toBeNull());
});
