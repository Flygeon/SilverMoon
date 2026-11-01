import { callBridge, hasBridge } from "./bridge";

export interface BiliCaptchaChallenge {
  gt: string;
  challenge: string;
}

export interface BiliCaptchaResult {
  challenge: string;
  validate: string;
  seccode: string;
}

function requireDesktop(): void {
  if (!hasBridge()) throw new Error("请在银月桌面应用中使用密码、短信及人机验证登录");
}

export function biliSolveCaptcha(
  challenge: BiliCaptchaChallenge,
  requestId: string,
): Promise<BiliCaptchaResult> {
  requireDesktop();
  return callBridge("bilibiliLogin", { op: "captcha", challenge, requestId });
}

export async function biliCancelCaptcha(requestId: string): Promise<void> {
  if (hasBridge()) await callBridge("bilibiliLogin", { op: "cancel", requestId });
}

export function biliEncryptLogin(key: string, values: string[]): Promise<string[]> {
  requireDesktop();
  return callBridge("bilibiliLogin", { op: "encrypt", key, values });
}
