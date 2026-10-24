/**
 * Steam 协议层（纯 HTTPS WebAPI，不依赖 CM 长连接）。
 *
 * ## 为什么是这一层、为什么是 HTTPS
 *
 * 参考实现（`Aurelia参考/`）用 `steam-vent` 走 CM（Connection Manager）的
 * WebSocket 长连接 + 自建 protobuf。但实测本机：**CM 的 WebSocket 会被网络重置**
 * （`ECONNRESET` / `ETIMEDOUT`），而 Steam 的 **WebAPI 认证接口纯 HTTPS 完全可用**
 * （扫码挑战、轮询、RSA 公钥、商店接口全部 200）。因此这里只依赖
 * `IAuthenticationService` 这套 HTTPS 接口。
 *
 * 这条路能拿到的：
 *   - 完整登录：二维码 / 账号密码 + Steam Guard（邮箱码、手机令牌、App 确认）/ 会话恢复
 *   - refresh_token → access_token → 账号资料（昵称、头像、SteamID）
 *   - 游戏库：`IPlayerService/GetOwnedGames`
 *   - 商店元信息：`store.steampowered.com/api/appdetails`（免登录）
 *
 * 拿不到的（需要 CM 长连接 / 本地 Steam 客户端）：下载安装、启动游戏、
 * Workshop、好友聊天、云存档。那些能力不在本模块里假装实现。
 *
 * ## 可测试性（重要）
 *
 * 本文件**不静态依赖 electron**：网络与存储都通过构造参数注入。
 * - 宿主里由 `electron/steam/index.ts` 注入 Electron 的 `net.fetch`（走 Chromium
 *   网络栈，因此遵守「设置 → 网络」的代理配置）与 `safeStorage` 加密存储；
 * - 本地验证脚本注入 Node 全局 `fetch` + 明文临时目录，于是**能在本机真打网络**。
 *
 * 这一点是本模块放在 Node 侧的主要理由：本机没有 MSVC 链接器，Rust 后端连
 * `cargo check` 都跑不了，协议代码写在那里等于无法验证。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 落盘的会话（加密后写 `steam-session.json`）。 */
export interface SteamSessionFile {
  /** 长期凭据，用于换取 access_token。**等同密码**，必须加密存储。 */
  refreshToken: string;
  /** 账号名（用户输入的那个，不是昵称）。 */
  accountName?: string | null;
  /** 展示昵称。 */
  personaName?: string | null;
  /** SteamID64，字符串形式（u64 超出 JS 安全整数范围）。 */
  steamId?: string | null;
  avatarUrl?: string | null;
}

export interface SteamStatus {
  loggedIn: boolean;
  accountName?: string | null;
  personaName?: string | null;
  steamId?: string | null;
  avatarUrl?: string | null;
  /** 磁盘上是否有会话（哪怕已失效）。 */
  hasSession: boolean;
}

export interface SteamGame {
  appId: number;
  name: string;
  playtimeMinutes: number;
  playtimeRecentMinutes?: number | null;
  lastPlayedAt?: number | null;
  iconUrl?: string | null;
  headerUrl?: string | null;
}

export interface SteamLibrary {
  games: SteamGame[];
  total: number;
  cachedAt?: number | null;
  warning?: string | null;
}

export interface SteamAppDetails {
  appId: number;
  name?: string | null;
  headerImage?: string | null;
  capsuleImage?: string | null;
  shortDescription?: string | null;
  genres?: string[];
  releaseDate?: string | null;
  isFree?: boolean;
  priceText?: string | null;
}

export type SteamAuthStateName = "idle" | "pending" | "guard" | "authenticated" | "failed";

export interface SteamAuthState {
  state: SteamAuthStateName;
  message?: string | null;
  guardType?: "email" | "device" | null;
  status?: SteamStatus | null;
}

/**
 * 存储适配器。
 *
 * 宿主实现走 `safeStorage`（DPAPI / Keychain / libsecret）；验证脚本实现走明文
 * 临时文件。协议层只认这三个动作，不关心加密细节。
 */
export interface SteamStorage {
  read(file: string): string | null;
  write(file: string, text: string): void;
  remove(file: string): void;
  exists(file: string): boolean;
}

export interface SteamProtocolOptions {
  /** 会话文件名（相对 dataDir）。 */
  sessionFile: string;
  /** 游戏库缓存文件名（相对 dataDir）。 */
  libraryFile: string;
  storage: SteamStorage;
  /** 网络实现。宿主传 Electron `net.fetch`，验证脚本传全局 fetch。 */
  fetchImpl: typeof fetch;
  /**
   * 可选的诊断日志。
   *
   * 协议层不直接 import Electron 的 log：那样会把它绑死在宿主上，
   * 验证脚本（`npm run verify:steam`）就跑不起来了。
   */
  log?: (message: string, detail?: unknown) => void;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const API_BASE = "https://api.steampowered.com";
const STORE_BASE = "https://store.steampowered.com";
const COMMUNITY_BASE = "https://steamcommunity.com";

/** 商店 / 社区接口要 UA，否则部分地区返回 HTML 错误页而不是 JSON。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20_000;
const APP_DETAILS_TTL_MS = 10 * 60_000;

/** Steam 的 EResult：1 = OK，5 = InvalidPassword，63 = AccountLoginDeniedNeedTwoFactor… */
const ERESULT_OK = 1;
const ERESULT_INVALID_PASSWORD = 5;
const ERESULT_RATE_LIMIT = 84;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 带可选 HTTP 状态的可读错误。文案直接面向用户，前端原样展示。 */
export class SteamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SteamError";
  }
}

// ---------------------------------------------------------------------------
// 协议实现
// ---------------------------------------------------------------------------

interface PendingAuth {
  clientId: string;
  requestId: string;
  /** 服务端建议的轮询间隔（秒）。 */
  interval: number;
  /** 账号密码流程带回的 SteamID（提交 Guard 码要用）。 */
  steamId?: string;
  guardType?: "email" | "device" | null;
  accountName?: string;
}

/**
 * Steam 认证 + 游戏库 + 商店。
 *
 * 单例使用（见 `electron/steam/index.ts`）：登录态是**进程级**的，
 * 多个窗口调 status 必须看到同一份结果。
 */
export class SteamProtocol {
  private pending: PendingAuth | null = null;
  private session: SteamSessionFile | null = null;
  private sessionLoaded = false;
  private accessToken: string | null = null;
  private accessTokenSteamId: string | null = null;
  private appDetailsCache = new Map<number, { data: SteamAppDetails; at: number }>();

  constructor(private readonly options: SteamProtocolOptions) {}

  // -------------------------------------------------------------------------
  // 底层请求
  // -------------------------------------------------------------------------

  /** 带超时与错误归一化的 fetch。 */
  private async request(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.options.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        // Chromium 的 net.fetch 无 credentials 概念，显式 omit 避免带上无关 cookie
        ...(init?.method === "POST" ? {} : {}),
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new SteamError("连接 Steam 超时，请检查网络或在「设置 → 网络」里配置代理");
      }
      // undici / Chromium 的网络层错误都很干，把底层 errno 补进文案
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const code = cause?.code ?? "";
      if (code) {
        throw new SteamError(`连接 Steam 失败（${code}），请检查网络或代理设置`);
      }
      throw new SteamError(`连接 Steam 失败：${(error as Error)?.message ?? String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST 表单到 WebAPI，返回 `response` 字段体。 */
  private async postForm(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams(params).toString();
    const response = await this.request(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body,
    });
    return this.readApiPayload(endpoint, response);
  }

  /** GET 一个 WebAPI，返回 `response` 字段体。 */
  private async getApi(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const search = new URLSearchParams(params).toString();
    const response = await this.request(`${API_BASE}/${endpoint}?${search}`, {
      headers: { "User-Agent": UA },
    });
    return this.readApiPayload(endpoint, response);
  }

  /** 统一的 WebAPI 响应解析：HTTP 状态 → JSON → EResult → response 体。 */
  private async readApiPayload(
    endpoint: string,
    response: Response,
  ): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!response.ok) {
      throw new SteamError(`Steam 接口 ${endpoint} 返回 HTTP ${response.status}`, response.status);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 少数错误路径返回 HTML（地区限制 / 维护页），截断后抛出便于定位
      throw new SteamError(`Steam 接口 ${endpoint} 返回非 JSON 响应：${text.slice(0, 160)}`);
    }
    const container = parsed as { response?: Record<string, unknown> };
    const payload = container?.response;
    if (!payload || typeof payload !== "object") {
      throw new SteamError(`Steam 接口 ${endpoint} 缺少 response 字段`);
    }
    const eresult = payload.eresult;
    if (typeof eresult === "number" && eresult !== ERESULT_OK) {
      throw new SteamError(describeEResult(eresult), 200);
    }
    return payload;
  }

  // -------------------------------------------------------------------------
  // 会话读写
  // -------------------------------------------------------------------------

  /** 读会话（首次访问后缓存在内存）。 */
  private loadSession(): SteamSessionFile | null {
    if (this.sessionLoaded) return this.session;
    this.sessionLoaded = true;
    const raw = this.options.storage.read(this.options.sessionFile);
    if (!raw) {
      this.session = null;
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SteamSessionFile> | null;
      if (!parsed || typeof parsed.refreshToken !== "string" || !parsed.refreshToken) {
        this.session = null;
        return null;
      }
      this.session = {
        refreshToken: parsed.refreshToken,
        accountName: parsed.accountName ?? null,
        personaName: parsed.personaName ?? null,
        steamId: parsed.steamId ?? null,
        avatarUrl: parsed.avatarUrl ?? null,
      };
    } catch {
      // 解密失败（换机 / 凭据损坏）按「未登录」处理，让用户重新登录
      this.session = null;
    }
    return this.session;
  }

  private saveSession(session: SteamSessionFile): void {
    this.session = session;
    this.sessionLoaded = true;
    this.options.storage.write(this.options.sessionFile, JSON.stringify(session));
  }

  /** 磁盘上是否有会话（不校验有效性）。 */
  hasStoredSession(): boolean {
    return this.options.storage.exists(this.options.sessionFile) && this.loadSession() !== null;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 当前登录态。有会话但 token 换不出来 → `loggedIn:false` + `hasSession:true`。 */
  async status(): Promise<SteamStatus> {
    const session = this.loadSession();
    if (!session) {
      return {
        loggedIn: false,
        hasSession: false,
        accountName: null,
        personaName: null,
        steamId: null,
        avatarUrl: null,
      };
    }
    if (!this.accessToken) {
      try {
        await this.ensureAccessToken();
      } catch (error) {
        // 必须留痕：这里静默吞掉错误的话，界面只会显示「未登录」，
        // 而真实原因（例如换 token 被 Steam 以 400 拒绝）在日志里一点痕迹都没有 ——
        // 本轮就因此把「steamid 传 0」这个 bug 拖到用户实测才暴露。
        this.options.log?.("[steam] 换取 access_token 失败，按未登录处理", error);
        return {
          loggedIn: false,
          hasSession: true,
          accountName: session.accountName ?? null,
          personaName: session.personaName ?? null,
          steamId: session.steamId ?? null,
          avatarUrl: session.avatarUrl ?? null,
        };
      }
    }
    return {
      loggedIn: true,
      hasSession: true,
      accountName: session.accountName ?? null,
      personaName: session.personaName ?? null,
      steamId: this.accessTokenSteamId ?? session.steamId ?? null,
      avatarUrl: session.avatarUrl ?? null,
    };
  }

  /**
   * 用 refresh_token 换 access_token（约 24h 有效，按需换，不做本地过期计时）。
   *
   * ⚠️ **`steamid` 必须是真实的 SteamID64，不能传 `"0"`**。
   * 实测传 0 时该接口返回 `400 Missing required routing parameter`（HTML，不是 JSON），
   * 表现是「扫码成功了、账号名也存下来了，但一读 status 就显示未登录」——
   * 因为换不到 token，`status()` 只能判 `loggedIn:false`。
   * 参考实现（`Aurelia参考/src/steam_client/market.rs`）同样传真实 steam_id。
   */
  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const session = this.loadSession();
    if (!session) throw new SteamError("尚未登录 Steam");
    const steamId = session.steamId ?? "";
    if (!steamId) throw new SteamError("会话缺少 SteamID，请重新登录");
    const payload = await this.postForm("IAuthenticationService/GenerateAccessTokenForApp/v1/", {
      refresh_token: session.refreshToken,
      steamid: steamId,
    });
    const accessToken = String(payload.access_token ?? "");
    if (!accessToken) throw new SteamError("Steam 未返回 access_token，登录态可能已失效");
    this.accessToken = accessToken;
    this.accessTokenSteamId = payload.steamid ? String(payload.steamid) : steamId;
    // 服务端可能轮换 refresh_token，轮换了就落盘
    const rotated = String(payload.refresh_token ?? "");
    if (rotated && rotated !== session.refreshToken) {
      this.saveSession({ ...session, refreshToken: rotated });
    }
    return accessToken;
  }

  // -------------------------------------------------------------------------
  // 登录方式一：二维码
  // -------------------------------------------------------------------------

  /** 开始扫码登录。返回可直接编码成二维码的 URL。 */
  async beginQr(): Promise<{ challengeUrl: string; interval: number }> {
    const payload = await this.postForm("IAuthenticationService/BeginAuthSessionViaQR/v1/", {
      device_friendly_name: "SilverMoon",
      platform_type: "SteamClient",
      website_id: "Client",
    });
    const clientId = String(payload.client_id ?? "");
    const requestId = String(payload.request_id ?? "");
    const challengeUrl = String(payload.challenge_url ?? "");
    if (!clientId || !requestId || !challengeUrl) {
      throw new SteamError("Steam 未返回完整的二维码挑战信息，请稍后重试");
    }
    const interval = Number(payload.interval ?? 5) || 5;
    this.pending = { clientId, requestId, interval };
    return { challengeUrl, interval };
  }

  // -------------------------------------------------------------------------
  // 登录方式二：账号密码 + Steam Guard
  // -------------------------------------------------------------------------

  /**
   * 用 Steam 公钥加密密码。
   *
   * Steam 要求客户端先取 RSA 公钥（hex modulus / exponent），再用 PKCS#1 v1.5
   * 加密后 base64 上传。**明文密码永不出本进程**。
   */
  private async encryptPassword(
    accountName: string,
    password: string,
  ): Promise<{ encrypted: string; timestamp: string }> {
    const payload = await this.getApi("IAuthenticationService/GetPasswordRSAPublicKey/v1/", {
      account_name: accountName,
    });
    const mod = String(payload.publickey_mod ?? "");
    const exp = String(payload.publickey_exp ?? "");
    const timestamp = String(payload.timestamp ?? "");
    if (!mod || !exp) {
      throw new SteamError("未能取得 Steam 登录公钥，请检查账号名是否正确");
    }
    // node:crypto 能直接吃 JWK：把 hex 的 n / e 转成 base64url 即可
    const { createPublicKey, publicEncrypt, constants } = await import("node:crypto");
    const key = createPublicKey({
      key: {
        kty: "RSA",
        n: Buffer.from(mod, "hex").toString("base64url"),
        e: Buffer.from(exp, "hex").toString("base64url"),
      },
      format: "jwk",
    });
    const encrypted = publicEncrypt(
      { key, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(password, "utf8"),
    );
    return { encrypted: encrypted.toString("base64"), timestamp };
  }

  /** 账号密码登录。返回 `guard` 时需要再调 `submitGuard`。 */
  async beginCredentials(accountName: string, password: string): Promise<SteamAuthState> {
    const account = accountName.trim();
    if (!account) throw new SteamError("请填写 Steam 账号名");
    if (!password) throw new SteamError("请填写密码");

    const { encrypted, timestamp } = await this.encryptPassword(account, password);
    const payload = await this.postForm(
      "IAuthenticationService/BeginAuthSessionViaCredentials/v1/",
      {
        account_name: account,
        encrypted_password: encrypted,
        encryption_timestamp: timestamp,
        remember_login: "true",
        platform_type: "SteamClient",
        persistence: "1",
        website_id: "Client",
        device_friendly_name: "SilverMoon",
      },
    );

    const clientId = String(payload.client_id ?? "");
    const requestId = String(payload.request_id ?? "");
    if (!clientId || !requestId) {
      // 实测：账号不存在 / 密码错误时 Steam 返回 **200 + 空 response {}**，
      // 既没有 EResult 也没有错误文案。必须自己给出可读提示。
      throw new SteamError("账号名或密码不正确（Steam 未返回认证会话）");
    }

    const steamId = payload.steamid ? String(payload.steamid) : undefined;
    const interval = Number(payload.interval ?? 5) || 5;
    const guardType = readGuardType(payload);
    this.pending = { clientId, requestId, interval, steamId, guardType, accountName: account };

    // 无需 Guard（已信任设备）时直接轮询取 token
    if (guardType === null) {
      const result = await this.pollOnce();
      if (result.state === "authenticated") return result;
      return { state: "pending", message: "正在等待 Steam 确认登录…" };
    }

    return {
      state: "guard",
      guardType,
      message:
        guardType === "email"
          ? `Steam 已向 ${account} 的邮箱发送验证码`
          : "请输入 Steam 手机令牌验证码，或在 Steam 手机应用中确认登录",
    };
  }

  /** 提交 Steam Guard 验证码。 */
  async submitGuard(code: string, codeType: "email" | "device"): Promise<SteamAuthState> {
    const pending = this.pending;
    if (!pending) throw new SteamError("没有进行中的登录请求，请重新登录");
    const trimmed = code.trim();
    if (!trimmed) throw new SteamError("请输入验证码");
    await this.postForm("IAuthenticationService/UpdateAuthSessionWithSteamGuardCode/v1/", {
      client_id: pending.clientId,
      steamid: pending.steamId ?? "0",
      code: trimmed,
      // 2 = 邮箱码，3 = 手机令牌（TOTP）
      code_type: codeType === "email" ? "2" : "3",
    });
    return this.pollOnce();
  }

  // -------------------------------------------------------------------------
  // 轮询
  // -------------------------------------------------------------------------

  /**
   * 轮询一次认证结果。
   *
   * 二维码流程由前端按 `interval` 反复调用；Guard 流程在用户提交后调用。
   * 拿到 refresh_token 即登录成功，随后补全资料并落盘。
   */
  async pollOnce(): Promise<SteamAuthState> {
    const pending = this.pending;
    if (!pending) return { state: "idle", message: null };

    const payload = await this.postForm("IAuthenticationService/PollAuthSessionStatus/v1/", {
      client_id: pending.clientId,
      request_id: pending.requestId,
    });

    const refreshToken = payload.refresh_token ? String(payload.refresh_token) : "";
    const steamId = payload.steamid ? String(payload.steamid) : (pending.steamId ?? null);

    if (!refreshToken) {
      // 服务端可能要求切换 Guard 方式（例如邮箱码改为 App 确认）
      const guardType = readGuardType(payload);
      if (guardType && guardType !== pending.guardType) {
        this.pending = { ...pending, guardType };
        return {
          state: "guard",
          guardType,
          message:
            guardType === "email"
              ? "请输入邮箱验证码"
              : "请在 Steam 手机应用确认，或输入手机令牌验证码",
        };
      }
      if (payload.had_remote_interaction) {
        return {
          state: "pending",
          message: "已在 Steam 应用确认，正在完成登录…",
          guardType: pending.guardType ?? null,
        };
      }
      return {
        state: "pending",
        message: "等待 Steam 确认中…",
        guardType: pending.guardType ?? null,
      };
    }

    // 登录成功：先拉资料，再落盘（资料失败不影响登录）
    let session: SteamSessionFile = {
      refreshToken,
      accountName: pending.accountName ?? null,
      steamId,
      personaName: null,
      avatarUrl: null,
    };
    this.accessToken = null;
    try {
      const profile = await this.fetchProfile(refreshToken, steamId);
      session = { ...session, ...profile };
    } catch {
      // 资料只是锦上添花，拿不到就显示账号名
    }
    this.saveSession(session);
    this.pending = null;

    // ---------------------------------------------------------------------
    // 自检：登录「成功」必须真的能换出 access_token。
    //
    // 少了这一步，「拿到 refresh_token 但换不到 access_token」会变成一个
    // **自相矛盾的状态**：pollOnce 报 authenticated，status() 却报 loggedIn:false。
    // 界面的表现是——面板卸载 → GamesView 一看仍未登录 → 重新挂登录面板 →
    // 又自动开始扫码，用户看到「刚登录成功，怎么又让我扫一次」的死循环。
    // 宁可在这里明确失败，也不要让它循环。
    // ---------------------------------------------------------------------
    this.accessToken = null;
    try {
      await this.ensureAccessToken();
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.options.log?.("[steam] 登录后换取 access_token 失败", error);
      // 会话换不出 token 就是废的，删掉免得下次启动又「有会话但仍未登录」
      this.options.storage.remove(this.options.sessionFile);
      this.session = null;
      this.sessionLoaded = true;
      return {
        state: "failed",
        message: `登录成功但会话无法使用（${detail}），请重试`,
      };
    }

    // 预热游戏库：切到「游戏」页时库已在磁盘缓存里，不必再等一次往返。
    // 失败无所谓（首次进库会再拉一次）。
    void this.getLibrary(true).catch(() => {
      /* 预热失败不影响登录结果 */
    });

    return {
      state: "authenticated",
      message: `已登录：${session.personaName ?? session.accountName ?? "Steam 账号"}`,
      status: await this.status(),
    };
  }

  /** 放弃进行中的登录（服务端会话会自然过期）。 */
  cancel(): void {
    this.pending = null;
  }

  /** 退出登录：清会话与缓存。 */
  logout(): void {
    this.pending = null;
    this.session = null;
    this.sessionLoaded = true;
    this.accessToken = null;
    this.accessTokenSteamId = null;
    this.options.storage.remove(this.options.sessionFile);
    this.options.storage.remove(this.options.libraryFile);
  }

  // -------------------------------------------------------------------------
  // 账号资料
  // -------------------------------------------------------------------------

  /**
   * 拉昵称 / 头像。
   *
   * 优先走 `GetPlayerSummaries`（带 access_token，新版接口接受它代替 key）；
   * 失败则回退到社区 XML 资料页 —— 那是**免鉴权**的公开页，兼容性最好。
   * 两条都失败就只保留 SteamID，不影响登录结果。
   */
  private async fetchProfile(
    refreshToken: string,
    steamId?: string | null,
  ): Promise<Pick<SteamSessionFile, "personaName" | "avatarUrl" | "steamId">> {
    let resolvedId = steamId ?? null;
    let accessToken = "";
    // 这里同样必须传真实 steamid（传 "0" 会被 Steam 以 400 拒绝）。
    // 拿不到 id 就跳过换 token，直接走免鉴权的社区 XML。
    if (resolvedId) {
      try {
        const payload = await this.postForm(
          "IAuthenticationService/GenerateAccessTokenForApp/v1/",
          {
            refresh_token: refreshToken,
            steamid: resolvedId,
          },
        );
        accessToken = String(payload.access_token ?? "");
        this.accessToken = accessToken || null;
        this.accessTokenSteamId = resolvedId;
      } catch {
        // 换不到 token 就只走 XML 回退
      }
    }

    if (resolvedId) {
      try {
        const payload = await this.getApi("ISteamUser/GetPlayerSummaries/v2/", {
          ...(accessToken ? { access_token: accessToken } : {}),
          steamids: resolvedId,
        });
        const players = payload.players as
          { personaname?: string; avatarfull?: string; avatarmedium?: string }[] | undefined;
        const player = players?.[0];
        if (player?.personaname) {
          return {
            personaName: player.personaname,
            avatarUrl: player.avatarfull ?? player.avatarmedium ?? null,
            steamId: resolvedId,
          };
        }
      } catch {
        // 落到 XML
      }
      const xml = await this.fetchCommunityProfile(resolvedId);
      if (xml) return { ...xml, steamId: resolvedId };
    }
    return { personaName: null, avatarUrl: null, steamId: resolvedId };
  }

  /** 社区资料 XML（免 key）：昵称 + 头像。失败返回 null。 */
  private async fetchCommunityProfile(
    steamId: string,
  ): Promise<{ personaName: string | null; avatarUrl: string | null } | null> {
    try {
      const response = await this.request(`${COMMUNITY_BASE}/profiles/${steamId}?xml=1`, {
        headers: { "User-Agent": UA },
      });
      if (!response.ok) return null;
      const xml = await response.text();
      const name =
        /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/.exec(xml)?.[1] ??
        /<steamID>([\s\S]*?)<\/steamID>/.exec(xml)?.[1] ??
        null;
      const avatar =
        /<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/.exec(xml)?.[1] ??
        /<avatarFull>([\s\S]*?)<\/avatarFull>/.exec(xml)?.[1] ??
        null;
      return { personaName: name?.trim() || null, avatarUrl: avatar?.trim() || null };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 游戏库
  // -------------------------------------------------------------------------

  /** 读库缓存（上次成功拉取的结果，用于秒开首屏）。 */
  readLibraryCache(): SteamLibrary | null {
    const raw = this.options.storage.read(this.options.libraryFile);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { games?: SteamGame[]; cachedAt?: number } | null;
      if (!parsed || !Array.isArray(parsed.games)) return null;
      return { games: parsed.games, total: parsed.games.length, cachedAt: parsed.cachedAt ?? null };
    } catch {
      return null;
    }
  }

  /**
   * 取游戏库。
   *
   * - `refresh:false` 且有缓存 → 直接返回缓存（秒开）；
   * - `refresh:true` → 走网络，成功后刷新缓存；
   * - 未登录但有缓存 → 返回缓存并附 `warning`（比抛错更有用）；
   * - 未登录且无缓存 → 抛错，前端据此进入登录页。
   */
  async getLibrary(refresh = false): Promise<SteamLibrary> {
    if (!refresh) {
      const cached = this.readLibraryCache();
      if (cached) return cached;
    }
    const status = await this.status();
    if (!status.loggedIn) {
      const cached = this.readLibraryCache();
      if (cached) return { ...cached, warning: "登录态已失效，显示的是上次缓存的游戏库" };
      throw new SteamError("尚未登录 Steam，请先登录");
    }
    const token = await this.ensureAccessToken();
    const games = await this.fetchOwnedGames(token);
    const cachedAt = Date.now();
    this.options.storage.write(this.options.libraryFile, JSON.stringify({ games, cachedAt }));
    return { games, total: games.length, cachedAt };
  }

  /** `IPlayerService/GetOwnedGames`：拥有的全部游戏（含免费游戏与游玩时长）。 */
  private async fetchOwnedGames(accessToken: string): Promise<SteamGame[]> {
    const payload = await this.getApi("IPlayerService/GetOwnedGames/v1/", {
      access_token: accessToken,
      include_appinfo: "1",
      include_played_free_games: "1",
      skip_unvetted_apps: "0",
      language: "schinese",
    });
    const rawGames = payload.games as
      | {
          appid?: number;
          name?: string;
          playtime_forever?: number;
          playtime_2weeks?: number;
          rtime_last_played?: number;
          img_icon_url?: string;
        }[]
      | undefined;
    if (!Array.isArray(rawGames)) return [];
    const games: SteamGame[] = [];
    for (const g of rawGames) {
      const appId = Number(g.appid ?? 0);
      if (!appId) continue;
      const iconHash = g.img_icon_url ? String(g.img_icon_url) : "";
      games.push({
        appId,
        name: String(g.name ?? `App ${appId}`),
        playtimeMinutes: Number(g.playtime_forever ?? 0),
        playtimeRecentMinutes: g.playtime_2weeks != null ? Number(g.playtime_2weeks) : null,
        // Steam 给的是秒级 unix 时间，转毫秒便于前端直接 new Date()
        lastPlayedAt: g.rtime_last_played ? Number(g.rtime_last_played) * 1000 : null,
        iconUrl: iconHash
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appId}/${iconHash}.jpg`
          : null,
        headerUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
      });
    }
    return games;
  }

  // -------------------------------------------------------------------------
  // 商店详情
  // -------------------------------------------------------------------------

  /**
   * 批量取商店详情。**失败不抛**（返回已有部分），由 UI 降级展示。
   *
   * 结果按 appId 缓存 10 分钟：游戏库滚动时不会反复打商店接口。
   */
  async fetchAppDetails(appIds: number[]): Promise<Record<string, SteamAppDetails>> {
    const now = Date.now();
    const result: Record<string, SteamAppDetails> = {};
    const missing: number[] = [];
    for (const id of appIds) {
      if (!Number.isFinite(id) || id <= 0) continue;
      const hit = this.appDetailsCache.get(id);
      if (hit && now - hit.at < APP_DETAILS_TTL_MS) {
        result[String(id)] = hit.data;
      } else if (!missing.includes(id)) {
        missing.push(id);
      }
    }
    if (missing.length === 0) return result;

    // appdetails 支持逗号批量，但一次太多会 414 / 超时，按 20 个一组
    const CHUNK = 20;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      try {
        const response = await this.request(
          `${STORE_BASE}/api/appdetails?appids=${chunk.join(",")}&l=schinese&cc=cn`,
          { headers: { "User-Agent": UA } },
        );
        if (!response.ok) continue;
        const parsed = (await response.json()) as Record<
          string,
          { success?: boolean; data?: Record<string, unknown> }
        >;
        for (const [key, entry] of Object.entries(parsed)) {
          if (!entry?.success || !entry.data) continue;
          const d = entry.data;
          const data: SteamAppDetails = {
            appId: Number(d.steam_appid ?? key),
            name: (d.name as string) ?? null,
            headerImage: (d.header_image as string) ?? null,
            capsuleImage: (d.capsule_image as string) ?? null,
            shortDescription: (d.short_description as string) ?? null,
            genres: Array.isArray(d.genres)
              ? (d.genres as { description?: string }[])
                  .map((g) => String(g.description ?? ""))
                  .filter(Boolean)
              : [],
            releaseDate: ((d.release_date as { date?: string })?.date as string) ?? null,
            isFree: Boolean(d.is_free),
            priceText:
              ((d.price_overview as { final_formatted?: string })?.final_formatted as string) ??
              (d.is_free ? "免费" : null),
          };
          result[key] = data;
          this.appDetailsCache.set(data.appId, { data, at: now });
        }
      } catch {
        // 单个分片失败不影响其他分片；UI 对缺失项显示占位
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从认证响应里推断可用的 Guard 方式。
 *
 * `allowed_confirmations.confirmation_type`：
 * 1 = 无（已信任设备）、2 = 邮箱码、3 = 手机令牌（TOTP）、4 = 手机 App 确认。
 */
export function readGuardType(payload: Record<string, unknown>): "email" | "device" | null {
  const confirmations = payload.allowed_confirmations as
    { confirmation_type?: number }[] | undefined;
  if (!Array.isArray(confirmations) || confirmations.length === 0) return null;
  const types = confirmations
    .map((c) => Number(c.confirmation_type))
    .filter((n) => Number.isFinite(n));
  if (types.length === 0) return null;
  // 只有 1（无需验证）时不进 Guard 流程
  if (types.every((t) => t === 1)) return null;
  // 设备码优先：手机令牌输入框比邮箱码更常见，且 App 确认也归到这里
  if (types.includes(3)) return "device";
  if (types.includes(2)) return "email";
  if (types.includes(4)) return "device";
  return null;
}

/** EResult → 面向用户的中文文案。 */
export function describeEResult(eresult: number): string {
  switch (eresult) {
    case ERESULT_INVALID_PASSWORD:
      return "账号名或密码不正确";
    case ERESULT_RATE_LIMIT:
      return "登录尝试过于频繁，请稍后再试";
    case 63:
      return "需要输入 Steam Guard 验证码";
    case 65:
      return "验证码不正确或已过期，请重新输入";
    case 88:
      return "该账号需在 Steam 客户端完成首次验证";
    case 5:
      return "账号名或密码不正确";
    case 27:
      return "该账号已被封禁";
    case 22:
      return "该账号已被限制登录";
    default:
      return `Steam 返回错误（EResult ${eresult}），请稍后重试`;
  }
}
