import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { BiliCredentialLogin, biliAppLoginSign } from "../bilibiliLogin";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  commit: vi.fn(),
  encrypt: vi.fn(),
  solve: vi.fn(),
  cancel: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../bilibili", () => ({
  biliCreateLoginTransport: async () => ({ request: mocks.request, commit: mocks.commit }),
}));
vi.mock("@/ipc/bilibili-login", () => ({
  biliEncryptLogin: mocks.encrypt,
  biliSolveCaptcha: mocks.solve,
  biliCancelCaptcha: mocks.cancel,
}));
vi.mock("@/ipc/store", () => ({
  JsonStore: class {
    get = async () => null;
    set = mocks.set;
    save = mocks.save;
  },
}));
const key = { code: 0, data: { key: "fixture-public-key", hash: "fixture-salt" } };
const authorized = {
  code: 0,
  data: { token_info: { access_token: "fixture-token" }, cookie_info: {} },
};
const captchaUrl =
  "https://passport.bilibili.com/captcha?gee_gt=gt&gee_challenge=challenge&recaptcha_token=token";
const riskUrl =
  "https://passport.bilibili.com/h5-app/passport/risk/verify?tmp_token=tmp&request_id=request&source=risk";
function body(call: number): URLSearchParams {
  return new URLSearchParams(mocks.request.mock.calls[call][1].body);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.encrypt.mockImplementation(async (_key, values: string[]) =>
    values.map(() => "rsa+fixture/="),
  );
  mocks.solve.mockResolvedValue({
    challenge: "challenge",
    validate: "validate",
    seccode: "validate|jordan",
  });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.commit.mockResolvedValue({ isLogin: true, mid: 42, name: "fixture" });
  mocks.set.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("PiliPlus password and SMS login", () => {
  it("signs sorted URI components and omits equals only for empty signature values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const signed = biliAppLoginSign({ username: "a+b@例子.cn", empty: "" });
    const query = `appkey=dfca71928277209b&empty&ts=${signed.ts}&username=${encodeURIComponent("a+b@例子.cn")}`;
    expect(signed.sign).toBe(
      createHash("md5")
        .update(query + "b5475a8825547a4fc26c7d518eaaa02e")
        .digest("hex"),
    );
  });
  it("fetches a fresh salt/key after captcha, encrypts the password, and signs the final form", async () => {
    mocks.request
      .mockResolvedValueOnce(key)
      .mockResolvedValueOnce({ code: -105, data: { url: captchaUrl } })
      .mockResolvedValueOnce({ code: 0, data: { key: "new-key", hash: "new-salt" } })
      .mockResolvedValueOnce(authorized);
    const login = new BiliCredentialLogin();
    const result = await login.password("fixture-user", "fixture-secret");
    expect(result).toHaveProperty("account.isLogin", true);
    expect(mocks.encrypt).toHaveBeenCalledWith("fixture-public-key", [
      "fixture-saltfixture-secret",
    ]);
    expect(mocks.encrypt).toHaveBeenCalledWith("new-key", ["new-saltfixture-secret"]);
    expect(body(1).get("password")).toBe("rsa+fixture/=");
    expect(body(1).toString()).not.toContain("fixture-secret");
    expect(body(3).get("gee_validate")).toBe("validate");
    expect(body(3).get("recaptcha_token")).toBe("token");
    expect(body(3).get("dt")).toBe(encodeURIComponent("rsa+fixture/="));
    expect(body(3).get("device_id")).toMatch(/^[0-9a-f]{64}$/);
    const params = Object.fromEntries(body(3));
    const sign = params.sign;
    delete params.sign;
    expect(sign).toBe(biliAppLoginSign(params).sign);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.set.mock.calls.flat().join(" ")).not.toContain("fixture-secret");
  });
  it("does not recursively retry repeated captcha failures", async () => {
    mocks.request
      .mockResolvedValueOnce(key)
      .mockResolvedValueOnce({ code: -105, data: { url: captchaUrl } })
      .mockResolvedValueOnce(key)
      .mockResolvedValueOnce({ code: -105, data: { url: captchaUrl } });
    await expect(new BiliCredentialLogin().password("fixture", "secret")).rejects.toThrow(
      "人机验证",
    );
    expect(mocks.solve).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("captcha cancellation sends no second password request", async () => {
    mocks.request
      .mockResolvedValueOnce(key)
      .mockResolvedValueOnce({ code: -105, data: { url: captchaUrl } });
    mocks.solve.mockRejectedValueOnce(new Error("验证已取消"));
    await expect(new BiliCredentialLogin().password("fixture", "secret")).rejects.toThrow("取消");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("SMS challenge code=0 is not success; cooldown starts only after actual SMS delivery", async () => {
    mocks.request
      .mockResolvedValueOnce({ code: 0, data: { recaptcha_url: captchaUrl } })
      .mockResolvedValueOnce({ code: 0, data: { recaptcha_url: "", captcha_key: "sms-key" } })
      .mockResolvedValueOnce(key)
      .mockResolvedValueOnce(authorized);
    const login = new BiliCredentialLogin();
    await login.sendSms("86", "13800000000");
    expect(mocks.solve).toHaveBeenCalledTimes(1);
    expect(body(1).get("gee_seccode")).toBe("validate|jordan");
    await expect(login.sendSms("86", "13800000000")).rejects.toThrow("稍后");
    await expect(login.smsLogin("86", "13800000001", "123456")).rejects.toThrow("当前手机号");
    await login.smsLogin("86", "13800000000", "123456");
    expect(body(3).get("captcha_key")).toBe("sms-key");
    expect(body(3).get("cid")).toBe("86");
  });
  it("falls back to pre-captcha only for an incomplete SMS challenge", async () => {
    mocks.request
      .mockResolvedValueOnce({ code: -105, data: {} })
      .mockResolvedValueOnce({
        code: 0,
        data: { gee_gt: "gt", gee_challenge: "challenge", recaptcha_token: "token" },
      })
      .mockResolvedValueOnce({ code: 0, data: { captcha_key: "sms-key" } });
    await new BiliCredentialLogin().sendSms("86", "13800000000");
    expect(mocks.request.mock.calls[1][0]).toBe("/x/safecenter/captcha/pre");
    expect(mocks.solve).toHaveBeenCalledTimes(1);
  });
  it("allows retry after failed SMS delivery and invalidates codes after phone edits", async () => {
    mocks.request
      .mockResolvedValueOnce({ code: -449 })
      .mockResolvedValueOnce({ code: 0, data: { captcha_key: "sms-key" } });
    const login = new BiliCredentialLogin();
    await expect(login.sendSms("86", "13800000000")).rejects.toThrow("频繁");
    await login.sendSms("86", "13800000000");
    login.resetSms();
    await expect(login.smsLogin("86", "13800000000", "123456")).rejects.toThrow("获取验证码");
  });
  it("rejects expired SMS proof before requesting keys or submitting an OTP", async () => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValueOnce({ code: 0, data: { captcha_key: "sms-key" } });
    const login = new BiliCredentialLogin();
    await login.sendSms("86", "13800000000");
    vi.setSystemTime(Date.now() + 300001);
    await expect(login.smsLogin("86", "13800000000", "123456")).rejects.toThrow("过期");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it.each([2, 3])(
    "handles risk status %s through captcha, SMS verify and oauth exchange before committing",
    async (status) => {
      mocks.request
        .mockResolvedValueOnce(key)
        .mockResolvedValueOnce({ code: 0, data: { status, url: riskUrl } })
        .mockResolvedValueOnce({
          code: 0,
          data: { account_info: { tel_verify: true, hide_tel: "138****0000" } },
        })
        .mockResolvedValueOnce({
          code: 0,
          data: { gee_gt: "gt", gee_challenge: "challenge", recaptcha_token: "token" },
        })
        .mockResolvedValueOnce({ code: 0, data: { captcha_key: "risk-key" } })
        .mockResolvedValueOnce({ code: 0, data: { code: "oauth-code" } })
        .mockResolvedValueOnce(authorized);
      const login = new BiliCredentialLogin();
      await expect(login.password("fixture", "secret")).resolves.toEqual({
        riskPhone: "138****0000",
      });
      expect(mocks.commit).not.toHaveBeenCalled();
      await expect(login.verifyRisk("123456")).rejects.toThrow("先获取");
      await login.sendRiskSms();
      expect(body(4).get("tmp_code")).toBe("tmp");
      expect(body(4).get("gee_validate")).toBe("validate");
      expect(mocks.request.mock.calls[4][1].headers.Referer).toBe(riskUrl);
      await login.verifyRisk("123456");
      expect(body(5).get("request_id")).toBe("request");
      expect(body(5).get("captcha_key")).toBe("risk-key");
      expect(body(6).get("grant_type")).toBe("authorization_code");
      expect(body(6).get("code")).toBe("oauth-code");
      expect(mocks.commit).toHaveBeenCalledTimes(1);
    },
  );
  it("disposal cancels captcha and ignores a late successful password response", async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockResolvedValueOnce(key).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const login = new BiliCredentialLogin();
    const pending = login.password("fixture", "secret");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    login.dispose();
    finish(authorized);
    await expect(pending).rejects.toThrow("取消");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
