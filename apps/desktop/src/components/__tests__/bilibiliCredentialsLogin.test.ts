// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import BilibiliCredentialsLogin from "../BilibiliCredentialsLogin.vue";

const auth = vi.hoisted(() => ({
  password: vi.fn(),
  sendSms: vi.fn(),
  smsLogin: vi.fn(),
  sendRiskSms: vi.fn(),
  verifyRisk: vi.fn(),
  resetSms: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@/utils/bilibiliLogin", () => ({
  BiliCredentialLogin: class {
    password = auth.password;
    sendSms = auth.sendSms;
    smsLogin = auth.smsLogin;
    sendRiskSms = auth.sendRiskSms;
    verifyRisk = auth.verifyRisk;
    resetSms = auth.resetSms;
    dispose = auth.dispose;
  },
}));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));
let app: App;
let host: HTMLElement;
const success = vi.fn();
function mount(method: "password" | "sms") {
  app = createApp(BilibiliCredentialsLogin, { method, onSuccess: success });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
}
async function input(name: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
function submit() {
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  auth.sendSms.mockResolvedValue(undefined);
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.useRealTimers();
});

it("submits by Enter outside IME composition and clears the password immediately", async () => {
  let finish!: (value: unknown) => void;
  auth.password.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount("password");
  await input("username", "fixture");
  await input("password", "secret");
  const password = host.querySelector<HTMLInputElement>("input[name=password]")!;
  password.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  expect(auth.password).not.toHaveBeenCalled();
  password.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  expect(auth.password).toHaveBeenCalledWith("fixture", "secret");
  expect(password.value).toBe("");
  submit();
  expect(auth.password).toHaveBeenCalledTimes(1);
  finish({ account: { isLogin: true, mid: 42 } });
  await settle();
  expect(success).toHaveBeenCalledWith({ isLogin: true, mid: 42 });
});

it("shows bound-phone verification without emitting login success", async () => {
  auth.password.mockResolvedValue({ riskPhone: "138****0000" });
  auth.sendRiskSms.mockResolvedValue(undefined);
  auth.verifyRisk.mockResolvedValue({ account: { isLogin: true, mid: 42 } });
  mount("password");
  await input("username", "fixture");
  await input("password", "secret");
  submit();
  await settle();
  expect(success).not.toHaveBeenCalled();
  expect(host.textContent).toContain("138****0000");
  host.querySelector<HTMLElement>(".code-fields m3e-button")!.click();
  await settle();
  expect(auth.sendRiskSms).toHaveBeenCalledTimes(1);
  await input("code", "123456");
  submit();
  await settle();
  expect(auth.verifyRisk).toHaveBeenCalledWith("123456");
  expect(success).toHaveBeenCalledTimes(1);
});

it("starts the SMS cooldown only on delivery and clears proof when the phone changes", async () => {
  auth.sendSms.mockRejectedValueOnce(new Error("发送失败"));
  mount("sms");
  await input("tel", "13800000000");
  const send = host.querySelector<HTMLElement>(".code-fields m3e-button")!;
  send.click();
  await settle();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("发送失败");
  expect(send.textContent).not.toContain("60s");
  send.click();
  await settle();
  expect(send.textContent).toContain("60s");
  await vi.advanceTimersByTimeAsync(1000);
  expect(send.textContent).toContain("59s");
  await input("code", "123456");
  await input("tel", "13800000001");
  expect(auth.resetSms).toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>("input[name=code]")!.value).toBe("");
  expect(send.textContent).not.toContain("59s");
});

it("disposes on close and ignores a late success", async () => {
  let finish!: (value: unknown) => void;
  auth.password.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount("password");
  await input("username", "fixture");
  await input("password", "secret");
  submit();
  app.unmount();
  expect(auth.dispose).toHaveBeenCalledTimes(1);
  finish({ account: { isLogin: true, mid: 42 } });
  await settle();
  expect(success).not.toHaveBeenCalled();
});
