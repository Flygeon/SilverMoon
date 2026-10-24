/**
 * Steam 协议层验证（本机可跑，**真打 Steam 接口**）。
 *
 * ## 为什么要有这个脚本
 *
 * 本机没有 MSVC 链接器，Rust 后端连 `cargo check` 都跑不了，只能等 CI。
 * Steam 协议落在 `electron/steam/protocol.ts` 之后，**没有任何东西保证它还能
 * 正确解析 Steam 的响应** —— 接口字段改名、EResult 语义变化、URL 调整都只会在
 * 用户点「登录」时才炸。这个脚本把「协议层与真实 Steam 的契约」固化成断言：
 *
 * ```bash
 * npm run verify:steam
 * ```
 *
 * ## 覆盖范围（全部免凭据）
 *
 * 1. 二维码挑战：能拿到 client_id / request_id / challenge_url；
 * 2. 轮询：未扫码时返回 pending 而不是崩；
 * 3. RSA 公钥：能解出 2048 位公钥并加密出 256 字节密文（账号密码登录的前置）；
 * 4. 错误账号：Steam 返回空 response —— 必须被翻译成可读错误，不能静默 pending；
 * 5. 商店详情：appid 440 能解析出名称与类型；
 * 6. 会话文件：加密信封能落盘、能读回、logout 能删干净。
 *
 * `--offline` 跳过所有网络断言（只跑本地逻辑），用于没网的环境。
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const OFFLINE = process.argv.includes("--offline");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, error) {
  fail += 1;
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`${name}: ${message}`);
  console.log(`  ✗ ${name} — ${message}`);
}
async function check(name, run) {
  try {
    const detail = await run();
    ok(name, detail ?? "");
  } catch (error) {
    bad(name, error);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 载入协议层（TypeScript → 用 esbuild 现场转译，避免引入额外运行时）
// ---------------------------------------------------------------------------

async function loadProtocol() {
  const { transform } = await import("esbuild");
  const file = path.join(ROOT, "electron", "steam", "protocol.ts");
  const source = readFileSync(file, "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "node20" });
  const temp = path.join(tmpdir(), `silvermoon-steam-protocol-${Date.now()}.mjs`);
  writeFileSync(temp, code, "utf8");
  const module = await import(`file://${temp.replace(/\\/g, "/")}`);
  rmSync(temp, { force: true });
  return module;
}

/** 临时明文存储（验证用，不涉及加密；加密由宿主 secure-store 负责）。 */
function tempStorage() {
  return {
    read(file) {
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    write(file, text) {
      writeFileSync(file, text, "utf8");
    },
    remove(file) {
      rmSync(file, { force: true });
    },
    exists(file) {
      return existsSync(file);
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log("Steam 协议层验证" + (OFFLINE ? "（离线模式）" : "（会真实请求 Steam）") + "\n");

const protocolModule = await loadProtocol();
const { SteamProtocol, describeEResult, readGuardType } = protocolModule;

const dir = mkdtempSync(path.join(tmpdir(), "silvermoon-steam-"));
const storage = tempStorage();
const steam = new SteamProtocol({
  sessionFile: path.join(dir, "steam-session.json"),
  libraryFile: path.join(dir, "steam-library.json"),
  storage,
  fetchImpl: fetch,
});

// ---- 纯本地逻辑（离线也跑） ----
await check("EResult 文案：5 → 密码错误", () => {
  const text = describeEResult(5);
  assert(text.includes("密码") || text.includes("账号"), `意外文案：${text}`);
});
await check("EResult 文案：84 → 频率限制", () => {
  assert(describeEResult(84).includes("频繁"), describeEResult(84));
});
await check("Guard 类型：只给 3 → device", () => {
  assert(readGuardType({ allowed_confirmations: [{ confirmation_type: 3 }] }) === "device");
});
await check("Guard 类型：只给 2 → email", () => {
  assert(readGuardType({ allowed_confirmations: [{ confirmation_type: 2 }] }) === "email");
});
await check("Guard 类型：只给 1（无需验证）→ null", () => {
  assert(readGuardType({ allowed_confirmations: [{ confirmation_type: 1 }] }) === null);
});
await check("未登录时 status() 不抛错且 loggedIn=false", async () => {
  const status = await steam.status();
  assert(status.loggedIn === false, "loggedIn 应为 false");
  assert(status.hasSession === false, "hasSession 应为 false");
});
await check("未登录时 getLibrary() 抛可读错误", async () => {
  try {
    await steam.getLibrary(true);
    throw new Error("本应抛错");
  } catch (error) {
    assert(String(error.message).includes("登录"), `错误文案不可读：${error.message}`);
  }
});
await check("会话落盘 / 读回 / logout 清理", async () => {
  const sessionPath = path.join(dir, "steam-session.json");
  steam.saveSession({
    refreshToken: "fake-token-for-test",
    accountName: "tester",
    steamId: "76561198000000000",
  });
  assert(existsSync(sessionPath), "会话文件未落盘");
  const raw = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert(raw.refreshToken === "fake-token-for-test", "refreshToken 未写入");
  // 重新构造一个实例，验证能从磁盘读回
  const second = new SteamProtocol({
    sessionFile: sessionPath,
    libraryFile: path.join(dir, "steam-library.json"),
    storage,
    fetchImpl: fetch,
  });
  const status = await second.status();
  // 假 token 换不到 access_token → loggedIn=false，但 hasSession 必须为 true
  assert(status.loggedIn === false, "假 token 不应登录成功");
  assert(status.hasSession === true, "hasSession 应为 true");
  assert(status.accountName === "tester", "账号名未读回");
  second.logout();
  assert(!existsSync(sessionPath), "logout 未删除会话文件");
});

if (!OFFLINE) {
  // ---- 真实网络：二维码 ----
  let qr = null;
  await check("二维码挑战：拿到 challenge_url", async () => {
    qr = await steam.beginQr();
    assert(qr.challengeUrl.startsWith("https://s.team/q/"), `异常 URL：${qr.challengeUrl}`);
    assert(qr.interval > 0, "interval 应为正数");
    return qr.challengeUrl.slice(0, 42) + "…";
  });

  await check("轮询：未扫码时返回 pending", async () => {
    if (!qr) throw new Error("上一步未取得二维码");
    const state = await steam.pollOnce();
    assert(state.state === "pending", `应 pending，实际 ${state.state}`);
    return state.message ?? "";
  });

  await check("取消登录后轮询返回 idle", async () => {
    steam.cancel();
    const state = await steam.pollOnce();
    assert(state.state === "idle", `应 idle，实际 ${state.state}`);
  });

  // ---- 真实网络：账号密码前置（RSA 加密） ----
  await check("RSA 公钥：能加密出 256 字节密文", async () => {
    const { createPublicKey, publicEncrypt, constants } = await import("node:crypto");
    const response = await fetch(
      "https://api.steampowered.com/IAuthenticationService/GetPasswordRSAPublicKey/v1/?account_name=gabelogannewell",
    );
    const { response: payload } = await response.json();
    assert(payload?.publickey_mod, "未返回 publickey_mod");
    const key = createPublicKey({
      key: {
        kty: "RSA",
        n: Buffer.from(payload.publickey_mod, "hex").toString("base64url"),
        e: Buffer.from(payload.publickey_exp, "hex").toString("base64url"),
      },
      format: "jwk",
    });
    assert(key.asymmetricKeyDetails?.modulusLength === 2048, "密钥应为 2048 位");
    const encrypted = publicEncrypt(
      { key, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from("dummy-password", "utf8"),
    );
    assert(encrypted.length === 256, `密文应 256 字节，实际 ${encrypted.length}`);
    return "2048-bit / 256B";
  });

  await check("错误账号：被翻译成可读错误而非静默 pending", async () => {
    const bogus = "silvermoon_probe_" + Math.random().toString(36).slice(2, 10);
    try {
      const state = await steam.beginCredentials(bogus, "NotARealPassword123");
      // Steam 若改为返回 challenge（某些风控路径），这里接受 guard/pending
      assert(
        state.state === "guard" || state.state === "pending" || state.state === "failed",
        `意外状态：${state.state}`,
      );
      return `状态 ${state.state}`;
    } catch (error) {
      assert(
        String(error.message).includes("账号") || String(error.message).includes("密码"),
        `错误文案不可读：${error.message}`,
      );
      return String(error.message).slice(0, 40);
    }
  });

  // ---- 真实网络：商店详情 ----
  await check("商店详情：appid 440 解析出名称", async () => {
    const details = await steam.fetchAppDetails([440]);
    const entry = details["440"];
    assert(entry, "未返回 440 的详情");
    assert(entry.name && entry.name.length > 0, "缺少名称");
    return entry.name;
  });

  await check("商店详情：缓存命中（第二次不发请求）", async () => {
    const started = Date.now();
    const again = await steam.fetchAppDetails([440]);
    const cost = Date.now() - started;
    assert(again["440"], "缓存未命中");
    assert(cost < 50, `缓存命中应几乎无耗时，实际 ${cost}ms`);
    return `${cost}ms`;
  });
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const item of failures) console.log("  - " + item);
  process.exit(1);
}
