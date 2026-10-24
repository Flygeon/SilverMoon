/**
 * `isSteamCmToken` 的单元测试。
 *
 * ## 为什么这条逻辑值得单独测
 *
 * CM 的 `Connection::access` 只接受 **三段式 JWT 且 `iss === "steam"`**，
 * 否则直接抛 `ConnectionError::AccessToken` —— 那句错误从 UI 看上去就是
 * 「登录被拒」，完全看不出是 token 格式问题。
 *
 * 所以判定必须在**本地**做对：判松了 → 白连一次 CM、拿到一句含糊错误；
 * 判严了 → 明明能用的 token 被拦下，下载直接不可用。
 *
 * 这里覆盖两类：合格形态必须放行，各类不合格形态必须拦住。
 */
import { describe, expect, it } from "vitest";
import { describeTokenShape, isSteamCmToken } from "../steam/protocol";

/** 造一个指定 payload 的 JWT（签名段随便填，本函数不校验签名）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "EdDSA", typ: "JWT" })}.${enc(payload)}.fakesignature`;
}

describe("isSteamCmToken", () => {
  it("接受 iss=steam 的三段式 JWT", () => {
    const token = makeJwt({ iss: "steam", sub: "76561197960287930", exp: 1900000000 });
    expect(isSteamCmToken(token)).toBe(true);
  });

  it("拒绝 iss 不是 steam 的 JWT", () => {
    const token = makeJwt({ iss: "someone-else", sub: "76561197960287930", exp: 1900000000 });
    expect(isSteamCmToken(token)).toBe(false);
  });

  it("拒绝缺少 iss 的 JWT", () => {
    const token = makeJwt({ sub: "76561197960287930", exp: 1900000000 });
    expect(isSteamCmToken(token)).toBe(false);
  });

  it("拒绝非三段式（不透明字符串 / 两段）", () => {
    expect(isSteamCmToken("opaque-refresh-token-without-dots")).toBe(false);
    expect(isSteamCmToken("header.payload")).toBe(false);
    expect(isSteamCmToken("a.b.c.d")).toBe(false);
  });

  it("拒绝空值与非法类型", () => {
    expect(isSteamCmToken("")).toBe(false);
    // 运行期可能是 null（会话字段缺失），不能抛
    expect(isSteamCmToken(null as unknown as string)).toBe(false);
    expect(isSteamCmToken(undefined as unknown as string)).toBe(false);
  });

  it("拒绝负载不是合法 JSON 的三段字符串", () => {
    expect(isSteamCmToken("aaa.!!!not-base64!!!.ccc")).toBe(false);
  });

  it("不因 exp 已过期而拒绝（过期交给服务端判）", () => {
    // steam-vent 自己也把 exp 检查注释掉了；本地判早了会把可用 token 拦下。
    const expired = makeJwt({ iss: "steam", sub: "76561197960287930", exp: 1 });
    expect(isSteamCmToken(expired)).toBe(true);
  });

  it("describeTokenShape 暴露 iss 实际值（排查「登录被拒」的关键）", () => {
    const shape = describeTokenShape(makeJwt({ iss: "steam" }));
    expect(shape.iss).toBe("steam");
    // 非 JWT 时没有 iss 可读
    expect(describeTokenShape("opaque").iss).toBeUndefined();
  });
});
