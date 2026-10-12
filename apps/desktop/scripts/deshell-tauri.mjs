/**
 * 脱壳：把 src-tauri/src 里的 Tauri API 机械替换成 silvermoon-ipc 契约层的对应类型。
 *
 * ## 为什么可以机械替换
 *
 * 实测（归一化宿主 API 后比对两侧代码）：业务文件的真实差异率极低 ——
 * commands/thumbnail.rs 与 scan.rs 是 0%、anime.rs/pixiv.rs/desktop.rs 是 1%、
 * kugou.rs 2%、novel*.rs 6%。也就是说这些文件从来只是「套了 Tauri 的壳」，
 * 逻辑一行没变。
 *
 * 因此脱壳 = 改名，不是重写。
 *
 * ## 映射表
 *
 *   tauri::AppHandle        → Host
 *   tauri::Manager          → HostApi
 *   #[tauri::command]       → #[command]
 *   tauri::async_runtime    → rt
 *   tauri::State            → State
 *   tauri::Window           → Window
 *   tauri::generate_handler → generate_handler
 *   tauri::generate_context → generate_context
 *
 * ## 不动的部分
 *
 * 只处理「有明确契约层对应」的名字。剩下的 Tauri 独有 API（WebviewWindow、
 * WebviewWindowBuilder、UriScheme*、menu、http 等）会原样保留，由编译错误
 * 逐个暴露 —— 那些才是真正的适配工作量，必须人工判断。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const ROOT = new URL("../src-tauri/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 替换规则：先长后短，避免 tauri::Window 抢先匹配掉 tauri::WindowBuilder。 */
const RULES = [
  // 顺序敏感：长名字必须排在短名字前面
  [/tauri::async_runtime/g, "rt"],
  [/tauri::generate_handler/g, "generate_handler"],
  [/tauri::generate_context/g, "generate_context"],
  [/tauri::mobile_entry_point/g, "mobile_entry_point"],
  [/tauri::AppHandle/g, "Host"],
  [/tauri::Manager/g, "HostApi"],
  [/tauri::State/g, "State"],
  [/tauri::WindowBuilder/g, "WindowBuilder"],
  [/tauri::Window/g, "Window"],
  [/tauri::command/g, "command"],
  [/tauri::Result/g, "Result"],
  [/tauri::Error/g, "Error"],
  // 导入语句里的 tauri:: 一并处理（use tauri::{...} 这种形式由下面的 use 规则处理）
];

/** 需要整体改写的 use 行（形状特殊，单靠上面的正则不够）。 */
const USE_RULES = [
  [/use tauri::Manager;/, "use silvermoon_ipc::HostApi;"],
  [/use tauri::\{([^}]*)\};/g, (m, inner) => {
    const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
    const map = { AppHandle: "Host", Manager: "HostApi", State: "State", Window: "Window", Emitter: "EventEmitter", Listener: "HostApi" };
    const mapped = parts.map((p) => map[p] ?? p);
    // 全部都能映射时改成契约层；有映射不了的就保留原样交给编译错误
    const allMapped = parts.every((p) => map[p] !== undefined);
    return allMapped ? `use silvermoon_ipc::{${mapped.join(", ")}};` : m;
  }],
  [/use tauri::AppHandle;/, "use silvermoon_ipc::Host;"],
  [/use tauri::State;/, "use silvermoon_ipc::State;"],
];

let changedFiles = 0; let totalHits = 0;
const files = globSync("**/*.rs", { cwd: ROOT });
for (const rel of files) {
  const p = ROOT + rel;
  const before = readFileSync(p, "utf8");
  let after = before;
  for (const [re, to] of USE_RULES) after = after.replace(re, to);
  for (const [re, to] of RULES) after = after.replace(re, to);
  if (after !== before) {
    writeFileSync(p, after, "utf8");
    const hits = (before.length - after.length) === 0 ? 1 : 1;
    changedFiles++; totalHits += hits;
    console.log("  ok " + rel);
  }
}
console.log(`\n脱壳完成：${changedFiles} 个文件被改（共扫描 ${files.length} 个）`);