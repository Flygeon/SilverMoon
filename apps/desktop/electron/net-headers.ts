/**
 * B 站视频 CDN 的请求头改写。
 *
 * B 站 upos/bilivideo（以及 i0.hdslb.com 的封面）都做防盗链：**必须带
 * `Referer: https://www.bilibili.com`**，否则 403。而渲染进程里的 `<video>` /
 * `<img>` 无法自带请求头，宿主 http 通道也不适合给媒体流用（要透传 Range、
 * 且不能把整个视频读进内存）。
 *
 * 这里用 Electron 原生的 `webRequest.onBeforeSendHeaders` 统一改写 Referer：
 * - 过滤器限定 B 站域名，不影响其它站点；
 * - **强制改写**（不是「只补」）：页面自身会带一个 `app://silvermoon/` 或
 *   `http://localhost:1420/` 的 Referer，留着它 CDN 就会 403；
 * - 媒体地址在 `utils/bilibili.ts` 里已统一升级为 https —— Chromium 不允许在
 *   明文 http 请求上手动改写 Referer（实测 net::ERR_BLOCKED_BY_CLIENT）。
 */
import { session } from "electron";

import { log } from "./log";

const BILI_REFERER = "https://www.bilibili.com";

const BILI_HOST_FILTER = {
  urls: [
    "*://*.bilivideo.com/*",
    "*://*.bilivideo.cn/*",
    "*://*.hdslb.com/*",
    "*://*.bilibili.com/*",
  ],
};

/** 在 `app.whenReady()` 之后调用（需要 defaultSession 已就绪）。 */
export function installBiliMediaHeaders(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(BILI_HOST_FILTER, (details, callback) => {
    // 头名大小写不固定：先删掉可能存在的 referer/referrer，再统一写入
    const headers = details.requestHeaders;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "referer") delete headers[key];
    }
    headers.Referer = BILI_REFERER;
    callback({ requestHeaders: headers });
  });
  log.info("B 站媒体请求头改写已安装（自动补 Referer）");
}
