/**
 * 开发环境编排：Vite dev server + Electron 主进程（watch）+ Electron 本体。
 *
 * 不引入 concurrently / wait-on 之类的依赖，用 30 行原生代码把三件事串起来，
 * 保持依赖树干净。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_URL = "http://localhost:1420";

const children = [];
let shuttingDown = false;

function launch(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.log(`[dev] ${name} 退出（code=${code}），停止其余进程`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/** 轮询等待 dev server 起来，避免 Electron 抢在 1420 之前加载失败。 */
async function waitForDevServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(DEV_URL, { method: "GET" });
      if (response.ok || response.status === 404) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

launch("vite", "npm", ["run", "dev:renderer"]);
launch("esbuild", "npm", ["run", "dev:main"]);

if (!(await waitForDevServer())) {
  console.error(`[dev] 等待 ${DEV_URL} 超时，请检查 Vite 是否正常启动`);
  shutdown(1);
}

// 让 Electron 用当前项目的 electron 可执行文件
launch("electron", "npx", ["electron", "."]);
