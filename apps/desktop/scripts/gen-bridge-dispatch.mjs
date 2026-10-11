#!/usr/bin/env node
// 生成 Rust 桥（bridge）的命令分发表。
// 用法：node scripts/gen-bridge-dispatch.mjs [--check] [--json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const tauriDir = join(desktopDir, "src-tauri");
const srcDir = join(tauriDir, "src");

function sliceBalanced(text, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced");
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("([<{".includes(ch)) depth++;
    if (")]>}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// heck 的 to_lower_camel_case 等价实现 —— Tauri 的 #[tauri::command] 默认就用它把
// Rust 形参名转成 JS 侧参数键（见 tauri-macros::command::wrapper）。
function toCamel(name) {
  const words = [];
  let cur = "";
  const chars = Array.from(name);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "_" || ch === "-" || ch === " ") {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    const upper = ch >= "A" && ch <= "Z";
    const prev = i > 0 ? chars[i - 1] : "";
    const prevUpper = prev >= "A" && prev <= "Z";
    const next = i + 1 < chars.length ? chars[i + 1] : "";
    const nextLower = next >= "a" && next <= "z";
    if (cur && upper && (!prevUpper || nextLower)) {
      words.push(cur);
      cur = "";
    }
    cur += ch.toLowerCase();
  }
  if (cur) words.push(cur);
  return words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}


function parseFn(text, fnName) {
  const re = new RegExp("fn\\s+" + fnName + "\\s*(?:<[^>]*>\\s*)?\\(", "g");
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    if (!/#\[tauri::command/.test(before)) continue;
    const attr = before.match(/#\[tauri::command[^\]]*\]/g);
    const attrText = attr ? attr[attr.length - 1] : "";
    const openIdx = m.index + m[0].length - 1;
    const paramsRaw = sliceBalanced(text, openIdx, "(", ")");
    const after = text.slice(openIdx + paramsRaw.length);
    const arrow = after.match(/^\s*->\s*([^{]+)\{/);
    const head = text.slice(Math.max(0, m.index - 40), m.index);
    const isPub = /pub(\s*\([^)]*\))?\s+(async\s+)?$/.test(head);
    return {
      isPub: isPub,
      params: splitTopLevel(stripComments(paramsRaw.slice(1, -1))),
      ret: arrow ? arrow[1].trim() : "()",
      snake: /rename_all\s*=\s*"snake_case"/.test(attrText),
      isAsync: /async\s+fn/.test(head + "fn"),
    };
  }
  return null;
}

function classifyParam(p) {
  const idx = p.indexOf(":");
  const name = p.slice(0, idx).replace(/^mut\s+/, "").trim();
  const decl = p.slice(idx + 1).trim();
  const t = decl.replace(/\s+/g, "");
  if (t === "AppHandle" || t === "tauri::AppHandle" || t === "&AppHandle" || t === "&tauri::AppHandle" || t.startsWith("AppHandle<")) {
    return { kind: "app", name: name, ty: decl };
  }
  if (t.startsWith("State<") || t.startsWith("tauri::State<")) {
    let inner = t.replace(/^tauri::State</, "").replace(/^State</, "");
    inner = inner.slice(0, -1).replace(/^'_,?/, "");
    return { kind: "state", name: name, ty: decl, stateTy: inner };
  }
  if (/^(tauri::)?(Window|WebviewWindow|Webview)(<.*>)?$/.test(t)) {
    return { kind: "unsupported", name: name, ty: decl };
  }
  return { kind: "arg", name: name, ty: decl };
}

const libRs = readFileSync(join(srcDir, "lib.rs"), "utf8");
const ghIdx = libRs.indexOf("generate_handler![");
if (ghIdx < 0) throw new Error("lib.rs 里找不到 generate_handler!");
const gh = sliceBalanced(libRs, ghIdx + "generate_handler!".length, "[", "]");
const entries = splitTopLevel(stripComments(gh.slice(1, -1)));

const commands = [];
const problems = [];
const fileCache = new Map();
function fileText(candidate) {
  let t = fileCache.get(candidate);
  if (t === undefined) {
    t = readFileSync(candidate, "utf8");
    fileCache.set(candidate, t);
  }
  return t;
}

for (const entry of entries) {
  const parts = entry.split("::");
  const fnName = parts[parts.length - 1];
  const modPath = parts.slice(0, -1);
  const candidate = modPath.length === 0 ? join(srcDir, "lib.rs") : join(srcDir, modPath.join("\\\\")) + ".rs";
  if (!existsSync(candidate)) {
    problems.push(entry + " → 找不到源文件 " + candidate);
    continue;
  }
  const info = parseFn(fileText(candidate), fnName);
  if (!info) {
    problems.push(entry + " → 找不到 #[tauri::command] fn " + fnName);
    continue;
  }
  commands.push({
    entry: entry,
    fn: fnName,
    rustPath: "crate::" + parts.join("::"),
    file: candidate.slice(tauriDir.length + 1).replace(/\\\\/g, "/"),
    isAsync: info.isAsync,
    isPub: info.isPub,
    ret: info.ret.replace(/\s+/g, " "),
    snake: info.snake,
    params: info.params.map(classifyParam),
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ commands: commands, problems: problems }, null, 2));
  process.exit(0);
}

console.log("命令总数: " + commands.length + "   问题: " + problems.length);
for (const p of problems) console.log("  !! " + p);
const unsupported = commands.filter((c) => c.params.some((p) => p.kind === "unsupported"));
console.log("含不支持参数(窗口/Webview)的命令: " + unsupported.length);
for (const c of unsupported) console.log("  ~~ " + c.entry + "  " + c.params.filter((p) => p.kind === "unsupported").map((p) => p.ty).join(","));
console.log("async 命令: " + commands.filter((c) => c.isAsync).length);
const nonPub = commands.filter((c) => !c.isPub);
console.log("非 pub 命令（子模块仍可访问，仅供确认）: " + nonPub.length + " " + nonPub.map((c) => c.entry).join(", "));
const stateTys = new Set();
for (const c of commands) for (const p of c.params) if (p.kind === "state") stateTys.add(p.stateTy);
console.log("state 类型: " + Array.from(stateTys).join(" | "));
const rets = Array.from(new Set(commands.map((c) => c.ret)));
console.log("返回值种类: " + rets.length);
for (const r of rets.slice(0, 40)) console.log("   ret: " + r);
const argTys = Array.from(new Set(commands.flatMap((c) => c.params.filter((p) => p.kind === "arg").map((p) => p.ty))));
console.log("arg 类型种类: " + argTys.length);
for (const a of argTys.slice(0, 60)) console.log("   arg: " + a);

// ---------------------------------------------------------------------------
// 代码生成：src/bridge/dispatch.generated.rs
// ---------------------------------------------------------------------------

const STATE_PATHS = { DbState: "crate::commands::DbState", JobState: "crate::commands::JobState" };

function argExpr(param) {
  if (param.kind === "app") return "app.clone()";
  if (param.kind === "state") {
    const path = STATE_PATHS[param.stateTy];
    if (!path) throw new Error("未知的 State 类型: " + param.stateTy);
    return "app.state::<" + path + ">()";
  }
  return "arg(args, \"" + toCamel(param.name) + "\")?";
}

function arm(c) {
  const call =
    c.rustPath + "(\n            " + c.params.map(argExpr).join(",\n            ") + (c.params.length ? ",\n        " : "") + ")";
  const body = c.isAsync ? "tauri::async_runtime::block_on(async {\n            " + call + "\n        })" : call;
  const wrapper = c.ret.startsWith("Result<") ? "res_json" : "ok_json";
  return [
    "        \"" + c.fn + "\" => {",
    "            let __out = " + body + ";",
    "            " + wrapper + "(__out)",
    "        }",
  ].join("\n");
}

const out = [
  "// @generated by apps/desktop/scripts/gen-bridge-dispatch.mjs -- 请勿手工编辑。",
  "//",
  "// 这张表把 KMP 桌面端的 JSON-RPC 命令名映射到现有的 #[tauri::command] 函数，",
  "// 业务逻辑零重写：只是把 Tauri 宏内部那份派发逻辑重新展开一遍。",
  "// 重新生成： cd apps/desktop && node scripts/gen-bridge-dispatch.mjs",
  "// 校验一致性：node scripts/gen-bridge-dispatch.mjs --check",
  "",
  "#![allow(clippy::too_many_arguments)]",
  "",
  "use serde_json::Value;",
  "use tauri::Manager;",
  "",
  "/// 从参数对象里取一个键并反序列化成命令形参类型（键名 camelCase，与 Tauri 的约定一致）。",
  "fn arg<T: serde::de::DeserializeOwned>(args: &serde_json::Map<String, Value>, key: &str) -> Result<T, String> {",
  "    let raw = args.get(key).cloned().unwrap_or(Value::Null);",
  "    serde_json::from_value(raw).map_err(|e| format!(\"参数 {key} 解析失败: {e}\"))",
  "}",
  "",
  "fn ok_json<T: serde::Serialize>(value: T) -> Result<Value, String> {",
  "    serde_json::to_value(value).map_err(|e| e.to_string())",
  "}",
  "",
  "fn res_json<T: serde::Serialize, E: std::fmt::Display>(value: Result<T, E>) -> Result<Value, String> {",
  "    match value {",
  "        Ok(v) => serde_json::to_value(v).map_err(|e| e.to_string()),",
  "        Err(e) => Err(e.to_string()),",
  "    }",
  "}",
  "",
  "/// 已桥接命令总数。",
  "pub const COMMAND_COUNT: usize = " + commands.length + ";",
  "",
  "/// 派发一条命令。cmd 与前端 invoke 的命令名一致，args 用 camelCase 键。",
  "pub fn dispatch(app: &tauri::AppHandle, cmd: &str, args: &serde_json::Map<String, Value>) -> Result<Value, String> {",
  "    match cmd {",
  commands.map(arm).join("\n"),
  "        other => Err(format!(\"未知命令: {other}\")),",
  "    }",
  "}",
  "",
  "/// 全部已桥接的命令名，按源码顺序排列（/health 自检用）。",
  "pub const COMMANDS: &[&str] = &[",
  commands.map((c) => "    \"" + c.fn + "\",").join("\n"),
  "];",
  "",
].join("\n");

const outFile = join(srcDir, "bridge", "dispatch.generated.rs");
if (process.argv.includes("--check")) {
  const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  if (current !== out) {
    console.error("dispatch.generated.rs 与源码不一致，请运行 node scripts/gen-bridge-dispatch.mjs 重新生成。");
    process.exit(1);
  }
  console.log("dispatch.generated.rs 一致（" + commands.length + " 条命令）");
  process.exit(0);
}

mkdirSync(join(srcDir, "bridge"), { recursive: true });
writeFileSync(outFile, out, "utf8");
console.log("已写出 " + outFile + "（" + commands.length + " 条命令，async " + commands.filter((c) => c.isAsync).length + " 条）");



