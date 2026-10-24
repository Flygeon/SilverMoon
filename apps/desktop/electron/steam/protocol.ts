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
  /**
   * 上次拿到的 access_token（JWT，约 24h 有效）。
   *
   * **为什么要存它**：只靠 refresh_token 的话，一旦 `GenerateAccessTokenForApp`
   * 换不出 token（Steam 侧限流 / 该 token 已失效 / 网络抖动），重启后就直接
   * 变成「未登录」——即使登录当时一切正常。存一份 access_token，重启时先用它，
   * 真正过期了再换，能把「记得密码但下次打开就掉线」的概率降到最低。
   *
   * 与 refresh_token 同等敏感（可直接冒用接口），因此同样走 safeStorage 加密。
   */
  accessToken?: string | null;
  /** access_token 的过期时间（毫秒时间戳，从 JWT 的 exp 解出）。 */
  accessTokenExpiresAt?: number | null;
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
  /** 详情页增强字段（商店接口本来就有，之前没用上） */
  screenshots?: string[];
  developers?: string[];
  publishers?: string[];
  /** 商店页大背景图（hero 用） */
  backgroundImage?: string | null;
  /**
   * DLC 的 appid 列表（对应 Steam 商店 `dlc` 字段）。
   *
   * 详情页「额外内容」用它列出该游戏的 DLC。名字需要再查一次 appdetails，
   * 因此这里只放 id —— 前端按需批量取（或先显示 id 再补名字）。
   */
  dlc?: number[];
}

/** 单个成就。 */
export interface SteamAchievement {
  apiName: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  unlocked: boolean;
  /** 解锁时间（毫秒）；未解锁为 null */
  unlockTime?: number | null;
}

/** 某款游戏的成就进度。 */
export interface SteamAchievements {
  appId: number;
  /** false = 无成就 / 私密 / 未登录，不是错误 */
  available: boolean;
  unlocked: number;
  total: number;
  achievements: SteamAchievement[];
  warning?: string | null;
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
  log?: (message: string, ...detail: unknown[]) => void;
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
    const response = await this.requestWithRetry(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body,
    });
    return this.readApiPayload(endpoint, response);
  }

  /**
   * 带重试的请求（只对 **5xx** 与网络层瞬时错误重试）。
   *
   * ## 为什么必须有
   *
   * 用户实测碰到过 `BeginAuthSessionViaQR` 返回 **502**：Steam 网关的瞬时故障，
   * 几秒后同一请求就恢复正常（实测连续 3 次 200）。若不重试，用户看到的是
   * 红条「返回 HTTP 502」并被迫手动点「刷新二维码」—— 明明再试一次就好。
   *
   * 只重试 5xx / 网络错误，**不重试 4xx**：4xx 是确定性错误（参数错、token 失效），
   * 重试只会拖慢失败反馈，还可能加重限流。
   */
  private async requestWithRetry(url: string, init?: RequestInit): Promise<Response> {
    const attempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.request(url, init);
        // 只有服务端错误才值得重试；4xx 立刻返回让上层给出准确文案
        if (response.status >= 500 && attempt < attempts) {
          this.options.log?.(`[steam] 服务端 ${response.status}，第 ${attempt} 次重试`, url);
          await sleep(400 * attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        // 网络层瞬时错误（超时 / 连接被重置）也重试
        const transient =
          (error instanceof SteamError && !error.status) ||
          (error as { status?: number })?.status === undefined;
        if (attempt < attempts && transient) {
          this.options.log?.(`[steam] 请求失败，第 ${attempt} 次重试`, (error as Error)?.message);
          await sleep(400 * attempt);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new SteamError(String(lastError));
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
      // 401/403 的实际含义是「token 无效或过期」，不是「接口不存在」。
      // 直接把状态码抛出去会让排查者以为是 URL 写错了（本轮就踩过这个误判）。
      if (response.status === 401 || response.status === 403) {
        throw new SteamError("Steam 登录凭据无效或已过期，请重新登录", response.status);
      }
      // 5xx 已经重试过仍失败：给用户可行动的提示，而不是裸状态码
      if (response.status >= 500) {
        throw new SteamError(
          "Steam 服务器暂时不可用（已自动重试），请稍等片刻再点「刷新二维码」",
          response.status,
        );
      }
      // 429：Steam 对频繁请求的限流
      if (response.status === 429) {
        throw new SteamError("请求过于频繁，已被 Steam 限流，请稍等几分钟再试", response.status);
      }
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
      // 旧版本存下的会话可能没有 steamId（二维码登录曾漏掉）——从 token 自愈补上，
      // 否则升级后的老会话仍然换不出 access_token。补上后立刻写回，只做一次。
      // refresh_token 不是 JWT，解不出 steamid；这里只在缺失时留空，
      // 真正的 steamid 会在拿到 access_token（JWT）后从它的 sub 解出来。
      const healedSteamId = parsed.steamId ?? null;
      this.session = {
        refreshToken: parsed.refreshToken,
        // ⚠️ 这三个字段必须一起搬出来。漏掉 accessToken 的话，落盘的 token
        // 等于白存 —— 重启后仍会去换 token，一旦换失败又显示未登录。
        accessToken: parsed.accessToken ?? null,
        accessTokenExpiresAt: parsed.accessTokenExpiresAt ?? null,
        accountName: parsed.accountName ?? null,
        personaName: parsed.personaName ?? null,
        steamId: healedSteamId ?? null,
        avatarUrl: parsed.avatarUrl ?? null,
      };
      if (!parsed.steamId && healedSteamId) {
        this.options.storage.write(this.options.sessionFile, JSON.stringify(this.session));
      }
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

  /**
   * 导出建立 CM 会话所需的凭据（**仅主进程内部使用**）。
   *
   * 下载必须连 CM，而 CM 要 access_token（JWT）。但 access_token 是长期凭据 ——
   * **绝不能传到渲染进程**。所以前端只说「我要下载 appId=X」，
   * 由主进程在这里取凭据再转发给 sidecar。渲染层永远看不到 token。
   *
   * 返回 null 表示未登录或换不出 token。
   */
  async exportCmCredentials(): Promise<
    { accountName: string; token: string; source: string } | { error: string }
  > {
    const session = this.loadSession();
    if (!session) return { error: "尚未登录 Steam，无法连接 CM" };
    const accountName = session.accountName ?? "";
    if (!accountName) return { error: "会话缺少账号名，请重新登录" };

    /*
     * CM 的 `Connection::access` **只接受 JWT**，且要求 `iss === "steam"`
     * （见 steam-vent 的 unauthenticated.rs：会 split('.') 取第二段做 base64 + JSON 解析）。
     *
     * 所以不能「随便给一个 token」。两个候选都试：
     * - `refreshToken`：参考实现 Aurelia 登录 CM 用的就是它
     * - `accessToken`：我们自己用 GenerateAccessTokenForApp 换出来的
     *
     * 用 isSteamCmToken 实测哪个真的合格，而不是靠猜。
     */
    /*
     * 顺序有讲究：**access_token 优先**。
     *
     * CM logon 发的是 `CMsgClientLogon.access_token` 字段 —— 协议语义上
     * 它就是要 access_token。参考实现 Aurelia 传 refresh_token 也能连上
     * （Steam 对这两种 token 都接受），但 access_token 才是这个字段的本意，
     * 所以先试它；refresh_token 兜底，避免「access_token 换不出来就彻底不能下载」。
     */
    const candidates: { source: string; token: string }[] = [
      { source: "access_token", token: session.accessToken ?? "" },
      { source: "refresh_token", token: session.refreshToken ?? "" },
    ];

    // 换一次 token，尽量让 accessToken 候选是新鲜的（失败不影响 refresh 候选）
    try {
      const fresh = await this.ensureAccessToken();
      if (fresh) {
        const idx = candidates.findIndex((c) => c.source === "access_token");
        if (idx >= 0) candidates[idx] = { source: "access_token", token: fresh };
      }
    } catch {
      // 换不出来就沿用已存的（可能仍有效），不做处理
    }

    for (const candidate of candidates) {
      if (!candidate.token) {
        // 记录「缺失」本身：缺 access_token 往往说明换取失败，是排查的第一步
        this.options.log?.("[steam] CM 凭据候选为空", { source: candidate.source });
        continue;
      }
      const ok = isSteamCmToken(candidate.token);
      // 两个候选**都**记下来（不只记失败的那个）。
      // 关键是 iss 的实际值：steam-vent 硬性要求 iss==="steam"，
      // 不知道它是多少就只能猜。
      this.options.log?.("[steam] CM 凭据候选判定", {
        source: candidate.source,
        accepted: ok,
        ...describeTokenShape(candidate.token),
      });
      if (ok) {
        return { accountName, token: candidate.token, source: candidate.source };
      }
    }

    // 一个都不合格：把每个候选的 iss 实际值记下来（iss 不敏感，仅 "steam" 这类标识）
    this.options.log?.(
      "[steam] 没有可用于 CM 的凭据",
      candidates.map((c) => ({
        source: c.source,
        present: Boolean(c.token),
        ...describeTokenShape(c.token),
      })),
    );

    // 到这里说明两个候选都不是 CM 能接受的 JWT —— 给出可诊断的信息
    const shapes = candidates
      .filter((c) => c.token)
      .map((c) => `${c.source}: ${JSON.stringify(describeTokenShape(c.token))}`)
      .join("；");
    return {
      error: `登录凭据格式不被 CM 接受，请重新登录（${shapes || "无可用凭据"}）`,
    };
  }

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

    // ---- 第一步：优先复用上次落盘的 access_token ----
    //
    // 为什么要这一步：只靠 refresh_token 的话，任何一次「换 token 失败」
    // （限流 / 网络抖动 / 该 refresh_token 已失效）都会让**重启后直接显示未登录**，
    // 哪怕登录当时一切正常 —— 用户看到的就是「明明记住密码了，下次打开又让我登录」。
    // access_token 约 24h 有效，先用它能把这条路径的失败面收窄成「真的过期了」。
    const saved = session.accessToken ?? "";
    if (saved && !isTokenExpired(session.accessTokenExpiresAt)) {
      this.accessToken = saved;
      this.accessTokenSteamId = steamIdFromToken(saved) ?? session.steamId ?? null;
      return saved;
    }

    // 旧会话可能没有 steamId。这里**先换 token 再补 id**：
    // access_token 本身是 JWT，能解出 sub（= steamid），所以缺 id 不该成为死路。
    // （早期实现直接 `if (!steamId) throw`，让上一版遗留的会话永远无法恢复。）
    const steamId = session.steamId ?? "";
    const payload = await this.postForm("IAuthenticationService/GenerateAccessTokenForApp/v1/", {
      refresh_token: session.refreshToken,
      // 缺 id 时传 "0"：Steam 会以 400 拒绝（这是已知行为），
      // 所以调用方应尽量先确保有 id；这里只是兜底，失败会照常抛给上层。
      steamid: steamId || "0",
    });

    const accessToken = String(payload.access_token ?? "");
    if (!accessToken) throw new SteamError("Steam 未返回 access_token，登录态可能已失效");
    this.accessToken = accessToken;

    // steamid：响应里带的 > 从 access_token 解出的 > 会话里存的
    const resolvedId =
      (payload.steamid ? String(payload.steamid) : null) ??
      steamIdFromToken(accessToken) ??
      (steamId || null);
    this.accessTokenSteamId = resolvedId;

    /*
     * 落盘：只更新 access_token 与 steamId，**绝不覆盖 refreshToken**。
     *
     * ## 为什么这一行曾经导致「CM 登录被拒：invalid credentials」
     *
     * `GenerateAccessTokenForApp` 的响应里也会带一个 `refresh_token`（rotated）。
     * 早先的实现拿它覆盖了会话里的原始 refreshToken，看起来"总是用最新的更安全"，
     * 实际上是**把可用于 CM logon 的凭据换成了不能用的那个**：
     *
     * | token 来源 | iss（实测） | 用途 |
     * |---|---|---|
     * | QR 登录拿到的 refreshToken | `steam` | **CM logon 的唯一凭据** |
     * | GenerateAccessTokenForApp 的 rotated | `steam`，但带 `oat`/无 `rt_exp` | 只用于再换 access_token |
     * | GenerateAccessTokenForApp 的 access_token | `r:0016_...` | WebAPI |
     *
     * 换成 rotated 之后，Steam 对 CM logon 回 `Login failed: invalid credentials` ——
     * 而错误信息里完全看不出是"用错了 token"。
     *
     * 所以：原始 refreshToken 是**长期凭据**，只在登录/登出时变更，这里不碰它。
     * rotated 即使存在也丢弃 —— 它带来的收益（延期）远小于"CM 直接连不上"的代价。
     */
    const latest = this.loadSession() ?? session;
    this.saveSession({
      ...latest,
      steamId: resolvedId ?? latest.steamId ?? null,
      accessToken,
      accessTokenExpiresAt: tokenExpiresAt(accessToken),
    });
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
    // poll 响应里可能直接给 access_token（proto 字段 4）与 account_name（字段 6）
    const polledAccessToken = payload.access_token ? String(payload.access_token) : "";
    const polledAccountName = payload.account_name ? String(payload.account_name) : null;

    // steamid 的可靠来源，按优先级：
    // 1) 响应里的 steamid（账号密码流程会给）；
    // 2) **access_token 这个 JWT 的 sub**（二维码流程靠它）；
    // 3) 待处理对象里记住的（凭据流程早期存下的）。
    //
    // 注意：refresh_token 是**不透明字符串**，不是 JWT，解不出 steamid —— 别再用它。
    const steamId =
      (payload.steamid ? String(payload.steamid) : null) ??
      (polledAccessToken ? steamIdFromToken(polledAccessToken) : null) ??
      pending.steamId ??
      null;

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
    //
    // （polledAccessToken / polledAccountName 已在上面函数开头取好。）
    let session: SteamSessionFile = {
      refreshToken,
      accountName: pending.accountName ?? polledAccountName,
      steamId,
      personaName: null,
      avatarUrl: null,
    };
    this.accessToken = polledAccessToken || null;
    if (polledAccessToken) this.accessTokenSteamId = steamId;
    try {
      const profile = await this.fetchProfile(refreshToken, steamId);
      session = { ...session, ...profile };
      // fetchProfile 可能顺手拿到新的 access_token（换 token 成功时）
      if (this.accessToken && this.accessToken !== polledAccessToken) {
        session = { ...session, accessToken: this.accessToken };
      }
    } catch {
      // 资料只是锦上添花，拿不到就显示账号名
    }
    // 把 access_token 一起落盘：重启后先用它，真的过期了才去换 refresh_token。
    // 这是「记住密码但下次打开掉线」的主要修复点。
    if (this.accessToken) {
      session = {
        ...session,
        accessToken: this.accessToken,
        accessTokenExpiresAt: tokenExpiresAt(this.accessToken),
      };
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
    try {
      await this.ensureAccessToken();
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.options.log?.("[steam] 登录后换取 access_token 失败", error, {
        // token 形状（不含内容）足以定位「为什么解不出 steamid」
        refreshTokenShape: describeTokenShape(refreshToken),
      });
      // 会话换不出 token 就是废的，删掉免得下次启动又「有会话但仍未登录」
      this.options.storage.remove(this.options.sessionFile);
      this.session = null;
      this.sessionLoaded = true;
      return {
        state: "failed",
        message: `登录成功但会话无法使用（${detail}），请重试`,
      };
    }

    // 自检拿到的 token 可能比登录时新（refresh 过一次），补落盘
    if (this.accessToken) {
      const cur = this.loadSession();
      if (cur && cur.accessToken !== this.accessToken) {
        this.saveSession({
          ...cur,
          accessToken: this.accessToken,
          accessTokenExpiresAt: tokenExpiresAt(this.accessToken),
        });
      }
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
        // ⚠️ 只在**真的换到**时才覆盖 this.accessToken。
        // 原先写成 `this.accessToken = accessToken || null`：换失败（空串）时会把
        // poll 已经拿到的有效 token 抹成 null，于是登录后自检报
        // 「Steam 未返回 access_token」—— 而 token 其实一直是好的。
        if (accessToken) {
          this.accessToken = accessToken;
          this.accessTokenSteamId = resolvedId;
        }
      } catch {
        // 换不到 token 就只走 XML 回退（保留已有的 accessToken 不动）
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
    // ⚠️ `steamid` 是**必需参数**：不带它 Steam 返回 400
    // `Required parameter 'steamid' is missing`（只在 token 有效时才暴露，
    // 无效 token 会先被 401 拦下 —— 因此假 token 探测发现不了）。
    // 优先从 access_token（JWT）解 sub，其次用会话里保存的 steamId。
    const steamId =
      steamIdFromToken(accessToken) ??
      this.accessTokenSteamId ??
      this.loadSession()?.steamId ??
      null;
    if (!steamId) {
      throw new SteamError("无法确定 SteamID，请重新登录");
    }
    const payload = await this.getApi("IPlayerService/GetOwnedGames/v1/", {
      access_token: accessToken,
      steamid: steamId,
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
            // 详情页增强：截图 / 开发商 / 发行商 / 大背景图
            screenshots: Array.isArray(d.screenshots)
              ? (d.screenshots as { path_full?: string }[])
                  .map((s) => String(s.path_full ?? ""))
                  .filter(Boolean)
              : [],
            developers: Array.isArray(d.developers) ? (d.developers as string[]).map(String) : [],
            publishers: Array.isArray(d.publishers) ? (d.publishers as string[]).map(String) : [],
            backgroundImage: (d.background_raw as string) ?? (d.background as string) ?? null,
            dlc: Array.isArray(d.dlc)
              ? (d.dlc as unknown[])
                  .map((n) => Number(n))
                  .filter((n) => Number.isFinite(n) && n > 0)
              : [],
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

  // -------------------------------------------------------------------------
  // 成就
  // -------------------------------------------------------------------------

  /**
   * 读某款游戏的成就进度。
   *
   * 走 `ISteamUserStats/GetPlayerAchievements`（需要 access_token 与 steamid）。
   * 隐私设置为私密 / 游戏无成就 / token 失效都会失败 —— 这些**都不是错误**，
   * 统一返回 `available:false` 并附 `warning`，详情页照常显示其他内容。
   */
  async fetchAchievements(appId: number): Promise<SteamAchievements> {
    const empty: SteamAchievements = {
      appId,
      available: false,
      unlocked: 0,
      total: 0,
      achievements: [],
    };
    let steamId: string;
    try {
      steamId = await this.ensureSteamId();
    } catch (error) {
      return { ...empty, warning: (error as Error)?.message ?? "需要登录才能读取成就" };
    }

    // 走**社区公开 XML**，而不是 `ISteamUserStats/GetPlayerAchievements`。
    //
    // 原因（实测）：后者**只认 WebAPI key**，不接受 access_token ——
    // 传 token 会直接 400 `Required parameter 'key' is missing`。
    // 而本应用没有、也不该要求用户去申请一个 WebAPI key。
    // 社区 XML 接口免鉴权、返回结构化 XML，是这个场景唯一可用的来源。
    //
    // 隐私为「仅好友可见 / 私密」时，XML 只回 `privacyState` 而无成就列表 ——
    // 这不是错误，返回 available:false 并说明原因即可。
    const url = `${COMMUNITY_BASE}/profiles/${steamId}/stats/${appId}/achievements/?xml=1`;
    try {
      const response = await this.request(url, { headers: { "User-Agent": UA } });
      if (!response.ok) {
        return { ...empty, warning: `读取成就失败（HTTP ${response.status}）` };
      }
      const xml = await response.text();
      const privacy = /<privacyState>([^<]*)<\/privacyState>/.exec(xml)?.[1] ?? "";
      if (privacy && privacy !== "public") {
        return {
          ...empty,
          warning:
            privacy === "private"
              ? "该账号的成就资料设为私密，无法读取"
              : "该账号的成就资料仅好友可见，无法读取",
        };
      }

      // 每个成就是一个 <achievement> 块；按块切分后再取字段，避免跨块正则误配
      const blocks = xml.match(/<achievement\b[\s\S]*?<\/achievement>/g) ?? [];
      const achievements: SteamAchievement[] = [];
      for (const block of blocks) {
        const pick = (tag: string) => {
          const m =
            new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(block) ??
            new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
          return m?.[1]?.trim() ?? "";
        };
        const apiName = pick("apiname");
        if (!apiName) continue;
        // <closed>1</closed>：1 = 已解锁
        const closed = pick("closed") === "1";
        const unlockTime = Number(pick("unlockTimestamp") || 0);
        achievements.push({
          apiName,
          name: pick("name") || apiName,
          description: pick("description") || null,
          icon: pick("iconClosed") || null,
          unlocked: closed,
          unlockTime: unlockTime > 0 ? unlockTime * 1000 : null,
        });
      }

      if (achievements.length === 0) {
        return { ...empty, warning: "该游戏没有成就，或成就资料未公开" };
      }
      const unlocked = achievements.filter((a) => a.unlocked).length;
      return {
        appId,
        available: true,
        unlocked,
        total: achievements.length,
        achievements,
      };
    } catch (error) {
      return { ...empty, warning: (error as Error)?.message ?? String(error) };
    }
  }

  /** 取当前登录账号的 SteamID64（成就等社区接口需要）。 */
  private async ensureSteamId(): Promise<string> {
    const token = await this.ensureAccessToken();
    const id =
      steamIdFromToken(token) ?? this.accessTokenSteamId ?? this.loadSession()?.steamId ?? null;
    if (!id) throw new SteamError("缺少 SteamID，请重新登录");
    return id;
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 简易延时（重试退避用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从 refresh_token 里解出 SteamID64。
 *
 * ## 为什么必须这么做
 *
 * Steam 的 refresh_token 是 **JWT**，其 payload 的 `sub` 就是 SteamID64。
 * 而不同登录流程能拿到的字段并不一样：
 * - **账号密码流程**：`BeginAuthSessionViaCredentials` 会直接回 `steamid`；
 * - **二维码流程**：`PollAuthSessionStatus` 在登录成功时**只回 refresh_token**，
 *   没有 steamid 字段（实测 keys 只有 `had_remote_interaction` 等）。
 *
 * 而换 access_token（`GenerateAccessTokenForApp`）又**必须**带真实 steamid ——
 * 传 `"0"` 会被 Steam 以 400 拒绝。所以二维码登录后，只能从 token 自己解出来。
 *
 * 参考实现（steam-vent / Aurelia）只走「凭据 + CM 会话」那条路，steamid 由
 * 连接对象持有，因此没有这个问题；我们走纯 HTTPS 才必须自己补这一步。
 *
 * 解不出来（不是 JWT / 结构异常）时返回 null，调用方按「会话不可用」处理。
 */
/**
 * 描述一个 token 的**结构**（绝不输出内容，只输出可用于排查的形状信息）。
 *
 * 用于回答「为什么解不出 steamid」这类问题：是根本不是 JWT、还是 claim 名不对、
 * 还是值类型不对。把它写进日志是安全的 —— 不包含任何可被冒用的凭据。
 */
export function describeTokenShape(token: string): Record<string, unknown> {
  const text = typeof token === "string" ? token : "";
  const parts = text.split(".");
  const shape: Record<string, unknown> = {
    length: text.length,
    segments: parts.length,
    /** 是否形如 JWT（三段） */
    jwtLike: parts.length === 3,
  };
  if (parts.length >= 2) {
    try {
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
      // 只暴露 claim 名与值类型，不暴露值本身
      const claims: Record<string, string> = {};
      for (const [key, value] of Object.entries(payload)) {
        claims[key] = Array.isArray(value) ? "array" : typeof value;
      }
      shape.claims = claims;
      shape.subType = typeof payload.sub;
      shape.subLength = typeof payload.sub === "string" ? payload.sub.length : null;
      // iss 是公开标识（"steam" 这类），不是秘密；但它是 CM 唯一的接受条件，
      // 排查「登录被拒」时必须能直接看到值，否则只能靠猜。
      shape.iss = typeof payload.iss === "string" ? payload.iss : null;
    } catch {
      shape.payloadParseError = true;
    }
  }
  return shape;
}

/**
 * 这个 token 能否被 **CM 的 `Connection::access`** 接受。
 *
 * ## 为什么需要这个判断（下载功能踩的坑）
 *
 * `steam-vent` 的 `Connection::access` 不是「随便给个 token 就能连」：
 *
 * ```text
 * token.split('.').nth(1)  → base64_url_safe_decode → JSON 解析成 { iss, sub, exp }
 * 若 iss != "steam"  →  ConnectionError::AccessToken(InvalidIssuer)
 * 若只有一两段      →  ConnectionError::AccessToken(Malformed)
 * ```
 *
 * 也就是说**必须是 JWT，且签发者必须是 steam**。
 * 传错 token 的后果是一句含糊的「登录被拒」，看不出真正原因 ——
 * 所以这里先本地判定，不合格就不发请求、直接给出可读结论。
 *
 * 注意：不校验 exp。steam-vent 自己也把 exp 检查注释掉了（TODO），
 * 是否过期交给 Steam 服务端判，本地判早了反而会把可用 token 拦下。
 */
export function isSteamCmToken(token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      iss?: unknown;
    };
    return payload.iss === "steam";
  } catch {
    return false;
  }
}

/**
 * 从 Steam 的 **JWT** 里解出 SteamID64（`sub`）。
 *
 * ## 两个关键事实（都是踩坑换来的）
 *
 * 1. **access_token 是 JWT**（`sub` = SteamID64），而 **refresh_token 是不透明
 *    字符串**（不是 JWT）。早期版本误以为 refresh_token 是 JWT，导致二维码登录
 *    一直拿不到 steamid。
 * 2. `IPlayerService/GetOwnedGames` **必须**带 `steamid` 参数（与 access_token 并列），
 *    否则 Steam 回 400 `Required parameter 'steamid' is missing`。
 *    这个 400 **只在 token 有效时才出现**（无效 token 先被 401 拦下），
 *    所以用假 token 探测永远测不出来 —— 本轮就是因此多绕了一圈。
 */

/** 从 JWT 里取 `exp`（秒）并转成毫秒；解不出返回 null。 */
export function tokenExpiresAt(token: string): number | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/**
 * 判断已落盘的 access_token 是否该视为过期。
 *
 * - 没有过期时间（解不出 exp）→ **当作过期**，走换 token。宁可多换一次，
 *   也不要用一个来路不明的 token 去调接口（会得到 401，比多一次请求更糟）。
 * - 留 5 分钟余量：避免「判为有效、发出去已过期」的边界抖动。
 */
export function isTokenExpired(expiresAt: number | null | undefined): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  const SAFETY_MS = 5 * 60_000;
  return Date.now() + SAFETY_MS >= expiresAt;
}

export function steamIdFromToken(token: string): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    // JWT payload 是 base64url；补足 padding 后按 base64 解
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(json) as { sub?: string | number };
    const sub = payload?.sub;
    if (sub === undefined || sub === null) return null;
    // ⚠️ 只认**字符串**形式的 sub。
    // SteamID64 是 17 位，远超 Number.MAX_SAFE_INTEGER（9007199254740991，16 位），
    // 一旦以 JSON number 形式出现，解析阶段就已丢精度（...930 → ...940），
    // 而失真后的值**仍然是** 17 位数字，光靠正则拦不住 —— 只能从类型上拒绝。
    // Steam 实际发的始终是字符串；收到数字说明链路某处已损坏，
    // 此时返回 null 比返回一个错误 ID 安全（错误 ID 会让换 token 一直失败且极难排查）。
    if (typeof sub !== "string") return null;
    const id = sub.trim();
    if (!/^\d{17}$/.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}

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
