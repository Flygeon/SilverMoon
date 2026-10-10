/**
 * 校验 capability 里的 HTTP URL pattern 能匹配**带端口**的地址。
 *
 * ## 为什么需要它
 *
 * Tauri 的 capability 用 urlpattern 语法，而 https://** 的 **port 解析为空**
 * （不是通配）—— 于是**任何带端口的 URL 都会被 http 插件拒绝**，
 * 报错只到 url not allowed，用户侧只看到「视频播不了」。
 *
 * 真实踩过：B 站 PCDN 的取流地址是 mcdn.bilivideo.cn:8082（实测该稿件的
 * 27 个流地址里 **17 个带端口**，另有备用域 :4483）。被拒后 DASH 取流直接失败，
 * 播放器时长停在 00:00 / 00:00。
 *
 * 正确写法是 https://**:*（port 为 *，同时匹配有端口与无端口）。
 *
 * ## ⚠️ 为什么不直接用 URLPattern
 *
 * URLPattern 是 **Node 24 才默认可用的全局**，CI 用的是 Node 22（官方 v22 的
 * 全局与 url 模块文档里都没有它）。本机 Node 24 测通过、CI 上却是 undefined
 * —— 这个坑我踩过一次（第一版脚本就是这么挂的）。
 *
 * 因此这里不依赖运行时 API，而是**按插件源码的语义自己实现匹配**
 * （见 tauri-plugin-http/src/scope.rs 的 parse_url_pattern +
 * urlpattern crate 的 constructor-string 解析）：
 *
 * 1. 解析出 protocol / hostname / port / pathname 四段；
 * 2. search / hash 为空 → 填 *（插件显式做的）；
 * 3. pathname 为空或 / → 填 *（同上）；
 * 4. 逐段按 * 通配（含 **）匹配。
 *
 * 本脚本只处理 capability 里实际会写的形态（scheme://host[:port][/path]），
 * 遇到不认识的写法会**明确报错**而不是静默放过。
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

/** 把一个 URL 拆成协议 / 主机 / 端口 / 路径四段。 */
function splitUrl(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (!m) throw new Error("无法解析 URL：" + url);
  const protocol = m[1];
  const authority = m[2];
  const pathname = m[3];
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (v6) return { protocol, hostname: v6[1], port: v6[2] || "", pathname: pathname || "/" };
  const idx = authority.lastIndexOf(":");
  if (idx >= 0) {
    return {
      protocol,
      hostname: authority.slice(0, idx),
      port: authority.slice(idx + 1),
      pathname: pathname || "/",
    };
  }
  return { protocol, hostname: authority, port: "", pathname: pathname || "/" };
}

/** 把 capability 里的 pattern 拆成同样的四段（缺省段填 *，与插件一致）。 */
function splitPattern(pattern) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(pattern);
  if (!m) {
    throw new Error(
      "不认识的 pattern 写法（本脚本只支持 scheme://host[:port][/path]）：" + pattern,
    );
  }
  const protocol = m[1];
  const authority = m[2];
  const rawPath = m[3];
  let hostname = authority;
  let port = "";
  const v6 = /^\[([^\]]+)\](?::(\*|\d+))?$/.exec(authority);
  if (v6) {
    hostname = v6[1];
    port = v6[2] || "*";
  } else {
    const idx = authority.lastIndexOf(":");
    if (idx >= 0) {
      hostname = authority.slice(0, idx);
      port = authority.slice(idx + 1);
    } else {
      // ⚠️ 这就是那个坑：不写端口时 port 是**空**，不是通配
      port = "";
    }
  }
  const pathname = !rawPath || rawPath === "/" ? "*" : rawPath;
  return { protocol, hostname, port, pathname };
}

/** 单段通配匹配：支持 * 与 **。 */
function segMatch(pattern, value) {
  if (pattern === "*" || pattern === "**") return true;
  if (!pattern.includes("*")) return pattern === value;
  // 把 * 转成正则（** 与 * 在这几段里语义相同：匹配任意字符）
  const escaped = pattern.replace(/[.+?^$()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp("^" + escaped + "$").test(value);
}

/** pattern 是否匹配 url（复刻插件 scope.is_allowed 的单条判定）。 */
function matches(pattern, url) {
  const p = splitPattern(pattern);
  const u = splitUrl(url);
  return (
    segMatch(p.protocol, u.protocol) &&
    segMatch(p.hostname, u.hostname) &&
    // 端口：空 pattern 段只匹配空端口（这正是 https://** 拒绝 :8082 的原因）
    (p.port === "" ? u.port === "" : segMatch(p.port, u.port)) &&
    segMatch(p.pathname, u.pathname)
  );
}

const failures = [];

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
    for (const url of PORTED) {
      if (!patterns.some((p) => matches(p, url))) {
        failures.push(
          file + " 的 " + perm.identifier + " 无法匹配带端口的 " + url.slice(0, 58) + "…",
        );
      }
    }
    for (const url of PLAIN) {
      if (!patterns.some((p) => matches(p, url))) {
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
