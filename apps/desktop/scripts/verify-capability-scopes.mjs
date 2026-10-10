/**
 * 校验 capability 里的 HTTP URL pattern 能匹配**带端口**的地址。
 *
 * ## 为什么需要它
 *
 * Tauri 的 capability 用 \`urlpattern\` 语法，而 \`https://**\` 的 **port 解析为空**
 * （不是通配）—— 于是**任何带端口的 URL 都会被 http 插件拒绝**，
 * 报错是 \`url not allowed\`，但用户侧只看到「视频播不了」。
 *
 * 真实踩过：B 站 PCDN 的取流地址是 \`mcdn.bilivideo.cn:8082\`（实测该稿件的
 * 27 个流地址里 **17 个带端口**，另有备用域 \`:4483\`）。被拒后 DASH 取流直接失败，
 * 播放器时长停在 \`00:00 / 00:00\`。
 *
 * 正确写法是 \`https://**:*\`（port 为 \`*\`，同时匹配有端口与无端口）。
 *
 * ## 用法
 *
 *   node scripts/verify-capability-scopes.mjs
 *
 * 已在 CI 的 lint 作业里执行（离线，无需网络）。
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "src-tauri", "capabilities");

/** 必须能匹配的「带端口」真实地址（来自实测的 B 站取流 URL）。 */
const PORTED = [
  "https://xy115x231x41x12xy.mcdn.bilivideo.cn:8082/v1/resource/upgcxcode/99/91/x.m4s?e=abc",
  "https://mv0b373m.edge.mountaintoys.cn:4483/upgcxcode/99/91/x.m4s?e=def",
];
/** 顺带确认不带端口的照旧放行（避免修过头把范围收窄）。 */
const PLAIN = [
  "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/x.m4s",
  "https://api.bilibili.com/x/web-interface/nav",
  "https://i0.hdslb.com/bfs/archive/x.jpg",
];

const failures = [];

/** 复刻插件 scope.rs 的 parse_url_pattern：search/hash/pathname 为空时填 *。 */
function compile(pattern) {
  // 用 globalThis 访问：URLPattern 是 Node 20+ 的全局，但 eslint 的
  // globals.node 白名单里还没有它（会报 no-undef），显式取全局可两全。
  return new globalThis.URLPattern(pattern);
}

for (const file of await readdir(DIR)) {
  if (!file.endsWith(".json")) continue;
  const json = JSON.parse(await readFile(join(DIR, file), "utf8"));
  for (const perm of json.permissions ?? []) {
    // 只看 http 插件的 scope（字符串权限没有 url 列表）
    if (typeof perm !== "object" || !Array.isArray(perm.allow)) continue;
    if (!String(perm.identifier ?? "").startsWith("http:")) continue;
    const patterns = perm.allow
      .map((a) => (typeof a === "object" && typeof a.url === "string" ? a.url : null))
      .filter(Boolean);
    const compiled = patterns.map(compile);
    for (const url of PORTED) {
      if (!compiled.some((p) => p.test(url))) {
        failures.push(
          file + " 的 " + perm.identifier + " 无法匹配带端口的 " + url.slice(0, 60) + "…",
        );
      }
    }
    for (const url of PLAIN) {
      if (!compiled.some((p) => p.test(url))) {
        failures.push(file + " 的 " + perm.identifier + " 连不带端口的也匹配不了：" + url);
      }
    }
  }
}

if (failures.length) {
  console.error("✗ capability 的 HTTP scope 有问题：");
  for (const f of failures) console.error("    " + f);
  console.error("");
  console.error("  提示：pattern 要写成 https://**:* 而不是 https://** ——");
  console.error("        后者的 port 是空值，会拒绝一切带端口的地址。");
  process.exit(1);
}
console.log("✓ capability HTTP scope 覆盖带端口与不带端口两类地址");
