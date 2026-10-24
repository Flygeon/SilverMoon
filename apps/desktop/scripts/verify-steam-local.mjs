/**
 * Steam 本地库 / 启动 / 设置的验证（**真读本机 Steam，真校验**）。
 *
 * ## 覆盖范围
 *
 * 1. VDF 解析：v2（现行）与 v1（旧版）两种 libraryfolders 格式 + 转义；
 * 2. 真实扫描：找到 Steam 根、库目录、已安装游戏（名称/占用/最近运行）；
 * 3. StateFlags 过滤：未完整安装的游戏不得进库；
 * 4. appId 查找；
 * 5. 设置持久化：去重、去空、读回一致、坏文件降级；
 * 6. 启动层：非法 appId 必须拒绝（**不真的拉起游戏**）。
 *
 * 「没装 Steam」的机器上，真实扫描类断言自动跳过，只跑静态部分，不会误红。
 *
 * ## 为什么用 esbuild bundle 而不是逐文件转译
 *
 * `settings.ts` 里有 `import { discoverSteamRoot } from "./local"`。逐文件转译到临时目录后，
 * 这个相对路径找不到目标模块（ERR_MODULE_NOT_FOUND）。用 bundle 把依赖一起打进来，
 * 与宿主里的真实模块图一致。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
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
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(name, run) {
  try {
    ok(name, await run());
  } catch (error) {
    bad(name, error);
  }
}

/**
 * 输出目录：**项目内**的临时目录，而不是系统 %TEMP%。
 *
 * 系统临时目录在这台机器上出现过 Access is denied（上一次 rm 与写入撞车），
 * 放在项目内更稳，也便于排查残留。
 */
const WORK_DIR = path.join(ROOT, "node_modules", ".cache", "verify-steam-local");

/** 用 esbuild 把入口（连同其相对依赖）打成单文件 ESM，再动态 import。 */
async function bundle(entry) {
  const { build } = await import("esbuild");
  mkdirSync(WORK_DIR, { recursive: true });
  const outfile = path.join(WORK_DIR, `${path.basename(entry, ".ts")}-${Date.now()}.mjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    // 外部依赖保持 import（如果将来有），相对模块一起打进来
    packages: "external",
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  rmSync(outfile, { force: true });
  return module;
}

console.log("Steam 本地库 / 启动 验证\n");

// launch.ts 不依赖相对模块，单独打；local/settings 有依赖，各自 bundle
const local = await bundle("electron/steam/local.ts");
const settings = await bundle("electron/steam/settings.ts");
const launch = await bundle("electron/steam/launch.ts");

// ---- VDF 解析 ----
await check("VDF：v2 格式（现行 libraryfolders）", () => {
  const vdf = `"libraryfolders"
{
  "0"
  {
    "path"    "C:\\\\Program Files (x86)\\\\Steam"
    "label"   ""
  }
  "1"
  {
    "path"    "D:\\\\SteamLibrary"
  }
}`;
  const parsed = local.parseVdf(vdf);
  assert(parsed.libraryfolders, "未解析出 libraryfolders");
  assert(parsed.libraryfolders["0"].path, "缺少 0.path");
  return "ok";
});

await check("VDF：旧版 v1 格式", () => {
  const parsed = local.parseVdf('"LibraryFolders" { "1" "D:\\\\Lib1" "2" "E:\\\\Lib2" }');
  assert(parsed.LibraryFolders, "未解析出 LibraryFolders");
  // 输入里的 \\\\ 是 VDF 转义，解析后应是单个反斜杠：D:\Lib1
  assert(
    parsed.LibraryFolders["1"] === "D:\\Lib1",
    `v1 值不对：${JSON.stringify(parsed.LibraryFolders["1"])}`,
  );
  return parsed.LibraryFolders["1"];
});

await check("VDF：注释与转义不影响解析", () => {
  const parsed = local.parseVdf('// 注释\n"AppState" { "name" "A \\"quoted\\" B" }');
  assert(parsed.AppState.name === 'A "quoted" B', `转义处理不对：${parsed.AppState.name}`);
  return "ok";
});

// ---- 真实扫描 ----
const lib = local.scanLocalLibrary([]);
const hasSteam = Boolean(lib.steamRoot);

await check("发现 Steam 安装根", () => {
  if (!hasSteam) return "跳过（本机未安装 Steam）";
  return lib.steamRoot;
});

await check("读到库目录列表", () => {
  if (!hasSteam) return "跳过";
  assert(lib.libraries.length > 0, "库列表为空");
  return `${lib.libraries.length} 个库`;
});

await check("已安装游戏可枚举（名称/占用/最近运行）", () => {
  if (!hasSteam) return "跳过";
  if (lib.installed.length === 0) return "本机无已安装游戏（跳过）";
  for (const g of lib.installed) {
    assert(g.appId > 0, `无效 appId：${g.appId}`);
    assert(g.name.length > 0, `appId ${g.appId} 缺名称`);
    assert(g.sizeOnDisk >= 0, `appId ${g.appId} 占用异常`);
  }
  const s = lib.installed[0];
  return `${lib.installed.length} 款，示例：${s.name}（${(s.sizeOnDisk / 1073741824).toFixed(2)}GB）`;
});

await check("入库游戏都满足 StateFlags & 4（已完整安装）", () => {
  if (!hasSteam || lib.installed.length === 0) return "跳过";
  for (const g of lib.installed) {
    assert((g.stateFlags & 4) !== 0, `appId ${g.appId} 的 StateFlags=${g.stateFlags} 不含 4`);
  }
  return "ok";
});

await check("findInstalled 命中已安装游戏", () => {
  if (!hasSteam || lib.installed.length === 0) return "跳过";
  const target = lib.installed[0];
  const found = local.findInstalled(target.appId, []);
  assert(found, "未找到已安装的游戏");
  assert(found.name === target.name, "名称不一致");
  return target.name;
});

await check("findInstalled 对不存在的 appId 返回 null", () => {
  assert(local.findInstalled(99999999, []) === null, "应为 null");
  return "ok";
});

await check("传入不存在的库路径时不抛错", () => {
  const fake = local.scanLocalLibrary(["Z:\\definitely-not-steam"]);
  assert(Array.isArray(fake.installed), "installed 应为数组");
  return "ok";
});

// ---- 配置 ----
await check("设置：写入 → 读回一致，且去重去空", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sm-steam-cfg-"));
  try {
    const updated = settings.updateSteamSettings(dir, {
      customRoots: ["C:\\A", "C:\\A", "  ", "D:\\B"],
    });
    assert(updated.customRoots.length === 2, `去重后应为 2，实际 ${updated.customRoots.length}`);
    const back = settings.readSteamSettings(dir);
    assert(back.customRoots.length === 2, "读回数量不一致");
    return back.customRoots.join(" , ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("设置：文件损坏时按空设置处理，不抛错", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sm-steam-bad-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "steam-settings.json"), "{ 这不是 JSON", "utf8");
    const s = settings.readSteamSettings(dir);
    assert(Array.isArray(s.customRoots) && s.customRoots.length === 0, "应为空设置");
    return "ok";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 启动层（只校验拒绝逻辑，不真的拉起游戏）----
await check("launchGame 拒绝非法 appId（不拼 URL）", async () => {
  for (const b of [0, -1, 1.5, Number.NaN]) {
    const r = await launch.launchGame(b);
    assert(r.ok === false, `appId ${b} 应被拒绝`);
  }
  return "ok";
});

await check("installGame 拒绝非法 appId", async () => {
  const r = await launch.installGame(-5);
  assert(r.ok === false, "应被拒绝");
  return "ok";
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const item of failures) console.log("  - " + item);
  process.exit(1);
}
