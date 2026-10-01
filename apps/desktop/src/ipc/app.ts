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

/**
 * 清空在线封面磁盘缓存（主进程 `<cache>/covers`），返回释放的字节数。
 * 非桌面环境（浏览器预览）下返回 0。
 */
export async function clearCoverCache(): Promise<number> {
  const freed = await callBridge<number | null>("app", { op: "clearCoverCache" });
  return freed ?? 0;
}
