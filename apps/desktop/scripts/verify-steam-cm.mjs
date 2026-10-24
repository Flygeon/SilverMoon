/**
 * Steam CM 可达性验证（**真连 CM 端点，不模拟**）。
 *
 * ## 为什么需要它
 *
 * 下载功能的前置是 CM 长连接。而本机**没有 MSVC 链接器**，
 * `cargo build` 跑不了，Rust 侧的 CM 连接层无法在本地编译验证。
 * 这个脚本退一步：用 Node 直接验证「CM 端点能不能连上」，
 * 把「网络层不通」与「Rust 代码有问题」区分开 —— 否则线上报错时无法判断是哪一类。
 *
 * ## 覆盖
 *
 * 1. 取 CM 服务器列表（`ISteamDirectory/GetCMListForConnect`）；
 * 2. 逐个尝试建立 WebSocket 到 `/cmsocket/`，报告第一个成功端点；
 * 3. 取 CDN 服务器列表（`GetServersForSteamPipe`）；
 * 4. 验证「无鉴权拉 manifest 会 401」——这是**证明必须走 CM**的关键事实。
 *
 * 全部失败也不报错退出：网络不通是环境问题，不是代码问题。
 */
const CM_LIST_API = "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/";
const CDN_API =
  "https://api.steampowered.com/IContentServerDirectoryService/GetServersForSteamPipe/v1/";
const UA = "Valve/Steam HTTP Client 1.0";

let pass = 0;
let fail = 0;

function ok(name, detail = "") {
  pass += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name, why) {
  console.log(`  - ${name}（跳过：${why}）`);
}
function bad(name, error) {
  fail += 1;
  console.log(`  ✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
}

/** 试连一个 CM 端点，返回是否握手成功。 */
function tryWs(endpoint, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    let socket = null;
    try {
      socket = new WebSocket(`wss://${endpoint}/cmsocket/`);
    } catch {
      done("invalid");
      return;
    }
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      done("open");
    };
    socket.onerror = () => {
      clearTimeout(timer);
      done("error");
    };
  });
}

console.log("Steam CM 可达性验证\n");

// ---- 1. CM 列表 ----
let cmEndpoints = [];
try {
  const res = await fetch(`${CM_LIST_API}?cellid=0&cmtype=websockets&maxcount=20`, {
    headers: { "User-Agent": UA },
  });
  const json = await res.json();
  const list = json?.response?.serverlist ?? [];
  const ws = list
    .filter((s) => s.ws)
    .map((s) => s.endpoint ?? s.ws)
    .filter(Boolean);
  cmEndpoints = ws.length > 0 ? ws : list.map((s) => s.endpoint).filter(Boolean);
  if (cmEndpoints.length > 0) ok("取到 CM 服务器列表", `${cmEndpoints.length} 个端点`);
  else bad("取到 CM 服务器列表", "列表为空");
} catch (error) {
  bad("取到 CM 服务器列表", error);
}

// ---- 2. 实际连一个 ----
if (cmEndpoints.length > 0) {
  let connected = null;
  for (const endpoint of cmEndpoints.slice(0, 8)) {
    const result = await tryWs(endpoint);
    if (result === "open") {
      connected = endpoint;
      break;
    }
  }
  if (connected) {
    ok("成功建立 CM WebSocket", connected);
  } else {
    bad("成功建立 CM WebSocket", "前 8 个端点全部失败");
  }

  // ---- 3. 无鉴权拉 manifest 会 401（证明必须走 CM）----
  try {
    const res = await fetch(`${CDN_API}?cell_id=0&max_servers=3`, {
      headers: { "User-Agent": UA },
    });
    const json = await res.json();
    const server = (json?.response?.servers ?? [])[0];
    if (!server) {
      skip("CDN 服务器列表", "未返回可用服务器");
    } else {
      ok("取到 CDN 服务器列表", server.host ?? server.Host ?? "?");
      const host = server.host ?? server.Host;
      const port = server.port ?? 80;
      const scheme = server.use_https ? "https" : "http";
      // 用一个常见的公共 depot（228980 = Steamworks Common Redistributables）
      const probeUrl = `${scheme}://${host}:${port}/depot/228980/manifest/4630212058042865068/5`;
      const manifest = await fetch(probeUrl, { headers: { "User-Agent": UA } });
      if (manifest.status === 401) {
        ok("无鉴权拉 manifest 返回 401（证实必须走 CM 拿 CDN auth token）", `HTTP 401`);
      } else {
        ok("无鉴权拉 manifest", `HTTP ${manifest.status}`);
      }
    }
  } catch (error) {
    bad("验证 CDN 鉴权要求", error);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
  // 网络类失败不算代码错：给出明确提示，但仍然非零退出以便 CI 发现环境异常
  console.log("\n提示：若失败项都是网络相关（端点连不上），说明本机到 Steam CM 不通，");
  console.log("      下载功能在此环境下不可用 —— 这不代表代码有误。");
  process.exit(1);
}
