import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCsp, cspDirective, CSP_MODE } from "../cspPolicy";

/**
 * CSP 策略的静态守卫。
 *
 * 策略是纯字符串拼接（拼错了不会编译报错，只会在真机上白屏或缺图），
 * 所以用单测把**每一项的意图**钉住 —— 尤其是「哪些必须放开、哪些必须锁死」。
 *
 * 只 import `cspPolicy`（纯数据），**不** import `csp.ts`：后者顶层
 * `import { session } from "electron"`，在 vitest 里会去加载真实 Electron 二进制。
 */

describe("CSP 策略", () => {
  it("默认档位是 report（观察期），转强制只需改一个常量", () => {
    expect(CSP_MODE).toBe("report");
  });

  it("script-src 只允许 self —— 拒绝远程脚本，也拒绝 eval", () => {
    expect(cspDirective("script-src")).toEqual(["'self'"]);
    // 不允许 eval/new Function：渲染层实测没有用
    expect(buildCsp()).not.toContain("unsafe-eval");
  });

  it("object-src / base-uri 锁死", () => {
    expect(cspDirective("object-src")).toEqual(["'none'"]);
    expect(cspDirective("base-uri")).toEqual(["'self'"]);
  });

  it("style-src 必须留 unsafe-inline，否则界面会没有样式", () => {
    // Vue <style scoped> / @m3e/web adoptedStyleSheets / 远程皮肤注入都要它
    expect(cspDirective("style-src")).toContain("'unsafe-inline'");
  });

  it("在线内容源必须放行，否则封面与视频全挂", () => {
    for (const name of ["img-src", "media-src", "connect-src"]) {
      expect(cspDirective(name)).toContain("https:");
    }
    // 本地宿主服务与 Vite dev server
    expect(cspDirective("connect-src")).toContain("http://127.0.0.1:*");
  });

  it("本地协议必须放行：asset/app-cover 是封面与媒体的入口", () => {
    for (const name of ["img-src", "media-src", "connect-src"]) {
      expect(cspDirective(name)).toContain("app-cover:");
      expect(cspDirective(name)).toContain("asset:");
    }
  });

  it("blob: 只在图片/媒体/worker 放开，不进 script-src", () => {
    expect(cspDirective("worker-src")).toContain("blob:");
    expect(cspDirective("img-src")).toContain("blob:");
    expect(cspDirective("script-src")).not.toContain("blob:");
  });

  it("frame-src 放行扩展宿主的 iframe（app: 与 asset:）", () => {
    expect(cspDirective("frame-src")).toContain("app:");
    expect(cspDirective("frame-src")).toContain("asset:");
  });

  it("default-src 收紧到 none，各类型显式列出", () => {
    expect(cspDirective("default-src")).toEqual(["'none'"]);
  });
});

describe("CSP 注入范围", () => {
  const read = (p: string): string =>
    readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  it("main.ts 确实调用了 installCsp", () => {
    expect(read("../main.ts")).toContain("installCsp()");
  });

  it("策略只注入 app://，不得牵连第三方远程页", () => {
    expect(read("../csp.ts")).toContain('details.url.startsWith("app://")');
  });

  it("注入逻辑与策略数据分离在两个文件（否则单测会被 electron 依赖拖死）", () => {
    // 匹配真正的 import 语句，而不是注释里提到的那句话
    expect(read("../cspPolicy.ts")).not.toMatch(/^import .*from "electron"/m);
    expect(read("../csp.ts")).toMatch(/^import .*from "electron"/m);
  });
});
