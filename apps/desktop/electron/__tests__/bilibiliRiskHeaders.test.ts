import { beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ before: vi.fn() }));
vi.mock("electron", () => ({
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: hooks.before } } },
}));
vi.mock("../log", () => ({ log: { info: vi.fn() } }));
import { installBiliMediaHeaders, prepareBiliHttpHeaders } from "../net-headers";

const endpoint = "https://passport.bilibili.com/x/safecenter/common/sms/send";
const referer = "https://passport.bilibili.com/h5-app/passport/risk/verify?tmp_token=fixture";
beforeEach(() => vi.clearAllMocks());
function outgoing(url: string, requestHeaders: Record<string, string>) {
  installBiliMediaHeaders();
  const callback = vi.fn();
  hooks.before.mock.calls[0][1]({ url, requestHeaders }, callback);
  return callback.mock.calls[0][0].requestHeaders as Record<string, string> | undefined;
}
it("restores the risk Referer only at the Chromium header hook and strips the private marker", () => {
  const headers = { Referer: referer, Cookie: "fixture-only" };
  prepareBiliHttpHeaders(endpoint, headers);
  expect(headers).not.toHaveProperty("Referer");
  expect(outgoing(endpoint, headers)).toEqual({ Cookie: "fixture-only", Referer: referer });
});
it.each(["https://passport.bilibili.com/x/safecenter/login/tel/verify", endpoint])(
  "allows only the two safety endpoints: %s",
  (url) => {
    const headers = { referer };
    prepareBiliHttpHeaders(url, headers);
    expect(outgoing(url, headers)?.Referer).toBe(referer);
  },
);
it.each([
  "https://evil.invalid/h5-app/passport/risk/verify",
  "https://passport.bilibili.com.evil.invalid/h5-app/passport/risk/verify",
  "https://passport.bilibili.com/other",
])("rejects an invalid verification origin/path: %s", (invalid) => {
  const headers = { Referer: invalid };
  prepareBiliHttpHeaders(endpoint, headers);
  expect(outgoing(endpoint, headers)?.Referer).toBe("https://www.bilibili.com");
});
it("preserves the old default for QR, nav and media even with a supplied private marker", () => {
  for (const url of [
    "https://passport.bilibili.com/x/passport-tv-login/qrcode/poll",
    "https://api.bilibili.com/x/web-interface/nav",
    "https://example.bilivideo.com/video.m4s",
  ]) {
    const headers = { Referer: referer, "X-SilverMoon-Bili-Referer": referer };
    prepareBiliHttpHeaders(url, headers);
    expect(outgoing(url, headers)).toEqual({ Referer: "https://www.bilibili.com" });
  }
});
it("does not rewrite unrelated hosts or insecure media requests", () => {
  const headers = { Referer: "https://example.org" };
  prepareBiliHttpHeaders("https://example.org/api", headers);
  expect(headers.Referer).toBe("https://example.org");
  expect(outgoing("http://example.bilivideo.com/video.m4s", {})).toBeUndefined();
});
