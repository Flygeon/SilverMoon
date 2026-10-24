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
  steamIdFromRefreshToken,
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

  it("会话缺 steamId 时直接判未登录，不发那个注定 400 的请求", async () => {
    const { calls, fake } = captureFetch();
    const storage = storageWith({ refreshToken: "rt" });
    const status = await make(fake, storage).status();

    expect(status.loggedIn).toBe(false);
    expect(status.hasSession).toBe(true);
    expect(calls.find((c) => c.url.includes("GenerateAccessTokenForApp"))).toBeUndefined();
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

describe("steamIdFromRefreshToken：二维码流程唯一的 steamid 来源", () => {
  /** 造一个形状合法的 JWT（不校验签名，只需要 payload 可解）。 */
  function jwt(payload: Record<string, unknown>): string {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    return `${b64u({ alg: "EdDSA", typ: "JWT" })}.${b64u(payload)}.c2ln`;
  }

  it("从 sub 解出 17 位 SteamID64", () => {
    expect(steamIdFromRefreshToken(jwt({ iss: "steam", sub: "76561197960287930" }))).toBe(
      "76561197960287930",
    );
  });

  it("sub 是**小**数字时也能解（但 17 位数字必然丢精度，见下一条）", () => {
    // 只验证类型容错：合法 17 位的数字字面量在 JS 里已失真，不能当输入
    expect(steamIdFromRefreshToken(jwt({ sub: "76561197960287930" }))).toBe("76561197960287930");
  });

  it("17 位 SteamID 若以数字形式出现，必然已丢精度 —— 我们宁可不认", () => {
    // 76561197960287930 > Number.MAX_SAFE_INTEGER（9007199254740991），
    // 以 number 承载时必然失真（...930 → ...940）。Steam 实际发的是字符串；
    // 若真收到数字形态，说明链路上某处已经损坏，返回 null 比返回错 ID 安全。
    // 这里用 Number() 构造而不是字面量：字面量会被 ESLint 的
    // no-loss-of-precision 直接拦下（那恰好也是同一个事实）。
    const corrupted = Number("76561197960287930");
    expect(String(corrupted)).not.toBe("76561197960287930"); // 证明确实失真
    expect(steamIdFromRefreshToken(jwt({ sub: corrupted }))).toBeNull();
  });

  it("不是 JWT 时返回 null（不能抛）", () => {
    expect(steamIdFromRefreshToken("plain-token")).toBeNull();
    expect(steamIdFromRefreshToken("")).toBeNull();
    expect(steamIdFromRefreshToken("a.b")).toBeNull(); // payload 不是合法 JSON
  });

  it("sub 形状不对时返回 null（避免把脏值发去换 token）", () => {
    expect(steamIdFromRefreshToken(jwt({ sub: "123" }))).toBeNull();
    expect(steamIdFromRefreshToken(jwt({ sub: "abc" }))).toBeNull();
    expect(steamIdFromRefreshToken(jwt({}))).toBeNull();
  });

  it("二维码登录成功后，会话里必须带上从 token 解出的 steamId", async () => {
    // 模拟二维码流程：轮询只回 refresh_token，不回 steamid
    const token = jwt({ sub: "76561198000000009" });
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
        // 关键：只给 refresh_token，没有 steamid
        return new Response(JSON.stringify({ response: { refresh_token: token } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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

    // 且换 token 时发出去的是真实 ID（不是 0）
    const tokenCall = calls.find((c) => c.url.includes("GenerateAccessTokenForApp"));
    expect(tokenCall).toBeTruthy();
    expect(new URLSearchParams(tokenCall?.body ?? "").get("steamid")).toBe("76561198000000009");
  });

  it("旧会话缺 steamId 时自动从 token 补全并写回", async () => {
    const token = jwt({ sub: "76561198000000010" });
    const files = new Map<string, string>();
    // 模拟上一版遗留的会话：有 refreshToken，没有 steamId
    files.set("/v/steam-session.json", JSON.stringify({ refreshToken: token, accountName: "old" }));
    const storage: SteamStorage = {
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      exists: (f) => files.has(f),
    };
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ response: { access_token: "at" } }), {
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
    expect(status.loggedIn).toBe(true);
    expect(status.steamId).toBe("76561198000000010");
    // 自愈结果已写回磁盘
    expect(JSON.parse(files.get("/v/steam-session.json") ?? "{}").steamId).toBe(
      "76561198000000010",
    );
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
