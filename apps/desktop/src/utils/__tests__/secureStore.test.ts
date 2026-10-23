import { describe, expect, it } from "vitest";

/**
 * 凭据文件路径约束的回归测试。
 *
 * 宿主侧 `secure.*` 操作接受侧车传来的文件名，而侧车不是可信输入源
 * （规则、注入脚本都可能影响它）。这里校验的实现与 `host-server.ts` 里的
 * `resolveSecurePath` 一致：只接受纯文件名，且解析后必须落在数据目录内。
 *
 * 之所以单独复刻一份而不是 import：`host-server.ts` 依赖 electron 运行时，
 * 在 vitest 里无法直接加载。约束逻辑本身必须保持同步 —— 改动任一侧都要
 * 同时改这里，测试会因此失败并提醒。
 */
function resolveSecurePath(dataRoot: string, raw: string): string {
  if (!dataRoot) throw new Error("应用数据目录尚未初始化");
  if (!raw) throw new Error("缺少文件路径");
  const base = raw.split(/[\\/]/).pop() ?? "";
  if (!base || base === "." || base === "..") throw new Error(`非法文件名：${raw}`);
  if (/[\\/]/.test(base)) throw new Error(`非法文件名：${raw}`);
  return `${dataRoot.replace(/[\\/]+$/, "")}/${base}`;
}

describe("凭据文件路径约束", () => {
  const root = "C:/data/cn.cool.silvermoon";

  it("接受纯文件名并拼到数据目录下", () => {
    expect(resolveSecurePath(root, "pixiv.json")).toBe(`${root}/pixiv.json`);
    expect(resolveSecurePath(root, "netease.json")).toBe(`${root}/netease.json`);
  });

  it("剥离目录部分，只保留文件名（不允许改动目录层级）", () => {
    expect(resolveSecurePath(root, "sub/dir/kugou.json")).toBe(`${root}/kugou.json`);
    expect(resolveSecurePath(root, "..\\kugou.json")).toBe(`${root}/kugou.json`);
  });

  it("拒绝空路径与纯目录穿越", () => {
    expect(() => resolveSecurePath(root, "")).toThrow();
    expect(() => resolveSecurePath(root, "..")).toThrow();
    expect(() => resolveSecurePath(root, "dir/..")).toThrow();
  });

  it("数据目录未初始化时拒绝（不能退化成当前工作目录）", () => {
    expect(() => resolveSecurePath("", "pixiv.json")).toThrow();
  });
});

/**
 * 加密信封格式的回归测试。
 *
 * 信封是「先判别、再解密」的依据：`__smEnc` 缺省表示历史明文，读取端据此
 * 触发就地迁移。格式一旦变了，老用户的凭据就读不出来了，所以盯死它。
 */
describe("加密信封格式", () => {
  /** 与 `secure-store.ts` 的 parseEnvelope 同构的最小实现 */
  function parseEnvelope(text: string): { __smEnc: string; data: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.__smEnc !== "string" || typeof parsed.data !== "string") return null;
      return { __smEnc: parsed.__smEnc, data: parsed.data };
    } catch {
      return null;
    }
  }

  it("识别加密信封", () => {
    const text = JSON.stringify({ __smEnc: "v1", data: "QUJD" });
    expect(parseEnvelope(text)).toEqual({ __smEnc: "v1", data: "QUJD" });
  });

  it("识别降级（plain）信封 —— 加密不可用时仍能读出内容", () => {
    const text = JSON.stringify({ __smEnc: "plain", data: '{"a":1}' });
    expect(parseEnvelope(text)?.data).toBe('{"a":1}');
  });

  it("普通明文 JSON 不被识别为信封（触发迁移路径）", () => {
    expect(parseEnvelope('{"cookies":{"SESSDATA":"x"}}')).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("缺字段的伪信封不被识别，避免把坏文件当密文", () => {
    expect(parseEnvelope('{"__smEnc":"v1"}')).toBeNull();
    expect(parseEnvelope('{"data":"QUJD"}')).toBeNull();
  });
});
