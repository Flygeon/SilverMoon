#!/usr/bin/env node
/**
 * Rust 纯逻辑回归 —— **真正执行**项目里的 Rust 源码。
 *
 * ## 为什么需要它
 *
 * 本机（以及很多只需要跑前端的机器）**没有 MSVC 链接器**，`cargo test` 连
 * proc-macro / build script 都链接不过。于是 Rust 侧改动在本机没有任何可执行证据，
 * 只能等 CI —— 反馈链路很长，也容易把「语法对、行为错」的改动放过去。
 *
 * 但有一条绕开 MSVC 的路：**`wasm32-unknown-unknown` 目标用 rustup 自带的
 * `rust-lld` 链接**，不需要 link.exe。于是可以把项目里**不带任何依赖的纯函数**
 * 原样抽出来编成 wasm，再在 Node 里真的跑一遍断言。
 *
 * 关键点：**抽取的是项目源文件里的原文**（不是复制粘贴的副本），
 * 所以这份验证跟着实现一起变化，不会悄悄失效。
 *
 * ## 覆盖范围
 *
 * 只覆盖「无外部依赖的纯逻辑」——目前是封面 Referer 伪装、封面扩展名推断、
 * 路径规范化。异步 / 网络 / 数据库路径仍需 CI 的 `cargo test`。
 *
 * ## 用法
 *
 * ```bash
 * npm run verify:rust-pure            # 本地跑
 * ```
 *
 * 首次运行需要 wasm 目标：`rustup target add wasm32-unknown-unknown`。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(appRoot, "src-tauri", "src");

/** 断言计数 */
let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) passed += 1;
  else failures.push(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
}

/**
 * 从源文件里抽出某个顶层 `fn` 的完整文本（含它前面的文档注释）。
 *
 * 按花括号配平找函数体结尾，因此不依赖任何解析器；抽不到就**大声失败**，
 * 避免实现改名后这里的验证被静默跳过。
 */
function extractFn(relFile, fnName) {
  const file = path.join(srcRoot, relFile);
  const src = readFileSync(file, "utf8");
  const needle = `fn ${fnName}(`;
  const idx = src.indexOf(needle);
  if (idx === -1) {
    throw new Error(`${relFile} 里找不到 ${needle} —— 实现可能改名了，请更新本脚本`);
  }
  // 往前吃掉紧邻的 /// 文档注释
  let start = idx;
  const lines = src.slice(0, idx).split("\n");
  let li = lines.length - 2;
  while (li >= 0 && /^\s*(\/\/\/|\/\/!)/.test(lines[li])) li -= 1;
  start = lines.slice(0, li + 1).join("\n").length + 1;

  let depth = 0;
  let i = src.indexOf("{", idx);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return src.slice(start, i).trim();
}

/** 待验证的纯函数：源文件 → 函数名 → 该函数需要的 use。 */
const TARGETS = [
  {
    file: "cover.rs",
    fn: "referer_for",
    uses: [],
    wrapper: `
#[no_mangle]
pub extern "C" fn referer_kind(ptr: *const u8, len: usize) -> u32 {
    let h = unsafe { std::slice::from_raw_parts(ptr, len) };
    let owned = String::from_utf8_lossy(h);
    match referer_for(&owned) {
        Some("https://music.163.com/") => 1,
        Some("https://www.kugou.com/") => 2,
        Some("https://y.qq.com/") => 3,
        Some(_) => 9,
        None => 0,
    }
}`,
    run: (ex) => {
      const call = (host) => {
        const b = enc.encode(host);
        const ptr = base(ex) + 1024;
        mem(ex).set(b, ptr);
        return ex.referer_kind(ptr, b.length);
      };
      console.log("\n[referer_for] 防盗链 Referer 按域名分流（0=不伪装 1=网易云 2=酷狗 3=QQ）");
      // 期望值对齐 Electron 版 electron/protocols.ts 的 coverRefererRules
      const cases = [
        ["p1.music.126.net", 1],
        ["music.163.com", 1],
        ["imge.kugou.com", 2],
        ["www.kugou.com", 2],
        ["kglink.com", 2],
        ["m.kugou.cn", 2],
        ["u.y.qq.com", 3],
        ["y.qq.com", 3],
        // 不得误伤：第三方 / 仿冒域名
        ["i0.hdslb.com", 0],
        ["example.com", 0],
        ["notkugou.com", 0],
        ["kglink.com.evil.net", 0],
        ["notqq.com", 0],
      ];
      for (const [host, want] of cases) check(`  ${host}`, call(host), want);
    },
  },
  {
    file: path.join("commands", "host.rs"),
    fn: "normalize_str",
    uses: [],
    wrapper: `
#[no_mangle]
pub extern "C" fn normalize_write(ptr: *const u8, len: usize, out: *mut u8) -> usize {
    let s = unsafe { std::slice::from_raw_parts(ptr, len) };
    let r = normalize_str(&String::from_utf8_lossy(s));
    unsafe { std::ptr::copy_nonoverlapping(r.as_ptr(), out, r.len()) };
    r.len()
}`,
    run: (ex) => {
      const call = (s) => {
        const b = enc.encode(s);
        const ptr = base(ex) + 4096;
        const outPtr = base(ex) + 8192;
        mem(ex).set(b, ptr);
        const n = ex.normalize_write(ptr, b.length, outPtr);
        return dec.decode(mem(ex).subarray(outPtr, outPtr + n));
      };
      console.log("\n[normalize_str] 路径规范化（对齐 Node path.normalize）");
      const cases = [
        ["a\\b\\c", "a/b/c"],
        ["C:\\blog\\SilverMoon", "C:/blog/SilverMoon"],
        ["/a/./b/../c", "/a/c"],
        ["a//b", "a/b"],
        ["../x", "x"],
        ["/", "/"], // Node 的 path.normalize("/") 就是 "/"
        ["/a/../", "/"],
      ];
      for (const [input, want] of cases) check(`  ${JSON.stringify(input)}`, call(input), want);
    },
  },
  {
    file: path.join("commands", "music_tags.rs"),
    fn: "cover_ext",
    uses: [],
    wrapper: `
#[no_mangle]
pub extern "C" fn cover_ext_write(
    mime_ptr: *const u8, mime_len: usize, has_mime: u32,
    b64_ptr: *const u8, b64_len: usize, out: *mut u8,
) -> usize {
    let mime = if has_mime == 1 {
        Some(String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(mime_ptr, mime_len) }).into_owned())
    } else { None };
    let b64 = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(b64_ptr, b64_len) }).into_owned();
    let r = cover_ext(mime.as_deref(), Some(&b64));
    unsafe { std::ptr::copy_nonoverlapping(r.as_ptr(), out, r.len()) };
    r.len()
}`,
    run: (ex) => {
      const call = (mime, b64) => {
        const mp = base(ex) + 12000,
          bp = base(ex) + 14000,
          op = base(ex) + 16000;
        const mb = enc.encode(mime ?? ""),
          bb = enc.encode(b64);
        if (mime) mem(ex).set(mb, mp);
        mem(ex).set(bb, bp);
        const n = ex.cover_ext_write(mp, mb.length, mime ? 1 : 0, bp, bb.length, op);
        return dec.decode(mem(ex).subarray(op, op + n));
      };
      console.log("\n[cover_ext] 封面扩展名推断（mime 优先，缺失时看 dataURL 前缀）");
      const PNG =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
      const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      check("  image/png", call("image/png", ""), "png");
      check("  IMAGE/WEBP（大小写不敏感）", call("IMAGE/WEBP", ""), "webp");
      check("  image/jpeg", call("image/jpeg", ""), "jpg");
      check("  image/x-icon（未知 → jpg 兜底）", call("image/x-icon", ""), "jpg");
      check("  null + png dataURL", call(null, PNG), "png");
      check("  null + gif dataURL", call(null, GIF), "gif");
      check(
        "  null + 短样本（<30 字符 → jpg 兜底）",
        call(null, "data:image/png;base64,iVBOR"),
        "jpg",
      );
    },
  },
];

// ---------------------------------------------------------------------------
// 1) 组装临时 crate
// ---------------------------------------------------------------------------
const workspace = mkdtempSync(path.join(os.tmpdir(), "silvermoon-rust-pure-"));
const cleanup = () => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};
process.on("exit", cleanup);

mkdirSync(path.join(workspace, "src"), { recursive: true });
writeFileSync(
  path.join(workspace, "Cargo.toml"),
  '[package]\nname = "silvermoon_rust_pure"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\n',
);

const body = TARGETS.map((t) => {
  const fnText = extractFn(t.file, t.fn);
  const uses = t.uses.map((u) => `use ${u};`).join("\n");
  return `// ---- 取自 ${t.file} 的 ${t.fn} ----\n${uses}\n${fnText}\n${t.wrapper}`;
}).join("\n\n");

writeFileSync(
  path.join(workspace, "src", "lib.rs"),
  `//! 由 scripts/verify-rust-pure.mjs 自动生成；函数体抽自项目源文件，请勿手工维护。\n#![allow(dead_code)]\n\n${body}\n`,
);

// ---------------------------------------------------------------------------
// 2) 编译成 wasm（用 rustup 自带的 rust-lld，绕开 MSVC）
// ---------------------------------------------------------------------------
function hasWasmTarget() {
  try {
    return execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" }).includes(
      "wasm32-unknown-unknown",
    );
  } catch {
    return false;
  }
}
if (!hasWasmTarget()) {
  console.error(
    "缺少 wasm32-unknown-unknown 目标。这条验证路径刻意绕开 MSVC 链接器，需要它才能在本机编译：\n" +
      "  rustup target add wasm32-unknown-unknown",
  );
  process.exit(1);
}

console.log("编译纯逻辑到 wasm32（绕开 MSVC，利用 rustup 自带的 rust-lld）…");
try {
  execFileSync("cargo", ["build", "--quiet", "--target", "wasm32-unknown-unknown"], {
    cwd: workspace,
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch {
  console.error("wasm 编译失败 —— 上面的 rustc 报错即项目源码的真实编译错误。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3) 在 Node 里执行并断言
// ---------------------------------------------------------------------------
const wasmPath = path.join(
  workspace,
  "target",
  "wasm32-unknown-unknown",
  "debug",
  "silvermoon_rust_pure.wasm",
);
if (!existsSync(wasmPath)) {
  console.error("未找到 wasm 产物：" + wasmPath);
  process.exit(1);
}
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();
/** 取一块空闲内存偏移的基准（__heap_base 之后）。 */
const base = (e) => Number(e.__heap_base?.value ?? 65536);
const mem = (e) => new Uint8Array(e.memory.buffer);

console.log("\n=== 执行项目 Rust 源码（真实运行，非静态检查）===");
for (const t of TARGETS) t.run(ex);

// ---------------------------------------------------------------------------
// 4) 汇总
// ---------------------------------------------------------------------------
const total = passed + failures.length;
if (failures.length) {
  console.error(`\n✗ Rust 纯逻辑验证失败：${failures.length}/${total} 条不通过`);
  for (const f of failures) console.error("   - " + f);
  process.exit(1);
}
console.log(`\n✓ Rust 纯逻辑验证通过：${passed}/${total} 条断言（源码抽自 src-tauri，真实执行）`);
