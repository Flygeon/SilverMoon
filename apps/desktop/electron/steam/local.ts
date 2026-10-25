import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const STATE_FULLY_INSTALLED = 4;
const MANAGED_INSTALLS_FILE = "steam-managed-installs.json";

export interface SteamLibraryFolder {
  path: string;
  label?: string | null;
  appCount: number;
}

export interface SteamInstalledGame {
  appId: number;
  name: string;
  source?: "steam" | "silvermoon";
  installDir?: string | null;
  installPath?: string | null;
  sizeOnDisk: number;
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

type VdfValue = string | VdfObject;
interface VdfObject {
  [key: string]: VdfValue;
}

export function parseVdf(text: string): VdfObject {
  const root: VdfObject = {};
  const stack: VdfObject[] = [root];
  let pendingKey: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

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

function steamPathFromRegistry(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out);
    const value = match?.[1]?.trim();
    if (!value) return null;
    return path.win32.normalize(value);
  } catch {
    return null;
  }
}

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

function looksLikeSteamRoot(dir: string): boolean {
  try {
    return statSync(path.join(dir, "steamapps")).isDirectory();
  } catch {
    return false;
  }
}

export interface SteamRootDiscovery {
  root: string | null;
  candidates: string[];
}

export function discoverSteamRoot(customRoots: string[] = []): SteamRootDiscovery {
  const candidates = [
    ...customRoots.filter(Boolean),
    steamPathFromRegistry(),
    ...commonSteamRoots(),
  ].filter((v): v is string => Boolean(v));

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
    if (typeof value === "object" && value !== null && typeof value.path === "string") {
      result.push(path.resolve(value.path));
    } else if (typeof value === "string") {
      result.push(path.resolve(value));
    }
  }

  const seen = new Set<string>();
  return result.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  if ((stateFlags & STATE_FULLY_INSTALLED) === 0) return null;

  const lastPlayedSec = Number(state.LastPlayed ?? 0);
  return {
    appId,
    name,
    source: "steam",
    installDir: typeof state.installdir === "string" ? state.installdir : null,
    installPath: null,
    sizeOnDisk: Number(state.SizeOnDisk ?? 0),
    lastPlayedAt: lastPlayedSec > 0 ? lastPlayedSec * 1000 : null,
    stateFlags,
    libraryPath,
    manifestPath,
  };
}

let scanCache: { key: string; at: number; value: SteamLocalLibrary } | null = null;

const SCAN_CACHE_TTL_MS = 10_000;

export function invalidateLocalLibraryCache(): void {
  scanCache = null;
}

export function scanLocalLibrary(customRoots: string[] = [], dataDir = ""): SteamLocalLibrary {
  const key = `${customRoots.join("|")}\0${dataDir}`;
  const now = Date.now();
  if (scanCache && scanCache.key === key && now - scanCache.at < SCAN_CACHE_TTL_MS) {
    return scanCache.value;
  }
  const value = scanLocalLibraryUncached(customRoots, dataDir);
  scanCache = { key, at: Date.now(), value };
  return value;
}

export function scanLocalLibraryUncached(
  customRoots: string[] = [],
  dataDir = "",
): SteamLocalLibrary {
  const scannedAt = Date.now();
  const { root, candidates } = discoverSteamRoot(customRoots);
  const managed = readManagedInstalls(dataDir);
  if (!root) {
    return {
      installed: managed,
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

  for (const game of managed) {
    if (seenApps.has(game.appId)) continue;
    seenApps.add(game.appId);
    installed.push(game);
  }

  installed.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));

  return {
    installed,
    steamRoot: root,
    libraries,
    scannedAt,
    warning: libraries.length === 0 ? "已找到 Steam 目录，但没有可用的库" : null,
  };
}

export function findInstalled(
  appId: number,
  customRoots: string[] = [],
  dataDir = "",
): SteamInstalledGame | null {
  return scanLocalLibrary(customRoots, dataDir).installed.find((g) => g.appId === appId) ?? null;
}

interface ManagedInstallRecord {
  appId: number;
  name: string;
  installPath: string;
  sizeOnDisk: number;
  installedAt: number;
}

function managedInstallFile(dataDir: string): string {
  return path.join(dataDir, MANAGED_INSTALLS_FILE);
}

function readManagedRecords(dataDir: string): ManagedInstallRecord[] {
  if (!dataDir) return [];
  try {
    const parsed = JSON.parse(readFileSync(managedInstallFile(dataDir), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ManagedInstallRecord => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<ManagedInstallRecord>;
      return (
        Number.isInteger(record.appId) &&
        Number(record.appId) > 0 &&
        typeof record.name === "string" &&
        typeof record.installPath === "string" &&
        typeof record.sizeOnDisk === "number" &&
        typeof record.installedAt === "number"
      );
    });
  } catch {
    return [];
  }
}

function directorySize(root: string): number {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        try {
          total += statSync(fullPath).size;
        } catch {
          // Files may disappear while the directory is being scanned.
        }
      }
    }
  }
  return total;
}

export function registerManagedInstall(
  dataDir: string,
  appId: number,
  name: string,
  installPath: string,
): void {
  if (!dataDir || !Number.isInteger(appId) || appId <= 0) {
    throw new Error("无法记录无效的游戏安装信息");
  }
  const absolutePath = path.resolve(installPath);
  if (!statSync(absolutePath).isDirectory()) {
    throw new Error(`安装目录不存在：${absolutePath}`);
  }

  mkdirSync(dataDir, { recursive: true });
  const file = managedInstallFile(dataDir);
  const records = readManagedRecords(dataDir).filter((record) => record.appId !== appId);
  records.push({
    appId,
    name,
    installPath: absolutePath,
    sizeOnDisk: directorySize(absolutePath),
    installedAt: Date.now(),
  });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(records, null, 2), "utf8");
  renameSync(temp, file);
}

function readManagedInstalls(dataDir: string): SteamInstalledGame[] {
  const manifestPath = dataDir ? managedInstallFile(dataDir) : "";
  return readManagedRecords(dataDir).flatMap((record) => {
    const installPath = path.resolve(record.installPath);
    try {
      if (!statSync(installPath).isDirectory()) return [];
    } catch {
      return [];
    }
    return [
      {
        appId: record.appId,
        name: record.name,
        source: "silvermoon",
        installDir: path.basename(installPath),
        installPath,
        sizeOnDisk: record.sizeOnDisk,
        lastPlayedAt: null,
        stateFlags: STATE_FULLY_INSTALLED,
        libraryPath: path.dirname(installPath),
        manifestPath,
      },
    ];
  });
}
