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

/*
 * ⚠️ `*://*.bilibili.com/*` **必须**留在 filter 里。这不是"顺带覆盖"，而是必需：
 *
 * Chromium 把 `Referer` 视为 **forbidden request header** —— 通过 `net.fetch`
 * 的 headers 传它，整个请求会被判 `net::ERR_BLOCKED_BY_CLIENT`（不可读的错误）。
 *
 * 而 B 站的空间/历史/收藏夹接口**必须**带 Referer（缺了回 -352/-799）。
 *
 * 所以 Referer 只能由 `onBeforeSendHeaders` 在 Chromium 网络层补 ——
 * 而它**只对 filter 命中的 URL 生效**。一旦把 bilibili.com 从 filter 里去掉，
 * 接口请求就会带着 net.fetch 传入的 Referer 出发 → 直接 BLOCKED。
 *
 * 这个教训第 20 行注释早就写过（forbidden header → BLOCKED_BY_CLIENT），
 * 但只在"媒体地址要升级 https"的语境里提，没点明**接口 Referer 也必须走拦截器**。
 * 曾经为"收窄打击面"把 bilibili.com 摘出去，结果正是把能用的路径改坏了。
 */
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
    /*
     * ⚠️ 明文 http 请求**一律放行，不改头**。
     *
     * Chromium 不允许在非安全来源的请求上手动改写 Referer：一旦改了，
     * 整个请求会被直接判成 `net::ERR_BLOCKED_BY_CLIENT`，而不是回一个
     * 可读的 4xx。这个错误在界面上的表现就是「网络请求全挂」——
     * B 站扫码登录没反应、视频播不出来，根源都在这里。
     *
     * 之前只靠「媒体地址在 utils/bilibili.ts 里统一升级成 https」来规避，
     * 但那是**调用方约定**：只要有一个 http 地址漏上来（B 站偶尔会下发
     * http 的 upos 备份地址），整条链路就被这个拦截器毒死。
     * 在这里兜底更稳：http 请求保持原样，宁可让它 403（可读），
     * 也不要变成 BLOCKED（不可读）。
     */
    if (!details.url.startsWith("https://")) {
      callback({});
      return;
    }

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
