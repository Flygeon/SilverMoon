/**
 * 网络代理的宿主桥（渲染进程 → 主进程）。
 *
 * 只作用于 Chromium 网络栈；Rust 侧的番剧抓取有独立配置，见
 * `capabilities.networkConfigure`（走 `net_set_proxy` 命令）。设置页保存时
 * 两条通道都要推一次，缺一条就会出现「一部分请求走了代理、另一部分没走」。
 */
import { callBridge } from "./bridge";

export type ProxyMode = "system" | "custom" | "none";

/** 让 Electron 的默认 session 按设置切换代理（system / custom / none）。 */
export function configureHostProxy(mode: ProxyMode, url: string): Promise<void> {
  return callBridge("netProxy", { mode, url });
}
