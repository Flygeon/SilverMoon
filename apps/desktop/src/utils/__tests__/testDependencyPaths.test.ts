/**
 * 路径解析自检：确认测试进程里能正确定位仓库根下的依赖。
 *
 * 这个用例的存在有实际理由：`colorMixM3e.test.ts` 依赖从
 * `node_modules/@m3e/web/dist/all.js` 读取**真实样式**来做回归测试。
 * 一旦 `__dirname` 的相对层级因目录调整而失效，那个测试会静默变成「跳过」
 *（拿不到文件 → calls 为空），覆盖率断言就形同虚设。这里显式钉住这条路径。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("测试环境的依赖路径解析", () => {
  it("@m3e/web 的 bundle 可从测试进程定位到", () => {
    const p = path.resolve(__dirname, "../../../node_modules/@m3e/web/dist/all.js");
    expect(existsSync(p), `未找到 ${p}`).toBe(true);
  });

  it("electron 依赖可从测试进程定位到（主进程测试用）", () => {
    const p = path.resolve(__dirname, "../../../node_modules/electron/package.json");
    expect(existsSync(p), `未找到 ${p}`).toBe(true);
  });
});
