import { EventEmitter } from "node:events";
import type { Cookie, WebContents } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface TestWindow extends EventEmitter {
  webContents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
  options: Record<string, unknown>;
  destroyed: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
}
const mocks = vi.hoisted(() => ({
  windows: [] as TestWindow[],
  fromPartition: vi.fn(),
  proxy: vi.fn(async () => {}),
}));
vi.mock("../net-proxy", () => ({ applyCurrentNetworkProxy: mocks.proxy }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    session: { fromPartition: mocks.fromPartition },
    BrowserWindow: class extends EventEmitter {
      static fromWebContents() {
        return null;
      }
      webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
      destroyed = false;
      loadURL = vi.fn(async () => {});
      focus = vi.fn();
      show = vi.fn();
      destroy = vi.fn(() => {
        this.destroyed = true;
        this.emit("closed");
      });
      isDestroyed() {
        return this.destroyed;
      }
      constructor(public options: Record<string, unknown>) {
        super();
        mocks.windows.push(this);
      }
    },
  };
});

const cookies = Object.assign(new EventEmitter(), { get: vi.fn() });
const ses = {
  cookies,
  fetch: vi.fn(),
  clearStorageData: vi.fn(async () => {}),
  closeAllConnections: vi.fn(async () => {}),
};
let sender: WebContents;
let login: typeof import("../bilibili-login");
const completeCookies = [
  { name: "SESSDATA", value: "fixture%2Csession", domain: ".bilibili.com" },
  { name: "bili_jct", value: "csrf", domain: ".bilibili.com" },
  { name: "DedeUserID", value: "42", domain: ".bilibili.com" },
] as Cookie[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  mocks.windows.length = 0;
  mocks.proxy.mockResolvedValue();
  cookies.removeAllListeners();
  cookies.get.mockResolvedValue(completeCookies);
  ses.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ code: 0, data: { isLogin: true } }),
  });
  mocks.fromPartition.mockReturnValue(ses);
  sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false }) as WebContents;
  login = await import("../bilibili-login");
});
afterEach(async () => {
  login.cancelBilibiliLogin(sender);
  await Promise.resolve();
  vi.useRealTimers();
});

it("accepts only HTTPS Bilibili login navigation", () => {
  expect(login.isBilibiliLoginUrl("https://passport.bilibili.com/login")).toBe(true);
  expect(login.isBilibiliLoginUrl("https://passport.biligame.com/crossDomain")).toBe(true);
  for (const value of [
    "http://www.bilibili.com",
    "https://bilibili.com.example.test",
    "javascript:alert(1)",
    "https://user@bilibili.com",
    "https://bilibili.com:8443",
  ])
    expect(login.isBilibiliLoginUrl(value)).toBe(false);
});

it("collects only allowed cookies belonging to the main website", () => {
  expect(
    login.collectBilibiliLoginCookies([
      ...completeCookies,
      { name: "SESSDATA", value: "evil", domain: "bilibili.com.example.test" } as Cookie,
      { name: "SESSDATA", value: "subdomain", domain: "passport.bilibili.com" } as Cookie,
      { name: "unrelated", value: "ignored", domain: ".bilibili.com" } as Cookie,
    ]),
  ).toEqual({ SESSDATA: "fixture%2Csession", bili_jct: "csrf", DedeUserID: "42" });
});

it("opens a sandboxed memory session and completes after actual account verification", async () => {
  const pending = login.openBilibiliLogin(sender);
  const win = mocks.windows[0];
  expect(mocks.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^bilibili-login-/), {
    cache: false,
  });
  expect(win.options.webPreferences).toEqual({
    session: ses,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  expect(mocks.proxy).toHaveBeenCalledWith(ses);
  await Promise.resolve();
  expect(win.loadURL).toHaveBeenCalledWith(
    expect.stringContaining("https://passport.bilibili.com/login?"),
  );
  win.emit("ready-to-show");
  expect(win.show).toHaveBeenCalledOnce();
  win.webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toEqual({
    SESSDATA: "fixture%2Csession",
    bili_jct: "csrf",
    DedeUserID: "42",
  });
  expect(ses.fetch).toHaveBeenCalledWith(
    "https://api.bilibili.com/x/web-interface/nav",
    expect.objectContaining({ credentials: "include" }),
  );
  expect(win.destroy).toHaveBeenCalledOnce();
  expect(cookies.listenerCount("changed")).toBe(0);
  expect(sender.listenerCount("destroyed")).toBe(0);
  expect(ses.clearStorageData).toHaveBeenCalledOnce();
  expect(ses.closeAllConnections).toHaveBeenCalledOnce();
});

it("does not accept cookies without a verified account and retries transient failures", async () => {
  ses.fetch.mockRejectedValueOnce(new Error("temporary"));
  ses.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ code: 0, data: { isLogin: false } }),
  });
  const pending = login.openBilibiliLogin(sender);
  const win = mocks.windows[0];
  win.webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2200);
  expect(win.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).not.toBeNull();
});

it("does not query the account until all required credentials are present", async () => {
  cookies.get.mockResolvedValueOnce(completeCookies.slice(0, 1));
  const pending = login.openBilibiliLogin(sender);
  mocks.windows[0].webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(200);
  expect(ses.fetch).not.toHaveBeenCalled();
  cookies.emit("changed", {}, completeCookies[1], "explicit", false);
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).not.toBeNull();
});

it("cancels safely while proxy setup is pending without loading a destroyed window", async () => {
  let ready!: () => void;
  mocks.proxy.mockImplementationOnce(() => new Promise<void>((resolve) => (ready = resolve)));
  const pending = login.openBilibiliLogin(sender);
  login.cancelBilibiliLogin(sender);
  expect(await pending).toBeNull();
  ready();
  await Promise.resolve();
  expect(mocks.windows[0].loadURL).not.toHaveBeenCalled();
  expect(ses.clearStorageData).toHaveBeenCalledOnce();
});

it("reuses the same owner's window and rejects a different owner", async () => {
  const pending = login.openBilibiliLogin(sender);
  expect(login.openBilibiliLogin(sender)).toBe(pending);
  expect(mocks.windows).toHaveLength(1);
  expect(mocks.windows[0].focus).toHaveBeenCalledOnce();
  await expect(login.openBilibiliLogin({ id: 8 } as WebContents)).rejects.toThrow();
  login.cancelBilibiliLogin({ id: 8 } as WebContents);
  expect(mocks.windows[0].destroy).not.toHaveBeenCalled();
  sender.emit("destroyed");
  expect(await pending).toBeNull();
});

it("cleans up load failures without exposing the remote error", async () => {
  const pending = login.openBilibiliLogin(sender);
  mocks.windows[0].loadURL.mockRejectedValueOnce(new Error("private-remote-url"));
  await expect(pending).rejects.toThrow("无法打开 B 站官方登录页面");
  expect(ses.clearStorageData).toHaveBeenCalledOnce();
});

it("times out and removes all session listeners", async () => {
  const pending = login.openBilibiliLogin(sender);
  const result = expect(pending).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(600000);
  await result;
  expect(cookies.listenerCount("changed")).toBe(0);
});
