/**
 * CSP 注入（主进程侧）。
 *
 * ## 为什么分两步走
 *
 * 一上来就强制 CSP 的风险很大：这个应用的内容面极宽 —— 在线图床/CDN、jsdelivr 上的
 * AMLL 歌词库、远程皮肤注入的 CSS、blob: 的 MSE 视频、data: 的内联占位图、
 * 扩展宿主的 iframe、番剧取流页。策略一旦漏掉一项，表现是「某处图不出来了」，
 * 而且只有装了发布版、切到对应页面才复现 —— 本机根本验不了。
 *
 * 所以做成两档：
 * - **默认 Report-Only**：违规只上报到控制台，**不阻断**任何功能。
 *   跑一段时间、把真实使用路径都覆盖到之后，确认没有意外违规再转强制。
 * - **强制**：把 `cspPolicy.ts` 里的 `CSP_MODE` 改成 `"enforce"`。
 *
 * 策略逐条依据见 `cspPolicy.ts`（那里也解释了为什么 script-src 可以收得那么紧）。
 */
import { session } from "electron";

import { buildCsp, CSP_MODE, type CspMode } from "./cspPolicy";
import { log } from "./log";

let applied = false;

/**
 * 给默认会话装上 CSP。
 *
 * 通过 onHeadersReceived 注入，因此**只作用于我们自己提供的 app:// 页面**，
 * 不会去动番剧 / Pixiv / 文库8 这些**远程页**（它们自己管自己的策略，
 * 给第三方页面强加我们的策略既无意义，也可能直接搞坏它们）。
 *
 * Report 阶段只看**浏览器控制台**的 "Refused to …" 报告。刻意不配 report-uri：
 * 本地宿主服务只回 JSON、不收报告，配一个不存在的端点只会让人误以为报告已上报。
 */
export function installCsp(mode: CspMode = CSP_MODE): void {
  if (applied) return;
  applied = true;

  const policy = buildCsp(mode);
  log.info(`[CSP] 模式=${mode} 策略=${policy}`);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith("app://")) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = { ...details.responseHeaders };
    // report 阶段用 xxx-前缀，不影响渲染；转强制后改回正式头名。
    const name =
      mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
    headers[name] = [policy];
    callback({ responseHeaders: headers });
  });
}
