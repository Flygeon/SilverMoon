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
 *    看到上一个号的游戏库"。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SteamProtocol,
  readGuardType,
  describeEResult,
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
