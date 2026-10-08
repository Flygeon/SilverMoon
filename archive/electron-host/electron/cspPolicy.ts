/**
 * CSP 策略本身（纯数据，无任何 Electron 依赖）。
 *
 * 单独成文件的原因：这个文件会被单测直接 import。如果策略和 Electron 注入逻辑
 * 写在一起，顶层的 `import { session } from "electron"` 会让 vitest 试图加载真实的
 * Electron 二进制而挂起 —— 纯逻辑必须能脱离 Electron 测试。
 *
 * 「为什么分两步走」与逐条依据见 `csp.ts`。
 */

/** 在线内容源：图床、CDN、jsdelivr（AMLL 歌词库默认基址）、WebDAV。 */
export const NETWORK = ["https:", "data:", "blob:", "app:", "asset:", "app-cover:"];

/** 本地宿主服务与 Vite dev server。 */
export const LOCAL = ["'self'", "http://127.0.0.1:*", "http://localhost:*"];

/** 严格程度：report（只上报，默认）| enforce（强制阻断）。 */
export type CspMode = "report" | "enforce";

/**
 * 默认档位。
 *
 * 当前是 **report**（观察期）。观察期建议：
 * 1. 装发布版，各页面都点一遍（在线源、图片/视频、音乐、番剧、扩展、皮肤、写作、绘画）；
 * 2. 看 DevTools 控制台里的 "Refused to …" 报告；
 * 3. 确认只剩「有意为之」的违规后，把这里改成 "enforce"。
 *
 * 转强制只改这一行。
 */
export const CSP_MODE: CspMode = "report";

/** 生成策略字符串。 */
export function buildCsp(_mode: CspMode = CSP_MODE): string {
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'none'"]],
    // 不加 'unsafe-eval'：src/** 全量 grep 确认渲染层没有 eval / new Function /
    // WebAssembly。唯一用 eval 的 webview-preload 与 taglib-wasm 都在主进程侧。
    ["script-src", ["'self'"]],
    // 必须留 'unsafe-inline'：Vue <style scoped>、@m3e/web 的 adoptedStyleSheets、
    // 远程皮肤注入的 CSS 都要它，缺了整个界面会没有样式。
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["img-src", ["'self'", ...NETWORK]],
    ["media-src", ["'self'", ...NETWORK]],
    ["font-src", ["'self'", "data:", "https:"]],
    ["connect-src", [...LOCAL, ...NETWORK]],
    ["frame-src", ["'self'", "app:", "asset:", "https:"]],
    ["child-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'none'"]],
    ["frame-ancestors", ["'self'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** 取某条指令的取值列表（供单测断言用）。 */
export function cspDirective(name: string, policy = buildCsp()): string[] {
  const line = policy.split("; ").find((d) => d.startsWith(name + " "));
  return (line?.split(" ").slice(1) ?? []) as string[];
}
