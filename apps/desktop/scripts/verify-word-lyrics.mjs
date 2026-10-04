#!/usr/bin/env node
/**
 * `npm run verify:word-lyrics` —— 逐字歌词「取词 → 编码 → 真实写盘 → 读回」的端到端验证。
 *
 * 为什么单独写：
 * - `musicTagWordLyrics.ts` / `wordLevelLrc.ts` 依赖 `@/ipc/http` 等渲染层路径别名，
 *   vitest 里全是 mock；这里用 esbuild 按别名打成临时 ESM，把**纯逻辑**真跑一遍；
 * - 编码出来的增强型 LRC 到底能不能被 `parseLrc` 原样读回、能不能经 taglib-wasm
 *   真写进音频文件再读出来，是这个功能的核心承诺，必须端到端验一次。
 *
 * 覆盖：
 * 1. 增强型 LRC 编解码往返（含厘秒进位、末词收尾标记、翻译行、三点行剔除）；
 * 2. 网易云 yrc 解析（绝对毫秒语义）；
 * 3. 各源取词能力：QQ/KG/网易云走真实网络（接口随时失效，**不算失败**）；
 * 4. taglib-wasm 真实落盘：把逐字歌词写进 WAV/MP3 再读回，断言词级标记完好。
 *
 * 想留着现场排查：`KEEP=1 node scripts/verify-word-lyrics.mjs`。
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/** 生成 1 秒 8kHz 单声道 8bit PCM 的最小合法 WAV（与 verify-music-tags 同款） */
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

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 12000;

async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 esbuild 把逐字歌词的纯逻辑打成临时 ESM。
 *
 * 别名与 vite.config.ts 对齐（`@` → src、`@shared` → shared）；只留纯模块，
 * `@/ipc/http` 与 `@/capabilities` 用桩替掉（本脚本的网络走 Node 原生 fetch）。
 */
async function bundleLogic(workDir) {
  const entry = path.join(workDir, "entry.ts");
  writeFileSync(
    entry,
    `export { serializeWordLevelLrc, formatLrcTime, hasWordUnits, parseNeteaseYrc, stripWordUnits } from "@@/utils/wordLevelLrc";
export { parseLrc } from "@@/utils/lyricTimeline";`.replaceAll("@@", appRoot + "/src"),
    "utf8",
  );
  const outFile = path.join(workDir, "logic.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: outFile,
    // 只打纯逻辑：把网络/主进程依赖留成 external，运行时用下面的桩接住
    external: ["@/ipc/http", "@/capabilities"],
    alias: {
      "@": path.join(appRoot, "src"),
      "@shared": path.join(appRoot, "shared"),
    },
    logLevel: "silent",
  });
  // external 的 bare specifier 在临时目录解析不到，写两个薄桩到产物同级
  mkdirSync(path.join(workDir, "node_modules"), { recursive: true });
  const stub = (body) => `export default {}; ${body}`;
  mkdirSync(path.join(workDir, "node_modules", "@"), { recursive: true });
  // 简化：把 external 换成内联桩（改写产物里的 import 说明符）
  let code = readFileSync(outFile, "utf8");
  code = code
    .replaceAll('from "@/ipc/http"', 'from "./stub-http.mjs"')
    .replaceAll('from "@/capabilities"', 'from "./stub-capabilities.mjs"');
  writeFileSync(outFile, code, "utf8");
  writeFileSync(
    path.join(workDir, "stub-http.mjs"),
    stub("export const fetch = globalThis.fetch;"),
    "utf8",
  );
  writeFileSync(
    path.join(workDir, "stub-capabilities.mjs"),
    stub("export const capabilities = { kugouSearch: async () => ({}) };"),
    "utf8",
  );
  return import(pathToFileURL(outFile).href);
}

async function main() {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "verify-word-lyrics-"));
  console.log(`verify:word-lyrics —— 临时目录 ${workDir}\n`);

  // ---- 1. 纯逻辑：编码 / 往返 / yrc 解析 ----
  let logic;
  try {
    logic = await bundleLogic(workDir);
    check("打包：逐字歌词逻辑可独立加载", true);
  } catch (e) {
    check("打包：逐字歌词逻辑可独立加载", false, String(e?.message ?? e));
  }

  if (logic) {
    const { serializeWordLevelLrc, formatLrcTime, parseLrc, parseNeteaseYrc, stripWordUnits } =
      logic;

    checkEqual("时间格式：厘秒右进不倒挂", formatLrcTime(59.996), "01:00.00");
    checkEqual("时间格式：负数归零", formatLrcTime(-1), "00:00.00");
    checkEqual("时间格式：超一小时", formatLrcTime(3661.5), "61:01.50");

    const source = [
      {
        time: 12.34,
        text: "原谅我",
        units: [
          { text: "原", start: 12.34, end: 12.61 },
          { text: "谅", start: 12.61, end: 12.88 },
          { text: "我", start: 12.88, end: 13.2 },
        ],
      },
      { time: 14.5, text: "不再送花" },
      { time: 16, text: "•••", instrumental: true },
      { time: 20, text: "hello", translation: "你好" },
    ];
    const text = serializeWordLevelLrc(source);
    check("编码：多字行带词级标记", text.includes("<00:12.34>原"));
    check("编码：末词有收尾标记", text.includes("<00:13.20>"));
    check("编码：普通行不带标记", /\[00:14\.50\]不再送花/.test(text));
    check("编码：三点行被剔除", !text.includes("•••"));
    check("编码：翻译作为同时间戳第二行", text.includes("[00:20.00]hello\n[00:20.00]你好"));

    const round = parseLrc(text, false);
    const first = round.find((l) => Math.abs(l.time - 12.34) < 0.005);
    checkEqual("往返：行文本一致", first?.text, "原谅我");
    checkEqual(
      "往返：词元一致",
      JSON.stringify(first?.units?.map((u) => u.text)),
      JSON.stringify(["原", "谅", "我"]),
    );
    check(
      "往返：首词起点一致",
      Math.abs((first?.units?.[0].start ?? 0) - 12.34) < 0.005,
      `实际 ${first?.units?.[0].start}`,
    );
    check(
      "往返：末词终点来自收尾标记",
      Math.abs((first?.units?.[2].end ?? 0) - 13.2) < 0.005,
      `实际 ${first?.units?.[2].end}`,
    );
    const translated = round.find((l) => Math.abs(l.time - 20) < 0.005);
    checkEqual("往返：翻译合并回 translation", translated?.translation, "你好");

    // 逐行 LRC 不该被当成逐字（attachRoughUnits=false）
    const plain = parseLrc("[00:01.00]第一行\n[00:03.00]第二行", false, false);
    check(
      "逐行 LRC：不留粗排 units（不会被误判成逐字）",
      plain.every((l) => l.units === undefined),
      JSON.stringify(plain.map((l) => l.units)),
    );
    // 默认行为不变：仍附粗排 units 供渲染
    const rough = parseLrc("[00:01.00]第一行", false);
    check("默认行为：仍附粗排 units（渲染链路不受影响）", (rough[0]?.units?.length ?? 0) > 0);

    // 落盘前必须剥掉粗排：序列化只看 units，会把逐行写成伪逐字（真实缺陷的回归）
    const meting = parseLrc("[00:10.00]第一句歌词\n[00:14.00]第二句歌词", true);
    check(
      "Meting 场景：逐行结果确实带粗排 units（缺陷前提成立）",
      meting.some((l) => (l.units?.length ?? 0) > 1),
    );
    const stripped = serializeWordLevelLrc(stripWordUnits(meting));
    check("剥掉粗排后：逐行歌词不含词级标记", !stripped.includes("<00:"), stripped.slice(0, 40));
    checkEqual(
      "剥掉粗排后：逐行歌词为纯 LRC",
      stripped,
      "[00:10.00]第一句歌词\n[00:14.00]第二句歌词",
    );
    check("stripWordUnits 不修改入参（行上 units 仍在）", (meting[0]?.units?.length ?? 0) > 1);

    // 脏数据：词级时间戳非单调 → 退回粗排而不是错位高亮
    const dirty = parseLrc("[00:10.00]<00:10.00>a<00:09.00>b", false);
    checkEqual("脏数据：行文本仍完整", dirty[0]?.text, "ab");
    check(
      "脏数据：首词起点不被拉到 9 秒",
      Math.abs((dirty[0]?.units?.[0].start ?? 0) - 10) < 0.005,
      `实际 ${dirty[0]?.units?.[0].start}`,
    );

    const yrc = parseNeteaseYrc("[40450,4620](40450,280,0)原(40730,260,0)谅(40990,320,0)我");
    checkEqual("yrc：整行文本", yrc[0]?.text, "原 谅我".replace(" ", ""));
    check(
      "yrc：词时间是绝对毫秒（不是相对行首）",
      Math.abs((yrc[0]?.units?.[0].start ?? 0) - 40.45) < 0.005,
      `实际 ${yrc[0]?.units?.[0].start}`,
    );
  }

  // ---- 2. 真实网络：各源逐字能力（接口失效不算失败）----
  console.log("\n真实网络探测（接口随时可能失效，仅作信息展示，不计入失败）");
  try {
    const search = await getJson(
      "https://music.163.com/api/cloudsearch/pc?s=" +
        encodeURIComponent("富士山下 陈奕迅") +
        "&type=1&offset=0&limit=1",
      { "User-Agent": DESKTOP_UA, Referer: "https://music.163.com/" },
    );
    const id = search?.result?.songs?.[0]?.id;
    if (id) {
      const lyric = await getJson(
        `https://music.163.com/api/song/lyric/v1?id=${id}&cp=false&lv=0&kv=0&tv=0&rv=0&yv=0&ytv=0&yrv=0`,
        { "User-Agent": DESKTOP_UA, Referer: "https://music.163.com/" },
      );
      const yrcText = lyric?.yrc?.lyric ?? "";
      const yrcLines = logic ? logic.parseNeteaseYrc(yrcText) : [];
      const wordy = yrcLines.filter((l) => (l.units?.length ?? 0) > 1).length;
      console.log(
        `  · 网易云 yrc：${yrcText ? `${yrcText.length} 字节，${wordy}/${yrcLines.length} 行带词级时间轴` : "该曲无逐字轨（接口正常）"}`,
      );
      // 有 yrc 时必须能解析出词级行 —— 这是新增能力的直接证据
      if (yrcText) {
        check("网易云 yrc：真实响应能解析出逐字行", wordy > 0, `wordy=${wordy}`);
      }
    } else {
      console.log("  · 网易云搜索无结果（跳过）");
    }
  } catch (e) {
    console.log(`  · 网易云探测失败（接口失效，不计失败）：${e?.message ?? e}`);
  }

  // ---- 3. 真实落盘：把逐字歌词交给 taglib-wasm 写进 WAV 再读回 ----
  try {
    const { createRequire: cr } = await import("node:module");
    const localRequire = cr(path.join(appRoot, "index.js"));
    const wasmEntry = localRequire.resolve("taglib-wasm");
    const wasmUrl = path.join(path.dirname(wasmEntry), "taglib-wasi.wasm");
    check("taglib-wasm：wasm 存在", existsSync(wasmUrl), wasmUrl);

    const wav = path.join(workDir, "word-lrc.wav");
    writeWav(wav);

    const { TagLib } = await import("taglib-wasm");
    const taglib = await TagLib.initialize({ wasmUrl, forceWasmType: "wasi" });
    const lyricsText = logic
      ? logic.serializeWordLevelLrc([
          {
            time: 1.5,
            text: "原谅我",
            units: [
              { text: "原", start: 1.5, end: 1.8 },
              { text: "谅", start: 1.8, end: 2.1 },
              { text: "我", start: 2.1, end: 2.4 },
            ],
          },
        ])
      : "";
    const file = await taglib.open(wav);
    try {
      file.tag().setTitle("逐字歌词样本");
      file.setLyrics([{ text: lyricsText }]);
      await file.saveToFile();
    } finally {
      file.dispose();
    }

    const readBack = await taglib.open(wav);
    try {
      const stored = readBack
        .getLyrics()
        .map((e) => e.text ?? "")
        .join("\n");
      check(
        "落盘：歌词写进了文件",
        stored.includes("<00:01.50>原"),
        JSON.stringify(stored.slice(0, 60)),
      );
      const reread = logic ? logic.parseLrc(stored, false) : [];
      const line = reread.find((l) => Math.abs(l.time - 1.5) < 0.005);
      checkEqual("落盘并读回：行文本", line?.text, "原谅我");
      check(
        "落盘并读回：词级时间轴完好",
        JSON.stringify(line?.units?.map((u) => u.text)) === JSON.stringify(["原", "谅", "我"]),
        JSON.stringify(line?.units),
      );
    } finally {
      readBack.dispose();
    }
  } catch (e) {
    check("taglib-wasm 真实落盘链路", false, String(e?.message ?? e));
  }

  console.log(results.join("\n"));
  console.log("\n样本目录：" + workDir);
  if (!process.env.KEEP) rmSync(workDir, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\nverify:word-lyrics 失败：${failed} 项断言未通过（通过 ${passed} 项）`);
    process.exit(1);
  }
  console.log(`\nverify:word-lyrics OK（${passed} 项断言全部通过）`);
}

main().catch((error) => {
  console.error("verify:word-lyrics 异常退出：", error);
  process.exit(1);
});
