import { callBridge } from "./bridge";

/** 官网负责完整验证，宿主仅返回经 nav 验证的 Cookie；不记录或直接写盘。 */
export function openBilibiliLogin(): Promise<Record<string, string> | null> {
  return callBridge("bilibiliLogin", { action: "open" });
}

export async function cancelBilibiliLogin(): Promise<void> {
  await callBridge("bilibiliLogin", { action: "cancel" });
}
