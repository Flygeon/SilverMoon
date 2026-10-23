/**
 * 远程页窗口（Rust 侧建的那些）的预加载脚本。
 *
 * 这类窗口有两个特殊要求：
 *
 * 1. **必须运行在页面世界**（所以 `windows.ts` 给它们设了
 *    `contextIsolation: false`）——番剧取流要挂钩 `HTMLMediaElement.prototype` /
 *    `fetch` / `XMLHttpRequest`，文库8 登录要读远程页的 `document.cookie`，
 *    在隔离世界里挂钩是无效的。
 * 2. **要提供最小可用的 `window.__SILVERMOON_HOST__.invoke`** —— 文库8 的注入脚本
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
// Electron 运行时在 preload 里提供 process.isMainFrame，但 @types 没挂到 Process 上；
// 取不到时按主 frame 处理（保持旧行为）。
const isMainFrame = (process as NodeJS.Process & { isMainFrame?: boolean }).isMainFrame !== false;

// 只暴露 invoke 一个能力，且只走已登记的命令通道（远程页用它上报登录日志）。
// 远程页面无法借此访问文件系统或任何 Electron API。
//
// iframe 场景（番剧取流窗口开了 nodeIntegrationInSubFrames）下，preload 也会在
// 每个子 frame 执行；但子 frame 常是第三方内容，**不能**把 host 桥暴露给它们，
// 否则任何广告 iframe 都能调 `sm:invoke`。host 只在主 frame 定义。
const minimalHost = {
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

if (isMainFrame) {
  Object.defineProperty(window, "__SILVERMOON_HOST__", {
    value: minimalHost,
    writable: false,
    configurable: false,
  });
}

// 执行 Rust 侧提供的初始化脚本。
if (scriptFile) {
  try {
    const source = readFileSync(scriptFile, "utf8");
    // 子 frame 只跑番剧取流的钩子脚本（标记：`__animeInjected`）。其它注入脚本
    // （文库8 登录）依赖 __SILVERMOON_HOST__ 且只需在主 frame 执行，不在 iframe 里重复跑。
    if (isMainFrame || source.includes("__animeInjected")) {
      // 用间接 eval 而非 new Function：脚本里的顶层 `this` 需要指向 window
      (0, eval)(source);
    }
  } catch (error) {
    console.error("[silvermoon] 初始化脚本执行失败：", error);
  }
}
