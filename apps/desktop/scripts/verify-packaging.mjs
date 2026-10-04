#!/usr/bin/env node
/**
 * verify:packaging —— 校验 electron-builder 的 files 白名单真的能把
 * taglib-wasm 及其运行时依赖打进包，且仍然排除掉整棵生产依赖树。
 *
 * 为什么需要这个脚本（真实故障）：
 * 安装版点「应用」写标签时报
 *   Cannot find package 'taglib-wasm' imported from
 *   C:\Users\...\app.asar\dist-electron\main.cjs
 * 根因是 electron-builder 的 files 是**顺序敏感**的 minimatch 列表，而原配置把
 * taglib-wasm 的 dist 白名单写在「排除整个 node_modules」**之前**，
 * 排除项后手生效 —— 包根本没进 asar。
 *
 * 更隐蔽的是 electron-builder 还会自动注入「排除所有 node_modules」，并在遇到第一个
 * 含 node_modules 的**正向**模式时把它插到前面（fileMatcher.js 的
 * insertExculdeNodeModulesIndex），所以「正向写在排除之前」是被双重堵死的。
 * 另外只给 dist 也不够：Node 的 ESM 解析要先读包内 package.json 的 exports。
 *
 * 这个脚本直接**调用 electron-builder 自己的 matcher**（而不是自己写一套 glob），
 * 因此结论与真实打包一致；配置一改坏就会红。
 *
 * 用法：cd apps/desktop && node scripts/verify-packaging.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(pathToFileURL(path.join(appRoot, "index.js")));

let passed = 0;
let failed = 0;
const out = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    out.push(`  ok   ${name}`);
  } else {
    failed += 1;
    out.push(`  FAIL ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

/** 必须进包的文件（缺一个安装版就可能在运行时炸） */
const MUST_INCLUDE = [
  "dist/index.html",
  "dist-electron/main.cjs",
  "package.json",
  // taglib-wasm：ESM 入口解析需要 package.json 的 exports
  "node_modules/taglib-wasm/package.json",
  "node_modules/taglib-wasm/dist/index.js",
  "node_modules/taglib-wasm/dist/taglib-wasi.wasm",
  // WASI 后端做 msgpack 编解码，静态 import 它
  "node_modules/taglib-wasm/dist/src/msgpack/decoder.js",
  "node_modules/taglib-wasm/dist/src/msgpack/encoder.js",
  // taglib-wasm 的运行时依赖
  "node_modules/@msgpack/msgpack/package.json",
  "node_modules/@msgpack/msgpack/dist.cjs/index.cjs",
];

/** 必须仍被排除的：重复打包的生产依赖树（不排就是约 55MB） */
const MUST_EXCLUDE = [
  "node_modules/pdfjs-dist/package.json",
  "node_modules/hls.js/package.json",
  "node_modules/@m3e/web/package.json",
  "node_modules/vue/package.json",
];

/**
 * 用 electron-builder 的真实 matcher 建一个「是否进包」的判定函数。
 *
 * 之所以不自己 glob：顺序 + 自动注入这两件事都在 electron-builder 内部，
 * 自己实现一遍等于把 bug 换个地方再写一次。
 */
async function buildFilter() {
  const yaml = require("js-yaml");
  const fileMatcher = require("app-builder-lib/out/fileMatcher.js");
  const config = yaml.load(readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8"));
  const packager = {
    projectDir: appRoot,
    buildResourcesDir: "build",
    isPrepackedAppAsar: false,
    config,
    debugLogger: { isEnabled: false },
  };
  const matchers = fileMatcher.getMainFileMatchers(
    appRoot,
    appRoot,
    (s) => s,
    {},
    { info: packager },
    path.join(appRoot, "release"),
    false,
  );
  const filter = matchers[0].createFilter();
  // 伪造一个「非目录」stat：minimatch 的过滤只看 isDirectory()，因此**文件不存在**
  // 也能正确判断白名单语义（lint 作业不跑构建，dist/ 可能还没生成）。
  const fileStat = { isDirectory: () => false };
  return (rel) => {
    const abs = path.join(appRoot, rel);
    let stat = fileStat;
    try {
      stat = statSync(abs);
    } catch {
      /* 路径不存在：沿用伪造 stat，仅验证模式是否命中 */
    }
    return Boolean(filter(abs, stat));
  };
}

async function main() {
  console.log("verify:packaging —— 用 electron-builder 的真实 matcher 校验 files 白名单\n");

  const included = await buildFilter();

  for (const rel of MUST_INCLUDE) {
    const verdict = included(rel);
    if (verdict === null) check(`进包：${rel}`, false, "文件不存在（依赖没装？）");
    else check(`进包：${rel}`, verdict === true, "被 files 白名单排除了");
  }

  for (const rel of MUST_EXCLUDE) {
    const verdict = included(rel);
    if (verdict === null) continue; // 该依赖未安装时跳过
    check(`排除：${rel}`, verdict === false, "仍在包内（白白增大安装包）");
  }

  // 兜底：白名单里除 taglib-wasm / @ 作用域外不应再有其它 node_modules 包
  const nmRoot = path.join(appRoot, "node_modules");
  const extra = [];
  for (const entry of readdirSync(nmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === "taglib-wasm" || entry.name.startsWith("@")) continue;
    if (included(`node_modules/${entry.name}/package.json`) === true) extra.push(entry.name);
  }
  check(
    "白名单没有夹带其它 node_modules 包",
    extra.length === 0,
    extra.length ? `意外进包：${extra.join(", ")}` : "",
  );

  console.log(out.join("\n"));
  if (failed > 0) {
    console.error(`\nverify:packaging 失败：${failed} 项断言未通过（通过 ${passed} 项）`);
    process.exit(1);
  }
  console.log(`\nverify:packaging OK（${passed} 项断言全部通过）`);
}

main().catch((error) => {
  console.error("verify:packaging 异常退出：", error);
  process.exit(1);
});
