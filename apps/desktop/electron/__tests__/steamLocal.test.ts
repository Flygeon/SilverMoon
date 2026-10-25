/**
 * Steam 本地库 / 启动 / 设置 的纯逻辑单测（**不依赖真实 Steam**）。
 *
 * 真实扫描由 `scripts/verify-steam-local.mjs`（`npm run verify:steam-local`）在本机
 * 真读 Steam 目录验证；这里锁的是「写错就静默坏」的解析与判定：
 *
 * 1. VDF 解析 —— `libraryfolders.vdf` 有两代格式，解析错会导致副库整个读不到
 *    （用户会以为「我明明装在 D 盘，应用说没装」）；
 * 2. appmanifest 判定 —— `StateFlags & 4` 判错会把「正在下载」的游戏当成已安装，
 *    点启动必然失败；
 * 3. 设置持久化 —— 去重/去空写错会让同一个库反复出现在列表里。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseVdf,
  readLibraryFolders,
  parseAppManifest,
  scanLocalLibrary,
  scanLocalLibraryUncached,
  registerManagedInstall,
} from "../steam/local";
import { readSteamSettings, updateSteamSettings, steamSettingsState } from "../steam/settings";

describe("parseVdf：Valve KeyValues", () => {
  it("解析嵌套对象与带引号的值", () => {
    const parsed = parseVdf('"AppState" { "appid" "440" "name" "Team Fortress 2" }');
    expect(parsed.AppState).toMatchObject({ appid: "440", name: "Team Fortress 2" });
  });

  it("处理 // 行注释", () => {
    const parsed = parseVdf('// 头部注释\n"Root" { "a" "1" // 行尾\n "b" "2" }');
    expect(parsed.Root).toMatchObject({ a: "1", b: "2" });
  });

  it("处理反斜杠转义", () => {
    // VDF 里 \" 表示一个引号字符；JS 字符串要再转义一层
    const vdf = '"R" { "path" "C:' + "\\\\" + "Games" + "\\" + '"x' + "\\" + '"' + '" }';
    const parsed = parseVdf(vdf);
    const root = parsed.R as Record<string, string>;
    expect(root.path).toBe("C:" + "\\" + 'Games"x"');
  });

  it("空/坏输入不抛错，返回空对象", () => {
    expect(parseVdf("")).toEqual({});
    expect(parseVdf("   ")).toEqual({});
    // 不闭合的括号：不崩即可（内容可能不完整）
    expect(() => parseVdf('"a" { "b" "c"')).not.toThrow();
  });
});

describe("readLibraryFolders：两代格式都要认", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sm-vdf-"));
    mkdirSync(path.join(dir, "steamapps"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLibraryFolders(content: string) {
    writeFileSync(path.join(dir, "steamapps", "libraryfolders.vdf"), content, "utf8");
  }

  it("v2 格式（现行）：从序号的 path 字段取库路径", () => {
    writeLibraryFolders(
      '"libraryfolders" { "0" { "path" "C:\\\\Steam" } "1" { "path" "D:\\\\Lib" } }',
    );
    const libs = readLibraryFolders(dir);
    // 第一项永远是 steamRoot 自身
    expect(libs[0].toLowerCase()).toBe(path.resolve(dir).toLowerCase());
    expect(libs.some((p) => p.toLowerCase().endsWith("lib"))).toBe(true);
  });

  it("v1 格式（旧版）：值是裸路径", () => {
    writeLibraryFolders('"LibraryFolders" { "1" "D:\\\\Lib1" "2" "E:\\\\Lib2" }');
    const libs = readLibraryFolders(dir);
    expect(libs.length).toBe(3);
  });

  it("没有 libraryfolders.vdf 时只返回根目录", () => {
    const libs = readLibraryFolders(dir);
    expect(libs).toHaveLength(1);
    expect(libs[0].toLowerCase()).toBe(path.resolve(dir).toLowerCase());
  });

  it("重复路径会去重（Windows 大小写不敏感）", () => {
    writeLibraryFolders('"libraryfolders" { "0" { "path" "C:\\\\STEAM" } }');
    const libs = readLibraryFolders(dir);
    const keys = libs.map((p) => p.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("parseAppManifest：StateFlags 判定", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sm-acf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(appId: string, body: string): string {
    const file = path.join(dir, `appmanifest_${appId}.acf`);
    writeFileSync(file, body, "utf8");
    return file;
  }

  it("StateFlags 含 4 → 已完整安装，字段解析正确", () => {
    const file = writeManifest(
      "413150",
      `"AppState" {
        "appid" "413150"
        "name" "Stardew Valley"
        "StateFlags" "4"
        "installdir" "Stardew Valley"
        "SizeOnDisk" "691846347"
        "LastPlayed" "1786703108"
      }`,
    );
    const game = parseAppManifest(file, dir);
    expect(game).not.toBeNull();
    expect(game?.appId).toBe(413150);
    expect(game?.name).toBe("Stardew Valley");
    expect(game?.sizeOnDisk).toBe(691846347);
    // 秒 → 毫秒
    expect(game?.lastPlayedAt).toBe(1786703108 * 1000);
  });

  it("StateFlags 不含 4（正在下载/未装完）→ 不进库", () => {
    const file = writeManifest(
      "999",
      '"AppState" { "appid" "999" "name" "Downloading" "StateFlags" "1026" }',
    );
    expect(parseAppManifest(file, dir)).toBeNull();
  });

  it("缺 appid / name → 返回 null，不抛错", () => {
    const noName = writeManifest("1", '"AppState" { "appid" "1" "StateFlags" "4" }');
    expect(parseAppManifest(noName, dir)).toBeNull();
    const noId = writeManifest("2", '"AppState" { "name" "X" "StateFlags" "4" }');
    expect(parseAppManifest(noId, dir)).toBeNull();
  });

  it("文件损坏 → 返回 null（单个坏文件不拖垮整库）", () => {
    const file = writeManifest("3", "这不是 VDF");
    expect(parseAppManifest(file, dir)).toBeNull();
  });

  it("LastPlayed 为 0 → lastPlayedAt 为 null（从未运行）", () => {
    const file = writeManifest(
      "4",
      '"AppState" { "appid" "4" "name" "Never" "StateFlags" "4" "LastPlayed" "0" }',
    );
    expect(parseAppManifest(file, dir)?.lastPlayedAt).toBeNull();
  });
});

describe("scanLocalLibrary：找不到 Steam 时的降级", () => {
  it("给出可读 warning 而不是抛错", () => {
    const result = scanLocalLibrary(["Z:\\definitely-not-a-steam-dir"]);
    expect(Array.isArray(result.installed)).toBe(true);
    // 本机装了 Steam 时会扫到；没装时应有 warning。两种都不能抛。
    expect(result.scannedAt).toBeGreaterThan(0);
  });
});

describe("SilverMoon 管理的下载", () => {
  let dataDir: string;
  let installPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "sm-managed-game-"));
    installPath = path.join(dataDir, "installed-game");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(path.join(installPath, "game.exe"), "binary", "utf8");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("download record makes the game appear installed with its direct path", () => {
    registerManagedInstall(dataDir, 987654321, "Managed Game", installPath);

    const library = scanLocalLibraryUncached(["Z:\\missing-steam-library"], dataDir);
    expect(library.installed).toContainEqual(
      expect.objectContaining({
        appId: 987654321,
        name: "Managed Game",
        source: "silvermoon",
        installPath,
        sizeOnDisk: 6,
      }),
    );
  });
});

describe("Steam 设置持久化", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sm-steam-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("没有文件时返回空设置", () => {
    expect(readSteamSettings(dir)).toMatchObject({
      customRoots: [],
      downloadFileWorkers: 3,
      downloadChunkWorkers: 8,
      downloadMaxRequests: 32,
      downloadRetries: 2,
      downloadCdnServers: 10,
    });
  });

  it("写入后读回一致", () => {
    updateSteamSettings(dir, {
      customRoots: ["C:\\A", "D:\\B"],
      downloadFileWorkers: 5,
      downloadChunkWorkers: 12,
      downloadMaxRequests: 64,
      downloadRetries: 4,
      downloadCdnServers: 15,
    });
    expect(readSteamSettings(dir)).toMatchObject({
      customRoots: ["C:\\A", "D:\\B"],
      downloadFileWorkers: 5,
      downloadChunkWorkers: 12,
      downloadMaxRequests: 64,
      downloadRetries: 4,
      downloadCdnServers: 15,
    });
  });

  it("写入时将下载参数归一到允许范围", () => {
    const state = updateSteamSettings(dir, {
      downloadFileWorkers: 99,
      downloadChunkWorkers: 0,
      downloadMaxRequests: 129,
      downloadRetries: -1,
      downloadCdnServers: 25,
    });
    expect(state).toMatchObject({
      downloadFileWorkers: 16,
      downloadChunkWorkers: 1,
      downloadMaxRequests: 128,
      downloadRetries: 1,
      downloadCdnServers: 20,
    });
    expect(readSteamSettings(dir)).toMatchObject({
      downloadFileWorkers: 16,
      downloadChunkWorkers: 1,
      downloadMaxRequests: 128,
      downloadRetries: 1,
      downloadCdnServers: 20,
    });
  });

  it("只更新目录时保留已有下载参数", () => {
    updateSteamSettings(dir, { downloadMaxRequests: 64, downloadFileWorkers: 7 });
    updateSteamSettings(dir, { customRoots: ["D:\\SteamLibrary"] });
    expect(readSteamSettings(dir)).toMatchObject({
      customRoots: ["D:\\SteamLibrary"],
      downloadFileWorkers: 7,
      downloadMaxRequests: 64,
    });
  });

  it("去重（大小写不敏感）并去掉空白项", () => {
    const state = updateSteamSettings(dir, {
      customRoots: ["C:\\A", "c:\\a", "   ", "D:\\B"],
    });
    expect(state.customRoots).toHaveLength(2);
  });

  it("文件损坏时按空设置处理，不抛错", () => {
    writeFileSync(path.join(dir, "steam-settings.json"), "{ 坏 JSON", "utf8");
    expect(readSteamSettings(dir).customRoots).toEqual([]);
  });

  it("steamSettingsState 带 detected 标记", () => {
    const state = steamSettingsState(dir);
    expect(typeof state.detected).toBe("boolean");
    expect(Array.isArray(state.customRoots)).toBe(true);
  });
});

describe("launch：非法 appId 必须拒绝", () => {
  it("0 / 负数 / 小数 / NaN 都不拼 URL", async () => {
    const { launchGame, installGame } = await import("../steam/launch");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = await launchGame(bad);
      expect(r.ok).toBe(false);
    }
    expect((await installGame(-1)).ok).toBe(false);
  });
});
