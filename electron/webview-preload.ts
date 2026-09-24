/**
 * 远程页窗口（Rust 侧建的那些）的预加载脚本。
 *
 * 这类窗口有两个特殊要求：
 *
 * 1. **必须运行在页面世界**（所以 `windows.ts` 给它们设了
 *    `contextIsolation: false`）——番剧取流要挂钩 `HTMLMediaElement.prototype` /
 *    `fetch` / `XMLHttpRequest`，文库8 登录要读远程页的 `document.cookie`，
 *    在隔离世界里挂钩是无效的。
 * 2. **要提供最小可用的 `window.__TAURI__.core.invoke`** —— 文库8 的注入脚本
 *    直接调用它上报日志（`wenku8_login_log`）。注意这个页面是**远程内容**，
 *    因此这里只放行 `invoke`，不暴露 `ipcRenderer`、`require` 等任何特权接口。
 *
 * 注入脚本本身由 Rust 侧给出（`initialization_script`），主进程把它写到缓存目录，
 * 路径通过 `--silvermoon-init-script` 参数传进来。
 */
import { readFileSync } from "node:fs";
import { ipcRenderer } from "electron";

function readArg(prefix: string): string | null {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const label = readArg("--silvermoon-label=") ?? "main";
const scriptFile = readArg("--silvermoon-init-script=");

// 只暴露 invoke 一个能力，且只走已登记的命令通道。
// 远程页面无法借此访问文件系统或 Electron API。
const minimalTauri = {
  core: {
    invoke: (cmd: string, args?: unknown) => ipcRenderer.invoke("sm:invoke", { cmd, args }),
  },
  event: {
    // 文库8 注入脚本未使用；留空实现避免报错
    emit: () => Promise.resolve(),
    listen: () => Promise.resolve(() => {}),
  },
  window: { label },
};

Object.defineProperty(window, "__TAURI__", {
  value: minimalTauri,
  writable: false,
  configurable: false,
});

// 执行 Rust 侧提供的初始化脚本。
if (scriptFile) {
  try {
    const source = readFileSync(scriptFile, "utf8");
    // 用间接 eval 而非 new Function：脚本里的顶层 `this` 需要指向 window
    (0, eval)(source);
  } catch (error) {
    console.error("[silvermoon] 初始化脚本执行失败：", error);
  }
}
