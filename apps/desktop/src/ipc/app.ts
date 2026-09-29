/**
 * 应用元信息与退出。
 *
 * 版本号来自 `backend/silvermoon.config.json`（后端编译期读同一份），
 * 前端皮肤校验用它做 `minAppVersion` 判断。
 */
import { callBridge } from "./bridge";

/** 应用版本号（来自 `silvermoon.config.json`，与 package.json 同源） */
export async function getVersion(): Promise<string> {
  return callBridge<string>("app", { op: "version" });
}

/** 应用名 */
export async function getName(): Promise<string> {
  return callBridge<string>("app", { op: "name" });
}

/** 宿主（Electron）版本号，用于诊断上报。 */
export async function getHostVersion(): Promise<string> {
  return callBridge<string>("app", { op: "hostVersion" });
}

/** 退出应用 */
export async function exit(code = 0): Promise<void> {
  await callBridge("app", { op: "exit", code });
}
