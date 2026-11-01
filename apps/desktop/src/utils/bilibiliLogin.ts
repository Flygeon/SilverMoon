/** PiliPlus lib/http/login.dart + pages/login/controller.dart 的桌面适配。 */
import { biliCreateLoginTransport, type BiliAccount } from "./bilibili";
import { md5 } from "./md5";
import { JsonStore } from "@/ipc/store";
import {
  biliCancelCaptcha,
  biliEncryptLogin,
  biliSolveCaptcha,
  type BiliCaptchaResult,
} from "@/ipc/bilibili-login";

const APP_KEY = "dfca71928277209b";
const APP_SECRET = "b5475a8825547a4fc26c7d518eaaa02e";
const UA =
  "Mozilla/5.0 BiliDroid/2.0.1 (bbcallen@gmail.com) os/android model/android_hd " +
  "mobi_app/android_hd build/2001100 channel/master innerVer/2001100 osVer/15 network/2";
const STATISTICS = '{"appId":5,"platform":3,"version":"2.0.1","abtest":""}';
type Json = Record<string, unknown>;
type Captcha = BiliCaptchaResult & { token: string };
type Device = { buvid: string; deviceId: string };
export type BiliLoginResult = { account: BiliAccount } | { riskPhone: string };

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function randomHex(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}

let devicePromise: Promise<Device> | undefined;
async function loginDevice(): Promise<Device> {
  return (devicePromise ??= (async () => {
    const store = new JsonStore("bilibili.json");
    const saved = await store.get<Device>("appLoginDevice").catch(() => null);
    if (saved && /^XY[0-9A-F]{35}$/.test(saved.buvid) && /^[0-9a-f]{64}$/.test(saved.deviceId)) {
      return saved;
    }
    const hex = randomHex(16).toUpperCase();
    const buvid = `XY${hex[2]}${hex[12]}${hex[22]}${hex}`;
    const now = new Date();
    const bcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)).toString(16).padStart(2, "0");
    const body =
      randomHex(16) +
      [
        Math.floor(now.getFullYear() / 100),
        now.getFullYear() % 100,
        now.getMonth() + 1,
        now.getDate(),
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
      ]
        .map(bcd)
        .join("") +
      randomHex(8);
    const bytes = body.match(/../g)!;
    const check = (bytes.reduce((sum, v) => sum + parseInt(v, 16), 0) & 255)
      .toString(16)
      .padStart(2, "0");
    const result = { buvid, deviceId: body + check };
    await store
      .set("appLoginDevice", result)
      .then(() => store.save())
      .catch(() => {});
    return result;
  })());
}

/** AppSign 空值参与签名时省略等号；实际表单仍交给 URLSearchParams 编码。 */
export function biliAppLoginSign(params: Record<string, string>): Record<string, string> {
  const signed = { ...params, appkey: APP_KEY, ts: String(Math.floor(Date.now() / 1000)) };
  const query = Object.entries(signed)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => encodeURIComponent(k) + (v ? `=${encodeURIComponent(v)}` : ""))
    .join("&");
  return { ...signed, sign: md5(query + APP_SECRET) };
}

function fail(json: Json, action: string): never {
  // 不拼接原响应／URL，防止服务端回显手机号、临时令牌或密码。
  const code = typeof json.code === "number" ? json.code : "无状态码";
  const hints: Record<string, string> = {
    "-629": "账号或密码错误",
    "-653": "账号或密码错误",
    "-662": "密码已加密但服务端拒绝，请重新尝试",
    "-105": "需要重新完成人机验证",
    "-449": "请求过于频繁，请稍后重试",
    "1006": "短信验证码错误",
    "1007": "短信验证码已过期，请重新获取",
    "86202": "短信验证码错误",
    "86203": "短信验证码已过期，请重新获取",
  };
  throw new Error(
    `${action}失败：${hints[String(code)] ?? "服务端拒绝了请求，请稍后重试"}（${code}）`,
  );
}
function ok(json: Json, action: string): Json {
  if (json.code !== 0) fail(json, action);
  return object(json.data);
}
function captchaFields(captcha?: Captcha): Record<string, string> {
  return captcha
    ? {
        gee_challenge: captcha.challenge,
        gee_validate: captcha.validate,
        gee_seccode: captcha.seccode,
        recaptcha_token: captcha.token,
      }
    : {};
}

/** 一次弹窗一个会话；关闭／切换方式会取消挑战并使所有在途结果失效。 */
export class BiliCredentialLogin {
  private active = true;
  private busy = false;
  private requestId = crypto.randomUUID();
  private transport = biliCreateLoginTransport();
  private sms?: { cid: string; tel: string; key: string; sentAt: number };
  private risk?: {
    tmpCode: string;
    requestId: string;
    source: string;
    url: string;
    key?: string;
    sentAt?: number;
  };

  dispose(): void {
    this.active = false;
    this.sms = undefined;
    this.risk = undefined;
    void biliCancelCaptcha(this.requestId).catch(() => {});
  }
  resetSms(): void {
    this.sms = undefined;
  }
  private current(): void {
    if (!this.active) throw new Error("登录已取消");
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    this.current();
    if (this.busy) throw new Error("请等待当前登录操作完成");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  private async request(
    path: string,
    params?: Record<string, string>,
    referer?: string,
  ): Promise<Json> {
    this.current();
    const device = await loginDevice();
    this.current();
    const transport = await this.transport;
    const mobile = [
      "/x/passport-login/oauth2/login",
      "/x/passport-login/sms/send",
      "/x/passport-login/login/sms",
      "/x/passport-login/oauth2/access_token",
    ].includes(path);
    const unsigned = path === "/x/safecenter/captcha/pre";
    const json = await transport.request(path, {
      method: params ? "POST" : "GET",
      headers: {
        "User-Agent": mobile ? UA : "Dart/3.6 (dart:io)",
        env: "prod",
        "app-key": "android64",
        "x-bili-aurora-zone": "sh001",
        ...(mobile
          ? {
              buvid: device.buvid,
              "x-bili-aurora-eid": "",
              "x-bili-trace-id": "11111111111111111111111111111111:1111111111111111:0:0",
              "bili-http-engine": "cronet",
            }
          : {}),
        ...(params ? { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" } : {}),
        Referer: referer ?? "https://www.bilibili.com",
      },
      ...(params
        ? { body: unsigned ? "" : new URLSearchParams(biliAppLoginSign(params)).toString() }
        : {}),
    });
    this.current();
    return json;
  }
  private async base(): Promise<Record<string, string>> {
    const { buvid } = await loginDevice();
    this.current();
    return {
      build: "2001100",
      buvid,
      local_id: buvid,
      c_locale: "zh_CN",
      s_locale: "zh_CN",
      channel: "master",
      disable_rcmd: "0",
      mobi_app: "android_hd",
      platform: "android",
      statistics: STATISTICS,
    };
  }
  private async deviceFields(key: string): Promise<Record<string, string>> {
    const { deviceId } = await loginDevice();
    const [dt] = await biliEncryptLogin(key, [randomHex(8)]);
    this.current();
    return {
      bili_local_id: deviceId,
      device_id: deviceId,
      device: "phone",
      device_name: "vivo",
      device_platform: "Android14vivo",
      dt: encodeURIComponent(dt),
    };
  }
  private async challenge(data: Json, fallback = false): Promise<Captcha> {
    let gt = string(data.gee_gt);
    let challenge = string(data.gee_challenge);
    let token = string(data.recaptcha_token);
    const raw = string(data.recaptcha_url) || string(data.url);
    if (raw) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("人机验证地址无效，请重试");
      }
      if (url.origin !== "https://passport.bilibili.com") throw new Error("人机验证地址无效");
      gt = url.searchParams.get("gee_gt") ?? "";
      challenge = url.searchParams.get("gee_challenge") ?? "";
      token = url.searchParams.get("recaptcha_token") ?? "";
    }
    if ((!gt || !challenge || !token) && fallback) {
      return this.challenge(
        ok(await this.request("/x/safecenter/captcha/pre", {}), "获取人机验证"),
      );
    }
    if (!gt || !challenge || !token) throw new Error("人机验证参数不完整，请重新尝试");
    const result = await biliSolveCaptcha({ gt, challenge }, this.requestId);
    this.current();
    if (!result.challenge || !result.validate || !result.seccode) throw new Error("人机验证未完成");
    return { ...result, token };
  }
  private async finish(json: Json): Promise<BiliLoginResult> {
    const data = ok(json, "登录");
    if (data.status === 2 || data.status === 3) {
      let url: URL;
      try {
        url = new URL(string(data.url));
      } catch {
        throw new Error("手机号安全验证地址缺失，请重新登录");
      }
      if (url.origin !== "https://passport.bilibili.com") throw new Error("手机号安全验证地址无效");
      const tmpCode = url.searchParams.get("tmp_token") ?? "";
      const requestId = url.searchParams.get("request_id") ?? "";
      const source = url.searchParams.get("source") ?? "";
      if (!tmpCode || !requestId || !source) throw new Error("手机号安全验证参数不完整");
      const info = ok(
        await this.request(`/x/safecenter/user/info?tmp_code=${encodeURIComponent(tmpCode)}`),
        "获取安全验证信息",
      );
      const account = object(info.account_info);
      if (account.tel_verify !== true || !string(account.hide_tel)) {
        throw new Error("此账号暂不支持绑定手机号验证，请使用扫码登录");
      }
      this.risk = { tmpCode, requestId, source, url: url.href };
      return { riskPhone: string(account.hide_tel) };
    }
    const account = await (await this.transport).commit(data, () => this.active);
    this.current();
    this.sms = undefined;
    this.risk = undefined;
    return { account };
  }
  password(username: string, password: string): Promise<BiliLoginResult> {
    return this.run(async () => {
      if (!username.trim() || !password) throw new Error("请输入账号和密码");
      let captcha: Captcha | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const key = ok(await this.request("/x/passport-login/web/key"), "获取加密密钥");
        if (!string(key.key) || !string(key.hash)) throw new Error("登录加密密钥不完整");
        const [encrypted] = await biliEncryptLogin(string(key.key), [string(key.hash) + password]);
        this.current();
        const json = await this.request("/x/passport-login/oauth2/login", {
          ...(await this.base()),
          ...(await this.deviceFields(string(key.key))),
          ...captchaFields(captcha),
          username: username.trim(),
          password: encrypted,
          permission: "ALL",
          from_pv: "main.homepage.avatar-nologin.all.click",
          from_url: encodeURIComponent("bilibili://pegasus/promo"),
        });
        if (json.code !== -105 || attempt === 1) return this.finish(json);
        captcha = await this.challenge(object(json.data));
      }
      throw new Error("请重新完成人机验证");
    });
  }
  sendSms(cid: string, tel: string): Promise<void> {
    return this.run(async () => {
      if (!/^\d{1,4}$/.test(cid) || !/^\d{5,20}$/.test(tel))
        throw new Error("请输入有效的区号和手机号");
      if (this.sms && Date.now() - this.sms.sentAt < 60000) throw new Error("请稍后再获取验证码");
      this.sms = undefined;
      let captcha: Captcha | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const base = await this.base();
        const json = await this.request("/x/passport-login/sms/send", {
          ...base,
          cid,
          tel,
          login_session_id: md5(base.buvid + Date.now()),
          ...captchaFields(captcha),
        });
        const data = object(json.data);
        if (json.code === 0 && !string(data.recaptcha_url) && string(data.captcha_key)) {
          this.sms = { cid, tel, key: string(data.captcha_key), sentAt: Date.now() };
          return;
        }
        if (![0, -105].includes(Number(json.code)) || attempt === 1) fail(json, "发送短信");
        captcha = await this.challenge(data, true);
      }
    });
  }
  smsLogin(cid: string, tel: string, code: string): Promise<BiliLoginResult> {
    return this.run(async () => {
      const sms = this.sms;
      if (!sms || sms.cid !== cid || sms.tel !== tel) throw new Error("请先为当前手机号获取验证码");
      if (Date.now() - sms.sentAt > 300000) {
        this.sms = undefined;
        throw new Error("验证码已过期，请重新获取");
      }
      if (!/^\d{4,8}$/.test(code)) throw new Error("请输入有效的短信验证码");
      const key = ok(await this.request("/x/passport-login/web/key"), "获取加密密钥");
      return this.finish(
        await this.request("/x/passport-login/login/sms", {
          ...(await this.base()),
          ...(await this.deviceFields(string(key.key))),
          cid,
          tel,
          code,
          captcha_key: sms.key,
          from_pv: "main.my-information.my-login.0.click",
          from_url: encodeURIComponent("bilibili://user_center/mine"),
        }),
      );
    });
  }
  sendRiskSms(): Promise<void> {
    return this.run(async () => {
      const risk = this.risk;
      if (!risk) throw new Error("请重新登录以获取安全验证");
      if (risk.sentAt && Date.now() - risk.sentAt < 60000) throw new Error("请稍后再获取验证码");
      risk.key = undefined;
      const captcha = await this.challenge(
        ok(await this.request("/x/safecenter/captcha/pre", {}), "获取人机验证"),
      );
      const data = ok(
        await this.request(
          "/x/safecenter/common/sms/send",
          {
            disable_rcmd: "0",
            sms_type: "loginTelCheck",
            tmp_code: risk.tmpCode,
            ...captchaFields(captcha),
          },
          risk.url,
        ),
        "发送安全验证短信",
      );
      if (!string(data.captcha_key)) throw new Error("未获取到短信验证凭据，请重新发送");
      risk.key = string(data.captcha_key);
      risk.sentAt = Date.now();
    });
  }
  verifyRisk(code: string): Promise<BiliLoginResult> {
    return this.run(async () => {
      const risk = this.risk;
      if (!risk?.key || !risk.sentAt) throw new Error("请先获取安全验证短信");
      if (Date.now() - risk.sentAt > 300000) {
        risk.key = undefined;
        throw new Error("验证码已过期，请重新获取");
      }
      if (!/^\d{4,8}$/.test(code)) throw new Error("请输入有效的短信验证码");
      const data = ok(
        await this.request(
          "/x/safecenter/login/tel/verify",
          {
            type: "loginTelCheck",
            code,
            tmp_code: risk.tmpCode,
            request_id: risk.requestId,
            source: risk.source,
            captcha_key: risk.key,
          },
          risk.url,
        ),
        "验证手机号",
      );
      if (!string(data.code)) throw new Error("手机号验证未返回授权码，请重新登录");
      risk.key = undefined;
      const { buvid } = await loginDevice();
      return this.finish(
        await this.request("/x/passport-login/oauth2/access_token", {
          build: "2001100",
          buvid,
          code: string(data.code),
          disable_rcmd: "0",
          grant_type: "authorization_code",
          local_id: buvid,
          mobi_app: "android_hd",
          platform: "android",
        }),
      );
    });
  }
}
