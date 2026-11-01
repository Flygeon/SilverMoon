import { EventEmitter } from "node:events";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  windows: [] as unknown[],
  parent: null as unknown,
  sessions: [] as { clearStorageData: ReturnType<typeof vi.fn> }[],
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeContents extends EventEmitter {
    id = 10;
    destroyed = false;
    setUserAgent = vi.fn();
    setWindowOpenHandler = vi.fn();
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }
  class FakeWindow extends EventEmitter {
    static fromWebContents(): unknown {
      return host.parent;
    }
    webContents = new FakeContents();
    destroyed = false;
    html = "";
    setMenu = vi.fn();
    show = vi.fn();
    constructor(readonly options: unknown) {
      super();
      host.windows.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
    }
    loadURL(url: string): Promise<void> {
      this.html = decodeURIComponent(url.split(",").slice(1).join(","));
      return Promise.resolve();
    }
  }
  return {
    BrowserWindow: FakeWindow,
    session: {
      fromPartition: vi.fn(() => {
        const isolated = {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          on: vi.fn(),
          clearStorageData: vi.fn().mockResolvedValue(undefined),
        };
        host.sessions.push(isolated);
        return isolated;
      }),
    },
  };
});

import {
  buildBiliCaptchaHtml,
  cancelBiliCaptcha,
  encryptBiliLogin,
  parseBiliCaptchaResult,
  solveBiliCaptcha,
} from "../../../electron/bilibili-login";

const challenge = { gt: "official-gt", challenge: "issued-challenge" };
const proof = {
  geetest_challenge: "solved-challenge",
  geetest_validate: "proof",
  geetest_seccode: "proof|jordan",
};

function callback(nonce: string, result: unknown = proof, state = "success"): string {
  const url = new URL("https://silvermoon.invalid/bili-captcha");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("state", state);
  url.searchParams.set("result", JSON.stringify(result));
  return url.href;
}

describe("Bilibili login encryption", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

  it("uses randomized PKCS#1 v1.5 encoding, preserving salt and UTF-8 password", () => {
    const text = "salt密码";
    const result = encryptBiliLogin(pem, [text, "device-random"]);
    expect(result).toHaveLength(2);
    expect(Buffer.from(result[0], "base64")).toHaveLength(128);
    const padded = privateDecrypt(
      { key: pair.privateKey, padding: constants.RSA_NO_PADDING },
      Buffer.from(result[0], "base64"),
    );
    expect([...padded.subarray(0, 2)]).toEqual([0, 2]);
    expect(padded.subarray(-Buffer.byteLength(text)).toString()).toBe(text);
    expect(encryptBiliLogin(pem, [text])[0]).not.toBe(result[0]);
  });

  it("rejects invalid keys and oversized values without echoing inputs", () => {
    expect(() => encryptBiliLogin("secret-invalid-key", ["secret-password"])).toThrow(
      "登录加密失败",
    );
    expect(() => encryptBiliLogin(pem, ["x".repeat(118)])).toThrow("登录加密失败");
    expect(() => encryptBiliLogin(pem, [])).toThrow("登录加密失败");
  });
});

describe("Geetest callback boundary", () => {
  it("accepts complete proof only from the nonce-bound callback", () => {
    expect(parseBiliCaptchaResult(callback("nonce"), "nonce")).toEqual({
      challenge: proof.geetest_challenge,
      validate: proof.geetest_validate,
      seccode: proof.geetest_seccode,
    });
    expect(() => parseBiliCaptchaResult(callback("old"), "new")).toThrow("响应无效");
    expect(() => parseBiliCaptchaResult("https://example.com/", "nonce")).toThrow("响应无效");
    expect(() => parseBiliCaptchaResult(callback("nonce", {}), "nonce")).toThrow("响应不完整");
    expect(() => parseBiliCaptchaResult(callback("nonce", null, "close"), "nonce")).toThrow(
      "[BILI_CAPTCHA_CANCELLED]",
    );
  });

  it("loads official Geetest scripts without allowing challenge HTML injection", () => {
    const html = buildBiliCaptchaHtml(
      { gt: "</script><script>evil()</script>", challenge: "c" },
      "n",
    );
    expect(html).toContain("https://static.geetest.com/static/js/fullpage.0.0.0.js");
    expect(html).toContain("https://api.geetest.com/gettype.php");
    expect(html).toContain(".onSuccess(()=>R('success',t.getValidate()))");
    expect(html).not.toContain("</script><script>evil()");
    expect(html).not.toContain("__SILVERMOON__");
  });
});

describe("isolated captcha window lifecycle", () => {
  let sender: EventEmitter & { id: number; isDestroyed: () => boolean };

  beforeEach(() => {
    vi.useFakeTimers();
    host.windows.length = 0;
    host.sessions.length = 0;
    host.parent = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    sender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false });
  });

  afterEach(() => {
    cancelBiliCaptcha(sender as Electron.WebContents, "request");
    vi.useRealTimers();
  });

  function window(): {
    options: { webPreferences: Record<string, unknown> };
    destroyed: boolean;
    html: string;
    webContents: EventEmitter;
  } {
    return host.windows[0] as ReturnType<typeof window>;
  }

  it("isolates third-party content and blocks the successful callback before navigation", async () => {
    const promise = solveBiliCaptcha(sender as Electron.WebContents, "request", challenge);
    expect(window().options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    });
    expect(window().options.webPreferences).not.toHaveProperty("preload");
    const configLine = window()
      .html.split("\n")
      .find((line) => line.startsWith("const config="))!;
    const config = JSON.parse(configLine.slice("const config=".length, -1)) as { nonce: string };
    const preventDefault = vi.fn();
    window().webContents.emit("will-frame-navigate", {
      preventDefault,
      isMainFrame: true,
      url: callback(config.nonce),
    });
    await expect(promise).resolves.toMatchObject({ validate: "proof" });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window().destroyed).toBe(true);
    expect(host.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect((host.parent as EventEmitter).listenerCount("closed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores cancellation from another sender or request, then cancels its own request", async () => {
    const promise = solveBiliCaptcha(sender as Electron.WebContents, "request", challenge);
    const rejected = expect(promise).rejects.toThrow("[BILI_CAPTCHA_CANCELLED]");
    cancelBiliCaptcha({ id: 99 } as Electron.WebContents, "request");
    cancelBiliCaptcha(sender as Electron.WebContents, "old-request");
    expect(window().destroyed).toBe(false);
    cancelBiliCaptcha(sender as Electron.WebContents, "request");
    await rejected;
    expect(window().destroyed).toBe(true);
  });

  it("allows official challenge subframes while keeping the main window isolated", async () => {
    const promise = solveBiliCaptcha(sender as Electron.WebContents, "request", challenge);
    const rejected = expect(promise).rejects.toThrow("[BILI_CAPTCHA_CANCELLED]");
    const preventDefault = vi.fn();
    window().webContents.emit("will-frame-navigate", {
      preventDefault,
      isMainFrame: false,
      url: "https://api.geetest.com/",
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(window().destroyed).toBe(false);
    cancelBiliCaptcha(sender as Electron.WebContents, "request");
    await rejected;
  });

  it("closes when the trusted owner is destroyed", async () => {
    const promise = solveBiliCaptcha(sender as Electron.WebContents, "request", challenge);
    const rejected = expect(promise).rejects.toThrow("[BILI_CAPTCHA_CANCELLED]");
    sender.emit("destroyed");
    await rejected;
    expect(window().destroyed).toBe(true);
  });

  it("times out with cleanup instead of leaving an abandoned modal window", async () => {
    const promise = solveBiliCaptcha(sender as Electron.WebContents, "request", challenge);
    const rejected = expect(promise).rejects.toThrow("已超时");
    vi.advanceTimersByTime(180000);
    await rejected;
    expect(window().destroyed).toBe(true);
  });
});
