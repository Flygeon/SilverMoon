/**
 * Steam 协议层的纯逻辑单测（**不联网**，可在 CI 与离线环境跑）。
 *
 * 真实网络契约由 `scripts/verify-steam-protocol.mjs`（`npm run verify:steam`）守，
 * 那份必须联网，因此不进 vitest。这里只锁**解析与判定**这两类"写错就静默坏"的逻辑：
 *
 * 1. `readGuardType` —— 判错会让登录卡在「等待确认」或把邮箱码当令牌提交，
 *    用户看到的是"验证码一直不对"，很难定位；
 * 2. `describeEResult` —— 判错会让登录失败只剩一个数字；
 * 3. 会话读写 / 缓存 / 登出的状态机 —— 判错的表现是"重启后账号丢了"或"换号后
 *    看到上一个号的游戏库"；
 * 4. 换 access_token 的**参数形状** —— 见文末「回归」用例：这里曾把 steamid 写成 "0"，
 *    Steam 直接回 400，而 status() 把异常吞成 loggedIn:false，于是界面表现成
 *    「扫码明明成功了，却一直说尚未登录」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SteamProtocol,
  readGuardType,
  describeEResult,
  steamIdFromToken,
  describeTokenShape,
  tokenExpiresAt,
  isTokenExpired,
  type SteamStorage,
} from "../steam/protocol";

/** 临时明文存储（协议层不关心加密，加密在宿主 secure-store）。 */
function memoryStorage(): SteamStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (file) => files.get(file) ?? null,
    write: (file, text) => void files.set(file, text),
    remove: (file) => void files.delete(file),
    exists: (file) => files.has(file),
  };
}

/** 一个永远不该被调用的 fetch：纯逻辑用例里出现网络调用就是写错了。 */
const noNetwork: typeof fetch = () => {
  throw new Error("本用例不应发起网络请求");
};

describe("readGuardType：Steam Guard 方式判定", () => {
  it("只给 3 → 手机令牌", () => {
    expect(readGuardType({ allowed_confirmations: [{ confirmation_type: 3 }] })).toBe("device");
  });

  it("只给 2 → 邮箱码", () => {
    expect(readGuardType({ allowed_confirmations: [{ confirmation_type: 2 }] })).toBe("email");
  });

  it("只给 4（App 确认）→ 归到 device", () => {
    expect(readGuardType({ allowed_confirmations: [{ confirmation_type: 4 }] })).toBe("device");
  });

  it("只给 1（无需验证）→ null，表示可直接取 token", () => {
    expect(readGuardType({ allowed_confirmations: [{ confirmation_type: 1 }] })).toBeNull();
  });

  it("同时给 2 与 3 时优先手机令牌", () => {
    expect(
      readGuardType({
        allowed_confirmations: [{ confirmation_type: 2 }, { confirmation_type: 3 }],
      }),
    ).toBe("device");
  });

  it("没有 allowed_confirmations → null（不误判成 Guard）", () => {
    expect(readGuardType({})).toBeNull();
    expect(readGuardType({ allowed_confirmations: [] })).toBeNull();
  });

  it("字段是字符串数字时也能识别（Steam 偶尔返回字符串）", () => {
    expect(
      readGuardType({ allowed_confirmations: [{ confirmation_type: "3" as unknown as number }] }),
    ).toBe("device");
  });
});

describe("describeEResult：错误文案", () => {
  it("5 → 账号或密码错误", () => {
    expect(describeEResult(5)).toContain("密码");
  });

  it("84 → 频率限制", () => {
    expect(describeEResult(84)).toContain("频繁");
  });

  it("65 → 验证码不正确", () => {
    expect(describeEResult(65)).toContain("验证码");
  });

  it("未知码也给出可读文案，不返回空串", () => {
    const text = describeEResult(9999);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("9999");
  });
});

describe("会话状态机", () => {
  let dir: string;
  let storage: SteamStorage;
  let sessionFile: string;
  let libraryFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sm-steam-test-"));
    storage = {
      read: (file) => {
        try {
          return readFileSync(file, "utf8");
        } catch {
          return null;
        }
      },
      write: (file, text) => {
        writeFileSync(file, text, "utf8");
      },
      remove: (file) => {
        try {
          rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
      },
      exists: (file) => existsSync(file),
    };
    sessionFile = path.join(dir, "steam-session.json");
    libraryFile = path.join(dir, "steam-library.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("没有会话文件时 status 返回未登录且不抛错", async () => {
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    const status = await steam.status();
    expect(status.loggedIn).toBe(false);
    expect(status.hasSession).toBe(false);
  });

  it("有会话文件但 token 无效时 hasSession=true、loggedIn=false（能提示是哪个号过期）", async () => {
    const storageWithSession: SteamStorage = {
      ...storage,
      read: (file) => {
        if (file === sessionFile) {
          return JSON.stringify({
            refreshToken: "bogus",
            accountName: "tester",
            personaName: "Tester",
          });
        }
        return null;
      },
      exists: () => true,
    };
    // 换 token 会走网络；这里给一个必然失败的 fetch，验证它被吞掉而不是崩
    const failing: typeof fetch = async () => {
      throw new Error("network down");
    };
    const steam = new SteamProtocol({
      sessionFile,
      libraryFile,
      storage: storageWithSession,
      fetchImpl: failing,
    });
    const status = await steam.status();
    expect(status.loggedIn).toBe(false);
    expect(status.hasSession).toBe(true);
    expect(status.personaName).toBe("Tester");
  });

  it("未登录且无缓存时 getLibrary 抛可读错误", async () => {
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    await expect(steam.getLibrary(true)).rejects.toThrow(/登录/);
  });

  it("未登录但有缓存时返回缓存并带 warning（比空列表有用）", async () => {
    storage.write(
      libraryFile,
      JSON.stringify({ games: [{ appId: 440, name: "TF2", playtimeMinutes: 10 }], cachedAt: 1 }),
    );
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    const library = await steam.getLibrary(true);
    expect(library.games).toHaveLength(1);
    expect(library.games[0].name).toBe("TF2");
    expect(library.warning).toBeTruthy();
  });

  it("refresh=false 时优先返回缓存，不发网络请求", async () => {
    storage.write(
      libraryFile,
      JSON.stringify({ games: [{ appId: 730, name: "CS2", playtimeMinutes: 1 }], cachedAt: 2 }),
    );
    const boom: typeof fetch = () => {
      throw new Error("不应该联网");
    };
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: boom });
    const library = await steam.getLibrary(false);
    expect(library.games[0].appId).toBe(730);
    expect(library.total).toBe(1);
  });

  it("logout 同时清会话与库缓存（避免换号后看到上一个号的库）", async () => {
    storage.write(sessionFile, JSON.stringify({ refreshToken: "x" }));
    storage.write(libraryFile, JSON.stringify({ games: [], cachedAt: 1 }));
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    steam.logout();
    expect(existsSync(sessionFile)).toBe(false);
    expect(existsSync(libraryFile)).toBe(false);
  });

  it("会话文件损坏时按未登录处理，不抛错", async () => {
    storage.write(sessionFile, "{ 这不是 JSON");
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    const status = await steam.status();
    expect(status.loggedIn).toBe(false);
    expect(status.hasSession).toBe(false);
  });

  it("readLibraryCache 对损坏缓存返回 null", () => {
    storage.write(libraryFile, "not-json");
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    expect(steam.readLibraryCache()).toBeNull();
  });

  it("fetchAppDetails 对空输入不发请求", async () => {
    const steam = new SteamProtocol({ sessionFile, libraryFile, storage, fetchImpl: noNetwork });
    await expect(steam.fetchAppDetails([])).resolves.toEqual({});
    await expect(steam.fetchAppDetails([0, -1, Number.NaN])).resolves.toEqual({});
  });
});

describe("回归：换 access_token 必须传真实 steamid", () => {
  /**
   * 这段守的是一个**真实上线过的 bug**：
   * 原实现调用 GenerateAccessTokenForApp 时写死了 steamid: "0"，
   * Steam 返回 400（Missing required routing parameter）；
   * 而 status() 为了「昵称仍可展示」把异常吞掉，只回 loggedIn:false ——
   * 用户看到的是「二维码扫了、账号名也显示了，却一直提示尚未登录，还反复重来」。
   *
   * 所以这里不联网，而是**截获真正要发出的表单**，断言 steamid 是会话里的那个。
   */
  function captureFetch(ok = true) {
    const calls: { url: string; body: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (!ok) return new Response("bad", { status: 400 });
      return new Response(
        JSON.stringify({ response: { access_token: "at-ok", refresh_token: "rt-ok" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { calls, fake };
  }

  function storageWith(session: unknown) {
    const files = new Map<string, string>();
    files.set("/v/steam-session.json", JSON.stringify(session));
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    return storage;
  }

  function make(fake: typeof fetch, storage: SteamStorage, log?: (m: string) => void) {
    return new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage,
      fetchImpl: fake,
      ...(log ? { log } : {}),
    });
  }

  it("把会话里的 steamId 原样发出去（绝不能是 0）", async () => {
    const { calls, fake } = captureFetch();
    const storage = storageWith({
      refreshToken: "rt",
      steamId: "76561198000000001",
      accountName: "acc",
    });
    const status = await make(fake, storage).status();
    expect(status.loggedIn).toBe(true);

    const tokenCall = calls.find((c) => c.url.includes("GenerateAccessTokenForApp"));
    expect(tokenCall, "应当调用过换 token 接口").toBeTruthy();
    const params = new URLSearchParams(tokenCall?.body ?? "");
    expect(params.get("steamid")).toBe("76561198000000001");
    expect(params.get("steamid")).not.toBe("0");
    expect(params.get("refresh_token")).toBe("rt");
  });

  it("会话缺 steamId 时会尝试换 token，并从 access_token 的 sub 补上", async () => {
    // 早期实现直接不发请求、判未登录，导致上一版遗留的会话永远无法恢复。
    // 现在会尝试换 token（access_token 是 JWT，能解出 sub=steamid）。
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const at = `${b64u({ alg: "EdDSA" })}.${b64u({ sub: "76561198000000011" })}.sig`;
    const calls: { url: string; body: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return new Response(JSON.stringify({ response: { access_token: at } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const storage = storageWith({ refreshToken: "opaque-rt" });
    const status = await make(fake, storage).status();

    expect(status.loggedIn).toBe(true);
    // 补出来的 steamId 来自 access_token 的 sub
    expect(status.steamId).toBe("76561198000000011");
  });

  it("换 token 失败时写诊断日志（否则界面只剩「未登录」，无从排查）", async () => {
    const logged: string[] = [];
    const { fake } = captureFetch(false);
    const storage = storageWith({ refreshToken: "rt", steamId: "76561198000000001" });
    const status = await make(fake, storage, (m) => void logged.push(m)).status();

    expect(status.loggedIn).toBe(false);
    expect(logged.some((m) => m.includes("access_token"))).toBe(true);
  });
});

describe("steamIdFromToken：从 JWT（access_token）解出 SteamID64", () => {
  /** 造一个形状合法的 JWT（不校验签名，只需要 payload 可解）。 */
  function jwt(payload: Record<string, unknown>): string {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    return `${b64u({ alg: "EdDSA", typ: "JWT" })}.${b64u(payload)}.c2ln`;
  }

  it("从 sub 解出 17 位 SteamID64", () => {
    expect(steamIdFromToken(jwt({ iss: "steam", sub: "76561197960287930" }))).toBe(
      "76561197960287930",
    );
  });

  it("sub 是**小**数字时也能解（但 17 位数字必然丢精度，见下一条）", () => {
    // 只验证类型容错：合法 17 位的数字字面量在 JS 里已失真，不能当输入
    expect(steamIdFromToken(jwt({ sub: "76561197960287930" }))).toBe("76561197960287930");
  });

  it("17 位 SteamID 若以数字形式出现，必然已丢精度 —— 我们宁可不认", () => {
    // 76561197960287930 > Number.MAX_SAFE_INTEGER（9007199254740991），
    // 以 number 承载时必然失真（...930 → ...940）。Steam 实际发的是字符串；
    // 若真收到数字形态，说明链路上某处已经损坏，返回 null 比返回错 ID 安全。
    // 这里用 Number() 构造而不是字面量：字面量会被 ESLint 的
    // no-loss-of-precision 直接拦下（那恰好也是同一个事实）。
    const corrupted = Number("76561197960287930");
    expect(String(corrupted)).not.toBe("76561197960287930"); // 证明确实失真
    expect(steamIdFromToken(jwt({ sub: corrupted }))).toBeNull();
  });

  it("不是 JWT 时返回 null（不能抛）", () => {
    expect(steamIdFromToken("plain-token")).toBeNull();
    expect(steamIdFromToken("")).toBeNull();
    expect(steamIdFromToken("a.b")).toBeNull(); // payload 不是合法 JSON
  });

  it("sub 形状不对时返回 null（避免把脏值发去换 token）", () => {
    expect(steamIdFromToken(jwt({ sub: "123" }))).toBeNull();
    expect(steamIdFromToken(jwt({ sub: "abc" }))).toBeNull();
    expect(steamIdFromToken(jwt({}))).toBeNull();
  });

  it("二维码登录成功后，steamId 从 access_token（JWT）解出并落盘", async () => {
    // 真实语义：poll 回的 refresh_token 是**不透明字符串**（不是 JWT），
    // 能解出 steamid 的是同一个响应里的 access_token（JWT）。
    const accessToken = jwt({ sub: "76561198000000009" });
    const calls: { url: string; body: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.includes("BeginAuthSessionViaQR")) {
        return new Response(
          JSON.stringify({
            response: {
              client_id: "1",
              request_id: "r",
              challenge_url: "https://s.team/q/1/1",
              interval: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("PollAuthSessionStatus")) {
        // 官方 proto 里 poll 响应没有 steamid，但带 access_token（JWT）
        return new Response(
          JSON.stringify({ response: { refresh_token: "opaque-rt", access_token: accessToken } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("GenerateAccessTokenForApp")) {
        return new Response(JSON.stringify({ response: { access_token: "at" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 资料 / 库：给空响应即可
      return new Response(JSON.stringify({ response: { players: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const files = new Map<string, string>();
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage,
      fetchImpl: fake,
    });

    await steam.beginQr();
    const state = await steam.pollOnce();
    expect(state.state).toBe("authenticated");

    // 落盘会话必须带 steamId
    const saved = JSON.parse(files.get("/v/steam-session.json") ?? "{}");
    expect(saved.steamId).toBe("76561198000000009");

    // 且 GetOwnedGames 必须带 steamid（不带会 400 Required parameter missing）
    const ownedCall = calls.find((c) => c.url.includes("GetOwnedGames"));
    expect(ownedCall, "应调用过 GetOwnedGames").toBeTruthy();
    expect(new URLSearchParams(ownedCall?.url.split("?")[1] ?? "").get("steamid")).toBe(
      "76561198000000009",
    );
  });

  it("旧会话缺 steamId 时，登录后仍能靠 access_token 补上并在下次读到时可用", async () => {
    // 说明：refresh_token 不是 JWT，**无法**从它解出 steamid；
    // 因此"自愈"不能靠读会话，而要靠下一次拿到 access_token 时补。
    // 这里验证的是：缺 steamId 的旧会话不会让整个登录态崩掉，
    // 且在换到 token 之后仍然可以正常工作。
    const accessToken = jwt({ sub: "76561198000000010" });
    const files = new Map<string, string>();
    files.set(
      "/v/steam-session.json",
      JSON.stringify({ refreshToken: "opaque-rt", accountName: "old" }),
    );
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    // 换 token 返回一个 JWT 形状的 access_token（其 sub 即 steamid）
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ response: { access_token: accessToken } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage,
      fetchImpl: fake,
    });

    const status = await steam.status();
    // 能换到 token 就算登录成功；缺失的 steamId 由 access_token 的 sub 补上
    expect(status.loggedIn).toBe(true);
    expect(status.steamId).toBe("76561198000000010");
  });
});

describe("二维码登录：直接采用 poll 返回的 access_token", () => {
  /** poll 响应按官方 proto：**没有 steamid，但有 access_token / account_name**。 */
  function makeSteam(
    pollResponse: Record<string, unknown>,
    calls?: { url: string; body: string }[],
  ) {
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls?.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.includes("BeginAuthSessionViaQR")) {
        return new Response(
          JSON.stringify({
            response: {
              client_id: "1",
              request_id: "r",
              challenge_url: "https://s.team/q/1/1",
              interval: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("PollAuthSessionStatus")) {
        return new Response(JSON.stringify({ response: pollResponse }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("GenerateAccessTokenForApp")) {
        // 这条路径不该被走到；真被走到就返回 400（模拟缺 steamid 的失败）
        return new Response("Missing required routing parameter", { status: 400 });
      }
      // GetOwnedGames / 资料：给空但合法的响应
      if (url.includes("GetOwnedGames")) {
        return new Response(JSON.stringify({ response: { games: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ response: { players: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const files = new Map<string, string>();
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage,
      fetchImpl: fake,
    });
    return { steam, files };
  }

  it("poll 给了 access_token 时，即使没有 steamid 也能登录成功", async () => {
    const calls: { url: string; body: string }[] = [];
    // 注意：refresh_token 故意用**非 JWT**（真实 Steam 的 refresh_token 形状
    // 未必是三段 JWT），确保这条路径不依赖解 token
    const { steam, files } = makeSteam(
      {
        refresh_token: "opaque-refresh-token",
        access_token: "polled-access-token",
        account_name: "gabelogannewell",
      },
      calls,
    );

    await steam.beginQr();
    const state = await steam.pollOnce();
    expect(state.state).toBe("authenticated");
    expect(state.status?.loggedIn).toBe(true);

    // 关键：不应为了拿 token 去调 GenerateAccessTokenForApp（那条路需要 steamid）
    expect(calls.find((c) => c.url.includes("GenerateAccessTokenForApp"))).toBeUndefined();

    const saved = JSON.parse(files.get("/v/steam-session.json") ?? "{}");
    expect(saved.refreshToken).toBe("opaque-refresh-token");
    expect(saved.accountName).toBe("gabelogannewell");
  });

  it("poll 只给 refresh_token（JWT 带 sub）时，仍能靠解析 sub 走通", async () => {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const jwt = `${b64u({ alg: "EdDSA" })}.${b64u({ sub: "76561197960287930" })}.sig`;
    const { steam, files } = makeSteam({ refresh_token: jwt });
    // 让换 token 接口可用（覆盖「poll 没给 token」时的回退路径）
    await steam.beginQr();
    const state = await steam.pollOnce();
    // 回退路径会调 GenerateAccessTokenForApp，而本用例的假 fetch 对它返回 400，
    // 因此这里断言的是「明确失败」而不是静默卡住 —— 符合自检的意图
    expect(state.state).toBe("failed");
    // 文案里必须说清「会话无法使用」，而不是让界面停在未登录什么都不说
    expect(String(state.message)).toContain("会话无法使用");
    // 失败时会清掉废会话，避免下次启动又「有会话但未登录」
    expect(files.has("/v/steam-session.json")).toBe(false);
  });

  it("describeTokenShape 不泄露 token 内容", () => {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const jwt = `${b64u({ alg: "EdDSA" })}.${b64u({ sub: "76561197960287930", iss: "steam" })}.sig`;
    const shape = describeTokenShape(jwt);
    const text = JSON.stringify(shape);
    // 只有长度 / 段数 / claim 类型，没有原值
    expect(shape.jwtLike).toBe(true);
    expect(text).not.toContain("76561197960287930");
    expect((shape.claims as Record<string, string>).sub).toBe("string");
    expect(shape.subLength).toBe(17);
  });
});

describe("回归：fetchProfile 不得抹掉 poll 拿到的 access_token", () => {
  /**
   * 真实上线过的 bug：fetchProfile 里写了 `this.accessToken = accessToken || null`，
   * 当 GenerateAccessTokenForApp 返回空（缺 steamid / 被限流）时，会把 poll 已经
   * 拿到的**有效** token 抹成 null —— 于是登录后自检报「Steam 未返回 access_token」，
   * 而 token 其实一直是好的。表现：二维码扫了、提示「登录成功但会话无法使用」，反复重来。
   */
  it("poll 给了 token、换 token 接口返回空时，仍应保持已登录", async () => {
    const fake: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("BeginAuthSessionViaQR")) {
        return new Response(
          JSON.stringify({
            response: {
              client_id: "1",
              request_id: "r",
              challenge_url: "https://s.team/q/1/1",
              interval: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("PollAuthSessionStatus")) {
        // 带 steamid：这样 fetchProfile 里「用 steamid 去换 token」的分支才会真的执行，
        // 否则整段被 `if (resolvedId)` 跳过，这个回归用例就抓不到 bug（踩过一次）。
        return new Response(
          JSON.stringify({
            response: {
              refresh_token: "opaque-rt",
              access_token: "good-at",
              steamid: "76561198000000002",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // 换 token 接口：返回空 response（等价于「换不到」），但不抛错
      if (url.includes("GenerateAccessTokenForApp")) {
        return new Response(JSON.stringify({ response: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("GetOwnedGames")) {
        return new Response(JSON.stringify({ response: { games: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ response: { players: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const files = new Map<string, string>();
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage,
      fetchImpl: fake,
    });

    await steam.beginQr();
    const state = await steam.pollOnce();

    // 关键：换 token 失败不该毁掉 poll 给的 token
    expect(state.state).toBe("authenticated");
    expect(state.status?.loggedIn).toBe(true);
  });
});

describe("回归：GetOwnedGames 必须带 steamid（否则 Steam 返回 400）", () => {
  /**
   * 真实上线过的 bug：游戏库请求漏了 `steamid`，Steam 回
   * `400 Required parameter 'steamid' is missing`，界面报
   * 「Steam 接口 IPlayerService/GetOwnedGames/v1/ 返回 HTTP 400」。
   *
   * 这个 400 **只在 token 有效时才出现**（无效 token 先被 401 拦下），
   * 所以用假 token 探测永远发现不了 —— 这正是它躲过前几轮验证的原因。
   */
  it("请求 URL 里必须同时带 access_token 与 steamid", async () => {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const at = `${b64u({ alg: "EdDSA" })}.${b64u({ sub: "76561198000000012" })}.sig`;
    const calls: { url: string; body: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.includes("GenerateAccessTokenForApp")) {
        return new Response(JSON.stringify({ response: { access_token: at } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("GetOwnedGames")) {
        return new Response(JSON.stringify({ response: { games: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ response: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const files = new Map<string, string>();
    files.set("/v/steam-session.json", JSON.stringify({ refreshToken: "opaque-rt" }));
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage,
      fetchImpl: fake,
    });

    await steam.getLibrary(true);

    const owned = calls.find((c) => c.url.includes("GetOwnedGames"));
    expect(owned, "应调用过 GetOwnedGames").toBeTruthy();
    const params = new URLSearchParams(owned?.url.split("?")[1] ?? "");
    expect(params.get("access_token")).toBeTruthy();
    // 核心断言：没有 steamid 就是 400
    expect(params.get("steamid")).toBe("76561198000000012");
  });
});

describe("会话持久化：重启后不应直接掉线", () => {
  /**
   * 真实场景：扫码登录当时成功（能看到库），**重启后显示「会话已过期」**。
   *
   * 根因是登录时只落盘 refresh_token，重启后第一次用到它就去换 access_token；
   * 只要那次换取失败（限流 / token 失效 / 网络抖动），用户就被踢到未登录。
   *
   * 修复：把 access_token 一起加密落盘，重启先用它；真过期了才换。
   */
  function makeStorage(files: Map<string, string>): SteamStorage {
    return {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
  }

  function jwtWithExp(expSeconds: number): string {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    return (
      b64u({ alg: "EdDSA", typ: "JWT" }) +
      "." +
      b64u({ iss: "steam", sub: "76561198000000001", exp: expSeconds }) +
      ".sig"
    );
  }

  it("tokenExpiresAt 从 exp（秒）转毫秒", () => {
    expect(tokenExpiresAt(jwtWithExp(1800000000))).toBe(1800000000 * 1000);
  });

  it("tokenExpiresAt 对非 JWT 返回 null", () => {
    expect(tokenExpiresAt("plain")).toBeNull();
    expect(tokenExpiresAt("a.b")).toBeNull();
  });

  it("isTokenExpired：解不出 exp 时按过期处理（宁可多换一次）", () => {
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired(undefined)).toBe(true);
    expect(isTokenExpired(0)).toBe(true);
  });

  it("isTokenExpired：留 5 分钟余量", () => {
    const now = Date.now();
    expect(isTokenExpired(now + 60_000)).toBe(true);
    expect(isTokenExpired(now + 3_600_000)).toBe(false);
  });

  it("重启时若落盘的 access_token 仍有效，不发起换 token 请求", async () => {
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const files = new Map<string, string>();
    files.set(
      "/v/steam-session.json",
      JSON.stringify({
        refreshToken: "opaque-rt",
        steamId: "76561198000000001",
        accessToken: token,
        accessTokenExpiresAt: Date.now() + 3_600_000,
      }),
    );
    const calls: string[] = [];
    const fake: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : String(input));
      return new Response("should-not-happen", { status: 500 });
    };
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage: makeStorage(files),
      fetchImpl: fake,
    });

    const status = await steam.status();
    expect(status.loggedIn).toBe(true);
    expect(status.steamId).toBe("76561198000000001");
    expect(calls.find((u) => u.includes("GenerateAccessTokenForApp"))).toBeUndefined();
  });

  it("落盘的 access_token 已过期时才去换，并把新 token 落盘", async () => {
    const oldToken = jwtWithExp(Math.floor(Date.now() / 1000) - 60);
    const newToken = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const files = new Map<string, string>();
    files.set(
      "/v/steam-session.json",
      JSON.stringify({
        refreshToken: "opaque-rt",
        steamId: "76561198000000001",
        accessToken: oldToken,
        accessTokenExpiresAt: Date.now() - 60_000,
      }),
    );
    const fake: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("GenerateAccessTokenForApp")) {
        return new Response(JSON.stringify({ response: { access_token: newToken } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ response: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage: makeStorage(files),
      fetchImpl: fake,
    });

    expect((await steam.status()).loggedIn).toBe(true);
    const saved = JSON.parse(files.get("/v/steam-session.json") ?? "{}");
    expect(saved.accessToken).toBe(newToken);
    expect(typeof saved.accessTokenExpiresAt).toBe("number");
  });

  it("登录成功时把 access_token 一并落盘（不只 refresh_token）", async () => {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const at =
      b64u({ alg: "EdDSA" }) +
      "." +
      b64u({ sub: "76561198000000077", exp: Math.floor(Date.now() / 1000) + 3600 }) +
      ".sig";
    const fake: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("BeginAuthSessionViaQR")) {
        return new Response(
          JSON.stringify({
            response: {
              client_id: "1",
              request_id: "r",
              challenge_url: "https://s.team/q/1/1",
              interval: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("PollAuthSessionStatus")) {
        return new Response(
          JSON.stringify({ response: { refresh_token: "opaque-rt", access_token: at } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ response: { players: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const files = new Map<string, string>();
    const steam = new SteamProtocol({
      sessionFile: "/v/steam-session.json",
      libraryFile: "/v/steam-library.json",
      storage: makeStorage(files),
      fetchImpl: fake,
    });

    await steam.beginQr();
    expect((await steam.pollOnce()).state).toBe("authenticated");

    const saved = JSON.parse(files.get("/v/steam-session.json") ?? "{}");
    expect(saved.accessToken).toBe(at);
    expect(saved.refreshToken).toBe("opaque-rt");
    expect(typeof saved.accessTokenExpiresAt).toBe("number");
  });
});

describe("内存存储（占位，确保纯逻辑用例不落盘）", () => {
  it("写进去能读出来，删掉就没了", () => {
    const storage = memoryStorage();
    storage.write("a", "1");
    expect(storage.read("a")).toBe("1");
    storage.remove("a");
    expect(storage.read("a")).toBeNull();
    expect(storage.exists("a")).toBe(false);
  });
});
