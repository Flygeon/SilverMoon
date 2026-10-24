/**
 * Steam 本地安装库：发现安装目录、解析 appmanifest、启动游戏。
 *
 * ## 参考实现
 *
 * 移植自 `DroidDeck参考`（GPL-3.0）的 `frontend/Library.kt`：
 * - 库目录来自 `steamapps/libraryfolders.vdf`（v2 格式：`"0"/"path"`）；
 * - 已安装游戏来自各库的 `steamapps/appmanifest_<appid>.acf`；
 * - `StateFlags & 4` 才算出「已完整安装」（4 = StateFullyInstalled）；
 * - 启动走 `steam://rungameid/<appid>`。
 *
 * ## 为什么不做「自己下载」
 *
 * DroidDeck 能让 Steam 下载，是因为它跑的是**官方 Steam 客户端**（proot + Proton），
 * 下载由 Valve 自己的代码完成。要在本应用里自己下，必须实现 depot 协议
 * （CM 长连接 + manifest 请求 + 分块 CDN + AES 解密）。
 * 实测本机的 CM WebSocket 会被重置（ECONNRESET），那条链路根本跑不通，
 * 且实现量极大。因此这里只做「发现 + 启动 + 唤起官方客户端下载」，
 * 与用户的取舍一致（见 LOG）。
 *
 * ## 路径发现顺序
 *
 * 1. 用户手动添加的目录（设置里存的）；
 * 2. Windows 注册表 `HKCU\\Software\\Valve\\Steam` 的 `SteamPath`；
 * 3. 常见安装位置兜底。
 *
 * 每个候选都要求存在 `steamapps` 子目录才算数 —— 只认真正能解析的目录，
 * 不靠猜。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** StateFlags 里「已完整安装」的位。 */
const STATE_FULLY_INSTALLED = 4;

/** 一个库目录（可能包含多个 appmanifest）。 */
export interface SteamLibraryFolder {
  path: string;
  label?: string | null;
  appCount: number;
}

/** 一款已安装的游戏。 */
export interface SteamInstalledGame {
  appId: number;
  name: string;
  installDir?: string | null;
  /** 字节 */
  sizeOnDisk: number;
  /** 最近运行时间（毫秒）；0 表示从未 */
  lastPlayedAt?: number | null;
  stateFlags: number;
  libraryPath: string;
  manifestPath: string;
}

export interface SteamLocalLibrary {
  installed: SteamInstalledGame[];
  steamRoot?: string | null;
  libraries: SteamLibraryFolder[];
  scannedAt: number;
  warning?: string | null;
}

/** 极简 VDF 解析结果：嵌套对象，叶子是字符串。 */
type VdfValue = string | VdfObject;
interface VdfObject {
  [key: string]: VdfValue;
}

/**
 * 解析 Valve 的 KeyValues（VDF）文本格式。
 *
 * 只实现本模块需要的子集：嵌套 `{ }`、带引号的 key/value、`//` 行注释。
 * 不处理条件标记（`[$WIN32]`）—— `libraryfolders.vdf` 与 `appmanifest` 里没有。
 *
 * **自己写而不是引依赖**：这两个文件的语法极稳定，几十行足够；
 * 引一个 VDF 库只为读两个文件不划算（且要跟着 lock 文件走）。
 */
export function parseVdf(text: string): VdfObject {
  const root: VdfObject = {};
  // 栈：每层一个对象，最后一项是「当前层」
  const stack: VdfObject[] = [root];
  let pendingKey: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    // 空白与注释
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "{") {
      const child: VdfObject = {};
      const parent = stack[stack.length - 1];
      if (pendingKey !== null) parent[pendingKey] = child;
      stack.push(child);
      pendingKey = null;
      continue;
    }
    if (ch === "}") {
      if (stack.length > 1) stack.pop();
      pendingKey = null;
      continue;
    }

    if (ch === '"') {
      // 读带引号的字符串（支持 \" 与 \\ 转义）
      let value = "";
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        value += text[i];
        i += 1;
      }
      const current = stack[stack.length - 1];
      if (pendingKey === null) {
        pendingKey = value;
      } else {
        current[pendingKey] = value;
        pendingKey = null;
      }
      continue;
    }
  }
  return root;
}

/** 从注册表读 Steam 安装路径（Windows）。失败返回 null。 */
function steamPathFromRegistry(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    // 输出形如：    SteamPath    REG_SZ    c:/program files (x86)/steam
    const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out);
    const value = match?.[1]?.trim();
    if (!value) return null;
    // 注册表里用正斜杠
    return path.win32.normalize(value);
  } catch {
    return null;
  }
}

/** 常见安装位置（仅作兜底，仍会校验 steamapps 是否存在）。 */
function commonSteamRoots(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const programFiles64 = process.env["ProgramFiles"] ?? "C:\\Program Files";
    return [
      path.join(programFiles, "Steam"),
      path.join(programFiles64, "Steam"),
      "C:\\Steam",
      "D:\\Steam",
    ];
  }
  if (process.platform === "darwin")
    return [path.join(process.env.HOME ?? "", "Library/Application Support/Steam")];
  return [
    path.join(process.env.HOME ?? "", ".steam/steam"),
    path.join(process.env.HOME ?? "", ".local/share/Steam"),
  ];
}

/** 一个目录是否像一个 Steam 安装根（有 steamapps 子目录）。 */
function looksLikeSteamRoot(dir: string): boolean {
  try {
    return statSync(path.join(dir, "steamapps")).isDirectory();
  } catch {
    return false;
  }
}

/** 找到的 Steam 根与候选列表（供设置页展示「已自动识别」）。 */
export interface SteamRootDiscovery {
  root: string | null;
  candidates: string[];
}

/**
 * 找出 Steam 根目录。
 *
 * 先手动配置（`customRoots`，用户可能在设置里加过），再注册表，最后常见位置。
 * 逐个校验 `steamapps` 存在，因此不会返回一个假的路径。
 */
export function discoverSteamRoot(customRoots: string[] = []): SteamRootDiscovery {
  const candidates = [
    ...customRoots.filter(Boolean),
    steamPathFromRegistry(),
    ...commonSteamRoots(),
  ].filter((v): v is string => Boolean(v));

  // 去重（大小写不敏感，Windows 路径不区分大小写）
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path.resolve(c));
  }

  const root = unique.find(looksLikeSteamRoot) ?? null;
  return { root, candidates: unique };
}

/**
 * 从一个 Steam 根解析出所有库目录。
 *
 * `libraryfolders.vdf` 有两种格式：
 * - v2（现行）：`"libraryfolders" { "0" { "path" "D:\\SteamLibrary" } }`
 * - v1（旧版）：`"LibraryFolders" { "1" "D:\\SteamLibrary" }`
 * 两种都支持，避免老客户端读不到副库。
 */
export function readLibraryFolders(steamRoot: string): string[] {
  const vdfPath = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
  const result: string[] = [path.resolve(steamRoot)];
  if (!existsSync(vdfPath)) return result;

  let parsed: VdfObject;
  try {
    parsed = parseVdf(readFileSync(vdfPath, "utf8"));
  } catch {
    return result;
  }

  const container = (parsed.libraryfolders ?? parsed.LibraryFolders) as VdfObject | undefined;
  if (!container) return result;

  for (const value of Object.values(container)) {
    // v2：值是个对象，取 path
    if (typeof value === "object" && value !== null && typeof value.path === "string") {
      result.push(path.resolve(value.path));
    } else if (typeof value === "string") {
      // v1：值就是路径
      result.push(path.resolve(value));
    }
  }

  // 去重
  const seen = new Set<string>();
  return result.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 解析单个 appmanifest_*.acf。解析失败返回 null（单个坏文件不该拖垮整库）。 */
export function parseAppManifest(
  manifestPath: string,
  libraryPath: string,
): SteamInstalledGame | null {
  let parsed: VdfObject;
  try {
    parsed = parseVdf(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const state = parsed.AppState as VdfObject | undefined;
  if (!state) return null;

  const appId = Number(state.appid);
  if (!Number.isFinite(appId) || appId <= 0) return null;
  const name = typeof state.name === "string" ? state.name : "";
  if (!name) return null;

  const stateFlags = Number(state.StateFlags ?? 0);
  // 只收「已完整安装」的；正在下载/更新的不进库（DroidDeck 同样判定）
  if ((stateFlags & STATE_FULLY_INSTALLED) === 0) return null;

  const lastPlayedSec = Number(state.LastPlayed ?? 0);
  return {
    appId,
    name,
    installDir: typeof state.installdir === "string" ? state.installdir : null,
    sizeOnDisk: Number(state.SizeOnDisk ?? 0),
    lastPlayedAt: lastPlayedSec > 0 ? lastPlayedSec * 1000 : null,
    stateFlags,
    libraryPath,
    manifestPath,
  };
}

/** 扫描所有库，得到已安装游戏列表。 */
export function scanLocalLibrary(customRoots: string[] = []): SteamLocalLibrary {
  const scannedAt = Date.now();
  const { root, candidates } = discoverSteamRoot(customRoots);
  if (!root) {
    return {
      installed: [],
      steamRoot: null,
      libraries: [],
      scannedAt,
      warning: `未找到 Steam 安装目录（已查找：${candidates.slice(0, 4).join("；") || "无"}）`,
    };
  }

  const libraryPaths = readLibraryFolders(root);
  const installed: SteamInstalledGame[] = [];
  const libraries: SteamLibraryFolder[] = [];
  const seenApps = new Set<number>();

  for (const libPath of libraryPaths) {
    const steamapps = path.join(libPath, "steamapps");
    if (!existsSync(steamapps)) continue;

    let manifests: string[] = [];
    try {
      manifests = readdirSync(steamapps).filter(
        (f) => f.startsWith("appmanifest_") && f.endsWith(".acf"),
      );
    } catch {
      continue;
    }

    let count = 0;
    for (const file of manifests) {
      const full = path.join(steamapps, file);
      const game = parseAppManifest(full, libPath);
      if (!game) continue;
      // 同一游戏可能在多个库有残留，只保留第一个
      if (seenApps.has(game.appId)) continue;
      seenApps.add(game.appId);
      installed.push(game);
      count += 1;
    }

    libraries.push({
      path: libPath,
      label: null,
      appCount: count,
    });
  }

  // 按最近运行倒序（从未玩过的排后面），与 Steam 库的默认观感一致
  installed.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));

  return {
    installed,
    steamRoot: root,
    libraries,
    scannedAt,
    warning: libraries.length === 0 ? "已找到 Steam 目录，但没有可用的库" : null,
  };
}

/** 在已安装列表里查一个 appId。 */
export function findInstalled(
  appId: number,
  customRoots: string[] = [],
): SteamInstalledGame | null {
  return scanLocalLibrary(customRoots).installed.find((g) => g.appId === appId) ?? null;
}
