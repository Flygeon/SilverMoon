/**
 * 纯浏览器预览用的 mock 后端（不经 Electron 启动、只有 Vite dev server 时生效）。
 * 只为让 UI 可见，不追求行为等价。
 */
import type {
  AnimeHistoryItem,
  AppliedOnlineTags,
  ExtInfo,
  MusicTagFields,
  AnimeRuleEntry,
  FfmpegStatus,
  ListenSourceStat,
  ListenStats,
  LoadedSkin,
  MediaEntry,
  NeteaseCloudPage,
  NeteasePlaylist,
  NeteaseProfile,
  NeteaseQrCheck,
  NeteaseSong,
  PixivCommentsPage,
  PixivIllustDetail,
  PixivIllustPage,
  PixivLoginStatus,
  PixivTrendTag,
  PixivUgoiraFrames,
  PixivUserDetail,
  ScanProgress,
  SkinEntry,
  SteamAchievements,
  SteamAchievement,
  SteamActionResult,
  SteamAppDetails,
  SteamAuthState,
  SteamGame,
  SteamGameDetail,
  SteamInstalledGame,
  SteamLibrary,
  SteamLibraryFolder,
  SteamLocalLibrary,
  SteamSettings,
  SteamStatus,
  SteamDepotInfo,
  SteamDownloadOutcome,
  TopTrackStat,
  WebDavEntry,
  WebDavStatus,
} from "@shared/types";

/** 内联 SVG 占位封面，避免依赖外部图片 */
function placeholderCover(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},60%,55%)"/>
      <stop offset="100%" stop-color="hsl(${hue + 40},55%,35%)"/>
    </linearGradient></defs>
    <rect width="320" height="320" fill="url(#g)"/>
    <text x="160" y="175" font-size="34" font-family="sans-serif" fill="rgba(255,255,255,.9)"
          text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

const DEMO: MediaEntry[] = [
  entry("demo-a1", "audio", "夜曲.flac", {
    title: "夜曲",
    artist: "周杰伦",
    album: "十一月的萧邦",
    durationMs: 231000,
  }),
  entry("demo-a2", "audio", "稻香.mp3", {
    title: "稻香",
    artist: "周杰伦",
    album: "魔杰座",
    durationMs: 223000,
  }),
  entry("demo-a3", "audio", "Bohemian Rhapsody.flac", {
    title: "Bohemian Rhapsody",
    artist: "Queen",
    album: "A Night at the Opera",
    durationMs: 354000,
  }),
  entry("demo-i1", "image", "海边日落.jpg", { width: 4032, height: 3024, takenAt: 1719300000 }),
  entry("demo-i2", "image", "城市夜景.png", { width: 3840, height: 2160, takenAt: 1717000000 }),
  entry("demo-i3", "image", "山脉.webp", { width: 2560, height: 1440 }),
  entry("demo-v1", "video", "旅行记录.mp4", {
    width: 1920,
    height: 1080,
    durationMs: 754000,
    codec: "H264",
    fps: 29.97,
  }),
  entry("demo-v2", "video", "延时摄影.mov", {
    width: 3840,
    height: 2160,
    durationMs: 62000,
    codec: "HEVC",
    fps: 60,
  }),
  entry("demo-b1", "book", "小王子.epub", { title: "小王子", artist: null }),
  // 用 ?bulk=N 注入大批量图片，便于验证虚拟滚动在大图库下的表现
  ...bulkImages(),
];

function bulkImages(): MediaEntry[] {
  const n = Number(
    new URLSearchParams(location.search).get("bulk") ??
      new URLSearchParams(location.hash.split("?")[1] ?? "").get("bulk") ??
      0,
  );
  if (!n || Number.isNaN(n)) return [];
  return Array.from({ length: n }, (_, i) =>
    entry(`bulk-${i}`, "image", `照片_${String(i).padStart(5, "0")}.jpg`, {
      width: 4000,
      height: 3000,
      mtime: 1700000000 + i,
    }),
  );
}

function entry(
  id: string,
  type: MediaEntry["type"],
  name: string,
  extra: Partial<MediaEntry>,
): MediaEntry {
  return {
    id,
    path: `D:/Demo/${name}`,
    parent: "D:/Demo",
    name,
    ext: name.split(".").pop() ?? "",
    type,
    size: 1024 * 1024 * 8,
    mtime: 1720000000,
    scannedAt: 1720000000,
    deleted: 0,
    title: extra.title ?? name.replace(/\.[^.]+$/, ""),
    hasCover: type === "audio",
    favorite: false,
    ...extra,
  };
}

const HUES: Record<string, number> = { audio: 265, image: 195, video: 20, book: 145 };
const LABELS: Record<string, string> = { audio: "♪", image: "IMG", video: "VIDEO", book: "BOOK" };

// ---- 皮肤库内存模拟（浏览器预览用）----
const mockSkins = new Map<string, string>();

// ---- WebDAV 演示目录树（浏览器预览用，真实行为由 Rust 代理提供）----

function davEntry(name: string, dir: string, isDir: boolean, size = 0): WebDavEntry {
  return {
    name,
    path: dir ? dir + "/" + name : name,
    isDir,
    size,
    mtime: 1720000000,
  };
}

const DAV_TREE: Record<string, WebDavEntry[]> = {
  "": [
    davEntry("音乐", "", true),
    davEntry("图片", "", true),
    davEntry("视频", "", true),
    davEntry("说明.txt", "", false, 120),
  ],
  音乐: [
    davEntry("夜曲.flac", "音乐", false, 9 * 1024 * 1024),
    davEntry("稻香.mp3", "音乐", false, 4 * 1024 * 1024),
  ],
  图片: [davEntry("海边日落.jpg", "图片", false, 2 * 1024 * 1024)],
  视频: [davEntry("旅行记录.mp4", "视频", false, 60 * 1024 * 1024)],
};

const favorites = new Set<string>(["demo-a1"]);

/** 浏览器预览用：扫码轮询计数（800 → 803 推进） */
let qrCheckCount: number | undefined;

// ---- 音乐标签写入（浏览器预览内存模拟）----
//
// 预览环境没有 taglib / 磁盘缓存，这里只用内存 Map 让 Dialog 的三个语义都走得通：
// 「应用 → 读到覆盖 → 还原默认 → 回到平台原值」与桌面端行为一致。

const EMPTY_TAG_FIELDS: MusicTagFields = {
  title: "",
  artist: "",
  album: "",
  albumArtist: "",
  year: "",
  trackNo: "",
  discNo: "",
  genre: "",
  comment: "",
  lyrics: "",
};

function tagFields(input: unknown): MusicTagFields {
  return { ...EMPTY_TAG_FIELDS, ...((input ?? {}) as Partial<MusicTagFields>) };
}

/** key = 在线合并 key；本地用 path 当 key（预览里两者互不干扰） */
const mockOnlineTags = new Map<string, AppliedOnlineTags>();
const mockOnlineLyrics = new Map<string, string>();
/** 本地：path → 当前标签 / 写入前备份 / 是否写过（预览里让三个语义都走得通） */
const mockLocalTags = new Map<string, MusicTagFields>();
const mockLocalBackups = new Map<string, MusicTagFields>();

/**
 * Steam 通道的 mock 实现（浏览器预览专用）。
 *
 * 与 Rust 命令的 mock **分开导出**，理由和 mockMusicTags 相同：steam 是主进程
 * 通用能力（call("steam")），不是后端路由表里的命令。若把它写成 mockInvoke 里的
 * 一个 case，`npm run verify:mock-coverage` 会按「路由表里没这条 → 死分支」直接判红。
 *
 * 形态尽量贴近真实宿主，好让三个界面都能点通：
 * - 默认**已登录**（直接能看到游戏库）；点「退出登录」后落到登录卡，
 *   此时 hasSession 仍为 true，于是「继续以 XXX 身份登录」这条路也走得通；
 * - 封面/头像用内联 SVG 占位（placeholderCover），不依赖外网，预览不会裂图；
 * - Guard 流程按 codeType 演示两种文案，提交任意 4 位以上验证码即登录成功。
 */
const MOCK_STEAM_GAMES: SteamGame[] = [
  { appId: 730, name: "Counter-Strike 2", playtimeMinutes: 18342, playtimeRecentMinutes: 320 },
  { appId: 570, name: "Dota 2", playtimeMinutes: 9021, playtimeRecentMinutes: 0 },
  { appId: 105600, name: "Terraria", playtimeMinutes: 4210, playtimeRecentMinutes: 145 },
  { appId: 413150, name: "Stardew Valley", playtimeMinutes: 3980, playtimeRecentMinutes: 60 },
  { appId: 367520, name: "Hollow Knight", playtimeMinutes: 2410, playtimeRecentMinutes: null },
  { appId: 1145360, name: "Hades", playtimeMinutes: 1560, playtimeRecentMinutes: 88 },
  { appId: 292030, name: "The Witcher 3: Wild Hunt", playtimeMinutes: 6200 },
  { appId: 1245620, name: "ELDEN RING", playtimeMinutes: 5400, playtimeRecentMinutes: 210 },
].map((g, i) => ({
  ...g,
  // 每款游戏给一个稳定的「最近游玩」时间点（毫秒），便于验证排序与相对时间
  lastPlayedAt: i === 1 ? null : Date.now() - (i + 1) * 26 * 3600 * 1000,
  iconUrl: placeholderCover(String(g.appId), (i * 47) % 360),
  headerUrl: placeholderCover(g.name.slice(0, 2), (i * 47) % 360),
}));

/** 预览里的登录态（退出登录后置 false，用来演示登录卡片） */
const mockSteamStatus: SteamStatus = {
  loggedIn: true,
  accountName: "silvermoon_demo",
  personaName: "SilverMoon 演示账号",
  steamId: "76561198000000000",
  avatarUrl: placeholderCover("SM", 200),
  hasSession: true,
};

/** 扫码轮询计数：第 3 次 poll 视为「已确认」，让预览不必真等 */
let mockSteamPollCount = 0;

// ---- CM 登录（预览）----
//
// 统一登录后 **CM 扫码就是主登录态**：游戏库与下载共用这份凭据。
// 预览默认「未扫码」（false），这样浏览器预览从登录卡开始，能完整走一遍
// 「扫码 → 授权 → 拉库」；扫码成功后下面的 mock 库才可见。
/** 预览里是否已有 CM 凭据：初始 false，扫一遍码之后置 true */
let mockCmHasToken = false;
/** CM 凭据对应的账号名 */
let mockCmAccountName = "";
/** CM 轮询计数：第 2 次 poll 视为已授权（让浏览器预览能快速看完整流程） */
let mockCmPollCount = 0;

function steamLib(): SteamLibrary {
  return {
    games: MOCK_STEAM_GAMES,
    total: MOCK_STEAM_GAMES.length,
    cachedAt: Date.now() - 5 * 60_000,
    warning: "浏览器预览：数据为演示内容，真实游戏库需在桌面端登录 Steam",
  };
}

function steamAppDetails(appIds: number[]): Record<string, SteamAppDetails> {
  const out: Record<string, SteamAppDetails> = {};
  for (const id of appIds) {
    const hit = MOCK_STEAM_GAMES.find((g) => g.appId === id);
    out[String(id)] = {
      appId: id,
      name: hit?.name ?? "未知游戏",
      headerImage: hit?.headerUrl ?? null,
      capsuleImage: hit?.headerUrl ?? null,
      shortDescription:
        "这是浏览器预览用的演示简介：真实内容来自 Steam 商店接口（store.steampowered.com/api/appdetails）。",
      genres: ["动作", "独立", "角色扮演"],
      releaseDate: "2023 年 10 月 24 日",
      isFree: id === 570,
      priceText: id === 570 ? "免费" : "¥ 98.00",
    };
  }
  return out;
}

// ------------------------------------------------------------------ 本地库 / 成就 / 详情

/**
 * 演示用的「已安装」集合。
 *
 * 刻意一装一未装：appId 730（CS2）已安装 —— 详情页能走到「开始游戏 + 占用空间 + 路径」这条分支；
 * 570（Dota 2）与 367520（Hollow Knight）未安装 —— 能走到「安装」按钮与「需要空间」。
 */
const MOCK_STEAM_INSTALLED_IDS = new Set<number>([730, 105600, 1245620]);

/** 稳定的演示时间戳（毫秒）：不用 Date.now()，否则每次刷新页面的「最近运行」都在跳 */
const MOCK_STEAM_NOW = Date.now();

const MOCK_STEAM_LIBRARY_FOLDERS: SteamLibraryFolder[] = [
  { path: "C:/Program Files (x86)/Steam", label: null, appCount: 2 },
  { path: "D:/SteamLibrary", label: "二盘", appCount: 1 },
];

function steamInstalled(): SteamInstalledGame[] {
  return MOCK_STEAM_GAMES.filter((g) => MOCK_STEAM_INSTALLED_IDS.has(g.appId)).map((g, i) => ({
    appId: g.appId,
    name: g.name,
    installDir: g.name.replace(/[^A-Za-z0-9]+/g, ""),
    // 1.8 GB ~ 62 GB，按序号错开，方便肉眼核对 formatSize 的显示
    sizeOnDisk: (i + 1) * 18.4 * 1024 ** 3,
    lastPlayedAt: g.lastPlayedAt ?? MOCK_STEAM_NOW - 3 * 24 * 3600 * 1000,
    // 4 = StateFlagsFullyInstalled
    stateFlags: 4,
    libraryPath: MOCK_STEAM_LIBRARY_FOLDERS[i % MOCK_STEAM_LIBRARY_FOLDERS.length].path,
    manifestPath: `appmanifest_${g.appId}.acf`,
  }));
}

function steamLocalLib(): SteamLocalLibrary {
  const installed = steamInstalled();
  return {
    installed,
    steamRoot: "C:/Program Files (x86)/Steam",
    libraries: MOCK_STEAM_LIBRARY_FOLDERS.map((f) => ({
      ...f,
      appCount: installed.filter((g) => g.libraryPath === f.path).length,
    })),
    scannedAt: MOCK_STEAM_NOW,
    warning: "浏览器预览：本地库为演示数据，真实数据需在桌面端读取 Steam 安装目录",
  };
}

/** 演示成就：每款游戏给 5~8 条，前一半已解锁（含解锁时间） */
function steamAchievementList(appId: number): SteamAchievements {
  const game = MOCK_STEAM_GAMES.find((g) => g.appId === appId);
  // 演示「有些游戏没成就」：Hollow Knight 在这里当作无成就，成就区块会整块隐藏
  if (!game || appId === 367520) {
    return {
      appId,
      available: false,
      unlocked: 0,
      total: 0,
      achievements: [],
      warning: "该演示游戏没有成就数据",
    };
  }
  const total = 7;
  const unlockedCount = 4;
  const achievements: SteamAchievement[] = Array.from({ length: total }, (_, i) => {
    const unlocked = i < unlockedCount;
    return {
      apiName: `ACH_${appId}_${i + 1}`,
      name: `演示成就 ${i + 1}`,
      description: unlocked ? "浏览器预览用的演示成就描述" : "尚未解锁的成就不会显示描述",
      icon: unlocked ? placeholderCover("★", (i * 61) % 360) : null,
      unlocked,
      unlockTime: unlocked ? MOCK_STEAM_NOW - (i + 1) * 5 * 24 * 3600 * 1000 : null,
    };
  });
  return { appId, available: true, unlocked: unlockedCount, total, achievements, warning: null };
}

/** 演示设置：自动识别成功，自定义库目录给一个，便于验证移除按钮 */
let mockSteamSettings: SteamSettings = {
  steamRoot: "C:/Program Files (x86)/Steam",
  customRoots: ["D:/SteamLibrary"],
  detected: true,
};

function steamGameDetailOf(appId: number): SteamGameDetail {
  const map = steamAppDetails([appId]);
  return {
    appId,
    details: map[String(appId)] ?? null,
    local: steamInstalled().find((g) => g.appId === appId) ?? null,
    achievements: steamAchievementList(appId),
  };
}

/** 演示用的启动 / 唤起结果：未安装在本地库时如实返回 ok:false */
function steamActionOf(op: "launchGame" | "openInSteam", appId: number): SteamActionResult {
  const installed = MOCK_STEAM_INSTALLED_IDS.has(appId);
  if (!installed) {
    return { ok: false, message: "该游戏尚未安装（浏览器预览：仅为演示状态）" };
  }
  return {
    ok: true,
    message: op === "launchGame" ? "已在 Steam 中启动（演示）" : "已在 Steam 中打开（演示）",
  };
}

function mockAuthenticated(): SteamAuthState {
  mockSteamStatus.loggedIn = true;
  return { state: "authenticated", message: "登录成功（演示）", status: { ...mockSteamStatus } };
}

/** Steam 通道 mock：按 op 分派，与 electron/ipc.ts 的 steam 分支一一对应。 */
export function mockSteam<T>(payload: Record<string, unknown>): T {
  const op = String(payload.op ?? "");
  switch (op) {
    case "status":
      return { ...mockSteamStatus } as unknown as T;
    case "library":
    case "refreshLibrary":
      if (!mockSteamStatus.loggedIn) {
        // 与真实宿主一致：未登录但有缓存时给缓存 + 警告，而不是直接抛错
        return { ...steamLib(), warning: "登录态已失效，显示的是上次缓存的游戏库" } as unknown as T;
      }
      return steamLib() as unknown as T;
    case "appDetails": {
      const ids = Array.isArray(payload.appIds) ? payload.appIds.map((n) => Number(n)) : [];
      return steamAppDetails(ids.filter((n) => Number.isFinite(n))) as unknown as T;
    }
    case "loginQrStart":
      mockSteamPollCount = 0;
      return {
        state: "pending",
        message: "请用 Steam 手机应用扫描二维码（浏览器预览：扫码不会真的生效）",
        challengeUrl: "https://s.team/q/mock-preview-challenge",
        // 契约里 interval 的单位是**秒**；预览给 3 秒，省得等太久
        interval: 3,
      } as unknown as T;
    case "loginPoll":
      mockSteamPollCount += 1;
      if (mockSteamPollCount >= 3) return mockAuthenticated() as unknown as T;
      return {
        state: "pending",
        message: `等待手机确认（演示：再轮询 ${3 - mockSteamPollCount} 次即成功）`,
      } as unknown as T;
    case "loginCredentials": {
      const account = String(payload.accountName ?? "").trim();
      if (!account) {
        return { state: "failed", message: "请输入账号名" } as unknown as T;
      }
      mockSteamStatus.accountName = account;
      // 演示「需要验证码」：手机令牌路径（真实宿主由 Steam 决定用哪种）
      return {
        state: "guard",
        guardType: "device",
        message: "请输入 Steam 手机令牌上显示的验证码（演示：任意 4 位以上即可）",
      } as unknown as T;
    }
    case "submitGuard": {
      const code = String(payload.code ?? "").trim();
      if (code.length < 4) {
        return { state: "failed", message: "验证码格式不正确" } as unknown as T;
      }
      mockSteamStatus.personaName = mockSteamStatus.personaName || "SilverMoon 演示账号";
      return mockAuthenticated() as unknown as T;
    }
    case "cancelLogin":
      mockSteamPollCount = 0;
      return null as unknown as T;
    case "logout":
      // 保留 hasSession：退出后仍能演示「继续以 XXX 身份登录」的恢复入口
      mockSteamStatus.loggedIn = false;
      return null as unknown as T;
    case "localLibrary":
      return steamLocalLib() as unknown as T;
    case "gameDetail": {
      const id = Number(payload.appId);
      if (!Number.isFinite(id)) return { appId: 0 } as unknown as T;
      return steamGameDetailOf(id) as unknown as T;
    }
    case "achievements": {
      const id = Number(payload.appId);
      if (!Number.isFinite(id))
        return {
          appId: 0,
          available: false,
          unlocked: 0,
          total: 0,
          achievements: [],
        } as unknown as T;
      return steamAchievementList(id) as unknown as T;
    }
    case "launchGame":
      return steamActionOf("launchGame", Number(payload.appId)) as unknown as T;
    case "openInSteam":
      return steamActionOf("openInSteam", Number(payload.appId)) as unknown as T;
    case "steamSettings":
      return { ...mockSteamSettings } as unknown as T;
    case "setSteamSettings": {
      // 只回写前端传上来的字段，其余保持原样（与宿主「读-改-写」语义一致）
      if (Array.isArray(payload.customRoots)) {
        mockSteamSettings = {
          ...mockSteamSettings,
          customRoots: payload.customRoots.map((p) => String(p)),
        };
      }
      return { ...mockSteamSettings } as unknown as T;
    }
    case "pickSteamRoot":
      return { path: "E:/SteamLibrary" } as unknown as T;

    // ---- 下载（浏览器预览：直接成功，不做真下载）----
    //
    // mock 里**不能**模拟进度事件：`steam:download` 是宿主从 sidecar 收到了
    // SSE 后转发过来的，浏览器预览根本没有这条通道，mock 里 setInterval 也发不出
    // 一个真实事件。所以这里只回一个成功结果；「下载中」的进度外观由
    // stores/steam.ts 在 !isDesktop 时用一段假进度自己走一遍（见那边注释）。
    // ---- CM 扫码登录（浏览器预览：扫一遍码就「登录成功」）----
    case "cmLoginStatus":
      return { hasToken: mockCmHasToken, accountName: mockCmAccountName } as unknown as T;
    case "cmBeginQr":
      // 每次重新发起都把计数归零：刷新二维码后同样「两次轮询成功」
      mockCmPollCount = 0;
      return {
        challengeUrl: "https://s.team/q/mock-cm-preview-challenge",
        clientId: "70000000000000001",
        requestId: "0123456789abcdef0123456789abcdef",
        // 契约里单位是**秒**；预览给 2 秒，省得等太久
        interval: 2,
      } as unknown as T;
    case "cmPollQr": {
      mockCmPollCount += 1;
      if (mockCmPollCount < 2) return { status: "pending" } as unknown as T;
      mockCmHasToken = true;
      mockCmAccountName = mockSteamStatus.accountName || "silvermoon_demo";
      // 统一登录：CM 扫码成功即视为登录，旧 WebAPI 分支的登录态同步跟上
      mockSteamStatus.loggedIn = true;
      mockSteamStatus.accountName = mockCmAccountName;
      return { status: "authorized", accountName: mockCmAccountName } as unknown as T;
    }
    case "cmLogout":
      mockCmHasToken = false;
      mockCmAccountName = "";
      mockCmPollCount = 0;
      mockSteamStatus.loggedIn = false;
      return { ok: true } as unknown as T;
    // 统一登录后的**主**游戏库：走 CM（未扫码时与真实宿主一样失败）
    case "playerSummary": {
      if (!mockCmHasToken) throw new Error("尚未扫码登录 Steam");
      // 头像哈希留空 → 视图走图标占位；若想预览头像效果，可给一段 40 位 hex
      return {
        personaName: "SilverMoon 预览账号",
        avatarHash: "",
        profileUrl: "https://steamcommunity.com/",
      } as T;
    }

    case "steamOwnedGames": {
      if (!mockCmHasToken) throw new Error("尚未扫码登录 Steam");
      return MOCK_STEAM_GAMES.map((g) => ({
        appId: g.appId,
        name: g.name,
        playtimeMinutes: g.playtimeMinutes,
        playtimeTwoWeeksMinutes: g.playtimeRecentMinutes ?? 0,
        // 演示图标哈希：真实宿主给的是 Steam 的 img_icon_url，拼 CDN 的方式一致
        iconHash: "mock" + g.appId.toString(16) + "icon",
        hasCommunityStats: g.appId !== 367520,
      })) as unknown as T;
    }

    case "appDepots":
      return mockSteamDepots(Number(payload.appId)) as unknown as T;
    case "download": {
      // 与真实宿主一致：未登录直接失败，好让「需要先登录」这条分支在预览里也能看见
      if (!mockSteamStatus.loggedIn) {
        return {
          ok: false,
          bytesWritten: 0,
          depots: 0,
          error: "尚未登录 Steam，无法下载",
        } satisfies SteamDownloadOutcome as unknown as T;
      }
      // 与真实宿主一致：没有 CM 凭据时回 needCmLogin，让「扫码登录」面板在预览里能被触发
      if (!mockCmHasToken) {
        return {
          ok: false,
          bytesWritten: 0,
          depots: 0,
          error: "需要先用「Steam 扫码登录（下载）」授权一次：网页登录的凭据无法用于下载",
          needCmLogin: true,
        } satisfies SteamDownloadOutcome as unknown as T;
      }
      const appId = Number(payload.appId);
      if (!Number.isFinite(appId)) {
        return {
          ok: false,
          bytesWritten: 0,
          depots: 0,
          error: "appId 不合法",
        } satisfies SteamDownloadOutcome as unknown as T;
      }
      const depots = mockSteamDepots(appId);
      return {
        ok: true,
        bytesWritten: depots.length * 1.2 * 1024 ** 3,
        depots: depots.length,
        error: null,
      } satisfies SteamDownloadOutcome as unknown as T;
    }

    default:
      return null as unknown as T;
  }
}

/**
 * 演示用的 depot 列表。
 *
 * 按 appId 派生 2~4 个 depot，manifestGid 用一串**长十进制字符串** —— 刻意
 * 超过 2^53（JS 安全整数），这样任何「顺手转 number」的写法在预览里就会
 * 肉眼可见地丢精度，而不是等真机上 CDN 404 才发现。
 */
function mockSteamDepots(appId: number): SteamDepotInfo[] {
  const base = Number.isFinite(appId) && appId > 0 ? appId : 730;
  const count = 2 + (base % 3);
  return Array.from({ length: count }, (_, i) => ({
    depotId: base * 10 + i + 1,
    // 21 位十进制，远超 Number.MAX_SAFE_INTEGER（16 位）
    manifestGid: `${base}${String(i + 1).padStart(6, "0")}9876543210`,
  }));
}

/**
 * 音乐标签通用能力的 mock 实现。
 *
 * 与 Rust 命令的 mock 分开导出：标签通道是主进程通用能力（`call("musicTags")`），
 * 由 `capabilities.musicTagCall` 在预览环境直接调用，不经过 `mockInvoke`。
 */
export function mockMusicTags<T>(op: string, payload: Record<string, unknown>): T {
  // 本地 op 的键是文件路径，在线 op 的键是 `${server}:${id}`，两者都从 key 取
  const path = String(payload.path ?? "");
  const key = String(payload.key ?? "");
  switch (op) {
    case "writeLyrics":
    case "writeOriginal":
      return undefined as unknown as T;
    case "writeLocal": {
      mockLocalTags.set(path, tagFields(payload.fields));
      return undefined as unknown as T;
    }
    case "backupLocal": {
      // 与主进程一致：只在没有备份时创建，保留最原始的写入前快照
      if (mockLocalBackups.has(path)) return { created: false } as unknown as T;
      mockLocalBackups.set(path, tagFields(payload.fields));
      return { created: true } as unknown as T;
    }
    case "readLocal": {
      const hit = mockLocalTags.get(path);
      return { fields: tagFields(hit), hasCover: false } as unknown as T;
    }
    case "readLocalBackup":
      return (mockLocalBackups.get(path) ?? null) as unknown as T;
    case "readLyrics":
    case "readOriginal":
    case "readOnline": {
      const hit = mockOnlineTags.get(key);
      if (op === "readOnline") return (hit ?? null) as unknown as T;
      if (op === "readLyrics") return (mockOnlineLyrics.get(key) ?? null) as unknown as T;
      return (hit?.original ?? null) as unknown as T;
    }
    case "cacheOnline": {
      const prev = mockOnlineTags.get(key);
      const applied: AppliedOnlineTags = {
        key,
        fields: tagFields(payload.fields),
        // 只保留首次覆盖前的快照，后续应用不覆盖它（与主进程一致）
        original: prev?.original ?? null,
        coverPath: null,
        cachedAt: Date.now(),
      };
      mockOnlineTags.set(key, applied);
      if (typeof payload.lyrics === "string") mockOnlineLyrics.set(key, payload.lyrics);
      return applied as unknown as T;
    }
    case "removeOnline": {
      const had = mockOnlineTags.delete(key);
      mockOnlineLyrics.delete(key);
      return { removed: had } as unknown as T;
    }
    case "listOnline":
      return [...mockOnlineTags.values()] as unknown as T;
    default:
      return null as unknown as T;
  }
}

export function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const as = <R>(v: R) => Promise.resolve(v as unknown as T);

  switch (cmd) {
    case "scan_start":
      return as({ jobId: "mock-job" });
    case "scan_cancel":
      return as(undefined);
    case "scan_status":
      return as<ScanProgress>({
        jobId: "mock-job",
        stage: "done",
        done: DEMO.length,
        total: DEMO.length,
        percent: 100,
        currentPath: "",
        added: DEMO.length,
        updated: 0,
        removed: 0,
      });
    case "list_files": {
      const q = (args?.query ?? {}) as {
        type?: string;
        search?: string;
        minSize?: number;
      };
      let list = DEMO.filter((f) => !q.type || f.type === q.type);
      if (q.minSize) list = list.filter((f) => f.size >= q.minSize!);
      if (q.search?.trim()) {
        const s = q.search.trim().toLowerCase();
        list = list.filter((f) =>
          [f.name, f.title, f.artist, f.album]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(s)),
        );
      }
      return as(list.map((f) => ({ ...f, favorite: favorites.has(f.id) })));
    }
    case "count_files": {
      const q = (args?.query ?? {}) as {
        type?: string;
        search?: string;
        minSize?: number;
      };
      let list = DEMO.filter((f) => !q.type || f.type === q.type);
      if (q.minSize) list = list.filter((f) => f.size >= q.minSize!);
      if (q.search?.trim()) {
        const s = q.search.trim().toLowerCase();
        list = list.filter((f) =>
          [f.name, f.title, f.artist, f.album]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(s)),
        );
      }
      return as(list.length);
    }
    case "library_counts": {
      const min = Number((args?.minSize as number) ?? 0);
      const counts: Record<string, number> = {};
      for (const f of DEMO) {
        if (f.size < min) continue;
        counts[f.type] = (counts[f.type] ?? 0) + 1;
      }
      return as(counts);
    }
    case "get_thumbnail": {
      const id = String(args?.fileId ?? "");
      const f = DEMO.find((x) => x.id === id);
      if (!f) return as(null);
      return as(placeholderCover(LABELS[f.type] ?? "?", HUES[f.type] ?? 0));
    }
    // 批量版：返回值与 fileIds 按下标一一对应（与 Rust 侧的契约一致）
    case "get_thumbnails": {
      const ids = (args?.fileIds as string[]) ?? [];
      return as(
        ids.map((id) => {
          const f = DEMO.find((x) => x.id === id);
          if (!f) return null;
          return placeholderCover(LABELS[f.type] ?? "?", HUES[f.type] ?? 0);
        }),
      );
    }
    case "get_song": {
      const id = String(args?.fileId ?? "");
      const f = DEMO.find((x) => x.id === id) ?? DEMO[0];
      return as({
        file: {
          id: f.id,
          path: f.path,
          parent: f.parent,
          name: f.name,
          ext: f.ext,
          type: f.type,
          size: f.size,
          mtime: f.mtime,
          scanned_at: f.scannedAt,
          deleted: 0,
        },
        meta: {
          fileId: f.id,
          title: f.title,
          artist: f.artist,
          album: f.album,
          durationMs: f.durationMs,
          hasCover: true,
          hasLyrics: true,
        },
        coverBase64: placeholderCover("♪", HUES.audio),
        lyrics:
          "[00:00.00]演示歌词\n[00:03.00]This is a demo line\n[00:03.00]这是一行演示歌词\n[00:08.00]浏览器预览模式",
      });
    }
    case "get_metadata": {
      const id = String(args?.fileId ?? "");
      const f = DEMO.find((x) => x.id === id);
      return as({
        fileId: id,
        title: f?.title,
        artist: f?.artist,
        hasCover: false,
        hasLyrics: false,
      });
    }
    case "toggle_favorite": {
      const id = String(args?.fileId ?? "");
      if (favorites.has(id)) {
        favorites.delete(id);
        return as(false);
      }
      favorites.add(id);
      return as(true);
    }
    case "list_favorites":
      return as(DEMO.filter((f) => favorites.has(f.id)).map((f) => ({ ...f, favorite: true })));
    case "list_history":
      return as(DEMO.slice(0, 3));
    case "list_trash":
      return as([]);
    case "empty_trash":
    case "clear_thumbnail_cache":
      return as(0);
    case "book_import": {
      // 浏览器预览没有真实文件系统；按传入路径数量返回，界面能走完导入流程
      const paths = (args?.paths as string[]) ?? [];
      return as(paths.length);
    }
    case "get_book_progress":
      return as(null);
    // ---- 在线小说共享书架（浏览器预览给空书架，避免模板拿到 null）----
    case "novel_shelf_list":
      return as([]);
    case "novel_shelf_add":
    case "novel_shelf_remove":
      return as(undefined);
    case "novel_progress_get":
      return as(null);
    case "save_book_progress":
      return as(undefined);
    case "ffmpeg_status":
      return as<FfmpegStatus>({ available: false, source: "none" });
    case "ffmpeg_set_path":
      return as<FfmpegStatus>({ available: false, source: "none" });
    case "ffmpeg_download_url":
      return as("https://ffmpeg.org/download.html");
    case "webdav_configure":
      return as(undefined);
    case "webdav_test":
      return as<WebDavStatus>({ ok: true, rootName: "demo" });
    case "webdav_list": {
      const path = String(args?.path ?? "");
      return as(DAV_TREE[path] ?? []);
    }
    case "webdav_media_url": {
      const path = String(args?.path ?? "");
      return as("https://demo.webdav.invalid/" + path);
    }
    case "netease_sms_captcha_sent":
      return as(undefined);
    case "netease_login_cellphone":
      return as<NeteaseProfile>({
        userId: 10001,
        nickname: "演示用户(手机)",
        avatarUrl: "",
      });
    case "netease_login_qr_key":
      return as("demo-unikey-abcdef");
    case "netease_login_qr_check": {
      // 演示：第一次 800，之后 803
      const count = (qrCheckCount = (qrCheckCount ?? 0) + 1);
      if (count <= 1) {
        return as<NeteaseQrCheck>({ code: 800 });
      }
      return as<NeteaseQrCheck>({
        code: 803,
        nickname: "演示用户",
        avatarUrl: "",
      });
    }
    case "netease_account":
      return as<NeteaseProfile>({
        userId: 10001,
        nickname: "演示用户",
        avatarUrl: "",
      });
    case "netease_user_playlists":
      return as<NeteasePlaylist[]>([
        { id: 1, name: "我喜欢的音乐", coverUrl: "", trackCount: 128 },
        { id: 2, name: "通勤歌单", coverUrl: "", trackCount: 45 },
      ]);
    case "netease_playlist_detail":
      return as<NeteaseSong[]>([
        { id: 1001, name: "夜曲", artist: "周杰伦", album: "十一月的萧邦", picUrl: "" },
        { id: 1002, name: "稻香", artist: "周杰伦", album: "魔杰座", picUrl: "" },
      ]);
    case "netease_cloud":
      return as<NeteaseCloudPage>({
        songs: [
          { id: 2001, name: "云盘试听曲", artist: "演示歌手", album: "云盘", picUrl: "" },
          { id: 2002, name: "Demo Track", artist: "Demo Artist", picUrl: "" },
        ],
        hasMore: false,
        count: 2,
      });
    case "netease_song_url": {
      const ids = (args?.ids as number[]) ?? [];
      return as(ids.map((id) => ({ id, url: "https://demo.netease.invalid/play?id=" + id })));
    }
    case "netease_logout":
      return as(undefined);
    case "start_play_session":
    case "end_play_session":
      return as(undefined);
    case "get_listen_stats": {
      return as<ListenStats | null>({
        day: "2025-01-15",
        playCount: 12,
        uniqueTracks: 8,
        totalMs: 2_580_000,
      });
    }
    case "list_listen_stats": {
      const days = Number((args?.days as number) ?? 7);
      const rows: ListenStats[] = Array.from({ length: days }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (days - 1 - i));
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return {
          day: ymd,
          playCount: Math.floor(Math.random() * 20) + 1,
          uniqueTracks: Math.floor(Math.random() * 10) + 1,
          totalMs: Math.floor(Math.random() * 3_600_000) + 60_000,
        };
      });
      return as(rows);
    }
    case "list_top_tracks": {
      const demo: TopTrackStat[] = [
        {
          trackId: "demo-a1",
          source: "local",
          title: "夜曲",
          artist: "周杰伦",
          album: "十一月的萧邦",
          coverUrl: null,
          filePath: "D:/Demo/夜曲.flac",
          fileName: "夜曲.flac",
          contentHash: null,
          playCount: 15,
          totalMs: 2_890_000,
          srcUrl: null,
        },
        {
          trackId: "demo-a2",
          source: "local",
          title: "稻香",
          artist: "周杰伦",
          album: "魔杰座",
          coverUrl: null,
          filePath: "D:/Demo/稻香.mp3",
          fileName: "稻香.mp3",
          contentHash: null,
          playCount: 10,
          totalMs: 1_950_000,
          srcUrl: null,
        },
        {
          trackId: "demo-a3",
          source: "local",
          title: "Bohemian Rhapsody",
          artist: "Queen",
          album: "A Night at the Opera",
          coverUrl: null,
          filePath: "D:/Demo/Bohemian Rhapsody.flac",
          fileName: "Bohemian Rhapsody.flac",
          contentHash: null,
          playCount: 8,
          totalMs: 2_520_000,
          srcUrl: null,
        },
        {
          trackId: "1001",
          source: "online",
          title: "晴天",
          artist: "周杰伦",
          album: "叶惠美",
          coverUrl: "https://p2.music.126.net/placeholder.jpg",
          filePath: null,
          fileName: null,
          contentHash: null,
          playCount: 5,
          totalMs: 1_340_000,
          srcUrl: "https://demo.netease.invalid/play?id=1001",
        },
        {
          trackId: "2001",
          source: "online",
          title: "起风了",
          artist: "买辣椒也用券",
          album: "起风了",
          coverUrl: "https://p2.music.126.net/placeholder2.jpg",
          filePath: null,
          fileName: null,
          contentHash: null,
          playCount: 3,
          totalMs: 780_000,
          srcUrl: "https://demo.netease.invalid/play?id=2001",
        },
      ];
      return as(demo);
    }
    case "listen_source_breakdown": {
      return as<ListenSourceStat[]>([
        { source: "local", playCount: 33, totalMs: 7_360_000 },
        { source: "online", playCount: 8, totalMs: 2_120_000 },
      ]);
    }
    case "smtc_set_media":
    case "smtc_set_playback":
      // 浏览器预览没有系统媒体控件，直接静默成功
      return as(undefined);

    // ---- 在线番剧（演示规则 + 空抓取；浏览器预览不做真实网络）----
    case "net_set_proxy":
      return as(undefined);
    case "anime_rules_list":
      return as<AnimeRuleEntry[]>([
        {
          name: "演示规则",
          version: "1.0",
          enabled: true,
          json: JSON.stringify({
            api: "4",
            type: "anime",
            name: "演示规则",
            version: "1.0",
            muliSources: true,
            useWebview: true,
            useNativePlayer: true,
            baseURL: "https://demo.anime.invalid/",
            searchURL: "https://demo.anime.invalid/search?wd=@keyword",
            searchList: "//div[2]/div[2]/div[2]/div[2]/div",
            searchName: "//div[2]/text()",
            searchResult: "//a",
            chapterRoads: "//div[2]/div[2]/div[2]/div/div[2]/div[1]//div",
            chapterResult: "//a",
          }),
        },
      ]);
    case "anime_rules_save":
    case "anime_rules_delete":
      return as(undefined);
    case "anime_rules_index":
      return as("[]");
    case "anime_fetch":
      throw new Error("浏览器预览不支持网络抓取，请在桌面端测试在线番剧");
    case "anime_media_url": {
      const url = String(args?.url ?? "");
      return as({ url: `https://demo.anime.invalid/proxy?u=${encodeURIComponent(url)}` });
    }
    case "anime_webview_resolve":
      return as(null);
    case "anime_history_list":
      return as<AnimeHistoryItem[]>([]);
    case "anime_history_upsert":
    case "anime_history_delete":
      return as(undefined);
    case "anime_favorites_list":
      return as([]);
    case "anime_favorites_add":
    case "anime_favorites_remove":
      return as(undefined);

    // ---- 在线图片（Pixiv，浏览器预览：无登录态，返回空结构）----
    case "pixiv_login_status":
      return as<PixivLoginStatus>({ loggedIn: false, user: null });
    case "pixiv_login_open":
    case "pixiv_login_submit":
    case "pixiv_set_refresh_token":
    case "pixiv_refresh_session":
      return as<PixivLoginStatus>({ loggedIn: false, user: null });
    case "pixiv_logout":
      return as(undefined);
    case "pixiv_illust_comments":
      return as<PixivCommentsPage>({ comments: [], nextOffset: null, total: null });
    case "pixiv_bookmark_add":
    case "pixiv_bookmark_delete":
    case "pixiv_follow_user":
      return as(undefined);
    case "pixiv_bookmark_detail":
      return as(false);
    case "pixiv_user_detail":
      return as<PixivUserDetail>({
        user: { id: 0, name: "", account: "" },
        totalIllusts: 0,
        following: 0,
      });
    case "pixiv_user_illusts":
    case "pixiv_user_bookmarks":
      return as<PixivIllustPage>({ illusts: [], nextUrl: null });
    case "pixiv_trending_tags":
      return as<PixivTrendTag[]>([]);
    case "pixiv_search_suggest":
      return as<string[]>([]);
    case "pixiv_ugoira_frames":
      return as<PixivUgoiraFrames>({ frames: [] });
    case "pixiv_frame_bytes":
      return as(new Uint8Array(0));
    case "pixiv_recommended":
    case "pixiv_ranking":
    case "pixiv_search":
    case "pixiv_follow":
    case "pixiv_next":
      return as<PixivIllustPage>({ illusts: [], nextUrl: null });
    case "pixiv_illust_detail":
      return as<PixivIllustDetail>({
        illust: {
          id: 0,
          title: "",
          type: "",
          caption: "",
          totalView: 0,
          totalBookmarks: 0,
          pageCount: 0,
          width: 0,
          height: 0,
          sanityLevel: 0,
          restrict: 0,
          xRestrict: 0,
          tags: [],
          user: { id: 0, name: "", account: "" },
          imageUrls: {},
          metaPages: [],
        },
        related: [],
      });
    case "pixiv_image":
      return as(new Uint8Array(0));

    // ---- 扩展框架：浏览器预览只有空态（无扩展目录/无引擎子进程）----
    case "ext_list":
      return as([] as ExtInfo[]);
    case "ext_get":
      return as(null);
    case "ext_current_nav":
      return as(null);
    case "ext_open_window":
      throw new Error("浏览器预览不支持打开扩展窗口，请在桌面端测试");
    case "ext_ui_surfaces":
      return as([]);
    case "ext_themes":
      return as([]);
    case "ext_theme_load":
      return as({ json: null, dir: null, absDir: null, files: [] });
    case "ext_install":
    case "ext_uninstall":
    case "ext_set_enabled":
    case "ext_invoke":
    case "ext_open":
      throw new Error("浏览器预览不支持扩展安装与引擎调用，请在桌面端测试");

    // ---- 皮肤系统（内存 Map 模拟皮肤库；浏览器预览不支持 ZIP 导入）----
    case "is_safe_mode":
      return as(false);
    case "skin_read_external_file":
      throw new Error("浏览器预览不支持读取本地文件，请在桌面端测试皮肤导入");
    case "skin_stage_zip":
    case "skin_commit":
    case "skin_abort":
      throw new Error("浏览器预览不支持 ZIP 皮肤导入，请在桌面端测试");
    case "skin_dir":
      return as("C:/MockAppData/skins");
    case "skin_save":
      mockSkins.set(String(args?.id), String(args?.json));
      return as(undefined);
    case "skin_list":
      return as(
        [...mockSkins.keys()].sort().map((id) => {
          try {
            const v = JSON.parse(mockSkins.get(id)!);
            const m = v.manifest;
            return {
              id,
              status: "ok",
              error: null,
              meta: {
                name: m.name,
                version: m.version,
                author: m.author,
                description: m.description ?? null,
                minAppVersion: m.minAppVersion ?? null,
                modes: m.modes,
                seedColor: m.seedColor ?? false,
                accent: m.accent ?? null,
                formatVersion: v.formatVersion ?? 1,
                hasBackground: v.background != null,
                hasIcons: v.icons != null,
              },
            } satisfies SkinEntry;
          } catch (e) {
            return { id, status: "broken", error: String(e), meta: null } satisfies SkinEntry;
          }
        }),
      );
    case "skin_load": {
      const json = mockSkins.get(String(args?.id));
      return as({ json: json ?? null, files: [] } satisfies LoadedSkin);
    }
    case "skin_delete":
      mockSkins.delete(String(args?.id));
      return as(undefined);

    // ---- 酷狗音乐：浏览器预览只提供空态，真实数据需桌面端运行 ----
    case "kugou_login_status":
      return as({ loggedIn: false, profile: null, signedDays: [] });
    case "kugou_login_qr_key":
      return as({ key: "preview", url: "https://example.invalid/kugou-preview" });
    case "kugou_login_qr_check":
      return as({ status: 1, loggedIn: false, profile: null });
    case "kugou_sign_in":
      return as({
        ok: false,
        message: "浏览器预览不支持酷狗签到，请在桌面端使用",
        ssaCode: null,
        svip: false,
      });
    case "kugou_song_url":
      return as({ url: "", quality: "128", trial: false });
    case "kugou_cover":
      throw new Error("浏览器预览不支持酷狗封面代理，请在桌面端使用");
    case "kugou_logout":
    case "kugou_captcha_sent":
      return as(undefined);
    case "kugou_login_cellphone":
    case "kugou_account":
      throw new Error("浏览器预览不支持酷狗账号操作，请在桌面端使用");
    case "kugou_search":
    case "kugou_playlist_detail":
    case "kugou_rank_list":
    case "kugou_rank_songs":
    case "kugou_everyday_recommend":
    case "kugou_recommend_songs":
    case "kugou_user_playlists":
    case "kugou_playlist_tracks":
      return as(null);

    // ---- osu! 谱面源：浏览器预览返回演示数据，真实下载需桌面端运行 ----
    case "osu_search":
      return as({
        items: [
          {
            id: "1",
            title: "Camellia - GHOST",
            artist: "Camellia",
            songTitle: "GHOST",
            uploader: "Preview",
            pageUrl: "https://osu.ppy.sh/beatmapsets/1",
            source: "sayobot",
          },
          {
            id: "2",
            title: "xi - Freedom Dive",
            artist: "xi",
            songTitle: "Freedom Dive",
            uploader: "Preview",
            pageUrl: "https://osu.ppy.sh/beatmapsets/2",
            source: "official",
          },
        ],
        errors: ["浏览器预览：仅演示数据"],
      });
    case "osu_import_archive":
    case "osu_download":
      throw new Error("浏览器预览不支持下载谱面，请在桌面端使用");

    case "bili_danmaku":
      // 浏览器预览没有宿主；弹幕是可选装饰，返回空数组即可
      return as([]);

    default:
      return as(null);
  }
}
