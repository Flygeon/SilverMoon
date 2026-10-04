#!/usr/bin/env node
/**
 * `npm run verify:music-tags` —— 真实跑一遍 taglib-wasm 的写读链路。
 *
 * 为什么需要它：主进程把 `taglib-wasm` 标成 external（ESM-only，不能 bundle 进 CJS），
 * 所以 `npm run typecheck` / vitest 都碰不到真正的写盘逻辑。这个脚本用 esbuild 把
 * `electron/tag-writer.ts` 打成临时 ESM（同样 external taglib-wasm），
 * 在临时目录里生成**真实可解析**的音频文件，然后真的写标签、真的读回来断言。
 *
 * 覆盖：
 * 1. WAV（RIFF）与 MP3（ID3v2）：写中文/年份/音轨/专辑艺术家/碟号/流派/备注/歌词 → 逐项读回；
 * 2. 封面：set 后 hasCover=true → remove 后 hasCover=false；
 * 3. 清空语义：空串字段必须真的从文件里消失（title / artist / 年份 / 歌词）；
 * 4. 失败路径：writeLocalTags 对不存在的文件必须抛错。
 *
 * 任何断言失败 → `process.exit(1)`；全部通过 → 打印 `verify:music-tags OK`。
 * 想留着现场排查：`KEEP=1 node scripts/verify-music-tags.mjs`。
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const results = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    results.push(`  ok   ${name}`);
  } else {
    failed += 1;
    results.push(`  FAIL ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function checkEqual(name, actual, expected) {
  check(
    name,
    actual === expected,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

/** 生成 1 秒 8kHz 单声道 8bit PCM 的最小合法 WAV（44 字节头 + 静音数据）。 */
function writeWav(file) {
  const rate = 8000;
  const data = Buffer.alloc(rate, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

/** 生成 20 帧静音 MPEG1 Layer3 128kbps 44.1kHz 的最小 MP3（可被 TagLib 解析）。 */
function writeMp3(file) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  writeFileSync(file, Buffer.concat(Array.from({ length: 20 }, () => frame)));
}

/** 1x1 透明 PNG（就是标签封面测试用的那张图）。 */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex",
);

const SAMPLE_FIELDS = {
  title: "夜曲",
  artist: "周杰伦",
  album: "十一月的萧邦",
  albumArtist: "周杰伦",
  year: "2005-10-31",
  trackNo: "3/12",
  discNo: "2",
  genre: "Pop",
  comment: "验证备注",
  lyrics: "[00:01.00]一群嗜血的蚂蚁\n[00:02.00]被腐肉所吸引",
};

const EMPTY_FIELDS = {
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

async function main() {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "silvermoon-verify-tags-"));
  const bundleFile = path.join(workDir, "tag-writer.bundle.mjs");
  const outFile = path.join(workDir, "esbuild-meta.json");

  // 1) 把 tag-writer 打成临时 ESM。external 只能写绝对路径或 bare specifier：
  //    tag-writer 在 electron/ 下，bare "taglib-wasm" 解析不到 apps/desktop/node_modules，
  //    所以这里用 require.resolve 换成绝对路径再交给 esbuild（对外仍等价于 external，
  //    产物里就是一行 `import { TagLib } from "<abs>/dist/index.js"`）。
  await build({
    entryPoints: [path.join(appRoot, "electron/tag-writer.ts")],
    outfile: bundleFile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: [require.resolve("taglib-wasm"), require.resolve("taglib-wasm/simple")],
    metafile: true,
    logLevel: "warning",
    write: false,
  }).then((result) => {
    writeFileSync(bundleFile, result.outputFiles[0].text);
    writeFileSync(outFile, JSON.stringify(result.metafile));
  });

  const metafile = JSON.parse(readFileSync(outFile, "utf8"));
  const bundledTaglib = Object.keys(metafile.inputs).filter((input) =>
    input.includes("taglib-wasm"),
  );
  checkEqual("taglib-wasm 未被内联（external 生效）", bundledTaglib.length, 0);
  const bundleText = readFileSync(bundleFile, "utf8");
  check("产物里没有内联 wasm 胶水", !bundleText.includes("wasi_snapshot_preview1"));
  check("产物里没有内联 taglib-wrapper", !bundleText.includes("taglib-wrapper"));
  check("产物里带着 taglib-wasm 的 import", bundleText.includes("taglib-wasm"));

  const writer = await import(pathToFileURL(bundleFile).href);

  // 2) 准备两个真实样本文件
  const wavFile = path.join(workDir, "sample.wav");
  const mp3File = path.join(workDir, "sample.mp3");
  writeWav(wavFile);
  writeMp3(mp3File);
  check("WAV 样本已生成", statSync(wavFile).size > 44);
  check("MP3 样本已生成", statSync(mp3File).size === 20 * 417);

  for (const [label, file] of [
    ["WAV", wavFile],
    ["MP3", mp3File],
  ]) {
    // 3) 写全部字段
    const written = await writer.writeLocalTags({ path: file, fields: SAMPLE_FIELDS });
    checkEqual(`${label}: writeLocalTags 返回原路径`, written?.path, file);

    const first = await writer.readLocalTags(file);
    checkEqual(`${label}: title（中文）`, first.fields.title, SAMPLE_FIELDS.title);
    checkEqual(`${label}: artist（中文）`, first.fields.artist, SAMPLE_FIELDS.artist);
    checkEqual(`${label}: album`, first.fields.album, SAMPLE_FIELDS.album);
    checkEqual(`${label}: albumArtist`, first.fields.albumArtist, SAMPLE_FIELDS.albumArtist);
    checkEqual(`${label}: year（保留完整日期）`, first.fields.year, SAMPLE_FIELDS.year);
    checkEqual(`${label}: trackNo（保留 3/12）`, first.fields.trackNo, SAMPLE_FIELDS.trackNo);
    checkEqual(`${label}: discNo`, first.fields.discNo, SAMPLE_FIELDS.discNo);
    checkEqual(`${label}: genre`, first.fields.genre, SAMPLE_FIELDS.genre);
    checkEqual(`${label}: comment`, first.fields.comment, SAMPLE_FIELDS.comment);
    checkEqual(`${label}: lyrics`, first.fields.lyrics, SAMPLE_FIELDS.lyrics);
    checkEqual(`${label}: 写入前无封面`, first.hasCover, false);

    // 4) 写封面（keep 保留旧值不应影响前面的字段）
    await writer.writeLocalTags({
      path: file,
      fields: SAMPLE_FIELDS,
      coverMode: "set",
      coverBase64: PNG_1X1.toString("base64"),
      coverMime: "image/png",
    });
    const withCover = await writer.readLocalTags(file);
    checkEqual(`${label}: 写封面后 hasCover`, withCover.hasCover, true);
    checkEqual(`${label}: 写封面后 title 未变`, withCover.fields.title, SAMPLE_FIELDS.title);

    // 5) keep 模式不能动已有封面
    await writer.writeLocalTags({ path: file, fields: SAMPLE_FIELDS, coverMode: "keep" });
    checkEqual(
      `${label}: coverMode=keep 保留封面`,
      (await writer.readLocalTags(file)).hasCover,
      true,
    );

    // 6) remove 删封面
    await writer.writeLocalTags({ path: file, fields: SAMPLE_FIELDS, coverMode: "remove" });
    checkEqual(
      `${label}: coverMode=remove 删掉封面`,
      (await writer.readLocalTags(file)).hasCover,
      false,
    );

    // 7) 清空语义：空串必须真的从文件里消失
    await writer.writeLocalTags({ path: file, fields: EMPTY_FIELDS });
    const cleared = await writer.readLocalTags(file);
    checkEqual(`${label}: 清空 title`, cleared.fields.title, "");
    checkEqual(`${label}: 清空 artist`, cleared.fields.artist, "");
    checkEqual(`${label}: 清空 album`, cleared.fields.album, "");
    checkEqual(`${label}: 清空 year`, cleared.fields.year, "");
    checkEqual(`${label}: 清空 trackNo`, cleared.fields.trackNo, "");
    checkEqual(`${label}: 清空歌词`, cleared.fields.lyrics, "");

    // 8) 清空后还能重新写回去（模拟用户改回默认）
    await writer.writeLocalTags({ path: file, fields: { ...EMPTY_FIELDS, title: "重写标题" } });
    checkEqual(
      `${label}: 清空后可重写`,
      (await writer.readLocalTags(file)).fields.title,
      "重写标题",
    );
  }

  // 9) 备份/缓存需要真实文件，这里只验证「不存在路径必须抛错」这条失败语义
  const missing = path.join(workDir, "does-not-exist.wav");
  let threw = false;
  try {
    await writer.writeLocalTags({ path: missing, fields: SAMPLE_FIELDS });
  } catch {
    threw = true;
  }
  check("writeLocalTags 对不存在的路径抛错", threw);

  // 10) readLocalTags 对坏路径必须**不抛**且回退空字段
  const fallback = await writer.readLocalTags(missing);
  checkEqual("readLocalTags 坏路径回退空 title", fallback.fields.title, "");
  checkEqual("readLocalTags 坏路径 hasCover=false", fallback.hasCover, false);

  // 11) 封面数据缺失时 set 必须抛错，而不是静默写坏文件
  let coverThrew = false;
  try {
    await writer.writeLocalTags({ path: wavFile, fields: SAMPLE_FIELDS, coverMode: "set" });
  } catch {
    coverThrew = true;
  }
  check("coverMode=set 缺封面数据时抛错", coverThrew);

  // ---------------------------------------------------------------------
  // 12) 主进程缓存层（electron/tags.ts）：备份 / 在线索引 / 封面 / 歌词旁路
  //
  // 它 import 了 electron，而 Node 里没有 electron —— 用一个 esbuild 插件把
  // `electron` 换成桩模块（app.getPath("userData") 指向临时目录），
  // 这样缓存目录、index.json、封面文件都能在真实文件系统上被验证。
  // ---------------------------------------------------------------------
  const tagsBundle = path.join(workDir, "tags.bundle.mjs");
  const electronStub = `export const app = {
  getPath: () => ${JSON.stringify(workDir)},
  getAppPath: () => ${JSON.stringify(appRoot)},
};
export default { app };`;
  await build({
    entryPoints: [path.join(appRoot, "electron/tags.ts")],
    outfile: tagsBundle,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: [require.resolve("taglib-wasm"), require.resolve("taglib-wasm/simple")],
    plugins: [
      {
        name: "electron-stub",
        setup(plugin) {
          plugin.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron-stub",
            namespace: "electron-stub",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "electron-stub" }, () => ({
            contents: electronStub,
            loader: "js",
          }));
        },
      },
    ],
    logLevel: "warning",
  });

  const tags = await import(pathToFileURL(tagsBundle).href);
  const onlineKey = "netease:10086";

  // 在线缓存：写索引 + 封面落盘
  const cached = await tags.handleMusicTags({
    op: "cacheOnline",
    key: onlineKey,
    fields: SAMPLE_FIELDS,
    coverMode: "set",
    coverBase64: PNG_1X1.toString("base64"),
    coverMime: "image/png",
  });
  checkEqual("缓存：cacheOnline 返回 key", cached.key, onlineKey);
  checkEqual("缓存：cacheOnline 字段落盘", cached.fields.title, SAMPLE_FIELDS.title);
  check(
    "缓存：封面文件已落盘",
    !!cached.coverPath && statSync(cached.coverPath).size === PNG_1X1.length,
  );
  check(
    "缓存：封面文件名按 sha1(key)",
    /covers[\\/]cover-[0-9a-f]{40}\.png$/.test(cached.coverPath ?? ""),
  );
  check(
    "缓存：index.json 可被 JSON.parse",
    !!JSON.parse(readFileSync(path.join(workDir, "music-tags", "index.json"), "utf8")).entries[
      onlineKey
    ],
  );

  const readBack = await tags.handleMusicTags({ op: "readOnline", key: onlineKey });
  checkEqual("缓存：readOnline 读回 title", readBack.fields.title, SAMPLE_FIELDS.title);
  checkEqual("缓存：readOnline 读回 coverPath", readBack.coverPath, cached.coverPath);
  checkEqual(
    "缓存：readOnline 未知 key 返回 null",
    await tags.handleMusicTags({ op: "readOnline", key: "x:1" }),
    null,
  );
  checkEqual(
    "缓存：listOnline 列出 1 条",
    (await tags.handleMusicTags({ op: "listOnline" })).length,
    1,
  );

  // 本地备份：仅首次创建，且不会被后来的覆盖
  const backupFirst = await tags.handleMusicTags({
    op: "backupLocal",
    path: wavFile,
    fields: SAMPLE_FIELDS,
  });
  const backupSecond = await tags.handleMusicTags({
    op: "backupLocal",
    path: wavFile,
    fields: EMPTY_FIELDS,
  });
  checkEqual("备份：首次 backupLocal 返回 created=true", backupFirst.created, true);
  checkEqual("备份：重复 backupLocal 返回 created=false", backupSecond.created, false);
  const backupRead = await tags.handleMusicTags({ op: "readLocalBackup", path: wavFile });
  checkEqual("备份：readLocalBackup 保留最原始字段", backupRead.title, SAMPLE_FIELDS.title);
  checkEqual(
    "备份：readLocalBackup 未备份路径返回 null",
    await tags.handleMusicTags({ op: "readLocalBackup", path: missing }),
    null,
  );

  // 歌词旁路 + original（Lead 在 player.ts 的歌词回退链里用）
  checkEqual(
    "歌词：writeLyrics 返回 written=true",
    (
      await tags.handleMusicTags({
        op: "writeLyrics",
        key: onlineKey,
        lyrics: "[00:10.00]旁路歌词",
      })
    ).written,
    true,
  );
  checkEqual(
    "歌词：readLyrics 默认读旁路",
    await tags.handleMusicTags({ op: "readLyrics", key: onlineKey }),
    "[00:10.00]旁路歌词",
  );
  const withOriginal = await tags.handleMusicTags({
    op: "writeOriginal",
    key: onlineKey,
    fields: { lyrics: "平台原始歌词" },
  });
  checkEqual(
    "original：writeOriginal 不覆盖 fields",
    withOriginal.fields.title,
    SAMPLE_FIELDS.title,
  );
  checkEqual(
    "original：writeOriginal 写入 original",
    withOriginal.original?.lyrics,
    "平台原始歌词",
  );
  checkEqual(
    "original：readOriginal 读回",
    (await tags.handleMusicTags({ op: "readOriginal", key: onlineKey }))?.lyrics,
    "平台原始歌词",
  );
  checkEqual(
    "original：readLyrics(kind=original) 读备份歌词",
    await tags.handleMusicTags({ op: "readLyrics", key: onlineKey, kind: "original" }),
    "平台原始歌词",
  );
  checkEqual(
    "歌词：writeLyrics 空串 = 删除旁路文件",
    (await tags.handleMusicTags({ op: "writeLyrics", key: onlineKey, lyrics: "" })).written,
    false,
  );
  checkEqual(
    "歌词：删除后 readLyrics 返回 null",
    await tags.handleMusicTags({ op: "readLyrics", key: onlineKey }),
    null,
  );

  // 还原默认：删索引 + 删封面文件
  const removed = await tags.handleMusicTags({ op: "removeOnline", key: onlineKey });
  checkEqual("还原：removeOnline 返回 removed=true", removed.removed, true);
  check("还原：封面文件已删除", !existsSync(cached.coverPath));
  checkEqual("还原：listOnline 变空", (await tags.handleMusicTags({ op: "listOnline" })).length, 0);
  checkEqual(
    "还原：removeOnline 再次调用返回 removed=false",
    (await tags.handleMusicTags({ op: "removeOnline", key: onlineKey })).removed,
    false,
  );

  // 未知 op 必须抛错（而不是静默返回 null）
  let unknownThrew = false;
  try {
    await tags.handleMusicTags({ op: "nope" });
  } catch {
    unknownThrew = true;
  }
  check("通道：未知 op 抛错", unknownThrew);

  // ---------------------------------------------------------------------
  // 13) 打包形态：产物同级 node_modules 里能解析到 external 的 taglib-wasm
  //
  // 主进程产物 <app>/dist-electron/main.cjs 对 `import("taglib-wasm")` 的解析，
  // 走的是 Electron 内置的 Node ESM 加载器（从产物目录往上找 node_modules）。
  // 这里用真实目录结构复现这一步：pack/dist-electron/main.cjs + pack/node_modules。
  // ---------------------------------------------------------------------
  const packDir = path.join(workDir, "pack");
  const packMain = path.join(packDir, "dist-electron", "main.cjs");
  mkdirSync(path.join(packDir, "dist-electron"), { recursive: true });
  symlinkSync(path.join(appRoot, "node_modules"), path.join(packDir, "node_modules"), "dir");
  writeFileSync(
    packMain,
    `const { createRequire } = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
(async () => {
  const req = createRequire(__filename);
  const entry = req.resolve("taglib-wasm");
  const simple = req.resolve("taglib-wasm/simple");
  const mod = await import("taglib-wasm");
  const wasm = path.join(path.dirname(entry), "taglib-wasi.wasm");
  if (!fs.existsSync(wasm)) throw new Error("wasm 不在 dist 下：" + wasm);
  console.log(JSON.stringify({
    entry: path.basename(entry),
    simple: path.basename(simple),
    hasInit: typeof mod.TagLib?.initialize === "function",
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`,
    "utf8",
  );
  const packResult = spawnSync(process.execPath, [packMain], { encoding: "utf8" });
  let packParsed = null;
  try {
    packParsed = JSON.parse((packResult.stdout ?? "").trim());
  } catch {
    packParsed = null;
  }
  checkEqual("打包形态：产物同级可解析 taglib-wasm 入口", packParsed?.entry, "index.js");
  checkEqual("打包形态：产物同级可解析 taglib-wasm/simple", packParsed?.simple, "simple.js");
  checkEqual("打包形态：动态 import 拿得到 TagLib.initialize", packParsed?.hasInit, true);
  if (!packParsed) {
    results.push(`       stderr: ${(packResult.stderr ?? "").trim().slice(0, 300)}`);
  }

  console.log(results.join("\n"));
  console.log("\n样本目录：" + workDir);
  if (!process.env.KEEP) {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`\nverify:music-tags 失败：${failed} 项断言未通过（通过 ${passed} 项）`);
    process.exit(1);
  }
  console.log(`\nverify:music-tags OK（${passed} 项断言全部通过）`);
}

// 保留 import，避免「生成了样本却从未读」的错觉；同时供以后扩展缓存断言。
void copyFileSync;

main().catch((error) => {
  console.error("verify:music-tags 异常退出：", error);
  process.exit(1);
});
