import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Tauri 版 CSP 策略的静态守卫。
 *
 * 背景：项目从 Electron 44 迁回 Tauri 2。Electron 时代的策略在
 * `archive/electron-host/electron/cspPolicy.ts`（纯数据 + 逐条注释），
 * 注入逻辑在同目录 `csp.ts`。Tauri 2 的 `tauri.conf.json` 支持 `csp` 字段，
 * 会作为 `Content-Security-Policy` 响应头注入主窗口 webview ——
 * 注意 Tauri **只支持强制模式**，没有 report-only 档位。
 *
 * ## Electron → Tauri 的适配（与归档策略的差异）
 *
 * 1. **删掉 `app:`**：Electron 时代页面跑在 `app://`，Tauri 2 主窗口跑在
 *    `https://tauri.localhost`（`'self'` 即它）。grep 确认 `app:` 不再作为
 *    URL scheme 使用（仅剩 `app:player-command` 这种事件名）。
 * 2. **补上 Windows 下的 `http://<scheme>.localhost` 形态**：Tauri 的自定义
 *    协议在 Windows 上实际走 `http://app-cover.localhost` /
 *    `http://asset.localhost` / `http://ext.localhost`（Linux/macOS 才走
 *    `app-cover://` 这种原生 scheme）。只写 scheme 名在 Windows 上会放行失败。
 *    依据：`src-tauri/src/cover.rs`、`src-tauri/src/ext_protocol.rs` 头部注释。
 * 3. **`frame-src` 加 `ext:`**：扩展 UI 跑在独立 origin 的 iframe 里
 *   （`src/views/PluginHost.vue`），Electron 时代对应的是 `app:`。
 * 4. **`connect-src` 加 `ws://localhost:*`**：Electron 的注入逻辑只对 `app://`
 *    生效，dev 模式（Vite dev server）天然没有 CSP；Tauri 的 `csp` 配置连 dev
 *    模式一起注入，没有这条 Vite HMR 的 WebSocket 会被拦掉。
 * 5. **`media-src` 加 `http://127.0.0.1:*`**：WebDAV 媒体走 127.0.0.1 本地代理
 *    流式播放（`src/utils/webdav.ts`），番剧/SMTC 也有 127.0.0.1 服务。
 *
 * ## 模式说明（report-only vs enforce）
 *
 * Electron 时代策略默认 report-only（观察期），由 `cspPolicy.ts` 的 `CSP_MODE`
 * 常量切换。Tauri 的 `csp` 字段**不支持** report-only —— 它就是标准强制头。
 * 迁移时策略已经在 Electron 生产版跑过观察期，且本次 CI 全绿，所以直接按
 * enforce 落盘。如果上线后发现某处资源被拦：
 * 1. 临时把 `tauri.conf.json` 的 `csp` 改回 `null`，看 DevTools 控制台的
 *    "Refused to …" 定位缺的来源；
 * 2. 补到策略里，并同步更新本文件的断言。
 */

const CONF_PATH = fileURLToPath(new URL("../../src-tauri/tauri.conf.json", import.meta.url));

function loadCsp(): string {
  const conf = JSON.parse(readFileSync(CONF_PATH, "utf8"));
  const csp: unknown = conf?.app?.security?.csp;
  expect(typeof csp, "tauri.conf.json 里 app.security.csp 必须是字符串").toBe("string");
  return csp as string;
}

/** 取某条指令的取值列表（与归档的 cspDirective 同语义）。 */
function cspDirective(name: string, policy: string): string[] {
  const line = policy.split("; ").find((d) => d.startsWith(name + " "));
  return line?.split(" ").slice(1) ?? [];
}

describe("Tauri CSP 策略", () => {
  it("csp 已配置（非 null），且以 default-src 'none' 开头", () => {
    const policy = loadCsp();
    expect(policy.length).toBeGreaterThan(0);
    expect(cspDirective("default-src", policy)).toEqual(["'none'"]);
  });

  it("script-src 只允许 self —— 拒绝远程脚本，也拒绝 eval", () => {
    const policy = loadCsp();
    expect(cspDirective("script-src", policy)).toEqual(["'self'"]);
    expect(policy).not.toContain("unsafe-eval");
  });

  it("object-src / form-action 锁死，base-uri 收紧", () => {
    const policy = loadCsp();
    expect(cspDirective("object-src", policy)).toEqual(["'none'"]);
    expect(cspDirective("form-action", policy)).toEqual(["'none'"]);
    expect(cspDirective("base-uri", policy)).toEqual(["'self'"]);
  });

  it("style-src 必须留 unsafe-inline，否则界面会没有样式", () => {
    // Vue <style scoped> / @m3e/web adoptedStyleSheets / 远程皮肤注入都要它
    expect(cspDirective("style-src", loadCsp())).toContain("'unsafe-inline'");
  });

  it("在线内容源必须放行，否则封面与视频全挂", () => {
    const policy = loadCsp();
    for (const name of ["img-src", "media-src", "connect-src"]) {
      expect(cspDirective(name, policy)).toContain("https:");
    }
    // 本地宿主服务（WebDAV/番剧/SMTC 都绑 127.0.0.1 随机端口）
    expect(cspDirective("connect-src", policy)).toContain("http://127.0.0.1:*");
    expect(cspDirective("media-src", policy)).toContain("http://127.0.0.1:*");
  });

  it("本地协议必须放行：asset/app-cover 是封面与媒体的入口（含 Windows 的 http 形态）", () => {
    const policy = loadCsp();
    for (const name of ["img-src", "media-src", "connect-src"]) {
      const dir = cspDirective(name, policy);
      expect(dir).toContain("asset:");
      expect(dir).toContain("http://asset.localhost");
      expect(dir).toContain("app-cover:");
      expect(dir).toContain("http://app-cover.localhost");
    }
  });

  it("frame-src 放行扩展宿主的 iframe（ext: 与 asset:，含 Windows 的 http 形态）", () => {
    const dir = cspDirective("frame-src", loadCsp());
    expect(dir).toContain("ext:");
    expect(dir).toContain("http://ext.localhost");
    expect(dir).toContain("asset:");
    expect(dir).toContain("http://asset.localhost");
  });

  it("已废弃的 app: scheme 不得出现在策略里", () => {
    // Tauri 主窗口是 https://tauri.localhost，app: 不再作为 URL scheme 使用
    const policy = loadCsp();
    for (const name of ["img-src", "media-src", "connect-src", "frame-src"]) {
      expect(cspDirective(name, policy)).not.toContain("app:");
    }
  });

  it("blob: 只在图片/媒体/worker 放开，不进 script-src", () => {
    const policy = loadCsp();
    expect(cspDirective("worker-src", policy)).toContain("blob:");
    expect(cspDirective("img-src", policy)).toContain("blob:");
    expect(cspDirective("script-src", policy)).not.toContain("blob:");
  });

  it("connect-src 放行 Vite dev 的 WebSocket（HMR），否则 dev 模式热更新被拦", () => {
    // Electron 时代注入逻辑跳过 dev URL所以不需要；Tauri 的 csp 连 dev 一起注入
    expect(cspDirective("connect-src", loadCsp())).toContain("ws://localhost:*");
  });
});
